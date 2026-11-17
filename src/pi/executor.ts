/**
 * The Executor port bound to pi sessions: start = a session in the ticket's workspace, deliver = a queued
 * prompt into the running one, stop = abort. Reports arrive through a tool, never by parsing worker prose.
 */
import type { Assignment, EngineForExecutor, Ticket, TicketInput } from '../core/index.ts'
import type { Reporter, ReportOrigin, ReportOutcome } from './report-tool.ts'

export interface WorkerSession {
  readonly sessionId: string
  /** Returns a name when the session can later say that a run took this prompt (`inputRead`). */
  prompt(text: string, mode: 'steer' | 'followUp'): string | void
  subscribe(listener: (event: WorkerEvent) => void): () => void
  abort(): void
  dispose(): void
  /** Where the worker is allowed to write; named so the operator can open it. */
  readonly workspace?: string
  /** Where the operator can watch it: a herdr tab, or the file it streams to. */
  readonly watch?: string
}

const NO_LIVE_WORKER = 'no live worker for this ticket'

export type WorkerEvent =
  /** The session took queued input into a step: the engine may mark those Inputs read. */
  | { type: 'turnStarted' }
  /** A running turn took the prompt that `prompt` named `name` into a step. */
  | { type: 'inputRead'; name: string }
  | { type: 'settled' }
  | { type: 'failed'; error: string }
  /** Any other session event: tool calls and model output are what a busy worker emits for minutes on end. */
  | { type: 'activity' }

export interface WorkerLauncher {
  launch(input: {
    ticket: Ticket
    assignment: Assignment
    brief: string
    /** The worker's report tool lands here; only the engine writes a ticket. */
    report: Reporter
  }): Promise<WorkerSession> | WorkerSession
}

export interface ExecutorOptions {
  /** The deployment owns git; the engine does not know a worktree exists. */
  worktreeFor(ticket: Ticket): string
  briefFor(ticket: Ticket, assignment: Assignment): string
  /** A router with no cap forks until the box dies. */
  maxConcurrent?: number
  /** True while a new worker must not start (the disk is nearly full): queued launches wait, running ones are untouched. */
  launchBlocked?(): boolean
  /** Render one Input into prompt text. Trigger inputs need the trigger's text, which the engine keeps
   *  in the store, not on the ticket: the deployment owns that lookup. Undefined = not worker-visible. */
  renderInput(input: TicketInput): string | undefined
  slotPollMs?: number
  /** Every report the engine accepted, with who ended the run: the deployment tells the person. */
  reported?(ticket: Ticket, assignmentId: string, origin: ReportOrigin,
            report: Filed & { pullRequests?: readonly string[], results?: readonly string[] }): void
  /**
   * Every report that reached the executor and could not be filed, said once each: the worker's tool call
   * answers `reported` in the pane, the ticket records nothing, and a run that spoke to nobody is indistinguishable
   * from a worker that went silent. Measured 2026-11-09, #255: a released worker kept its herdr tab, a queued
   * copy of its mandate surfaced after its report, its second report was dropped here, and three later runs of
   * that ticket spent their whole lives re-proving a merge from the receipt the first one wrote.
   */
  reportDropped?(fields: Record<string, unknown>): void
  /** Runs before the engine reads the report, because a ready report completes a ticket that follows no open pull
   *  request yet. Returns the pull requests the ticket now follows. */
  follow?(ticket: Ticket, pullRequests: readonly string[]): readonly string[]
  /** The ticket as it stands when a queued launch gets its slot, or undefined when `assignment` no longer wants a worker. */
  stillWanted?(ticket: Ticket, assignment: Assignment): Ticket | undefined
}

interface Live {
  session: WorkerSession
  unsubscribe: () => void
  pendingRead: Array<{ name: string | undefined; ids: string[] }>
  /** On a run. A settled worker is parked: its session stays for follow-ups, but it holds no slot. */
  busy: boolean
  startedAt: number
  lastEventAt: number
  events: number
  workspace: string
  quietReported: boolean
  deadlineReported: boolean
  /** The state of the last report the worker itself posted. A crash records a session ending; it does not
   *  overwrite this, because a worker whose last word was `ready` finished the work. */
  lastState: string
  assignmentId: string
}

export interface WorkerView {
  ticketId: string
  sessionId: string
  workspace: string
  startedAt: string
  lastEventAt: string
  events: number
  quietSeconds: number
  ageSeconds: number
  watch: string
  busy: boolean
}

