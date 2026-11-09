import { describe, expect, it } from 'vitest'
import { followedPulls, parsePull, parseThread, PullFollower, threadOfPull, threadUrl, type PullApi, type PullState } from '../src/pi/pulls.ts'
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

function follower(api: Partial<PullApi>, open: string[] | null = []) {
  const kv = new Map<string, unknown>()
  const calls: string[] = []
  const closed: Array<{ id: string; outcome: string; at: string }> = []
  const reopened: string[] = []
  const received: Trigger[] = []
  const warned: string[] = []
  let seen: Ticket[] = []
  let clock = Date.now()
  const full: PullApi = {
    pull: async (repo, n) => { calls.push(`pull ${repo}#${n}`); return api.pull?.(repo, n) },
    comments: async (repo, n, since) => { calls.push(`comments ${repo}#${n} since ${since === created ? 'created' : since}`); return api.comments?.(repo, n, since) ?? [] },
    reviews: async (repo, n) => { calls.push(`reviews ${repo}#${n}`); return api.reviews?.(repo, n) ?? [] },
  }
  const f = new PullFollower({
    home: 'o/r', api: full, openThreads: () => open === null ? undefined : new Set(open),
    positions: { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k, v) => { kv.set(k, v) } },
    self: 'agent-bot', bots: new Set(['ci-*']),
    closed: (thread, _pull, outcome, at) => closed.push({ id: thread.id, outcome, at }),
    // What the router does with this callback: count the tickets holding a recorded close on the thread GitHub says
    // is open, and open their wait. Zero is the common case, and it is the case that must stay silent.
    reopened: thread => {
      const n = seen.flatMap(t => t.follows ?? []).filter(f => f.thread === `github:${thread.id}` && f.closed?.outcome === 'closed').length
      if (n > 0) reopened.push(thread.id)
      return n
    },
    receive: t => received.push(t),
    warn: event => warned.push(event),
    now: () => clock, everyMs: 120_000,
  })
  const following = (...threads: string[]) => [{ follows: threads.map(t => ({ thread: `github:${t}`, own: true })) }] as unknown as Ticket[]
  const recorded = (...threads: string[]) => [{ follows: threads.map(t => ({ thread: `github:${t}`, own: true, closed: { at: created, outcome: 'closed' as const } })) }] as unknown as Ticket[]
  // The fake `reopened` reads the tickets of the pass in hand, the way the router reads them out of its store.
  const reconcile = (tickets: Ticket[]) => { seen = tickets; return f.reconcile(tickets) }
  return { f, kv, calls, closed, reopened, received, warned, following, recorded, reconcile, tick: (ms: number) => { clock += ms } }
}

