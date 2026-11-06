import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiExecutor } from '../src/pi/executor.ts'
import { SessionInbox } from '../src/pi/sink-session-inbox.ts'
import type { Assignment, Ticket, TicketInput } from '../src/core/index.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sa-inbox-')); dirs.push(d); return d }

const input = (id: string, text: string): TicketInput =>
  ({ id, kind: 'text', text, at: '2026-11-05T00:00:00Z' } as unknown as TicketInput)
const ticket = (over: object) => ({ id: 'T1', undelivered: ['i1'], inputs: [input('i1', 'operator: yolo it — session 01a1ac89 owns this card')], ...over } as unknown as Ticket)
const assignment = () => ({ id: 'A1', ticketId: 'T1' } as unknown as Assignment)

function fixture(inbox?: SessionInbox) {
  const calls: { fn: string; args: unknown[] }[] = []
  const engine = {
    deliveryFailed: (t: string, a: string, e: string) => calls.push({ fn: 'deliveryFailed', args: [t, a, e] }),
    inputsDelivered: (t: string, a: string, ids: string[]) => calls.push({ fn: 'inputsDelivered', args: [t, a, ids] }),
  }
  const executor = new PiExecutor(engine as never, { launch: () => { throw new Error('no session in this test') } }, {
    worktreeFor: () => '/tmp/wt',
    briefFor: () => 'brief',
    renderInput: (i) => (i as unknown as { text?: string }).text,
    ...(inbox ? { inbox } : {}),
  })
  return { calls, executor }
}

describe('SessionInbox', () => {
  it('writes one file per session and appends one block per message', () => {
    const dir = tmp()
    const inbox = new SessionInbox(dir)
    inbox.write('01a1ac89', 'first answer')
    inbox.write('01a1ac89', 'second answer')
    const raw = readFileSync(join(dir, '01a1ac89.md'), 'utf8')
    expect(raw.split('---').length - 1).toBe(2)
    expect(raw).toContain('first answer')
    expect(raw).toContain('second answer')
  })

  it('reads only what a session has not seen yet', () => {
    const dir = tmp()
    const inbox = new SessionInbox(dir)
    inbox.write('abcd1234', 'one')
    const first = inbox.read('abcd1234')
    inbox.write('abcd1234', 'two')
    const next = inbox.read('abcd1234', first.bytes)
    expect(next.body).toContain('two')
    expect(next.body).not.toContain('one')
  })

  it('refuses a prefix that is not a session id, rather than writing a file nobody reads', () => {
    const inbox = new SessionInbox(tmp())
    expect(() => inbox.write('../../etc/passwd', 'x')).toThrow(/not a hex id/)
  })

  it('returns nothing for a session with no mail', () => {
    expect(new SessionInbox(tmp()).read('ffffffff')).toEqual({ body: '', bytes: 0 })
  })
})

describe('PiExecutor delivery through the inbox', () => {
  it('delivers to an adopted worker it never spawned, and tells the engine it landed', () => {
    const dir = tmp()
    const { calls, executor } = fixture(new SessionInbox(dir))
    executor.deliver(ticket({}), assignment())
    expect(readFileSync(join(dir, '01a1ac89.md'), 'utf8')).toContain('yolo it')
    expect(calls.map(c => c.fn)).toEqual(['inputsDelivered'])
  })

  it('still fails the delivery in the engine when nothing identifies the session', () => {
    const { calls, executor } = fixture(new SessionInbox(tmp()))
    executor.deliver(ticket({ inputs: [input('i1', 'an answer with no owner stamp')], undelivered: ['i1'] }), assignment())
    expect(calls.map(c => c.fn)).toEqual(['deliveryFailed'])
  })

  it('keeps failing when no inbox is configured, so a delivery cannot be silently buffered', () => {
    const { calls, executor } = fixture()
    executor.deliver(ticket({}), assignment())
    expect(calls.map(c => c.fn)).toEqual(['deliveryFailed'])
  })

})

for (const d of dirs) rmSync(d, { recursive: true, force: true })
