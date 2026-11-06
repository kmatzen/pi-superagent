import { describe, expect, it } from 'vitest'
import { PiExecutor, type WorkerEvent, type WorkerSession } from '../src/pi/executor.ts'
import type { Assignment, Ticket, TicketInput } from '../src/core/index.ts'

class FakeSession implements WorkerSession {
  prompts: Array<{ text: string; mode: string }> = []
  events: WorkerEvent[] = []
  aborted = 0
  disposed = 0
  report!: (state: string, summary: string, question?: string | null, origin?: 'worker' | 'silent') => void
  private listeners: Array<(e: WorkerEvent) => void> = []
  constructor(readonly sessionId: string) {}
  prompt(text: string, mode: 'steer' | 'followUp'): void { this.prompts.push({ text, mode }) }
  subscribe(l: (e: WorkerEvent) => void): () => void {
    this.listeners.push(l)
    return () => { this.listeners = this.listeners.filter(x => x !== l) }
  }
  emit(e: WorkerEvent): void { for (const l of this.listeners) l(e) }
  abort(): void { this.aborted++ }
  dispose(): void { this.disposed++ }
}

interface Call { fn: string; args: unknown[] }

function fixture(extra: { maxConcurrent?: number; slotPollMs?: number } = {}, fail: { launch?: string; report?: string } = {}) {
  const calls: Call[] = []
  const sessions: FakeSession[] = []
  const engine = {
    assignmentStarted: (t: string, a: string) => calls.push({ fn: 'assignmentStarted', args: [t, a] }),
    inputsDelivered: (t: string, a: string, ids: string[]) => calls.push({ fn: 'inputsDelivered', args: [t, a, ids] }),
    inputsRead: (t: string, ids: string[]) => calls.push({ fn: 'inputsRead', args: [t, ids] }),
    deliveryFailed: (t: string, a: string, e: string) => calls.push({ fn: 'deliveryFailed', args: [t, a, e] }),
    report: (t: string, r: unknown) => {
      if (fail.report === t) throw new Error('ticketEnded')
      calls.push({ fn: 'report', args: [t, r] })
    },
  }
  const executor = new PiExecutor(engine as never, {
    launch: ({ ticket, report }) => {
      if (fail.launch === ticket.id) throw new Error('prepare command failed')
      const s = new FakeSession(`s${sessions.length}`)
      s.report = report as never
      sessions.push(s)
      return s
    },
  }, {
    worktreeFor: () => '/wt',
    briefFor: t => `brief for ${t.id}`,
    renderInput: i => (i.kind === 'text' ? i.text : i.kind === 'trigger' ? `trigger:${i.triggerId}` : `[${i.kind}]`),
    reported: (t, a, origin, r) => calls.push({ fn: 'reported', args: [t.id, a, origin, r] }),
    ...extra,
  })
  const calls_of = (fn: string) => calls.filter(c => c.fn === fn)
  return { executor, calls, sessions, calls_of }
}

const input = (id: string, kind: 'text' | 'trigger', extra: Record<string, unknown> = {}): TicketInput =>
  ({ id, kind, ...(kind === 'text' ? { text: `input ${id}` } : { triggerId: id, at: '2026-09-23T00:00:00Z' }), ...extra }) as TicketInput

const ticket = (over: Partial<Ticket> = {}): Ticket =>
  ({ id: 'T1', undelivered: [], inputs: [], ...over } as unknown as Ticket)
const assignment = (id = 'A1'): Assignment => ({ id, ticketId: 'T1', state: 'pending' } as unknown as Assignment)