const openPull: PullState = { open: true, merged: false, createdAt: created }
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
      pull: async (_r, n) => n === 9 ? { open: false, merged: true, createdAt: created, closedAt: later } : undefined,
    })
    await t.f.reconcile(t.following('#9', '#10'))
    expect(t.closed).toEqual([{ id: '#9', outcome: 'merged', at: later }, { id: '#10', outcome: 'closed', at: expect.any(String) }])
  })

  it('a pull request the reader cannot see keeps its ticket waiting, and is complained about once', async () => {
    // 404 is GitHub's answer for a pull request that is gone *and* for a repository the token cannot read. Ending
    // the wait on the second one posts "closed without merging, so this ticket ends" on an open, ready pull request
    // — measured 2026-11-09, twice in one day, about the router's own fix in a private repository.
    let broken = true
    const t = follower({
      pull: async () => {
        if (broken) throw new Error('HTTP 404 reading pull request private/secret#31, and this account cannot read private/secret either')
        return openPull
      },
    })
    await t.f.reconcile(t.following('private/secret#31'))
    expect(t.closed, 'an unreadable read ends nothing').toEqual([])
    expect(t.warned).toEqual(['pull.read_failed'])
    t.tick(120_000)
    await t.f.reconcile(t.following('private/secret#31'))
    t.tick(120_000)
    await t.f.reconcile(t.following('private/secret#31'))
    expect(t.warned, 'once per thread, not once per poll').toEqual(['pull.read_failed'])
    broken = false
    t.tick(120_000)
    await t.f.reconcile(t.following('private/secret#31'))
    expect(t.warned, 'and it says when the read comes back').toEqual(['pull.read_failed', 'pull.read_readable'])
    expect(t.closed, 'the follow survived to be read').toEqual([])
  })

  it('reopens a follow whose recorded close GitHub denies, and asks about it once per start', async () => {
    // 21 live tickets on the live board hold exactly this shape: one follow, recorded closed, pull request open.
    // Nothing reads a closed follow, so the ticket is followed by nothing, ends by nothing, and its reviews are
    // never read. The repair is a state repair, so it says nothing on the thread: the router's own comment is what
    // recruits a session (#309), and a repaired row is not news.
    const t = follower({ pull: async () => openPull })
    await t.reconcile(t.recorded('other/r#9'))
    expect(t.reopened).toEqual(['other/r#9'])
    expect(t.warned, 'the repair is said in the log, once').toEqual(['pull.reopened'])
    t.tick(120_000)
    await t.reconcile(t.recorded('other/r#9'))
    t.tick(120_000)
    await t.reconcile(t.recorded('other/r#9'))
    expect(t.calls.filter(c => c.startsWith('pull ')), 'one look per start, not one per poll').toEqual(['pull other/r#9'])
  })

  it('leaves a recorded close GitHub confirms alone, and ends nothing on the way', async () => {
    const t = follower({ pull: async () => ({ open: false, merged: false, createdAt: created, closedAt: later }) })
    await t.reconcile(t.recorded('other/r#9'))
    t.tick(120_000)
    await t.reconcile(t.recorded('other/r#9'))
    expect(t.reopened, 'the close is a fact, not a failed read').toEqual([])
    expect(t.closed, 'a thread read only to check a recorded close ends no other ticket').toEqual([])
    expect(t.calls.filter(c => c.startsWith('pull '))).toEqual(['pull other/r#9'])
  })

  it('says so, once, when the repair cannot be checked, and keeps the close as it was', async () => {
    const t = follower({ pull: async () => { throw new Error('HTTP 404 reading pull request private/secret#31, and this account cannot read private/secret either') } })
    await t.reconcile(t.recorded('private/secret#31'))
    t.tick(120_000)
    await t.reconcile(t.recorded('private/secret#31'))
    expect(t.reopened, 'unknown is not open').toEqual([])
    expect(t.warned).toEqual(['pull.read_failed'])
  })

  it('reopens a closed follow in the watched repository from its open-thread list, with no API call', async () => {
    const t = follower({}, ['#9'])
    await t.reconcile(t.recorded('#9'))
    expect(t.reopened).toEqual(['#9'])
    expect(t.calls, 'the list the poll already fetched answered it').toEqual([])
  })

  it('a merged close is never a suspect, and costs no read', async () => {
    const t = follower({ pull: async () => openPull })
    const merged = [{ follows: [{ thread: 'github:other/r#9', own: true, closed: { at: created, outcome: 'merged' } }] }] as unknown as Ticket[]
    await t.reconcile(merged)
    expect(t.reopened, 'merged needs a read that succeeded and saw merged_at').toEqual([])
    expect(t.calls).toEqual([])
  })

  it('waits for the first look at the watched repository before deciding anything', async () => {
    const t = follower({ pull: async () => ({ open: false, merged: true, createdAt: created, closedAt: later }) }, null)
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
    const t = follower({ pull: async () => ({ open: false, merged: false, createdAt: created, closedAt: later }) })
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

  it('a closed follow is history: nothing is read for it', async () => {
    const t = follower({ pull: async () => openPull })
    await t.f.reconcile([{ follows: [{ thread: 'github:other/lib#5', own: true, closed: { at: later, outcome: 'merged' } }] }] as unknown as Ticket[])
    expect(t.calls).toEqual([])
  })
})