/**
 * Whether the ticket that ended did so with finished work: the worker reported its result, the pull request it
 * opened merged, or the ticket closed with nothing to do. Escape cancels a run, and a cancel thrown at finished
 * work kills whatever the worker is doing at that moment — measured 2026-11-07T02:33:07Z, where a merge landing
 * while the worker called ticket_report destroyed the report, and the run then posted as stopped without a
 * result. A person stopping the ticket, a pull request closed without merging, and a retry are real
 * cancellations, and they still get Escape. The end is recorded on the ticket before this runs, so a stop that
 * carries no end at all (a retry, a delayed stop for a crashed run) reads as a cancellation.
 */
export const finishedWork = (ticket: Ticket): boolean =>
  ticket.ended?.outcome === 'completed' || ticket.ended?.outcome === 'merged' || ticket.ended?.outcome === 'dropped'

export class PiExecutor {
  private readonly live = new Map<string, Live>()
  private tail: Promise<void> = Promise.resolve()
  /** ticket/assignment launches queued and not yet live: the loop calls start() every pass while one waits. */
  private readonly launching = new Set<string>()
  /** Launches enqueued and not yet run. Measured, because a pass that waits on this needs to know its size. */
  private queued = 0
  /** When a launch last produced a live worker: a queue whose launches all fail moves, and starts nobody. */
  private startedAt = 0

  constructor(private readonly engine: EngineForExecutor, private readonly launcher: WorkerLauncher,
              private readonly options: ExecutorOptions) {}

  /** Workers on a run: the number the cap bounds. */
  get running(): number { return [...this.live.values()].filter(live => live.busy).length }
  get parked(): number { return this.live.size - this.running }

  start(ticket: Ticket, assignment: Assignment): void {
    const key = `${ticket.id}/${assignment.id}`
    if (this.launching.has(key) || this.live.get(ticket.id)?.assignmentId === assignment.id) return
    this.launching.add(key)
    this.enqueue(async () => {
      try {
        const current = this.options.stillWanted ? this.options.stillWanted(ticket, assignment) : ticket
        if (!current) return
        const brief = this.options.briefFor(current, assignment)
        let sessionRef: WorkerSession | undefined
        const session = await this.launcher.launch({ ticket: current, assignment, brief, report: this.reporter(current, () => sessionRef) })
        sessionRef = session
        // A stop during boot finds no worker to stop (2026-11-12: one ran 2 min on a closed issue), so ask again here.
        if (this.options.stillWanted && !this.options.stillWanted(current, assignment)) { session.dispose(); return }
        this.bind(current, assignment, session)
        this.startedAt = Date.now()
        this.engine.assignmentStarted(ticket.id, assignment.id)
        session.prompt(brief, 'followUp')
      } catch (error) {
        this.file(ticket, assignment.id, 'launch', report('failed', `could not start a worker: ${text(error)}`))
      } finally {
        this.launching.delete(key)
      }
    })
  }

  /** A worker already running that this process did not start (it outlived the previous router): bind it, and
   *  do not prompt the brief again. */
  adopt(ticket: Ticket, assignment: Assignment, attach: (report: Reporter) => WorkerSession): void {
    if (this.live.has(ticket.id)) return
    let own: WorkerSession | undefined
    own = attach(this.reporter(ticket, () => own))
    this.bind(ticket, assignment, own, false)
  }

  // Bound to the session that owns the ticket: a report from a worker the domain has already replaced or
  // stopped is not a ticket write.
  private reporter(ticket: Ticket, own: () => WorkerSession | undefined): Reporter {
    return (state, summary, question, origin = 'worker', pullRequests, wakeInMinutes, notes, results): ReportOutcome => {
      const live = this.live.get(ticket.id)
      if (!live || live.session.sessionId !== own()?.sessionId) {
        const reason = live ? 'its worker was replaced' : 'the ticket has no live worker'
        // Nothing downstream can see this: the pane's tool answers `reported`, the reports.jsonl cursor has
        // already moved past the line, so the report is not retried, and the ticket keeps its previous report.
        // The log line and the tool's answer are the only two witnesses it ever had.
        this.options.reportDropped?.({
          ticket: ticket.id, assignment: live?.assignmentId, origin, state, reason, summary: summary.slice(0, 200),
        })
        return 'dropped'
      }
      this.file(ticket, live.assignmentId, origin, report(state, summary, question), pullRequests, wakeInMinutes, notes, results)
      return 'recorded'
    }
  }

