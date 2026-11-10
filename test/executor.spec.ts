import { describe, expect, it } from 'vitest'
import { PiExecutor, type WorkerEvent, type WorkerSession } from '../src/pi/executor.ts'
import type { Reporter } from '../src/pi/report-tool.ts'
import type { Assignment, Ticket, TicketInput } from '../src/core/index.ts'

class FakeSession implements WorkerSession {
  prompts: Array<{ text: string; mode: string }> = []
  events: WorkerEvent[] = []
  aborted = 0
  disposed = 0
  report!: Reporter
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

function fixture(extra: { maxConcurrent?: number; slotPollMs?: number; follow?: (t: Ticket, urls: readonly string[]) => readonly string[];
                          reportDropped?: (fields: Record<string, unknown>) => void } = {},
                 fail: { launch?: string; report?: string } = {}) {
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
    reportDropped: fields => calls.push({ fn: 'reportDropped', args: [fields] }),
    ...extra,
    ...extra.follow ? { follow: (t: Ticket, urls: readonly string[]) => { calls.push({ fn: 'follow', args: [t.id, urls] }); return extra.follow!(t, urls) } } : {},
  })
  const calls_of = (fn: string) => calls.filter(c => c.fn === fn)
  return { executor, calls, sessions, calls_of }
}

