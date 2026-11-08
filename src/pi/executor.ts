/**
 * The Executor port bound to pi sessions: start = a session in the ticket's workspace, deliver = a queued
 * prompt into the running one, stop = abort. Reports arrive through a tool, never by parsing worker prose.
 */
import type { Assignment, EngineForExecutor, Ticket, TicketInput } from '../core/index.ts'
import type { Reporter, ReportOrigin } from './report-tool.ts'

export interface WorkerSession {
  readonly sessionId: string
  prompt(text: string, mode: 'steer' | 'followUp'): void
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
  /** Render one Input into prompt text. Trigger inputs need the trigger's text, which the engine keeps
   *  in the store, not on the ticket: the deployment owns that lookup. Undefined = not worker-visible. */
  renderInput(input: TicketInput): string | undefined
  slotPollMs?: number
  /** Every report the engine accepted, with who ended the run: the deployment tells the person. */
  reported?(ticket: Ticket, assignmentId: string, origin: ReportOrigin, report: Filed & { pullRequests?: readonly string[] }): void
  /** Runs before the engine reads the report, because a ready report completes a ticket that follows no open pull
   *  request yet. Returns the pull requests the ticket now follows. */
  follow?(ticket: Ticket, pullRequests: readonly string[]): readonly string[]
}

interface Live {
  session: WorkerSession
  unsubscribe: () => void
  pendingRead: string[]
  /** On a run. A settled worker is parked: its session stays for follow-ups, but it holds no slot. */
  busy: boolean
  startedAt: number
  lastEventAt: number
  events: number
  workspace: string
  quietReported: boolean
  deadlineReported: boolean
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
  private readonly queue: Array<() => void> = []
  private tail: Promise<void> = Promise.resolve()
  /** ticket/assignment launches queued and not yet live: the loop calls start() every pass while one waits. */
  private readonly launching = new Set<string>()

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
        const brief = this.options.briefFor(ticket, assignment)
        let sessionRef: WorkerSession | undefined
        const session = await this.launcher.launch({ ticket, assignment, brief, report: this.reporter(ticket, () => sessionRef) })
        sessionRef = session
        this.bind(ticket, assignment, session)
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
    return (state, summary, question, origin = 'worker', pullRequests) => {
      const live = this.live.get(ticket.id)
      if (!live || live.session.sessionId !== own()?.sessionId) return
      this.file(ticket, live.assignmentId, origin, report(state, summary, question), pullRequests)
    }
  }

  private file(ticket: Ticket, assignmentId: string, origin: ReportOrigin, filed: Filed, pullRequests?: readonly string[]): void {
    const followed = pullRequests?.length ? this.options.follow?.(ticket, pullRequests) ?? [] : []
    this.engine.report(ticket.id, filed)
    this.options.reported?.(ticket, assignmentId, origin, followed.length ? { ...filed, pullRequests: followed } : filed)
  }

  private bind(ticket: Ticket, assignment: Assignment, session: WorkerSession, busy = true): void {
    const born = Date.now()
    const live: Live = {
      session, unsubscribe: () => {}, pendingRead: [], busy,
      startedAt: born, lastEventAt: born, events: 0, workspace: session.workspace ?? this.options.worktreeFor(ticket),
      quietReported: false, deadlineReported: false, assignmentId: assignment.id,
    }
    live.unsubscribe = session.subscribe(event => {
      live.lastEventAt = Date.now()
      live.events += 1
      live.quietReported = false
      // An adopted worker's turn began before this process subscribed, so no turnStarted ever marks it busy.
      live.busy = event.type !== 'settled'
      if (event.type === 'turnStarted') {
        const ids = live.pendingRead.splice(0)
        if (ids.length) this.engine.inputsRead(ticket.id, ids)
      } else if (event.type === 'failed') {
        this.file(ticket, assignment.id, 'crash', report('failed', `the worker crashed: ${event.error}`))
        // A dead session does no work: free its slot now, or every crash costs a worker until the next restart.
        if (this.live.get(ticket.id) === live) { live.unsubscribe(); this.live.delete(ticket.id); live.session.dispose() }
      }
    })
    this.live.set(ticket.id, live)
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
    for (const input of visible) live.session.prompt(String(input.text), 'followUp')
    this.engine.inputsDelivered(ticket.id, assignment.id, visible.map(i => i.id))
    live.pendingRead.push(...visible.map(i => i.id))
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
    this.tail = this.tail.then(async () => {
      const max = this.options.maxConcurrent ?? 4
      // A slot frees when a session ends, which needs the event loop. Awaiting an already-resolved promise
      // never yields to it: the process spun at 100% with the panel dead as soon as a fifth ticket queued.
      while (this.running >= max) await new Promise(resolve => setTimeout(resolve, this.options.slotPollMs ?? 1000))
      await run()
    }).catch(() => {
      // A rejected tail skips every later launch; the only throw left here (a report on an ended ticket) is moot.
    })
  }

  /** Everything queued has been started: the seam tests use, and a graceful shutdown needs. */
  idle(): Promise<void> { return this.tail }
}

const text = (e: unknown): string => e instanceof Error ? e.message : String(e)

const report = (state: string, summary: string, question?: string | null) => ({
  state: state as never, summary: summary.trim() || '(no summary)', ...(question === undefined ? {} : { question }),
})

type Filed = ReturnType<typeof report>
