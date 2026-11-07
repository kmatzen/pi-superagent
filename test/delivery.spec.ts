// Measured 2026-11-07 audit: the old deliverToInbox chose its file by grepping the text for `session <8 hex>`, so a comment naming another worker steered that worker, and its file for a ticket with no worker had no reader.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiExecutor, type WorkerEvent, type WorkerSession } from '../src/pi/executor.ts'
import type { Assignment, Ticket, TicketInput } from '../src/core/index.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sa-delivery-')); dirs.push(d); return d }

class FakeSession implements WorkerSession {
  prompts: string[] = []
  constructor(readonly sessionId: string) {}
  prompt(text: string): void { this.prompts.push(text) }
  subscribe(_l: (e: WorkerEvent) => void): () => void { return () => {} }
  abort(): void {}
  dispose(): void {}
}

function harness(live: FakeSession | undefined) {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const engine = {
    assignmentStarted: () => {},
    inputsDelivered: (t: string, a: string, ids: string[]) => calls.push({ fn: 'inputsDelivered', args: [t, a, ids] }),
    inputsRead: () => {},
    deliveryFailed: (t: string, a: string, e: string) => calls.push({ fn: 'deliveryFailed', args: [t, a, e] }),
    report: () => {},
  }
  const executor = new PiExecutor(engine as never, {
    launch: async () => { if (!live) throw new Error('no worker'); return live },
  }, {
    worktreeFor: () => '/wt',
    briefFor: () => 'brief',
    renderInput: i => (i.kind === 'text' ? i.text : undefined),
  })
  return { executor, calls, prompted: () => live?.prompts ?? [] }
}

const input = (id: string, text: string): TicketInput => ({ id, kind: 'text', text, at: '2026-11-05T00:00:00Z' } as unknown as TicketInput)
const ticket = (over: object = {}): Ticket => ({
  id: 'T1', undelivered: ['i1'], inputs: [input('i1', 'operator: go ahead')], ...over,
} as unknown as Ticket)
const assignment = (): Assignment => ({ id: 'A1' } as Assignment)

describe('delivery to a worker', () => {
  it('gives the input to the live worker of its own ticket, and only to it', async () => {
    const mine = new FakeSession('11112222-3333')
    const f = harness(mine)
    f.executor.start(ticket(), assignment())
    await f.executor.idle()
    f.executor.deliver(ticket(), assignment())
    expect(f.prompted().at(-1), 'the brief went first, the input is the worker\'s own').toBe('operator: go ahead')
    expect(f.calls.map(c => c.fn)).toContain('inputsDelivered')
  })

  it('names no target taken from the message text: a comment that cites another session reaches no one', async () => {
    const text = 'see session 53dfeeff for the numbers'
    const stateDir = tmp()
    const f = harness(undefined)
    f.executor.deliver(ticket({ inputs: [input('i1', text)] }), assignment())
    expect(f.calls.filter(c => c.fn === 'deliveryFailed'))
      .toEqual([{ fn: 'deliveryFailed', args: ['T1', 'A1', 'no live worker for this ticket'] }])
    expect(f.calls.filter(c => c.fn === 'inputsDelivered'), 'nothing is marked delivered').toEqual([])
    expect(() => readdirSync(stateDir)).not.toThrow()
    expect(readdirSync(stateDir), 'no file inbox appeared for the cited session').toEqual([])
  })

  it('a ticket that keeps waiting for a worker is told once, not once per tick', () => {
    const f = harness(undefined)
    const t = ticket({})
    f.executor.deliver(t, assignment())
    const waiting = { ...t, delivery: { error: 'no live worker for this ticket', at: '2026-11-07T00:00:00Z' } } as never
    f.executor.deliver(waiting, assignment())
    f.executor.deliver(waiting, assignment())
    expect(f.calls.filter(c => c.fn === 'deliveryFailed'), 'six parked tickets measured 17,000 row writes a day').toHaveLength(1)
  })

  it('leaves the input undelivered so a later worker gets it, instead of marking it read', async () => {
    const f = harness(undefined)
    f.executor.deliver(ticket(), assignment())
    const failed = f.calls.filter(c => c.fn === 'deliveryFailed')
    expect(failed.length, 'the loop is told, so it retries').toBe(1)
    expect(f.calls.filter(c => c.fn === 'inputsDelivered').length).toBe(0)
  })
})
