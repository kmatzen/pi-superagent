import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ghPulls } from '../src/pi/gh-api.ts'
import { followedPulls, parsePull, parseThread, PullFollower, threadOfPull, threadUrl, type PullApi, type PullEvidence, type PullRead } from '../src/pi/pulls.ts'
import { absentRead, closedRead, mergedRead, openRead, unknownRead } from './pull-read.ts'
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
  // The same closes with the read they were decided from, for the tests that check what a receipt can quote.
  const ended: Array<{ id: string; outcome: string; at: string; evidence: PullEvidence }> = []
  const received: Trigger[] = []
  const warns: Array<{ event: string; fields: Record<string, unknown> }> = []
  let clock = Date.now()
  const full: PullApi = {
    pull: async (repo, n) => { calls.push(`pull ${repo}#${n}`); return api.pull ? await api.pull(repo, n) : openRead({ repo, number: n }) },
    comments: async (repo, n, since) => { calls.push(`comments ${repo}#${n} since ${since === created ? 'created' : since}`); return api.comments?.(repo, n, since) ?? [] },
    reviews: async (repo, n) => { calls.push(`reviews ${repo}#${n}`); return api.reviews?.(repo, n) ?? [] },
  }
  const f = new PullFollower({
    home: 'o/r', api: full, openThreads: () => open === null ? undefined : new Set(open),
    positions: { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k, v) => { kv.set(k, v) } },
    self: 'agent-bot', bots: new Set(['ci-*']),
    closed: (thread, _pull, outcome, at, evidence) => { closed.push({ id: thread.id, outcome, at }); ended.push({ id: thread.id, outcome, at, evidence }) },
    receive: t => received.push(t),
    warn: (event, fields) => { warns.push({ event, fields }) },
    now: () => clock, everyMs: 120_000,
  })
  const following = (...threads: string[]) => [{ follows: threads.map(t => ({ thread: `github:${t}`, own: true })) }] as unknown as Ticket[]
  return { f, kv, calls, closed, ended, received, warns, warned: () => warns.map(w => w.event), following, tick: (ms: number) => { clock += ms } }
}

const openPull = openRead({ createdAt: created })
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
      pull: async (_r, n) => n === 9 ? mergedRead(later) : absentRead({ repo: 'other/lib', number: n }),
    })
    await t.f.reconcile(t.following('#9', '#10'))
    expect(t.closed).toEqual([{ id: '#9', outcome: 'merged', at: later }, { id: '#10', outcome: 'closed', at: expect.any(String) }])
    expect(t.ended[1]!.evidence.reason, 'the vanished pull is named by the read that called it vanished').toBe('no-such-pull-request')
  })

  it('waits for the first look at the watched repository before deciding anything', async () => {
    const t = follower({ pull: async () => mergedRead(later) }, null)
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
    const t = follower({ pull: async () => closedRead(later) })
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.closed).toEqual([{ id: 'other/lib#5', outcome: 'closed', at: later }])
    expect(t.calls).toEqual(['pull other/lib#5'])
  })

  it('a failed read is a warning and the next pass tries again', async () => {
    const t = follower({ pull: async () => { throw new Error('gh api exited 1: rate limited') } })
    await t.f.reconcile(t.following('other/lib#5'))
    expect([t.warned(), t.closed]).toEqual([['pull.read_failed'], []])
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

  it("names a pull request whose talk it cannot read once, and says when it reads it again", async () => {
    const api: Partial<PullApi> = { pull: async () => openPull, comments: async () => { throw new Error('gh: Not Found (HTTP 404)') } }
    const t = follower(api)
    for (let pass = 0; pass < 3; pass++) {
      await t.f.reconcile(t.following('other/lib#5'))
      t.tick(120_000)
    }
    expect(t.warned(), 'a pull request that stays unreadable is named once, not 720 times a day').toEqual(['pull.listen_failed'])
    api.comments = async () => []
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.warned(), 'and a pull request that becomes readable says so').toEqual(['pull.listen_failed', 'pull.listen_readable'])
  })

  it('a closed follow is history: nothing is read for it', async () => {
    const t = follower({ pull: async () => openPull })
    await t.f.reconcile([{ follows: [{ thread: 'github:other/lib#5', own: true, closed: { at: later, outcome: 'merged' } }] }] as unknown as Ticket[])
    expect(t.calls).toEqual([])
  })
})

