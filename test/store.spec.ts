import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteRepositories } from '../src/pi/store.ts'

const dirs: string[] = []
const repos = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-store-')); dirs.push(dir)
  return new SqliteRepositories(join(dir, 'tickets.db'))
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const ticket = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, mandate: 'do it', goal: null, owner: 'octocat', channels: [], mandateVersion: 1, revision: 0,
  phase: 'executing', plan: null, planRev: 1, planDecisions: [], children: [], graphVersion: 1, evidence: [],
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ended: false, budget: { tokens: 100 },
  spend: { tokens: 0 }, attention: null, answers: [], inputs: [], undelivered: [], assignments: [], ...over,
}) as never

describe('the ticket store', () => {
  it('lists tickets in the order they were written, newest first where the caller asks for it', () => {
    // The memory store serves insertion order, and a test written against it must pass unchanged on SQLite:
    // the panel's ended list reverses this to show the newest first, so a silent flip shows up as a flipped panel.
    const r = repos()
    for (const id of ['t1', 't2', 't3']) r.tickets.save(ticket(id))
    expect(r.tickets.list().map(t => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('calls a ticket open for both shapes of an open ticket', () => {
    const r = repos()
    r.tickets.save(ticket('absent-key', { ended: undefined }))
    r.tickets.save(ticket('explicit-false', { ended: false }))
    r.tickets.save(ticket('done', { ended: { at: '2026-11-02T00:00:00Z', by: 'worker', outcome: 'completed' } }))
    expect(r.tickets.open().map(t => t.id), 'ended: false is open, and so is no ended key at all').toEqual(['absent-key', 'explicit-false'])
  })

  it('finds a thread with something waiting, and a ticket with something to do, without reading every row', () => {
    const r = repos()
    r.threads.save({ key: 'idle', channel: { source: 'github', thread: '#1', address: { issue: 1 } }, inputs: [], pending: [], asked: null, history: [], context: [], createdAt: 'x', updatedAt: 'x' } as never)
    r.threads.save({ key: 'waiting', channel: { source: 'github', thread: '#2', address: { issue: 2 } }, inputs: [], pending: [{ id: 'p1' }], asked: null, history: [], context: [], createdAt: 'x', updatedAt: 'x' } as never)
    expect(r.threads.active().map(t => t.key)).toEqual(['waiting'])
    r.tickets.save(ticket('quiet'))
    r.tickets.save(ticket('queued', { undelivered: ['i1'] }))
    r.tickets.save(ticket('working', { assignments: [{ id: 'a1', state: 'running' }] }))
    r.tickets.save(ticket('finished', { assignments: [{ id: 'a2', state: 'ended' }] }))
    expect(r.tickets.active().map(t => t.id).sort()).toEqual(['queued', 'working'])
  })
})

describe('the transaction wrapper', () => {
  it('refuses an async body, because the commit would land before its writes', () => {
    // `work: () => T` infers T = Promise for an async body, so the call compiles and commits an empty
    // transaction: every write inside it lands outside the atomic block, and a crash rolls back nothing.
    const dir = mkdtempSync(join(tmpdir(), 'sa-atomic-'))
    const store = new SqliteRepositories(join(dir, 't.db'))
    try {
      expect(() => store.atomic(async () => 1)).toThrow(/synchronous/)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
