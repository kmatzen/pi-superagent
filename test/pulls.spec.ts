import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { followedPulls, parsePull, parseThread, PullFollower, threadOfPull, threadUrl, type PullApi, type PullState } from '../src/pi/pulls.ts'
import { ghPulls, unreadablePullError } from '../src/pi/gh-api.ts'
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

function follower(api: Partial<PullApi>, open: string[] | null = [],
                 limits: { maxReads?: number; budgetMs?: number; maxAtOnce?: number } = {}) {
  const kv = new Map<string, unknown>()
  const calls: string[] = []
  const closed: Array<{ id: string; outcome: string; at: string }> = []
  const reopened: string[] = []
  const received: Trigger[] = []
  const warned: string[] = []
  const blind: Array<{ id: string; repo: string; number: number; problem: string }> = []
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
    blind: (thread, pull, problem) => blind.push({ id: thread.id, repo: pull.repo, number: pull.number, problem }),
    now: () => clock, everyMs: 120_000,
    ...(limits.maxReads === undefined ? {} : { maxReads: limits.maxReads }),
    ...(limits.budgetMs === undefined ? {} : { budgetMs: limits.budgetMs }),
    ...(limits.maxAtOnce === undefined ? {} : { maxAtOnce: limits.maxAtOnce }),
  })
  const following = (...threads: string[]) => [{ follows: threads.map(t => ({ thread: `github:${t}`, own: true })) }] as unknown as Ticket[]
  const recorded = (...threads: string[]) => [{ follows: threads.map(t => ({ thread: `github:${t}`, own: true, closed: { at: created, outcome: 'closed' as const } })) }] as unknown as Ticket[]
  // The fake `reopened` reads the tickets of the pass in hand, the way the router reads them out of its store.
  const reconcile = (tickets: Ticket[]) => { seen = tickets; return f.reconcile(tickets) }
  return { f, kv, calls, closed, reopened, received, warned, blind, following, recorded, reconcile, tick: (ms: number) => { clock += ms } }
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
        if (broken) throw unreadablePullError('HTTP 404 reading pull request private/secret#31, and this account cannot read private/secret either')
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

  it('names a pull request it can never read as a blind spot, on every pass that finds it', async () => {
    // Measured 2026-11-09: the router's account cannot read `kmatzen/pi-superagent`, the repository its own workers
    // push into, nor `matzen_adobe/fleet-board`. The read fails identically forever, and the only trace was a WARN
    // in the router's log — board #227 sat "waiting on one click" through 146 receipts of that silence. The ticket
    // is where the operator reads, so that is where a permanent 404 belongs.
    const t = follower({ pull: async () => { throw unreadablePullError('HTTP 404 reading pull request private/secret#31, and this account cannot read private/secret either') } })
    await t.reconcile(t.following('private/secret#31'))
    expect(t.blind).toEqual([{ id: 'private/secret#31', repo: 'private/secret', number: 31, problem: expect.any(String) }])
    expect(t.f.isBlind('private/secret#31'), 'the router knows this thread is a fact it cannot see').toBe(true)
    t.tick(120_000)
    await t.reconcile(t.following('private/secret#31'))
    expect(t.blind, 'a ticket opened later is told too — the dedup is the caller\'s journal, not this call').toHaveLength(2)
  })

  it('does not call a rate limit a permanent blind spot, and clears the blind spot when the read comes back', async () => {
    const transient = follower({ pull: async () => { throw new Error('gh api exited 1: rate limited') } })
    await transient.reconcile(transient.following('other/lib#5'))
    expect(transient.blind, 'a read that may succeed next pass is not a door to ask the operator to open').toEqual([])
    expect(transient.f.isBlind('other/lib#5')).toBe(false)

    let blind = true
    const t = follower({
      pull: async () => {
        if (blind) throw unreadablePullError('HTTP 404 reading pull request private/secret#31, and this account cannot read private/secret either')
        return openPull
      },
    })
    await t.reconcile(t.following('private/secret#31'))
    expect(t.f.isBlind('private/secret#31')).toBe(true)
    blind = false
    t.tick(120_000)
    await t.reconcile(t.following('private/secret#31'))
    expect(t.f.isBlind('private/secret#31'), 'the grant lands, and the terminal end is a fact again').toBe(false)
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
    const t = follower({ pull: async () => { throw unreadablePullError('HTTP 404 reading pull request private/secret#31, and this account cannot read private/secret either') } })
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

// The fan-out one pass pays, measured live 2026-11-09 (#303): 41 followed pull requests, all of them outside
// the watched repository, read every pass because the 120 s budget is wall-clock and a loop entered hourly
// finds every one of them past it. The pass cost 12.1 s against 1.9 s at 7 follows. These pin the pass's cost
// to the cap, and the cap to the fan-out.
describe('the fan-out a pass pays', () => {
  const threads = (n: number, from = 1) => Array.from({ length: n }, (_x, i) => `other/lib#${i + from}`)
  const many = (n: number, from = 1) => [{ follows: threads(n, from).map(t => ({ thread: `github:${t}`, own: true })) }] as unknown as Ticket[]

  it('reads at most maxReads pull requests in a pass and defers the rest', async () => {
    const t = follower({ pull: async () => openPull }, [], { maxReads: 16 })
    const report = await t.f.reconcile(many(41))
    expect(report).toEqual({ due: 41, read: 16, deferred: 25, atOnce: 6 })
    expect(t.calls.filter(c => c.startsWith('pull '))).toHaveLength(16)
    // The budget is wall-clock, so the deferred ones are due on the very next pass, and the rotation puts them
    // first: the cap moves work to a later pass, it never drops it.
    const second = await t.f.reconcile(many(41))
    expect(second.read, 'the 25 that waited, capped again').toBe(16)
    expect(second.deferred).toBe(9)
    expect(t.calls.filter(c => c.startsWith('pull #33'))).toHaveLength(0)
  })

  it('a capped pass reads a false-close repair before the fan-out it defers', async () => {
    // The seam where the two features meet: a per-pass cap on external reads, and a recorded close's re-check
    // pushed into the same due list. Sorting the fan-out least-recently-read first is what stops a busy follow
    // starving a quiet one, but on the first pass after a start nothing carries a `polled` stamp: every external
    // ties, the repair sorts last of nine, and a cap of two defers it. A false close left unrepaired is the row
    // that is followed by nothing and ends by nothing, so the repair outranks a routine read.
    const t = follower({ pull: async () => openPull }, [], { maxReads: 2 })
    const board = [
      ...t.following(...Array.from({ length: 8 }, (_, i) => `other/r#${100 + i}`)),
      ...t.recorded('other/r#9'),
    ] as unknown as Ticket[]
    const report = await t.reconcile(board)
    expect(report).toEqual({ due: 9, read: 2, deferred: 7, atOnce: 2 })
    expect(t.reopened, 'the repair is read on the pass that capped, not behind 8 routine reads').toEqual(['other/r#9'])
    expect(t.calls.filter(c => c.startsWith('pull '))[0], 'the repair is the first call of the pass').toBe('pull other/r#9')
  })

  it('every follow gets read within a few passes: a cap rotates, it does not starve', async () => {
    const t = follower({ pull: async () => openPull }, [], { maxReads: 16 })
    for (let pass = 0; pass < 3; pass++) await t.f.reconcile(many(41))
    const read = t.calls.filter(c => c.startsWith('pull '))
    expect(read).toHaveLength(41)
    expect(new Set(read).size, 'and none of them twice').toBe(41)
  })

  it('the width follows the fan-out, and stops at 16 `gh` calls at once', async () => {
    // 4 was chosen for 7 follows; at 41 the same cap serialized a pass into ~31 sequential round trips.
    const widths: Array<number> = []
    for (const n of [4, 41, 128]) {
      let live = 0
      let peak = 0
      const t = follower({
        pull: async () => { live += 1; peak = Math.max(peak, live); await Promise.resolve(); live -= 1; return openPull },
      }, [], { maxReads: 1000 })
      const report = await t.f.reconcile(many(n))
      widths.push(report.atOnce)
      expect(peak, `${n} due: calls overlap, they do not multiply`).toBeLessThanOrEqual(report.atOnce)
      expect(peak, `${n} due: the reads did run side by side`).toBeGreaterThan(1)
    }
    expect(widths, 'min(16, max(4, ceil(due/8))) over the 4, 41 and 128 follows a board can hold').toEqual([4, 6, 16])
  })

  it('a pass stops starting reads once its wall-clock budget is spent', async () => {
    const t = follower({ pull: async () => { t.tick(6_000); return openPull } }, [], { maxReads: 10, budgetMs: 10_000, maxAtOnce: 1 })
    const report = await t.f.reconcile(many(5))
    // The clock is the follower's own, and each read moves it 6 s: the third read starts past the 10 s budget.
    expect(report).toEqual({ due: 5, read: 2, deferred: 3, atOnce: 1 })
    expect(t.calls.filter(c => c.startsWith('pull '))).toHaveLength(2)
  })

  it('a pull request a pass deferred is still due, and is not marked as read', async () => {
    const t = follower({ pull: async () => openPull }, [], { maxReads: 1 })
    await t.f.reconcile(many(2))
    expect(t.calls.filter(c => c.startsWith('pull '))).toEqual(['pull other/lib#1'])
    // Still the same instant: the 120 s budget cannot be what releases the second one, it was never read.
    const second = await t.f.reconcile(many(2))
    expect(second.read).toBe(1)
    expect(t.calls.filter(c => c.startsWith('pull '))).toEqual(['pull other/lib#1', 'pull other/lib#2'])
  })
})

describe('the visibility probe (a grant a human makes must land)', () => {
  const root = mkdtempSync(join(tmpdir(), 'sa-vis-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  /** A fake `gh` whose answers follow a gate file, so a test can grant access mid-test. */
  function gated(name: string, script: string) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, 'gh')
    writeFileSync(bin, `#!/bin/bash\n${script}\n`)
    chmodSync(bin, 0o755)
    return { dir, bin }
  }

  it('a read grant made while the router runs takes effect, because the answer expires', async () => {
    // The blind-spot notice tells a human "grant that account read access". Measured 2026-11-09 the answer came
    // back "addressed" and no grant had landed; had one landed, the visibility answer was cached for the life of
    // the process, so the router would have gone on answering 404 until it restarted — a door the ticket names
    // that the running router cannot walk through.
    const gate = join(root, 'granted')
    writeFileSync(gate, 'no')
    const { bin } = gated('grant', `case "$*" in
  "api repos/private/secret")          [ "$(cat ${gate})" = yes ] && echo '{"full_name":"x"}' || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; } ;;
  "api repos/private/secret/pulls/31") [ "$(cat ${gate})" = yes ] && echo '{"state":"closed","merged_at":"2026-11-09T10:00:00Z","created_at":"2026-11-09T09:00:00Z"}' || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; } ;;
esac`)
    const pulls = ghPulls({ bin, visibilityTtlMs: 0 })
    await expect(pulls.pull!('private/secret', 31)).rejects.toThrow(/cannot read/)
    writeFileSync(gate, 'yes')
    expect(await pulls.pull!('private/secret', 31), 'the merge is visible the moment the grant is').toMatchObject({ open: false, merged: true })
  })

  it('probes a repository once per window, not once per blind read', async () => {
    // The window is what makes the expiry cheap. The board measured 41 followed pull requests and a 12 s pass, so
    // a probe per blind read would be the new cost of a grant that has not landed.
    const { dir, bin } = gated('window', `case "$*" in
  "api repos/private/secret") echo x >> ${root}/probes; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  "api repos/private/secret/pulls/"*) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac`)
    void dir
    const pulls = ghPulls({ bin })
    for (const n of [31, 32, 33]) await expect(pulls.pull!('private/secret', n)).rejects.toThrow(/cannot read/)
    expect(readFileSync(join(root, 'probes'), 'utf8').trim().split('\n').length, 'three blind reads, one probe').toBe(1)
  })
})