/**
 * The falsifying fixtures for the defect on board #235: eight receipts ended one ticket across nine hours on
 * `matzen_adobe/fleet-board#74`, which GitHub says was open, `closed_at: null`, `merged_at: null`, and unwritten
 * to since 06:00:01Z the whole time (`gh api repos/matzen_adobe/fleet-board/pulls/74`). None of those endings
 * followed a state change; every one followed a read that failed. So every way a poll can fail is here, and each
 * one has to leave the ticket open.
 */
describe('a pull-state read that failed is not a close', () => {
  const failures: Array<{ what: string; reason: string; status: number; read: () => PullRead }> = [
    { what: 'gh exited 1 with a 5xx body', reason: 'gh-exit-1', status: 1, read: () => unknownRead('gh-exit-1', { status: 1, headRefOid: '' }) },
    { what: 'gh exited 0 and printed nothing', reason: 'empty-output', status: 0, read: () => unknownRead('empty-output', { headRefOid: '' }) },
    { what: 'the body was not JSON', reason: 'unparseable-output', status: 0, read: () => unknownRead('unparseable-output', { state: '<html>502 Bad Gateway', headRefOid: '' }) },
    { what: 'the body carried no state', reason: 'no-state-in-body', status: 0, read: () => unknownRead('no-state-in-body') },
    { what: 'the state was one the poller does not know', reason: 'unrecognised-state:archived', status: 0, read: () => unknownRead('unrecognised-state:archived', { state: 'archived' }) },
    { what: 'a closed body carried no closed_at', reason: 'closed-without-closed-at', status: 0, read: () => unknownRead('closed-without-closed-at', { state: 'closed' }) },
    { what: 'GitHub rate limited the poll', reason: 'rate-limited', status: 1, read: () => unknownRead('rate-limited', { status: 1, headRefOid: '' }) },
    { what: 'the repository is invisible to this token, and answered its 404', reason: 'repo-invisible', status: 1, read: () => unknownRead('repo-invisible', { status: 1, headRefOid: '' }) },
  ]

  for (const failure of failures) {
    it(`${failure.what}: the ticket keeps its follow, the read is logged UNKNOWN, and no end receipt is written`, async () => {
      const t = follower({ pull: async () => failure.read() })
      await t.f.reconcile(t.following('other/lib#5'))
      expect(t.closed, 'nothing ends').toEqual([])
      expect(t.warned(), 'and the log says the read decided nothing').toEqual(['pull.state_unknown'])
      expect(t.warns[0]!.fields.thread, 'named by the thread that follows it').toBe('other/lib#5')
      expect(t.warns[0]!.fields.reason, 'with the reason a person can act on').toBe(failure.reason)
      expect(t.warns[0]!.fields.status, 'and the poll exit status that produced it').toBe(failure.status)
      t.tick(120_000)
      await t.f.reconcile(t.following('other/lib#5'))
      expect(t.calls.filter(c => c.startsWith('pull')), 'and the next pass asks GitHub again').toHaveLength(2)
      expect(t.closed).toEqual([])
    })
  }

  it('warns once while a pull request stays unreadable, and says so when it reads it again', async () => {
    let readable = false
    const t = follower({ pull: async () => readable ? openRead() : unknownRead('repo-invisible', { status: 1 }) })
    for (let pass = 0; pass < 3; pass++) { await t.f.reconcile(t.following('other/lib#5')); t.tick(120_000) }
    expect(t.warned(), 'not one line per poll: 720 a day bury the one that is new').toEqual(['pull.state_unknown'])
    expect(t.closed, 'and it ended nothing while it stayed unreadable').toEqual([])
    readable = true
    t.tick(120_000)
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.warned(), 'and the read that worked says the pull request is readable again').toEqual(['pull.state_unknown', 'pull.state_readable'])
  })

  it('an OPEN pull request keeps the ticket open, and only CLOSED with merged_at null ends it as a close', async () => {
    const t = follower({ pull: async (_r, n) => n === 74 ? openRead({ repo: 'matzen_adobe/fleet-board', number: 74 }) : closedRead('2026-11-09T06:00:01Z', { repo: 'o/r', number: n }) })
    await t.f.reconcile(t.following('matzen_adobe/fleet-board#74', 'other/lib#20'))
    expect(t.closed, 'the open pull request ends nothing; the closed one ends at GitHub\'s own time').toEqual([
      { id: 'other/lib#20', outcome: 'closed', at: '2026-11-09T06:00:01Z' },
    ])
    expect(t.ended[0]!.evidence, 'the ending carries the fields a receipt quotes').toMatchObject({
      repo: 'o/r', number: 20, status: 0, state: 'closed', closedAt: '2026-11-09T06:00:01Z', mergedAt: null,
    })
  })

  it('a MERGED read ends as merged, at GitHub\'s merge time', async () => {
    const t = follower({ pull: async () => mergedRead('2026-11-09T06:00:01Z') })
    await t.f.reconcile(t.following('other/lib#5'))
    expect(t.closed).toEqual([{ id: 'other/lib#5', outcome: 'merged', at: '2026-11-09T06:00:01Z' }])
  })
})