  private file(ticket: Ticket, assignmentId: string, origin: ReportOrigin, filed: Filed, pullRequests?: readonly string[],
               wakeInMinutes?: number, notes?: string, results?: readonly string[]): void {
    const followed = pullRequests?.length ? this.options.follow?.(ticket, pullRequests) ?? [] : []
    try {
      this.engine.report(ticket.id, filed)
    } catch (error) {
      // The engine refuses a report on a ticket that ended (`ticketEnded`, `assignmentEnded`). Throwing keeps the
      // contract the loop already relies on, and saying it first is what makes the run visible: without this the
      // launch queue's catch swallows the whole event, and the operator reads a worker that never answered.
      this.options.reportDropped?.({
        ticket: ticket.id, assignment: assignmentId, origin, state: filed.state, reason: `the engine refused it: ${text(error)}`,
        summary: filed.summary.slice(0, 200),
      })
      throw error
    }
    if (origin === 'worker') {
      const live = this.live.get(ticket.id)
      if (live) live.lastState = filed.state
    }
    const wakeAt = wakeInMinutes ? new Date(Date.now() + wakeInMinutes * 60_000).toISOString() : undefined
    this.options.reported?.(ticket, assignmentId, origin,
      { ...filed, ...(followed.length ? { pullRequests: followed } : {}), ...(results?.length ? { results } : {}),
        ...(wakeAt ? { wakeAt } : {}), ...(notes ? { notes } : {}) })
  }

  private bind(ticket: Ticket, assignment: Assignment, session: WorkerSession, busy = true): void {
    const born = Date.now()
    const live: Live = {
      session, unsubscribe: () => {}, pendingRead: [], busy,
      startedAt: born, lastEventAt: born, events: 0, workspace: session.workspace ?? this.options.worktreeFor(ticket),
      quietReported: false, deadlineReported: false,
      // A worker this process adopted already has a report on the record, and a crash must not erase it: after a
      // restart the router's memory of what a worker finished lives in that record, not in this map.
      lastState: assignment.report?.state ?? '', assignmentId: assignment.id,
    }
    // Registered before it subscribes: subscribing reads the worker's file at once, and a report it filed while no router
    // ran found no live worker and was dropped (2026-11-13: a waiting report, read 5 ms before its worker was adopted).
    this.live.set(ticket.id, live)
    live.unsubscribe = session.subscribe(event => {
      live.lastEventAt = Date.now()
      live.events += 1
      live.quietReported = false
      // An adopted worker's turn began before this process subscribed, so no turnStarted ever marks it busy.
      live.busy = event.type !== 'settled'
      if (event.type === 'turnStarted') {
        const ids = live.pendingRead.splice(0).flatMap(batch => batch.ids)
        if (ids.length) this.engine.inputsRead(ticket.id, ids)
      } else if (event.type === 'inputRead') {
        const at = live.pendingRead.findIndex(batch => batch.name === event.name)
        if (at >= 0) this.engine.inputsRead(ticket.id, live.pendingRead.splice(at, 1)[0]!.ids)
      } else if (event.type === 'failed') {
        // A crash is the session dying, not the work failing. Filing `failed` over a worker's own `ready` erased
        // a finished run, and the router relaunched tickets whose pull requests were already open for review
        // (measured 2026-11-10: four relaunched after their panes closed, two of them shipped). Keep the report
        // the worker made and record the death in the summary.
        const said = live.lastState && live.lastState !== 'failed' ? live.lastState : 'failed'
        this.file(ticket, assignment.id, 'crash', report(said, `the worker crashed: ${event.error}`))
        // A dead session does no work: free its slot now, or every crash costs a worker until the next restart.
        if (this.live.get(ticket.id) === live) { live.unsubscribe(); this.live.delete(ticket.id); live.session.dispose() }
      }
    })
  }