describe('PiExecutor', () => {
  it('names the running worker so the operator can find it, and counts its events', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    f.sessions[0]!.emit({ type: 'turnStarted' })
    const [w] = f.executor.workers()
    expect(w).toMatchObject({ ticketId: 'T1', sessionId: 's0', workspace: '/wt', events: 1 })
    expect(w!.quietSeconds).toBeLessThan(5)
  })

  it('at the cap a queued launch waits without starving the event loop, and starts when a slot frees', async () => {
    const f = fixture({ maxConcurrent: 1, slotPollMs: 5 })
    f.executor.start(ticket({ id: 'T1' }), assignment('A1'))
    await f.executor.idle()
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    // Never resolves if the wait spins on microtasks: that is the 100% CPU wedge.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.sessions).toHaveLength(1)
    f.executor.stop(ticket({ id: 'T1' }), assignment('A1'), 'done')
    await f.executor.idle()
    expect(f.sessions).toHaveLength(2)
  })

  it('a ticket is launched once, however often the loop asks while it waits or runs', async () => {
    const f = fixture({ maxConcurrent: 1, slotPollMs: 5 })
    f.executor.start(ticket({ id: 'T1' }), assignment('A1'))
    await f.executor.idle()
    for (let pass = 0; pass < 3; pass++) f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    f.executor.start(ticket({ id: 'T1' }), assignment('A1'))
    f.executor.stop(ticket({ id: 'T1' }), assignment('A1'), 'done')
    await f.executor.idle()
    expect(f.sessions.map(s => s.sessionId)).toEqual(['s0', 's1'])
  })

  it('a router that goes away lets go of its workers without stopping them', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    f.executor.detach()
    expect(f.executor.running).toBe(0)
    expect(f.sessions[0]!.aborted + f.sessions[0]!.disposed, 'the worker keeps running for the next router').toBe(0)
    f.sessions[0]!.emit({ type: 'failed', error: 'late' })
    expect(f.calls_of('report'), 'and this router no longer acts on it').toEqual([])
  })

  it('adopts a running worker without prompting its brief again', () => {
    const f = fixture()
    const session = new FakeSession('kept')
    f.executor.adopt(ticket(), assignment(), report => { session.report = report as never; return session })
    expect(f.executor.running).toBe(1)
    expect(session.prompts).toEqual([])
    session.report('ready', 'done after the restart')
    expect(f.calls_of('report')).toHaveLength(1)
  })

  it('a busy worker is not quiet, and a quiet stretch is reported once', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    expect(f.executor.quiet(0).map(w => w.sessionId)).toEqual(['s0'])
    expect(f.executor.quiet(0), 'the loop asks every pass; the operator is asked once').toEqual([])
    f.sessions[0]!.emit({ type: 'activity' })
    expect(f.executor.workers()[0]!.events).toBe(1)
    expect(f.executor.quiet(1), 'a tool call a moment ago is a working worker').toEqual([])
    expect(f.executor.quiet(0).map(w => w.sessionId), 'activity ends the stretch; the next one is reported').toEqual(['s0'])
  })

  it('a worker with no events at all is quiet, which is a state the ticket can see', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    expect(f.executor.quiet(0).map(w => w.sessionId)).toEqual(['s0'])
    expect(f.executor.quiet(60)).toEqual([])
  })

  it('starts a session, announces it, and prompts the brief', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    expect(f.calls_of('assignmentStarted')).toEqual([{ fn: 'assignmentStarted', args: ['T1', 'A1'] }])
    expect(f.sessions[0]!.prompts.map(p => p.text)).toEqual(['brief for T1'])
  })

  it('delivers visible inputs and marks them read when a turn takes them', async () => {
    const f = fixture()
    const t = ticket({ inputs: [input('i1', 'text'), input('i2', 'trigger', { context: true })], undelivered: ['i1', 'i2'] })
    f.executor.start(t, assignment())
    await f.executor.idle()
    f.executor.deliver(t, assignment())
    expect(f.sessions[0]!.prompts.slice(1).map(p => p.text)).toEqual(['input i1', 'trigger:i2'])
    expect(f.calls_of('inputsDelivered')[0]!.args).toEqual(['T1', 'A1', ['i1', 'i2']])
    expect(f.calls_of('inputsRead')).toEqual([])
    f.sessions[0]!.emit({ type: 'turnStarted' })
    expect(f.calls_of('inputsRead')[0]!.args).toEqual(['T1', ['i1', 'i2']])
  })

  it('fails a delivery with no live session, in the engine, not in a log line', () => {
    const f = fixture()
    f.executor.deliver(ticket({ inputs: [input('i1', 'text')], undelivered: ['i1'] }), assignment())
    expect(f.calls_of('deliveryFailed').length).toBe(1)
  })

  it('writes the worker report through the engine, with the question attached', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    f.sessions[0]!.report('blocked', 'needs the merge window', 'Ship tonight on the green build?')
    expect(f.calls_of('report')[0]!.args).toEqual(['T1', { state: 'blocked', summary: 'needs the merge window', question: 'Ship tonight on the green build?' }])
  })

  it('drops a late report from a session that outlived its assignment', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    const s = f.sessions[0]!
    f.executor.stop(ticket(), assignment(), 'ticket ended')
    s.report('ready', 'finished after the ticket closed')
    expect(f.calls_of('report')).toEqual([])
    expect([s.aborted, s.disposed]).toEqual([1, 1])
  })

  it('tells the deployment who ended each run: the worker, a run with no report, a crash, a failed launch', async () => {
    const f = fixture({}, { launch: 'T2' })
    f.executor.start(ticket(), assignment())
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    await f.executor.idle()
    const s = f.sessions[0]!
    s.report('blocked', 'needs the merge window', 'Ship tonight?')
    s.report('failed', 'the worker finished its run without calling ticket_report', null, 'silent')
    s.emit({ type: 'failed', error: 'its pi left' })
    expect(f.calls_of('reported').map(c => c.args.slice(0, 3))).toEqual([
      ['T2', 'A2', 'launch'], ['T1', 'A1', 'worker'], ['T1', 'A1', 'silent'], ['T1', 'A1', 'crash'],
    ])
    expect(f.calls_of('reported')[0]!.args[3]).toMatchObject({ state: 'failed', summary: /could not start a worker: prepare command failed/ })
  })

  it('a failed launch on a ticket that ended meanwhile does not stall every launch after it', async () => {
    const f = fixture({}, { launch: 'T1', report: 'T1' })
    f.executor.start(ticket(), assignment())
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    await f.executor.idle()
    expect(f.sessions, 'T2 still gets its worker').toHaveLength(1)
    expect(f.calls_of('reported'), 'a report the engine refused is not announced').toEqual([])
  })

  it('a worker between runs frees its slot for the queue, and takes it back when a new run starts', async () => {
    const f = fixture({ maxConcurrent: 1, slotPollMs: 5 })
    f.executor.start(ticket(), assignment())
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    for (let i = 0; i < 100 && f.sessions.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5))
    f.sessions[0]!.emit({ type: 'settled' })
    await f.executor.idle()
    expect(f.sessions, 'the queued ticket got the parked worker\'s slot').toHaveLength(2)
    expect([f.executor.running, f.executor.parked]).toEqual([1, 1])
    expect(f.executor.workers().find(w => w.ticketId === 'T1')?.busy).toBe(false)
    f.sessions[0]!.emit({ type: 'turnStarted' })
    expect([f.executor.running, f.executor.parked], 'a follow-up puts it back on a run').toEqual([2, 0])
  })

  it('the quiet flag is for workers on a run: a parked worker is quiet by design', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    await f.executor.idle()
    f.sessions[0]!.emit({ type: 'settled' })
    expect(f.executor.quiet(0).map(w => w.ticketId)).toEqual(['T2'])
  })

  it('a crashed worker frees its slot at once, so a crash does not cost a worker until the next restart', async () => {
    const f = fixture({ maxConcurrent: 1, slotPollMs: 5 })
    f.executor.start(ticket(), assignment())
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    for (let i = 0; i < 100 && f.sessions.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5))
    f.sessions[0]!.emit({ type: 'failed', error: 'its pi left' })
    await f.executor.idle()
    expect(f.sessions, 'the queued ticket got the freed slot').toHaveLength(2)
    expect(f.executor.workers().map(w => w.ticketId)).toEqual(['T2'])
    expect(f.sessions[0]!.disposed).toBe(1)
  })

  it('reports a session that died mid-run', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    f.sessions[0]!.emit({ type: 'failed', error: 'provider 502' })
    expect(f.calls_of('report')[0]!.args[1]).toMatchObject({ state: 'failed', summary: /provider 502/ })
  })
})
