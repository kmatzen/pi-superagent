/** Trigger ingestion, thread correlation, subscription fan-out, evaluation queuing, and the ready sweep. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { isoTime, liveTicket, mandateWithdrawn, threadKey } from './model.ts'
import type { ActorRef, ChannelRef, ThreadRef, Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * One open issue a Source lists on its board, as the ready sweep is offered it. The sweep builds its own Trigger
 * from these facts, which is what keeps `human: false` out of any caller's hands: see `Intake.sweep`.
 */
export interface SweepCandidate {
  thread: ThreadRef
  /** The Source's `updated_at`: the age the sweep ranks on, and the Trigger's own `at`. */
  updatedAt: string
  /** The board's priority label: a person put this one in the next free slot. */
  priority?: boolean
  /** The board's `waiting-on-human` label: the next move is a person's, so no slot is free for it. */
  waitingOnHuman?: boolean
  actor: ActorRef
  text: string
  channel?: ChannelRef
  /** Source-native details its `scope` reads; the sweep adds `via` and `sweep` to them. */
  meta?: Record<string, unknown>
}

/** One pass of the ready sweep, as the Engine's tick presents it. */
export interface SweepPass {
  /** Free worker slots: `maxWorkers - running`. A trigger with no slot behind it is a request nobody will take. */
  slots: number
  /** A Thread with activity newer than this is live conversation the comment and review paths already heard. */
  cursor: string
  day: string
  board: readonly SweepCandidate[]
  /** The per-issue cooldown, read and spent through callbacks because the counter lives in the caller's store. */
  cooled?: (thread: string, day: string) => boolean
  spend?: (thread: string, day: string) => void
}

/** What one sweep pass did: `passed` answers why a free slot stayed free, the question the panel gets asked. */
export interface SweepResult {
  swept?: string
  skipped?: 'no-slots' | 'eval-busy' | 'no-eligible-issue'
  passed?: { thread: string; reason: string }[]
}

/** The sweep's order: priority label first, then the oldest ask; ties by thread key, so a pass is deterministic. */
export const sweepRank = (board: readonly SweepCandidate[]): SweepCandidate[] =>
  [...board].sort((a, b) => (Number(b.priority === true) - Number(a.priority === true))
    || a.updatedAt.localeCompare(b.updatedAt)
    || threadKey(a.thread).localeCompare(threadKey(b.thread)))

/**
 * Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
 * Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
 * ticket's worker decides (see `followupOwners`).
 * Engine delegates trigger reception to this part.
 */
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  receive(received: Trigger): ReceiveResult {
    // The door `resumes` below opens is a person's: it wakes a ticket its author stopped. A trigger carrying the
    // sweep's marker asks on the router's own account, so one that also claims to be human is refused here, on
    // every path — the sweep's emitter, a Source, a replay — not only where the sweep builds its own.
    if (received.meta?.sweep === true && received.human) throw new UserError('sweepNotHuman', { thread: threadKey(received.threads[0] ?? { source: received.source, id: '' }) })
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // Track reached tickets and whether they were reached only via context threads (a ticket's own thread makes `context` false).
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      for (const ticketId of thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // Only a person's message on a non-context thread resumes an ended ticket; bots and CI do not (the Executor re-reads
        // threads when it resumes). A stop withdraws the Mandate only when a person asked for the stop from the panel, or
        // when the repeat guard stopped a loop: the router's conversation stop ends the thread, not the mandate, and the
        // person who closed the issue is the one who reopens it. One predicate, in model.ts, is this door and `wake`'s.
        const followed = !!thread.context?.includes(ticketId)
        const resumes = trigger.human && !!ticket && !mandateWithdrawn(ticket) && !followed
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.tickets.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
        ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
    }
    const fanout = [...reached.keys()], context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // A person's message that no ticket decides, such as one that reached only tickets a person stopped or that follow the
    // Thread for context, and every bot's, goes to Eval.
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }

  /**
   * The ready sweep: free slots, an empty eval queue, and open asks nobody is on. Intake is activity-driven, so an
   * issue quiet past the cursor produces no trigger and gets no worker: measured 2026-11-24, six ready issues idle
   * 62 to 84 hours on five free slots. One synthetic Trigger per pass enters the same Eval path a person's message
   * uses, so the judge — not this method — decides what an unowned issue deserves, and `ignore` is an answer.
   *
   * The Trigger is built here because `human` on it is not a parameter: `resumes` in `receive` is the door a
   * person's message walks through to wake a ticket its author stopped, and a sweep trigger with faked provenance
   * would open it. `SweepCandidate` has no `human` field, the check below is the guard (third pin after the unit
   * test and `formal/Intake.tla` C7), and `mandateWithdrawn` makes a stopped thread terminal, not merely ticketless.
   */
  sweep(pass: SweepPass): SweepResult {
    if (pass.slots <= 0) return { skipped: 'no-slots' }
    // An Eval queued or running is a person's ask in the judge's hands: the sweep does not queue behind it.
    if (this.repo.threads.active().length) return { skipped: 'eval-busy' }
    const passed: { thread: string; reason: string }[] = []
    for (const candidate of sweepRank(pass.board)) {
      const thread = threadKey(candidate.thread)
      // A public board lists strangers' issues, and the write-access scope is what keeps one from reaching a judge,
      // let alone a shell on this machine: ask it before spending the day's cooldown on an issue that cannot pass.
      if (!this.options.scope.scope({ source: candidate.thread.source, meta: { ...candidate.meta, via: 'sweep', sweep: true } }).listened) {
        passed.push({ thread, reason: 'outOfScope' }); continue
      }
      if (candidate.waitingOnHuman) { passed.push({ thread, reason: 'waitingOnHuman' }); continue }
      const stored = this.repo.threads.get(thread)
      // Newer than the sweep cursor is live conversation: the comment and review paths already heard it.
      if (stored?.lastAt && stored.lastAt > pass.cursor) { passed.push({ thread, reason: 'liveActivity' }); continue }
      const onThread = stored ? this.ticketsOnThread(stored) : []
      if (onThread.some(ticket => liveTicket(ticket))) { passed.push({ thread, reason: 'liveTicket' }); continue }
      // A person's stop withdrew the Mandate, so the thread is decided — and any ended ticket is, on work a second
      // ticket would duplicate.
      if (onThread.some(ticket => mandateWithdrawn(ticket))) { passed.push({ thread, reason: 'ticketStopped' }); continue }
      if (onThread.length) { passed.push({ thread, reason: 'ticketEnded' }); continue }
      if (pass.cooled?.(thread, pass.day)) { passed.push({ thread, reason: 'sweptToday' }); continue }
      const trigger: Trigger = {
        // One per issue per day, and stable across a replay of the same pass: the engine dedups ids forever.
        id: `sweep:${thread}:${pass.day}`,
        source: candidate.thread.source,
        threads: [candidate.thread],
        actor: candidate.actor,
        // Pinned: a sweep trigger is the router asking, never a person speaking.
        human: false,
        at: candidate.updatedAt,
        text: candidate.text,
        ...(candidate.channel ? { channel: candidate.channel } : {}),
        meta: { ...candidate.meta, via: 'sweep', sweep: true },
      }
      this.receive(trigger)
      pass.spend?.(thread, pass.day)
      this.emit('trigger.swept', { triggerId: trigger.id, threadKey: thread, passed })
      return { swept: thread, passed }
    }
    return { skipped: 'no-eligible-issue', passed }
  }
}