  deliver(ticket: Ticket, assignment: Assignment): void {
    const live = this.live.get(ticket.id)
    const pending = ticket.inputs.filter(i => ticket.undelivered.includes(i.id))
    const visible = pending.map(i => ({ id: i.id, text: this.options.renderInput(i) })).filter(i => i.text)
    if (visible.length === 0) return
    // No session, no delivery: the input stays undelivered and the loop retries it when a worker exists.
    // The file inbox this replaced picked its target by grepping the message for `session <8 hex>`, which let a
    // person's comment steer whichever worker's id appeared in it, and nothing read the file for a ticket with
    // no worker, so the input was marked delivered and lost. Measured 2026-11-07 audit.
    if (!live) {
      // The engine calls this every tick for every ticket with undelivered input; six parked tickets measured
      // 17,000 row writes a day recording the same sentence, and stamped the ticket's last failure "now" forever.
      if (ticket.delivery?.error === NO_LIVE_WORKER) return
      return this.engine.deliveryFailed(ticket.id, assignment.id, NO_LIVE_WORKER)
    }
      // An idle session queues a mode-tagged message and never starts it: an operator reply sat as "3 awaiting input".
    // A person's message steers a busy worker too: pi hands it over at the next tool boundary. As a follow-up it waited
    // for the whole run, and a worker polling CI read the operator's review long after it was written (2026-11-12).
    const fromPerson = pending.some(i => i.kind === 'trigger' && i.human === true)
    const mode = live.busy && !fromPerson ? 'followUp' : 'steer'
    const texts = visible.map(i => String(i.text))
    // One prompt for the whole batch. Each `prompt` call is its own steering message, and pi steers the session
    // with the first while the rest queue: a review that arrived as five comments was answered one comment at a
    // time, with the other four invisible to the worker. Operator report 2026-11-09.
    const name = live.session.prompt(texts.length === 1 ? texts[0]!
      : `${texts.length} messages arrived since your last turn. Read them together before you answer:\n\n${texts.join('\n\n')}`, mode)
    this.engine.inputsDelivered(ticket.id, assignment.id, visible.map(i => i.id))
    live.pendingRead.push({ name: name || undefined, ids: visible.map(i => i.id) })
  }

  /**
   * Free the worker's slot and its tab, leaving the ticket and its checkout alone, and post nothing.
   * The operator's rule 2026-11-08: a worker that has spoken and waits for an answer holds a herdr tab and a
   * busy slot for hours while a person reads, and tickets queue behind it. `stop` is not this: it cancels the
   * turn with Escape and pi hands queued messages back to a human input box nobody watches.
   */
  release(ticket: Ticket): void {
    const live = this.live.get(ticket.id)
    if (!live) return
    live.unsubscribe()
    this.live.delete(ticket.id)
    live.session.dispose()
  }

