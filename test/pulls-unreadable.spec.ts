import { describe, expect, it } from 'vitest'
import { PARK_AFTER_FAILURES, PullFollower, unreadableKey, type PullApi, type PullState } from '../src/pi/pulls.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

/**
 * inbox#883, live shape: 92 `pull.read_failed` WARNs in 24 h from 7 threads the account cannot read (404),
 * one per thread per router start, because the backoff lived in memory. Each spec runs on a store that survives a
 * restart, which is the whole difference, so `run` is a router start and every start in the finding is one spec.
 */
function harness(api: PullApi, limits: { cooldownMs?: number } = {}) {
  const kv = new Map<string, unknown>()
  const warns: Array<{ event: string, fields: Record<string, unknown> }> = []
  const reads: string[] = []
  const counted: PullApi = { ...api, pull: async (repo, n) => { reads.push(`${repo}#${n}`); return api.pull(repo, n) } }
  let clock = Date.now()
  const tickets = [
    { id: 'a', follows: [{ thread: 'github:other/r#14' }] },
    { id: 'b', follows: [{ thread: '#9' }] },
  ] as unknown as Ticket[]
  /** A router start is a fresh follower over the same store: memory gone, positions kept. */
  const start = (): PullFollower => new PullFollower({
    home: 'o/r', api: counted,
    openThreads: () => new Set<string>(),
    positions: {
      get: <T,>(k: string) => kv.get(k) as T | undefined,
      set: (k, v) => { kv.set(k, v) },
      delete: (k: string) => { kv.delete(k) },
    },
    self: 'agent-bot', closed: () => {}, reopened: () => 0, receive: (_t: Trigger) => {},
    warn: (event, fields) => { warns.push({ event, fields }) },
    now: () => clock, everyMs: INTERVAL, cooldownMs: limits.cooldownMs ?? COOLDOWN,
  })
  const run = async (passes: number, gapMs = INTERVAL): Promise<void> => {
    const follower = start()
    for (let i = 0; i < passes; i++) {
      clock += gapMs
      await follower.reconcile(tickets)
    }
  }
  const eventCount = (event: string): number => warns.filter(w => w.event === event).length
  return { kv, warns, reads, eventCount, run, unreadable: () => kv.get(unreadableKey('other/r#14')) }
}

const MIN = 60_000
const COOLDOWN = 30 * MIN
const INTERVAL = 2 * MIN
const open = (): PullState => ({ open: true, merged: false, createdAt: new Date().toISOString() })

const unreadable = (pull?: PullApi['pull']): PullApi => ({
  pull: async (repo, n) => {
    if (pull) return pull(repo, n)
    throw new Error(`HTTP 404 reading pull request ${repo}#${n}, and this account cannot read ${repo} either`)
  },
  comments: async () => [],
  reviews: async () => [],
})

describe('a pull request in a repository this account cannot read', () => {
  it('parks it after a streak of 404s, with one escalation, and stops reading it', async () => {
    const h = harness(unreadable())
    await h.run(PARK_AFTER_FAILURES)
    expect(h.eventCount('pull.read_failed'), 'the blip streak is complained about once').toBe(1)
    expect(h.eventCount('pull.thread_unreadable'), 'the park is announced once').toBe(1)
    expect(h.unreadable()).toMatchObject({ fails: PARK_AFTER_FAILURES, announced: true })

    const before = h.warns.length
    const readAt = h.reads.filter(r => r === 'other/r#14').length
    await h.run(10)
    expect(h.warns.length, 'a parked thread says nothing on a pass that does not read it').toBe(before)
    expect(h.reads.filter(r => r === 'other/r#14').length, 'and costs no GitHub read: it is out of the queue').toBe(readAt)
  })

  it('stays parked across a router start, which the in-memory backoff could not', async () => {
    const h = harness(unreadable())
    await h.run(PARK_AFTER_FAILURES)
    const warns = h.warns.length
    for (let i = 0; i < 5; i++) await h.run(1)
    expect(h.warns.length, 'the real box started 25 times in 35 h, and each start spoke again').toBe(warns)
    expect(h.unreadable()).toMatchObject({ fails: PARK_AFTER_FAILURES, announced: true })
  })

  it('probes a parked thread on the cooldown gap, silently, and re-parks it', async () => {
    const h = harness(unreadable())
    await h.run(PARK_AFTER_FAILURES)
    const readAt = h.reads.filter(r => r === 'other/r#14').length
    await h.run(1, COOLDOWN + MIN)
    expect(h.reads.filter(r => r === 'other/r#14').length, 'the probe is exactly one read').toBe(readAt + 1)
    expect(h.eventCount('pull.thread_unreadable'), 'the probe says nothing').toBe(1)
    expect(h.eventCount('pull.read_failed'), 'the probe is not a new blip').toBe(1)
    expect(h.unreadable()).toMatchObject({ fails: PARK_AFTER_FAILURES + 1, announced: true })
  })

  it('comes back the moment a read works, and says so once', async () => {
    let readable = false
    const h = harness(unreadable(async () => {
      if (!readable) throw new Error('HTTP 404 reading pull request other/r#14')
      return open()
    }))
    await h.run(PARK_AFTER_FAILURES)
    expect(h.eventCount('pull.thread_unreadable')).toBe(1)
    readable = true
    await h.run(1, COOLDOWN + MIN)
    expect(h.eventCount('pull.read_readable'), 'the recovery is the line that breaks the silence').toBe(1)
    expect(h.kv.get(unreadableKey('other/r#14')), 'the park is forgotten, not left to expire').toBeUndefined()
    await h.run(1)
    expect(h.eventCount('pull.read_readable'), 'a live thread is not announced every pass').toBe(1)
  })

  it('keeps reading a thread that only blipped, on the short interval', async () => {
    let fails = 2
    const h = harness(unreadable(async () => {
      if (fails-- > 0) throw new Error('HTTP 502 reading pull request other/r#14')
      return open()
    }))
    await h.run(4)
    expect(h.unreadable(), 'three failures is a bad minute, not a verdict').toBeUndefined()
    expect(h.eventCount('pull.thread_unreadable'), 'a blip never parks a thread').toBe(0)
    expect(h.eventCount('pull.read_failed'), 'the blip was said once').toBe(1)
    expect(h.eventCount('pull.read_readable'), 'and its end was said').toBe(1)
  })

  it('never parks a thread of the watched repository, whose reads the source poll already pays for', async () => {
    const h = harness(unreadable())
    await h.run(PARK_AFTER_FAILURES + 2)
    expect(h.kv.has(unreadableKey('#9')), 'the home repository is readable by construction').toBe(false)
    expect(h.warns.filter(w => w.fields.thread === '#9' && w.event === 'pull.thread_unreadable')).toHaveLength(0)
  })
})
