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

function workerPrefix(rendered: string[]): string {
  for (const text of rendered) {
    const m = /session ([0-9a-f]{8})/i.exec(text)
    if (m?.[1]) return m[1]
  }
  return ''
}

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
  /** Delivery when this process holds no session: adopted workers, the operator's own asks. */
  inbox?: { write(prefix: string, body: string): void }
  slotPollMs?: number
  /** Every report the engine accepted, with who ended the run: the deployment tells the person. */
  reported?(ticket: Ticket, assignmentId: string, origin: ReportOrigin, report: Filed): void
}

interface Live {
  session: WorkerSession
  unsubscribe: () => void
  pendingRead: string[]
  startedAt: number
  lastEventAt: number
  events: number
  workspace: string
  quietReported: boolean
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
  watch: string
}

export class PiExecutor {
  private readonly live = new Map<string, Live>()
  private readonly queue: Array<() => void> = []
  private tail: Promise<void> = Promise.resolve()
  /** ticket/assignment launches queued and not yet live: the loop calls start() every pass while one waits. */
  private readonly launching = new Set<string>()

  constructor(private readonly engine: EngineForExecutor, private readonly launcher: WorkerLauncher,
              private readonly options: ExecutorOptions) {}

  get running(): number { return this.live.size }

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
    this.bind(ticket, assignment, own)
  }

  // Bound to the session that owns the ticket: a report from a worker the domain has already replaced or
  // stopped is not a ticket write.
  private reporter(ticket: Ticket, own: () => WorkerSession | undefined): Reporter {
    return (state, summary, question, origin = 'worker') => {
      const live = this.live.get(ticket.id)
      if (!live || live.session.sessionId !== own()?.sessionId) return
      this.file(ticket, live.assignmentId, origin, report(state, summary, question))
    }
  }

  private file(ticket: Ticket, assignmentId: string, origin: ReportOrigin, filed: Filed): void {
    this.engine.report(ticket.id, filed)
    this.options.reported?.(ticket, assignmentId, origin, filed)
  }

  private bind(ticket: Ticket, assignment: Assignment, session: WorkerSession): void {
    const born = Date.now()
    const live: Live = {
      session, unsubscribe: () => {}, pendingRead: [],
      startedAt: born, lastEventAt: born, events: 0, workspace: session.workspace ?? this.options.worktreeFor(ticket),
      quietReported: false, assignmentId: assignment.id,
    }
    live.unsubscribe = session.subscribe(event => {
      live.lastEventAt = Date.now()
      live.events += 1
      live.quietReported = false
      if (event.type === 'turnStarted') {
        const ids = live.pendingRead.splice(0)
        if (ids.length) this.engine.inputsRead(ticket.id, ids)
      } else if (event.type === 'failed') {
        this.file(ticket, assignment.id, 'crash', report('failed', `the worker crashed: ${event.error}`))
      }
    })
    this.live.set(ticket.id, live)
  }

  deliver(ticket: Ticket, assignment: Assignment): void {
    const live = this.live.get(ticket.id)
    const pending = ticket.inputs.filter(i => ticket.undelivered.includes(i.id))
    const visible = pending.map(i => ({ id: i.id, text: this.options.renderInput(i) })).filter(i => i.text)
    if (visible.length === 0) return
    if (!live) return this.deliverToInbox(ticket, assignment, visible)
    for (const input of visible) live.session.prompt(String(input.text), 'followUp')
    this.engine.inputsDelivered(ticket.id, assignment.id, visible.map(i => i.id))
    live.pendingRead.push(...visible.map(i => i.id))
  }

  /** An adopted worker runs in a session this process never opened, so the prompt goes to its inbox file
   *  and the per-session reader delivers it. No prefix, no channel: say so, do not drop the input. */
  private deliverToInbox(ticket: Ticket, assignment: Assignment,
                         visible: { id: string; text: string | undefined }[]): void {
    const prefix = workerPrefix(visible.map(i => String(i.text)))
    if (!this.options.inbox || !prefix) {
      this.engine.deliveryFailed(ticket.id, assignment.id, 'no live worker session for this ticket')
      return
    }
    for (const input of visible) this.options.inbox.write(prefix, String(input.text))
    this.engine.inputsDelivered(ticket.id, assignment.id, visible.map(i => i.id))
  }

  /** The router is going away, not the workers: stop listening without stopping them, so a reloaded router in
   *  this process takes them over and the old one stops acting on their reports. */
  detach(): void {
    for (const live of this.live.values()) live.unsubscribe()
    this.live.clear()
  }

  stop(ticket: Ticket, _assignment: Assignment, reason: string): void {
    const live = this.live.get(ticket.id)
    if (!live) return
    live.unsubscribe()
    this.live.delete(ticket.id)
    // The domain already ended the ticket before this call; the worker's job is to stop touching the box.
    live.session.abort()
    live.session.dispose()
    void reason
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
      watch: live.session.watch ?? '',
    }))
  }

  /** Workers that have gone quiet. Silence is not completion: the loop reports each quiet stretch once, so
   *  the ticket asks a person instead of reading as running forever. */
  quiet(minutes: number): WorkerView[] {
    // Once per silent stretch: the loop asks every pass, and the operator should be asked once.
    const due = this.workers().filter(w => w.quietSeconds >= minutes * 60 && !this.live.get(w.ticketId)?.quietReported)
    for (const w of due) this.live.get(w.ticketId)!.quietReported = true
    return due
  }

  // Launches are serialised behind each other: the cap bounds how many workers exist at once, and
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
