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
    // Insertion order is this store's own contract, read by the panel, which reverses it to show the newest
    // first — a silent flip shows up as a flipped panel. Upstream's MemoryRepositories returns newest-first;
    // the two disagree on purpose and nothing may read this order as "oldest ticket wins" (see store.ts).
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
    const store = repos()
    expect(() => store.atomic(async () => 1)).toThrow(/synchronous/)
    store.close()
  })

  it('survives a failed BEGIN with its transaction wrapper intact', () => {
    // BEGIN used to run after the depth increment and outside the try that decrements it, so one failed BEGIN
    // left depth above zero forever and every later atomic() ran with no transaction (audit 2026-11-11).
    const store = repos()
    const db = (store as unknown as { db: { exec(sql: string): void } }).db
    const exec = db.exec.bind(db)
    let failed = false
    db.exec = (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !failed) { failed = true; throw new Error('database is locked') }
      return exec(sql)
    }
    expect(() => store.atomic(() => { throw new Error('unreachable: BEGIN failed first') })).toThrow('database is locked')
    db.exec = exec
    // The next command opens a real transaction again: a body that throws rolls its write back.
    expect(() => store.atomic(() => { store.tickets.save(ticket('tk-rolled-back')); throw new Error('boom') })).toThrow('boom')
    expect(store.tickets.get('tk-rolled-back')).toBeUndefined()
    // And a body that succeeds commits.
    store.atomic(() => store.tickets.save(ticket('tk-committed')))
    expect(store.tickets.get('tk-committed')).toBeDefined()
    store.close()
  })

  it('waits on a busy database instead of failing at once', () => {
    // Without busy_timeout, the daily backup or an overlapping router holding the write lock turned every
    // command into an instant SQLITE_BUSY throw (audit 2026-11-11).
    const store = repos()
    const row = (store as unknown as { db: { prepare(sql: string): { get(): unknown } } }).db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(row.timeout).toBeGreaterThan(0)
    store.close()
  })
})

describe('the ticket working set', () => {
  it('forgets tickets that ended long ago and keeps open and recent ones', () => {
    // Measured live: 81 of 89 ticket rows were closed, and tickets.open() parsed every one of them per call.
    const store = repos()
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString()
    const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString()
    store.atomic(() => {
      store.tickets.save(ticket('tk-old', { ended: { at: old, by: 'host', outcome: 'completed' } }))
      store.tickets.save(ticket('tk-fresh', { ended: { at: fresh, by: 'host', outcome: 'completed' } }))
      store.tickets.save(ticket('tk-open'))
    })
    expect(store.pruneClosedTickets(new Date(Date.now() - 90 * 86_400_000).toISOString())).toBe(1)
    expect(store.tickets.list().map(t => t.id)).toEqual(['tk-fresh', 'tk-open'])
    expect(store.tickets.open().map(t => t.id)).toEqual(['tk-open'])
    store.close()
  })

  it('never prunes a ticket that still holds undelivered input', () => {
    // The ticket row is the message's only owner: pruned with it, a person's waiting words sit in no queue at
    // all (audit 2026-11-11). The row is the working set; the message is not.
    const store = repos()
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString()
    store.atomic(() => {
      store.tickets.save(ticket('tk-empty', { ended: { at: old, by: 'host', outcome: 'completed' } }))
      store.tickets.save(ticket('tk-mail', { ended: { at: old, by: 'host', outcome: 'completed' }, undelivered: ['i1'],
        inputs: [{ id: 'i1', kind: 'trigger', triggerId: 't9', at: old }] }))
    })
    expect(store.pruneClosedTickets(new Date(Date.now() - 90 * 86_400_000).toISOString())).toBe(1)
    expect(store.tickets.list().map(t => t.id)).toEqual(['tk-mail'])
    store.close()
  })
})