  /** The router is going away, not the workers: stop listening without stopping them, so a reloaded router in
   *  this process takes them over and the old one stops acting on their reports. */
  detach(): void {
    for (const live of this.live.values()) live.unsubscribe()
    this.live.clear()
  }

  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    const live = this.live.get(ticket.id)
    if (!live || live.assignmentId !== assignment.id) return
    live.unsubscribe()
    this.live.delete(ticket.id)
    // The domain already ended the ticket before this call; the worker's job is to stop touching the box.
    // Not when the ticket ended because this worker said it was done: Escape is a cancellation, it cuts the
    // worker's last turn, and pi hands the run's queued messages back to the human's input box, where a review
    // sits unprocessed and the ticket's next step never happens.
    if (!finishedWork(ticket) && assignment.report?.state !== 'ready') live.session.abort()
    live.session.dispose()
  }

  /** Launches queued and not yet run: the ones waiting for a free worker slot, counted for the tick's drain. */
  get pendingLaunches(): number { return this.queued }

  /** When a launch last produced a live worker (0: never in this process). */
  get lastStartedAt(): number { return this.startedAt }

  /**
   * The worker cap the launch gate enforces, next to `running`: a stall is only readable when the reader can
   * see both (`running=18 cap=8` is the cause, `stage=drain` alone is a symptom). Startup takeover can push
   * `running` past this number on purpose, which is why the pair is worth publishing rather than assuming.
   */
  get capacity(): number { return this.options.maxConcurrent ?? 4 }

  /** What the operator can point a browser at: which worker, in which checkout, and when it last spoke. */
  workers(): WorkerView[] {
    return [...this.live.entries()].map(([ticketId, live]) => ({
      ticketId,
      sessionId: live.session.sessionId,
      workspace: live.session.workspace ?? live.workspace,
      startedAt: new Date(live.startedAt).toISOString(),
      lastEventAt: new Date(live.lastEventAt).toISOString(),
      events: live.events,
      quietSeconds: Math.round((Date.now() - live.lastEventAt) / 1000),
      ageSeconds: Math.round((Date.now() - live.startedAt) / 1000),
      watch: live.session.watch ?? '',
      busy: live.busy,
    }))
  }

  /** Workers that have gone quiet. Silence is not completion: the loop reports each quiet stretch once, so
   *  the ticket asks a person instead of reading as running forever. */
  quiet(minutes: number): WorkerView[] {
    // Once per silent stretch, and only on a run: a parked worker is quiet by design.
    const due = this.workers().filter(w => w.busy && w.quietSeconds >= minutes * 60 && !this.live.get(w.ticketId)?.quietReported)
    for (const w of due) this.live.get(w.ticketId)!.quietReported = true
    return due
  }

  /** Workers past their deadline, once each: the deadline is a prompt for a person, not a killer. */
  overdue(hours: number): WorkerView[] {
    const due = this.workers().filter(w => w.busy && w.ageSeconds >= hours * 3600 && !this.live.get(w.ticketId)?.deadlineReported)
    for (const w of due) this.live.get(w.ticketId)!.deadlineReported = true
    return due
  }

  // Launches are serialised behind each other: the cap bounds how many workers are on a run at once, and
  // starting two sessions in one tick is how a router forks until the box dies.
  private enqueue(run: () => Promise<void>): void {
    this.queued += 1
    this.tail = this.tail.then(async () => {
      // A slot frees when a session ends, which needs the event loop. Awaiting an already-resolved promise
      // never yields to it: the process spun at 100% with the panel dead as soon as a fifth ticket queued.
      while (this.gateClosed) await new Promise(resolve => setTimeout(resolve, this.options.slotPollMs ?? 1000))
      try { await run() } finally { this.queued -= 1 }
    }).catch(() => {
      // A rejected tail skips every later launch; the only throw left here (a report on an ended ticket) is moot.
      // The count is not adjusted here: the `finally` above runs on every path out of the launch, and counting a
      // failure twice would report a queue as drained while a launch still waits in it.
    })
  }

  /**
   * Everything queued has been started: the seam tests use, and a graceful shutdown needs.
   *
   * **A production tick must never await this.** The tail carries the slot gate, so with the fleet at its cap
   * it resolves only when the fleet goes quiet: measured 2026-11-09, one router entered 7 ticks in 6.6 h
   * against a 30 s timer, and every other await in the pass paid a full GitHub fan-out because of it (#303).
   * A caller that wants the launches without the capacity wait uses `drain`.
   */
  idle(): Promise<void> { return this.tail }

  /** The slot gate the head of the launch queue stands in: closed, no launch can start on this pass. */
  private get gateClosed(): boolean { return this.running >= this.capacity || this.options.launchBlocked?.() === true }

  /**
   * Wait for the queued launches to run, but at most `budgetMs` of wall clock, and say which of the two
   * happened. `pending` is the launches still waiting — normally on a free worker slot, which is the
   * router's steady state under load and is not this pass's business: the next pass finds them running.
   *
   * A closed gate answers immediately. The launch is already enqueued and the gate re-checks capacity on its
   * own timer, so a waiting caller starts nothing it would not start anyway; the budget only buys the launch
   * that capacity is holding. Measured on the deployed router 2026-11-09, the day after #303 shipped: the pass
   * paid the whole 5 s budget on 66 of 66 ticks (`drainMs=5001`, 47% of all tick time) against `running=8
   * cap=8` — the bounded form of the same capacity wait that made the loop enterable hourly, costing 5 s of
   * every 30 s and rising back toward that stall as the board grows.
   */
  async drain(budgetMs: number): Promise<{ settled: boolean; pending: number }> {
    if (this.queued === 0) return { settled: true, pending: 0 }
    if (budgetMs <= 0) return { settled: false, pending: this.queued }
    if (this.gateClosed) return { settled: false, pending: this.queued }
    const tail = this.tail
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), budgetMs)
      timer.unref?.()
    })
    const outcome = await Promise.race([tail.then(() => 'settled' as const), expired])
    clearTimeout(timer)
    return { settled: outcome === 'settled', pending: this.queued }
  }
}

const text = (e: unknown): string => e instanceof Error ? e.message : String(e)

const report = (state: string, summary: string, question?: string | null) => ({
  state: state as never, summary: summary.trim() || '(no summary)', ...(question === undefined ? {} : { question }),
})

type Filed = ReturnType<typeof report>