/**
 * The same fixtures one layer down, where the router really reads: a `gh` binary that fails, answering the
 * follower through the production `ghPulls`. This is the shape measured on 2026-11-09 — `fleet-board#74` open,
 * its polls failing — assembled so the ending of a ticket needs an explicit `CLOSED` with a `closed_at`.
 */
describe('a poll that failed, end to end from the gh binary', () => {
  function failingGh() {
    const dir = mkdtempSync(join(tmpdir(), 'pi-pull-gh-'))
    const bin = join(dir, 'gh')
    writeFileSync(bin, `#!/bin/bash
case "$*" in
  # GitHub's answer for the pull request in the ticket: open, never closed, never merged.
  "api repos/x/y/pulls/74") echo '{"state":"open","merged_at":null,"closed_at":null,"created_at":"2026-11-09T02:19:28Z","head":{"sha":"9a0e7ea1234567890abcdef1234567890abcdef1"}}' ;;
  "api repos/x/y/pulls/1") echo 'gh: Bad Gateway (HTTP 502)' >&2; exit 1 ;;
  "api repos/x/y/pulls/2") exit 0 ;;
  "api repos/x/y/pulls/3") echo '{"state":"closed","merged_at":null,"closed_at":"2026-11-09T06:00:01Z","created_at":"2026-11-09T02:19:28Z","head":{"sha":"3333333333333333333333333333333333333333"}}' ;;
  "api repos/x/y") echo '{"full_name":"x/y"}' ;;
  "api repos/x/y/issues/"*"/comments?"*) echo '[]' ;;
  "api repos/x/y/pulls/"*"/reviews?"*) echo '[]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`)
    chmodSync(bin, 0o755)
    return bin
  }

  it('rc=1 and an empty stdout keep every ticket open and log the read UNKNOWN; only CLOSED ends one', async () => {
    const kv = new Map<string, unknown>()
    const closed: Array<{ id: string; outcome: string; at: string }> = []
    const warned: Array<{ event: string; fields: Record<string, unknown> }> = []
    const f = new PullFollower({
      home: 'o/r', api: ghPulls({ bin: failingGh() }), openThreads: () => new Set(),
      positions: { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k, v) => { kv.set(k, v) } },
      self: 'agent-bot', now: () => Date.now(), everyMs: 0,
      closed: (thread, _pull, outcome, at) => closed.push({ id: thread.id, outcome, at }),
      receive: () => {}, warn: (event, fields) => { warned.push({ event, fields }) },
    })
    const following = (...threads: string[]) => [{ follows: threads.map(t => ({ thread: `github:${t}`, own: true })) }] as unknown as Ticket[]
    await f.reconcile(following('x/y#74', 'x/y#1', 'x/y#2', 'x/y#3'))
    expect(closed, 'the open pull request and the two failed polls end nothing; the CLOSED one ends at GitHub\'s time').toEqual([
      { id: 'x/y#3', outcome: 'closed', at: '2026-11-09T06:00:01Z' },
    ])
    expect(warned.map(w => [w.event, w.fields.thread]), 'each failed read is logged as UNKNOWN, and the open one is not').toEqual([
      ['pull.state_unknown', 'x/y#1'], ['pull.state_unknown', 'x/y#2'],
    ])
    expect(warned[0]!.fields.status, 'with the exit status the poll died with').toBe(1)
    expect(warned[1]!.fields.reason, 'and the reason: exit 0 and no output at all').toBe('empty-output')
  })
})
