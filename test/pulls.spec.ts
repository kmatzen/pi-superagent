import { describe, expect, it } from 'vitest'
import { followedPulls, parsePull, parseThread, PullFollower, threadOfPull, threadUrl, UNREADABLE_PULLS, type PullApi, type PullRead, type PullState, type UnreadablePulls } from '../src/pi/pulls.ts'
import { REPLY_MARKER, type IssueComment, type PrReview } from '../src/pi/source-github.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

describe('the pull requests tickets follow', () => {
  const ticket = (id: string, follows: Array<{ thread: string; closed?: boolean }>) =>
    ({ id, follows: follows.map(f => ({ thread: f.thread, closed: f.closed ? { at: 'x' } : undefined })) }) as never

  it('reads both thread shapes a follow takes, and skips closed ones', () => {
    // The shapes come from live rows: a follow in another repository names it, one in the home repository does
    // not. A filter that misses a shape returns an empty set, and an empty set reads no reviews and fails no test.
    const open = [
      ticket('a', [{ thread: 'github:other/r#14' }]),
      ticket('b', [{ thread: 'github:#202' }]),
      ticket('c', [{ thread: 'github:o/r#9', closed: true }]),
      ticket('d', [{ thread: 'card:TASK-9' }]),
      ticket('e', [{ thread: 'github:other/r#14' }]),
    ]
    expect(followedPulls(open, 'o/r')).toEqual([{ repo: 'other/r', number: 14 }, { repo: 'o/r', number: 202 }])
  })
})

describe('naming a pull request', () => {
  it('reads only the URL gh pr create prints', () => {
    expect(parsePull('https://github.com/o/r/pull/9')).toEqual({ repo: 'o/r', number: 9 })
    expect(parsePull(' https://github.com/Other-Org/lib.js/pull/12/ ')).toEqual({ repo: 'Other-Org/lib.js', number: 12 })
    expect(parsePull('https://github.com/o/r/pull/9#issuecomment-1')).toEqual({ repo: 'o/r', number: 9 })
    // Each of these can name an issue, whose thread never merges: a ticket bound to one would wait forever.
    for (const ref of ['#9', 'o/r#9', 'https://github.com/o/r/issues/9', 'https://github.com/o/r/pull/x', 'pull 9']) {
      expect(parsePull(ref), ref).toBeUndefined()
    }
  })

  it("the watched repository's pull request is its #N thread, any other one carries its repository", () => {
    expect(threadOfPull({ repo: 'O/R', number: 9 }, 'o/r')).toEqual({ source: 'github', id: '#9' })
    expect(threadOfPull({ repo: 'Other/Lib', number: 9 }, 'o/r')).toEqual({ source: 'github', id: 'other/lib#9' })
    expect(parseThread('#9', 'o/r')).toEqual({ repo: 'o/r', number: 9 })
    expect(parseThread('other/lib#9', 'o/r')).toEqual({ repo: 'other/lib', number: 9 })
    expect(parseThread('#9', ''), 'no watched repository, no #N').toBeUndefined()
    expect(parseThread('card:TASK-1', 'o/r')).toBeUndefined()
    expect(threadUrl('#9', 'o/r')).toBe('https://github.com/o/r/issues/9')
    expect(threadUrl('other/lib#5', 'o/r'), 'a thread elsewhere links to its own repository').toBe('https://github.com/other/lib/issues/5')
  })
})

const HOUR = 3_600_000
const created = new Date(Date.now() - HOUR).toISOString()
const later = new Date(Date.now() - HOUR / 2).toISOString()

function follower(api: Partial<PullApi>, open: string[] | null = [], options: { escalateAfter?: number } = {}) {
  const kv = new Map<string, unknown>()
  const calls: string[] = []
  const closed: Array<{ id: string; outcome: string; at: string }> = []
  const received: Trigger[] = []
  const warned: string[] = []
  let clock = Date.now()
  const full: PullApi = {
    pull: async (repo, n) => { calls.push(`pull ${repo}#${n}`); return api.pull ? api.pull(repo, n) : absent },
    comments: async (repo, n, since) => { calls.push(`comments ${repo}#${n} since ${since === created ? 'created' : since}`); return api.comments?.(repo, n, since) ?? [] },
    reviews: async (repo, n) => { calls.push(`reviews ${repo}#${n}`); return api.reviews?.(repo, n) ?? [] },
  }
  const f = new PullFollower({
    home: 'o/r', api: full, openThreads: () => open === null ? undefined : new Set(open),
    positions: { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k, v) => { kv.set(k, v) } },
    self: 'agent-bot', bots: new Set(['ci-*']),
    closed: (thread, _pull, outcome, at) => closed.push({ id: thread.id, outcome, at }),
    receive: t => received.push(t),
    warn: event => warned.push(event),
    now: () => clock, everyMs: 120_000, ...(options.escalateAfter ? { escalateAfter: options.escalateAfter } : {}),
  })
  const following = (...threads: string[]) => [{ follows: threads.map(t => ({ thread: `github:${t}`, own: true })) }] as unknown as Ticket[]
  // The durable list the follower publishes for health.json, as the router reads it out of the kv store.
  const unreadable = () => (kv.get(UNREADABLE_PULLS) ?? {}) as UnreadablePulls
  return { f, kv, calls, closed, received, warned, following, unreadable, tick: (ms: number) => { clock += ms } }
}