/** A ticket whose end carries `outcome`, as the domain writes it just before it stops the worker. */
const ended = (outcome: string, base: Ticket = ticket()): Ticket =>
  ({ ...base, ended: { at: 'now', by: 'executor', outcome } } as Ticket)

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

  it('a delayed stop for a crashed assignment leaves its replacement running', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment('replacement'))
    await f.executor.idle()
    f.executor.stop(ticket(), assignment('crashed'), 'retried')
    expect(f.executor.running).toBe(1)
    expect(f.sessions[0]!.aborted).toBe(0)
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
    expect(session.prompts).toEqual([])
    session.report('ready', 'done after the restart')
    expect(f.calls_of('report')).toHaveLength(1)
  })

  it('an adopted worker sits idle until it speaks, so an idle pane costs no worker slot', () => {
    const f = fixture({ maxConcurrent: 1 })
    const session = new FakeSession('kept')
    f.executor.adopt(ticket(), assignment(), report => { session.report = report as never; return session })
    expect(f.executor.running, 'the pane waits at its prompt: the router restarted mid-nothing').toBe(0)
    expect(f.executor.quiet(0), 'and a silent idle pane is not a worker the operator must be asked about').toEqual([])
    session.emit({ type: 'activity' })
    expect(f.executor.running, 'a pane that speaks has a run in flight, turnStarted or not').toBe(1)
    session.emit({ type: 'settled' })
    expect(f.executor.running).toBe(0)
  })

  it('input to an idle worker enters at once, and input to a running worker waits its turn', () => {
    const f = fixture()
    const session = new FakeSession('kept')
    f.executor.adopt(ticket(), assignment(), report => { session.report = report as never; return session })
    f.executor.deliver(ticket({ inputs: [input('i1', 'text')], undelivered: ['i1'] }), assignment())
    expect(session.prompts, 'an idle session queues a mode-tagged message and never starts it').toEqual([{ text: 'input i1', mode: 'steer' }])
    session.emit({ type: 'activity' })
    f.executor.deliver(ticket({ inputs: [input('i2', 'text')], undelivered: ['i2'] }), assignment())
    expect(session.prompts.at(-1), 'a running worker must not be interrupted mid-step').toEqual({ text: 'input i2', mode: 'followUp' })
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

  it('a worker past its deadline is asked about once, and a settled worker is never late', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    expect(f.executor.overdue(6), 'six hours have not passed').toEqual([])
    expect(f.executor.overdue(0).map(w => w.sessionId)).toEqual(['s0'])
    expect(f.executor.overdue(0), 'the deadline asks the operator once, not on every tick').toEqual([])
    f.sessions[0]!.emit({ type: 'settled' })
    expect(f.executor.overdue(0), 'a parked worker is idle by design, not overdue').toEqual([])
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
    const batch = f.sessions[0]!.prompts.slice(1).map(p => p.text)
    // One message for the batch: pi steers the session with the first prompt and queues the rest, so a review
    // that arrived as several comments got answered one comment at a time with the rest invisible.
    expect(batch.length, 'the batch arrives as one message').toBe(1)
    expect(batch[0]).toContain('input i1')
    expect(batch[0]).toContain('trigger:i2')
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

  it('binds the pull requests a report names before the engine reads it, and tells the receipt which it follows', async () => {
    const f = fixture({ follow: (_t, urls) => urls.filter(u => u.includes('/pull/')) })
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    const before = f.calls.length
    f.sessions[0]!.report('ready', 'opened the fix', null, 'worker', ['https://github.com/o/r/pull/9', '#9'])
    expect(f.calls.slice(before).map(c => c.fn), 'bound first: a ready report on an unbound ticket completes it').toEqual(['follow', 'report', 'reported'])
    expect(f.calls_of('follow')[0]!.args).toEqual(['T1', ['https://github.com/o/r/pull/9', '#9']])
    expect(f.calls_of('report')[0]!.args[1]).toEqual({ state: 'ready', summary: 'opened the fix', question: null })
    expect(f.calls_of('reported')[0]!.args[3]).toMatchObject({ pullRequests: ['https://github.com/o/r/pull/9'] })
  })

  it('drops a late report from a session that outlived its assignment', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    const s = f.sessions[0]!
    f.executor.stop(ended('stopped'), assignment(), 'a person stopped it')
    s.report('ready', 'finished after the ticket closed')
    expect(f.calls_of('report')).toEqual([])
    expect([s.aborted, s.disposed]).toEqual([1, 1])
  })

  it('a ticket that ended because its worker finished does not cut that worker off mid-sentence', async () => {
    // Escape is a cancellation: pi aborts the run and puts anything queued for it back in the human's input box.
    // A worker that just reported ready is finishing its own turn, and the messages waiting for it are its next work.
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    const done = ticket({ assignments: [{ id: 'A1', report: { state: 'ready', summary: 'merged the fix', at: 'now' } } as unknown as Assignment] })
    f.executor.stop(done, done.assignments[0]!, 'ready')
    expect(f.sessions[0]!.aborted, 'no Escape: the run ends by itself').toBe(0)
    expect(f.sessions[0]!.disposed, 'its session is still released').toBe(1)
  })

  it('a pull request merging does not cut off a worker whose report call is still in flight', async () => {
    // Measured 2026-11-07T02:33:07Z: a watched pull request merged, ending the ticket, and the
    // Escape that stop() sent killed the worker's ticket_report mid-call, so its result never landed.
    // A merged pull request is finished work, the same class as a ready report, and the report call in
    // flight has not been recorded yet, so the ready report alone cannot prove it.
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    expect(f.sessions[0]!.aborted, 'no Escape: the work merged, so nothing is being cancelled').toBe(0)
    f.executor.stop(ended('merged'), assignment(), 'pull request merged')
    expect(f.sessions[0]!.aborted).toBe(0)
    expect(f.sessions[0]!.disposed, 'its session is still released').toBe(1)
  })

  it('a ticket dropped with nothing to do does not cut off a worker mid-turn', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    f.executor.stop(ended('dropped'), assignment(), 'no work requested')
    expect(f.sessions[0]!.aborted).toBe(0)
  })

  it('a ticket cancelled while its worker works does cut that worker off', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    const running = ticket({ assignments: [{ id: 'A1', report: { state: 'progress', summary: 'halfway', at: 'now' } } as unknown as Assignment] })
    f.executor.stop(ended('stopped', running), running.assignments[0]!, 'a person stopped it')
    expect(f.sessions[0]!.aborted).toBe(1)
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

  it('a report landing after its worker was freed is said out loud, not swallowed', async () => {
    // Measured 2026-11-09 on matzen_adobe/superagent-board-spike#255: its worker reported at 08:59:23Z, the ticket
    // released the worker, a queued copy of the same mandate surfaced in the still-open tab at ~09:01Z, and the
    // worker's second `ticket_report` answered `reported` while the issue gained no comment. Three later runs of
    // that ticket re-proved a two-day-old merge starting from that receipt. Silence is what cost the sessions.
    const f = fixture()
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    const s = f.sessions[0]!
    expect(s.report('ready', 'the merge landed')).toBe('recorded')
    f.executor.release(ticket())
    expect(s.report('ready', 'the merge landed, again'), 'the pane is told the truth').toBe('dropped')
    expect(f.calls_of('report').length, 'the second report filed nothing').toBe(1)
    expect(f.calls_of('reportDropped').map(c => c.args[0])).toEqual([
      { ticket: 'T1', origin: 'worker', state: 'ready', reason: 'the ticket has no live worker', summary: 'the merge landed, again' },
    ])
  })

  it('a report from a worker the domain replaced is said out loud', async () => {
    const f = fixture()
    f.executor.start(ticket(), assignment('A1'))
    f.executor.start(ticket(), assignment('A2'))
    await f.executor.idle()
    expect(f.sessions).toHaveLength(2)
    expect(f.sessions[0]!.report('ready', 'my run is the one it replaced')).toBe('dropped')
    expect(f.calls_of('reportDropped')[0]!.args[0]).toMatchObject({ ticket: 'T1', assignment: 'A2', reason: 'its worker was replaced' })
    expect(f.calls_of('report'), 'a replaced worker files no ticket write').toEqual([])
  })

  it('a report the engine refuses is said out loud, and still throws', async () => {
    const f = fixture({}, { report: 'T1' })
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    expect(() => f.sessions[0]!.report('ready', 'done')).toThrow('ticketEnded')
    expect(f.calls_of('reportDropped')[0]!.args[0])
      .toMatchObject({ ticket: 'T1', assignment: 'A1', origin: 'worker', reason: 'the engine refused it: ticketEnded' })
    expect(f.calls_of('reported'), 'a refused report announces nothing').toEqual([])
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

// A production tick that awaits `idle()` awaits the worker slots with it. Measured live 2026-11-09 (#303): the
// router entered 7 ticks in 6.6 h against a 30 s timer, because its last await was this queue and the fleet was
// at its cap. `drain` is the seam that takes the launches without the capacity wait, and says which it got.
describe('draining the launch queue', () => {
  it('returns when its budget is spent, naming the launches still waiting for a slot', async () => {
    const f = fixture({ maxConcurrent: 1, slotPollMs: 5 })
    f.executor.start(ticket({ id: 'T1' }), assignment('A1'))
    expect(await f.executor.drain(50)).toEqual({ settled: true, pending: 0 })
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    expect(f.executor.pendingLaunches, 'the second launch is waiting for the slot T1 holds').toBe(1)
    const began = Date.now()
    expect(await f.executor.drain(30)).toEqual({ settled: false, pending: 1 })
    expect(Date.now() - began, 'the budget is the ceiling, not the slot').toBeLessThan(1_000)
    expect(f.sessions, 'and the launch is queued, not dropped').toHaveLength(1)
    f.executor.stop(ticket({ id: 'T1' }), assignment('A1'), 'done')
    expect(await f.executor.drain(500)).toEqual({ settled: true, pending: 0 })
    expect(f.sessions).toHaveLength(2)
  })

  it('answers at once when the gate is closed: a queue is not a place to wait for a slot', async () => {
    // Measured on the deployed router 2026-11-09, the day after #303 shipped: `drainMs=5001` on 66 of 66 ticks
    // — 47% of all tick time, 5 s of every 30 s — against `running=8 cap=8`. The bounded wait had become the
    // steady cost of a fleet at its cap, and the shape that made the loop enterable hourly in #303 is a
    // tick that outgrows the interval, so the residue of it is the same bug on a shorter leash.
    const f = fixture({ maxConcurrent: 1, slotPollMs: 5 })
    f.executor.start(ticket({ id: 'T1' }), assignment('A1'))
    expect(await f.executor.drain(500)).toEqual({ settled: true, pending: 0 })
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    const began = Date.now()
    expect(await f.executor.drain(5_000)).toEqual({ settled: false, pending: 1 })
    expect(Date.now() - began, 'no capacity: the answer is immediate, not the budget').toBeLessThan(250)
    expect(f.executor.pendingLaunches, 'the launch is still queued, and counted').toBe(1)
  })

  it('starts the launch it gave up on: the gate opens on its own timer, with nobody waiting', async () => {
    // The reason the early answer costs nothing: the launch is already enqueued and the gate re-reads capacity
    // on `slotPollMs`, so a caller that stops watching starts no launch later. A slot frees, T2 runs.
    const f = fixture({ maxConcurrent: 1, slotPollMs: 5 })
    f.executor.start(ticket({ id: 'T1' }), assignment('A1'))
    expect(await f.executor.drain(500)).toEqual({ settled: true, pending: 0 })
    f.executor.start(ticket({ id: 'T2' }), assignment('A2'))
    expect(await f.executor.drain(5_000)).toMatchObject({ settled: false, pending: 1 })
    f.executor.stop(ticket({ id: 'T1' }), assignment('A1'), 'done')
    for (let i = 0; i < 200 && f.executor.pendingLaunches > 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(f.executor.pendingLaunches, 'the queue drained itself').toBe(0)
    expect(f.sessions.map(s => s.sessionId), 'the launch abandoned by the drain ran anyway').toEqual(['s0', 's1'])
  })

  it('a launch that throws still leaves the queue drained, not parked', async () => {
    const f = fixture({}, { launch: 'T1' })
    f.executor.start(ticket(), assignment())
    expect(await f.executor.drain(500)).toEqual({ settled: true, pending: 0 })
    expect(f.calls_of('reported')[0]!.args[3], 'the failure is filed as a launch report').toMatchObject({ state: 'failed' })
  })

  it('counts every launch exactly once, so a queue with a failure in it reads its true size', async () => {
    // The count is what the tick reports as `launchPending`, and what its drain waits on: a launch counted
    // twice on the way out would tell the pass the queue was empty while a ticket still waited on a slot.
    const f = fixture({ maxConcurrent: 2 }, { launch: 'T2' })
    for (const id of ['T1', 'T2', 'T3']) f.executor.start(ticket({ id }), assignment(`A${id}`))
    expect(await f.executor.drain(500)).toEqual({ settled: true, pending: 0 })
    expect(f.sessions.map(s => s.sessionId), 'the failure does not stop the launch behind it').toEqual(['s0', 's1'])
    expect(f.calls_of('reported').map(c => (c.args[3] as { state: string }).state), 'one failure filed').toEqual(['failed'])
  })
})
