import { describe, expect, it } from 'vitest'
import { PullFollower, wakeOnChecks, type CheckReason, type CheckWakePorts, type ChecksState, type PullApi, type PullRef, type PullState } from '../src/pi/pulls.ts'
import type { Ticket } from '../src/core/index.ts'

// agent-inbox#667: a waiting ticket is called back by the checks it waits for, not by a timer.
const PULL: PullRef = { repo: 'o/r', number: 7 }
const THREAD = 'github:#7'
const at = (h: string) => `2026-11-20T${h}:00.000Z`

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'ask', decisionId: 'd',
  mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'addressed', addressed: 'direct' },
    actor: { source: 'github', id: 'octocat' }, scope: '#7' },
  channels: [{ source: 'github', thread: '#7', address: { repo: 'o/r', issue: '7' } }],
  assignments: [], inputs: [], undelivered: [],
  follows: [{ thread: THREAD, own: true }], createdAt: at('00:00'), updatedAt: at('00:00'),
  origin: { triggerId: 'x', triggerIds: [] }, ...over,
})

function fixture(state: Partial<PullState> = {}, checks: ChecksState = 'pending') {
  const kv = new Map<string, unknown>()
  const positions = { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k: string, v: unknown) => { kv.set(k, v) } }
  const current: PullState = { open: true, merged: false, createdAt: at('00:00'), headSha: 'sha1', ...state }
  const rollup = { state: checks, calls: 0 }
  const api: PullApi = {
    pull: async () => current,
    comments: async () => [],
    reviews: async () => [],
    checks: async () => { rollup.calls += 1; return rollup.state },
  }
  const wakes: Record<string, { at: string }> = {}
  const fired: Record<string, string> = {}
  const recruited: Array<{ ticket: string; reason: CheckReason; scheduledAt: string }> = []
  const logged: Array<{ ticket: string; reason: CheckReason }> = []
  const ports: CheckWakePorts = {
    scheduled: id => wakes[id]?.at,
    spend: id => { delete wakes[id] },
    fired: (id, sha, reason) => Boolean(fired[`${id}:${sha}:${reason}`]),
    mark: (id, sha, reason) => { fired[`${id}:${sha}:${reason}`] = 'marked' },
    recruit: (t, _pull, _checks, reason, scheduledAt) => { recruited.push({ ticket: t.id, reason, scheduledAt }) },
    log: (t, reason) => { logged.push({ ticket: t, reason }) },
  }
  const tickets: Ticket[] = [ticket()]
  const follower = new PullFollower({
    home: 'o/r', api, openThreads: () => new Set(), positions, self: 'bot', everyMs: 0,
    receive: () => {},
    warn: () => {},
    reopened: () => 0,
    closed: () => {},
    checksSettled: (thread, _pull, settled, pullState) => { wakeOnChecks(tickets, thread, PULL, settled, pullState, ports) },
  })
  return { current, rollup, wakes, recruited, logged, ports, follower, tickets, waiting: (when = at('05:00')) => { wakes.t1 = { at: when } } }
}

describe('event wake on pull checks', () => {
  it('a waiting ticket is recruited once, in the pass its followed pull request goes from pending to failed', async () => {
    const f = fixture()
    f.waiting()
    await f.follower.reconcile(f.tickets)
    expect(f.recruited).toEqual([])
    expect(f.wakes.t1?.at).toBe(at('05:00'))
    f.rollup.state = 'failed'
    await f.follower.reconcile(f.tickets)
    expect(f.recruited).toEqual([{ ticket: 't1', reason: 'checks_failed', scheduledAt: at('05:00') }])
    expect(f.logged).toEqual([{ ticket: 't1', reason: 'checks_failed' }])
    expect(f.wakes.t1).toBeUndefined()
    await f.follower.reconcile(f.tickets)
    expect(f.recruited).toHaveLength(1)
  })

  it('green with auto-merge armed recruits nobody and leaves the ticket to its merge', async () => {
    const f = fixture({ autoMergeArmed: true })
    f.waiting()
    await f.follower.reconcile(f.tickets)
    f.rollup.state = 'passed'
    await f.follower.reconcile(f.tickets)
    expect(f.recruited).toEqual([])
    expect(f.logged).toEqual([])
    expect(f.wakes.t1?.at).toBe(at('05:00'))
  })

  it('green with no auto-merge wakes it, because a person has to merge', async () => {
    const f = fixture()
    f.waiting()
    await f.follower.reconcile(f.tickets)
    f.rollup.state = 'passed'
    await f.follower.reconcile(f.tickets)
    expect(f.recruited.map(r => r.reason)).toEqual(['checks_passed'])
  })

  it('a ticket that asked for no check gets no session from a red build', async () => {
    const f = fixture()
    await f.follower.reconcile(f.tickets)
    f.rollup.state = 'failed'
    await f.follower.reconcile(f.tickets)
    expect(f.recruited).toEqual([])
  })

  it('a finished head is asked once: the check read follows the CI that runs, not the number of follows', async () => {
    const f = fixture()
    f.waiting()
    f.rollup.state = 'failed'
    await f.follower.reconcile(f.tickets)
    const calls = f.rollup.calls
    await f.follower.reconcile(f.tickets)
    await f.follower.reconcile(f.tickets)
    expect(f.rollup.calls).toBe(calls)
    expect(f.recruited).toHaveLength(1)
  })

  it('a head that is pushed replaces the finished one, and its checks are read again', async () => {
    const f = fixture()
    f.waiting()
    f.rollup.state = 'failed'
    await f.follower.reconcile(f.tickets)
    f.current.headSha = 'sha2'
    f.rollup.state = 'pending'
    f.waiting(at('06:00'))
    await f.follower.reconcile(f.tickets)
    expect(f.recruited).toHaveLength(1)
    f.rollup.state = 'passed'
    await f.follower.reconcile(f.tickets)
    expect(f.recruited.map(r => r.reason)).toEqual(['checks_failed', 'checks_passed'])
  })

  it('a commit with no checks at all is an outcome that never arrives, so the timer stands', async () => {
    const f = fixture()
    f.waiting()
    f.rollup.state = 'none'
    await f.follower.reconcile(f.tickets)
    expect(f.recruited).toEqual([])
    expect(f.wakes.t1?.at).toBe(at('05:00'))
  })
})