// The three answers a pull read returns (see `PullRead`): GitHub's body, "no such pull in a repository I
// answer for", and "the read said nothing".
const found = (pull: PullState): PullRead => ({ read: 'found', pull })
const openPull: PullRead = found({ open: true, merged: false, createdAt: created })
const absent: PullRead = { read: 'absent' }
const comment = (over: Partial<IssueComment> = {}): IssueComment =>
  ({ issue: 5, author: 'reviewer', association: 'MEMBER', at: later, body: 'please rename the flag', ...over })
const review = (over: Partial<PrReview> = {}): PrReview =>
  ({ pr: 5, repo: 'o/r', id: 900, author: 'reviewer', association: 'MEMBER', state: 'CHANGES_REQUESTED', at: later, body: 'not yet', ...over })

describe('following a ticket\'s pull requests', () => {
  it('asks GitHub nothing about a pull request in the watched repository while it is open there', async () => {
    const t = follower({}, ['#9'])
    await t.f.reconcile(t.following('#9'))
    expect(t.calls).toEqual([])
  })

  it('a merged pull request is reported merged at its merge time, and a vanished one closed', async () => {
    const t = follower({
      pull: async (_r, n) => n === 9 ? found({ open: false, merged: true, createdAt: created, closedAt: later }) : absent,
    })
    await t.f.reconcile(t.following('#9', '#10'))
    expect(t.closed).toEqual([{ id: '#9', outcome: 'merged', at: later }, { id: '#10', outcome: 'closed', at: expect.any(String) }])
  })

  it('waits for the first look at the watched repository before deciding anything', async () => {
    const t = follower({ pull: async () => found({ open: false, merged: true, createdAt: created, closedAt: later }) }, null)
    await t.f.reconcile(t.following('#9'))
    expect(t.calls).toEqual([])
  })

  it("turns a person's comment and review on another repository's pull request into triggers on its thread, once", async () => {
    const t = follower({
      pull: async () => openPull,
      comments: async () => [comment(), comment({ author: 'agent-bot', body: 'mine' }), comment({ body: `relayed\n\n${REPLY_MARKER}` })],
      reviews: async () => [review(), review({ id: 901, author: 'ci-bot', state: 'COMMENTED', body: 'lint ok' })],
    })
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.received.map(r => r.text)).toEqual(['please rename the flag', 'other/lib#5: reviewer changes requested\n\nnot yet', 'other/lib#5: ci-bot commented\n\nlint ok'])
    expect(t.received[0]).toMatchObject({
      threads: [{ source: 'github', id: 'other/lib#5' }], human: true,
      channel: { thread: 'other/lib#5', address: { repo: 'other/lib', issue: '5' } },
      meta: { association: 'MEMBER', author: 'reviewer', via: 'comment' },
    })
    expect(t.received[2]!.human, 'a bot pattern still marks a bot').toBe(false)
    expect(t.calls, 'the first look reads comments from the pull request\'s creation').toContain('comments other/lib#5 since created')

    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.calls.filter(c => c.startsWith('pull')), 'not again before its interval').toHaveLength(1)
    t.tick(120_000)
    t.received.length = 0
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.calls.at(-2), 'reads on from past the newest comment it saw').toBe(`comments other/lib#5 since ${new Date(Date.parse(later) + 1).toISOString()}`)
    expect(t.received.filter(r => r.text.includes('not yet')), 'a review is delivered once').toHaveLength(0)
  })

  it("another repository's closed pull request is reported, and its talk is not read", async () => {
    const t = follower({ pull: async () => found({ open: false, merged: false, createdAt: created, closedAt: later }) })
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.closed).toEqual([{ id: 'other/lib#5', outcome: 'closed', at: later }])
    expect(t.calls).toEqual(['pull other/lib#5'])
  })

  it('a failed read is a warning and the next pass tries again', async () => {
    const t = follower({ pull: async () => { throw new Error('gh api exited 1: rate limited') } })
    await t.f.reconcile(t.following('other/lib#5'))
    expect([t.warned, t.closed]).toEqual([['pull.read_failed'], []])
    t.tick(120_000)
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.calls).toHaveLength(2)
    expect(t.unreadable()['other/lib#5']!.reads, 'a thrown read is an unreadable read, counted like a 404').toBe(2)
  })

  it('a pull request the token cannot read never ends the ticket: one warning, the follow kept, the read repeated', async () => {
    // The bug, measured 2026-11-09: the router's account matzenbot_adobe gets HTTP 404 on
    // repos/kmatzen/pi-superagent and on its pull requests #29/#30/#31, which the owner read as open. GitHub
    // answers 404 for "invisible" and for "gone" alike, and src/pi read both as "closed, as of now" — board
    // ticket #303 ended "closed without merging" three times, seven sessions, two false endings.
    const t = follower({ pull: async () => ({ read: 'unreadable', reason: 'repo-invisible:http-404' }) })
    for (let pass = 0; pass < 3; pass++) {
      await t.f.reconcile(t.following('other/lib#5'))
      t.tick(120_000)
    }
    expect(t.closed, 'an unreadable read ends nothing: no close, no invented closedAt').toEqual([])
    expect(t.warned, 'named once per pull request, not once per poll (2880 polls a day)').toEqual(['pull.unreadable'])
    expect(t.unreadable()).toEqual({
      'other/lib#5': { reason: 'repo-invisible:http-404', reads: 3, at: expect.any(String), escalated: false },
    })
  })

  it('escalates a pull request that stays unreadable once per window, not once per poll', async () => {
    const t = follower({ pull: async () => ({ read: 'unreadable', reason: 'repo-invisible:http-404' }) }, [], { escalateAfter: 4 })
    for (let pass = 0; pass < 9; pass++) {
      await t.f.reconcile(t.following('other/lib#5'))
      t.tick(120_000)
    }
    expect(t.warned, 'reads 1, 4 and 8: nine polls, three lines').toEqual(['pull.unreadable', 'pull.unreadable_escalated', 'pull.unreadable_escalated'])
    expect(t.closed).toEqual([])
    expect(t.unreadable()['other/lib#5'], 'the count an operator reads from health.json')
      .toMatchObject({ reads: 9, escalated: true, reason: 'repo-invisible:http-404' })
  })

  it('says so once when a pull request it could not read answers again, and drops it from the count', async () => {
    let answer: PullRead = { read: 'unreadable', reason: 'repo-invisible:http-404' }
    const t = follower({ pull: async () => answer })
    await t.f.reconcile(t.following('other/lib#5'))
    t.tick(120_000)
    answer = openPull
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.warned, 'the pair the reviews read already reports: unreadable, then readable again').toEqual(['pull.unreadable', 'pull.readable'])
    expect(t.unreadable(), 'so the count in health.json goes back to nothing').toEqual({})
  })

  it('a pull request GitHub has none of, in a repository it does answer for, ends the wait', async () => {
    // The other half of the 404: gh-api answers `absent` only after the SAME token read the repository, so
    // this is GitHub saying it has no such pull request, and a pull that cannot exist can never be merged.
    const t = follower({ pull: async () => absent })
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.closed).toEqual([{ id: 'other/lib#5', outcome: 'closed', at: expect.any(String) }])
    expect(t.warned, 'and the reason is said out loud, because the close time here is the detection time').toEqual(['pull.absent'])
  })

  it('reads the pull requests it follows side by side, and never more than four at a time', async () => {
    // Seven followed pulls read one at a time serialized a tick out to 20 s (measured live 2026-11-07, every 120 s); an uncapped fan-out spends GitHub's abuse threshold on a router with a hundred follows.
    let live = 0
    let peak = 0
    let reads = 0
    const t = follower({
      pull: async () => {
        live++; peak = Math.max(peak, live); reads++
        await new Promise(resolve => setTimeout(resolve, 1))
        live--
        return openPull
      },
    })
    const seven = ['other/lib#1', 'other/lib#2', 'other/lib#3', 'other/lib#4', 'other/lib#5', 'other/lib#6', 'other/lib#7']
    await t.f.reconcile(t.following(...seven))
    expect([reads, peak], 'every followed pull is read, four of them at once').toEqual([7, 4])
    expect(t.closed).toEqual([])
  })

  it('names a pull request whose talk it cannot read once, and says when it reads it again', async () => {
    const api: Partial<PullApi> = { pull: async () => openPull, comments: async () => { throw new Error('gh: Not Found (HTTP 404)') } }
    const t = follower(api)
    for (let pass = 0; pass < 3; pass++) {
      await t.f.reconcile(t.following('other/lib#5'))
      t.tick(120_000)
    }
    expect(t.warned, 'a pull request that stays unreadable is named once, not 720 times a day').toEqual(['pull.listen_failed'])
    api.comments = async () => []
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.warned, 'and a pull request that becomes readable says so').toEqual(['pull.listen_failed', 'pull.listen_readable'])
  })

  it('drops the count of a follow no ticket holds open any more', async () => {
    const t = follower({ pull: async () => ({ read: 'unreadable', reason: 'repo-invisible:http-404' }) })
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.unreadable()['other/lib#5'], 'counted while a ticket waits on it').toBeDefined()
    await t.f.reconcile([{ follows: [{ thread: 'github:other/lib#5', own: true, closed: { at: later, outcome: 'merged' } }] }] as unknown as Ticket[])
    expect(t.unreadable(), 'health.json names the pull requests a ticket is waiting on now, not the ones that ended last month')
      .toEqual({})
  })

  it('a closed follow is history: nothing is read for it', async () => {
    const t = follower({ pull: async () => openPull })
    await t.f.reconcile([{ follows: [{ thread: 'github:other/lib#5', own: true, closed: { at: later, outcome: 'merged' } }] }] as unknown as Ticket[])
    expect(t.calls).toEqual([])
  })
})
