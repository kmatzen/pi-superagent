import { describe, expect, it } from 'vitest'
import { FreshnessGate, pullSnapshot, watched } from '../src/pi/freshness.ts'
import { REPLY_MARKER, type IssueComment, type PositionStore } from '../src/pi/source-github.ts'
import type { PullApi, PullState } from '../src/pi/pulls.ts'
import type { Ticket } from '../src/core/index.ts'

const HOUR = 3_600_000
const at = '2026-11-09T09:00:00.000Z'

/** A ticket in the shape #213 had seven times on 2026-11-09: asked, released, waiting on its own pull request. */
const settled = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't1', undelivered: ['i1'], inputs: [], channels: [{ source: 'github', thread: '#213', address: { issue: '213' } }],
  follows: [{ thread: 'github:research-adobe/applepie#307', own: true }],
  assignments: [{ id: 'a1', state: 'ended', endedReason: 'released', createdAt: at, endedAt: at,
    report: { state: 'blocked', summary: 'asked the operator', at } }],
  ...over,
} as unknown as Ticket)

function store(): PositionStore & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>()
  return { rows, get: <T,>(k: string) => rows.get(k) as T | undefined, set: (k, v) => void rows.set(k, v) }
}

const pullState = (over: Partial<PullState> = {}): PullState =>
  ({ open: true, merged: false, createdAt: at, headSha: '22f2b15', comments: 0, updatedAt: at, ...over })

interface Reads { pulls: string[]; asks: number[] }

function api(state: PullState | undefined, comments: IssueComment[], fails = false): { pulls: PullApi; comments: (i: number, r?: string) => Promise<IssueComment[]>; reads: Reads } {
  const reads: Reads = { pulls: [], asks: [] }
  return {
    reads,
    pulls: {
      pull: async (repo, number) => {
        reads.pulls.push(`${repo}#${number}`)
        if (fails) throw new Error('HTTP 502 from api.github.com')
        return state
      },
      comments: async () => [], reviews: async () => [],
    },
    comments: async (issue, repo) => { reads.asks.push(issue); if (fails) throw new Error('HTTP 502'); return comments },
  }
}

const said = (author: string, at: string, body = 'text'): IssueComment =>
  ({ issue: 213, author, association: 'OWNER', at, body })

function gate(fakes: ReturnType<typeof api>, over: { now?: () => number; redispatchHours?: number; memoMs?: number } = {}) {
  const warns: Array<{ event: string; fields: Record<string, unknown> }> = []
  const g = new FreshnessGate({
    home: 'matzen_adobe/superagent-board-spike', api: { pull: fakes.pulls.pull, comments: fakes.comments },
    positions: store(), self: 'matzenbot_adobe', bots: new Set(['pi-*']), warn: (event, fields) => warns.push({ event, fields }),
    now: over.now ?? (() => Date.parse('2026-11-09T09:30:00.000Z')), memoMs: 0, ...over,
  })
  return { g, warns }
}

/** The gate over a record it wrote earlier: what the router sees on the pass after the one that dispatched. */
function stored(fp: string, state: PullState | undefined, comments: IssueComment[] = [], at = '2026-11-09T09:00:00.000Z') {
  const positions = store()
  positions.set('freshness:t1', { fp, at })
  return new FreshnessGate({
    home: 'o/r', api: { pull: () => Promise.resolve(state), comments: () => Promise.resolve(comments) },
    positions, self: 'matzenbot_adobe', bots: new Set(['pi-*']), warn: () => {},
    now: () => Date.parse(at) + HOUR, memoMs: 0,
  })
}

const UNTOUCHED = 'research-adobe/applepie#307:open/22f2b15/0/2026-11-09T09:00:00.000Z#none'

describe('FreshnessGate', () => {
  it('watches only a settled ticket that is waiting on a pull request it opened, and its ask', () => {
    expect(watched(settled(), 'o/r')).toMatchObject({ pulls: [{ repo: 'research-adobe/applepie', number: 307 }], ask: { issue: 213 } })
    expect(watched(settled({ follows: [{ thread: 'github:o/r#7', own: false }] }), 'o/r'), 'a context follow is not its work').toBeUndefined()
    expect(watched(settled({ follows: [{ thread: 'github:o/r#7', own: true, closed: { at, outcome: 'merged' } }] }), 'o/r'), 'a closed follow has ended its wait').toBeUndefined()
    expect(watched(settled({ follows: [] }), 'o/r'), 'work that opened no pull request is not waiting on one').toBeUndefined()
    const progress = settled({ assignments: [{ id: 'a', state: 'ended', createdAt: at, report: { state: 'progress', summary: 'halfway', at } }] })
    expect(watched(progress, 'o/r'), 'a worker mid-flight is not a settled ticket').toBeUndefined()
    const noAsk = watched(settled({ channels: [{ source: 'panel', thread: 'p', address: {} }] }), 'o/r')
    expect(noAsk?.pulls.map(p => p.number), 'no ask to read, the pull request still is').toEqual([307])
    expect(noAsk?.ask).toBeUndefined()
  })

  it('the first look dispatches and says so; the same state on the next look does not', async () => {
    const fakes = api(pullState(), [])
    const { g } = gate(fakes)
    expect(await g.stale(settled()), 'nothing has been seen yet, so the work goes out').toBe(false)
    expect(fakes.reads).toEqual({ pulls: ['research-adobe/applepie#307'], asks: [213] })
    expect(await g.stale(settled()), 'the pull request is unreviewed at the same head and nobody answered').toBe(true)
    expect(fakes.reads.pulls, 'the check is two reads, not a session').toHaveLength(2)
  })

  it('a settled report writes the baseline, so the FIRST dispatch that repeats it is the withheld one', async () => {
    // #213's three sessions in 25 minutes and #289's thirteen all began as run 2: the first dispatch after a
    // receipt nobody had answered. Reading the state at the report is what saves that session, not the next.
    const fakes = api(pullState(), [])
    const { g } = gate(fakes)
    await g.note(settled())
    expect(fakes.reads, 'the report boundary reads the same two facts').toEqual({ pulls: ['research-adobe/applepie#307'], asks: [213] })
    expect(await g.stale(settled()), 'the state the worker reported is the state the gate keeps').toBe(true)
  })

  it('a baseline still being read is waited for, not missed', async () => {
    // The report commits, its two reads are in flight, and the pass that follows it lands in the same tick —
    // measured on #213, that pass is the one that used to start the redundant session.
    let release!: () => void
    const gateReads: string[] = []
    let inFlight = true
    const g = new FreshnessGate({
      home: 'o/r',
      api: {
        pull: async () => {
          gateReads.push('pull')
          // Only the baseline's own read is slow: that is the write the dispatch must not race past.
          if (inFlight) { inFlight = false; await new Promise<void>(resolve => { release = resolve }) }
          return pullState()
        },
        comments: async () => [],
      },
      positions: store(), self: 'me', bots: new Set<string>(), warn: () => {}, now: () => Date.parse(at), memoMs: 0,
    })
    const writing = g.note(settled())
    expect(gateReads, 'the report boundary starts its read synchronously').toEqual(['pull'])
    const decided = g.stale(settled())
    release()
    await writing
    expect(await decided, 'the dispatch in the same tick is measured against the report, not against nothing').toBe(true)
  })

  it('a baseline write that fails is a dispatch, said once, and the record is left alone', async () => {
    const fakes = api(pullState(), [], true)
    const { g, warns } = gate(fakes)
    await g.note(settled())
    expect(warns.map(w => w.event)).toEqual(['dispatch.freshness_unreadable'])
    expect(await g.stale(settled()), 'a ticket with no baseline has not been seen yet').toBe(false)
  })

  it('every move on the pull request is a dispatch: a new head, a comment, a review, a merge, a vanished pull', async () => {
    const moves: Array<[string, PullState | undefined]> = [
      ['a push', pullState({ headSha: '0fb3632' })],
      ['a comment', pullState({ comments: 3 })],
      ['a submitted review', pullState({ updatedAt: '2026-11-09T09:20:00.000Z' })],
      ['a merge', pullState({ open: false, merged: true, closedAt: at })],
      ['a pull request GitHub no longer has', undefined],
    ]
    for (const [what, state] of moves) expect(await stored(UNTOUCHED, state).stale(settled()), what).toBe(false)
    expect(await stored(UNTOUCHED, pullState()).stale(settled()), 'and the same state is not a move').toBe(true)
  })

  it('an answer on the ask is a dispatch; the router\'s own receipt and a bot comment are not', async () => {
    const mine: IssueComment[] = [said('matzenbot_adobe', '2026-11-09T09:10:00.000Z', `#213 blocked: asked\n\n${REPLY_MARKER}`)]
    const fakes = api(pullState(), mine)
    const { g } = gate(fakes)
    expect(await g.stale(settled())).toBe(false)
    expect(await g.stale(settled()), 'the receipt the router posted is not a reply').toBe(true)
    expect(await stored(UNTOUCHED, pullState(), [...mine, said('pi-bot-7', '2026-11-09T09:20:00.000Z')]).stale(settled()), 'a bot is not the operator').toBe(true)
    expect(await stored(UNTOUCHED, pullState(), [...mine, said('matzen_adobe', '2026-11-09T09:20:00.000Z', 'a: merge it')]).stale(settled()), 'the operator answered').toBe(false)
  })

  it('a read that fails is a dispatch, said once, never a silence', async () => {
    const fakes = api(pullState(), [], true)
    const { g, warns } = gate(fakes)
    expect(await g.stale(settled())).toBe(false)
    expect(await g.stale(settled())).toBe(false)
    expect(warns).toHaveLength(1)
    expect(warns[0]!.event).toBe('dispatch.freshness_unreadable')
    expect(warns[0]!.fields.ticket).toBe('t1')
  })

  it('an unchanged ticket still gets a worker on the valve, and the valve starts over', async () => {
    const fakes = api(pullState(), [])
    let now = Date.parse(at)
    const { g } = gate(fakes, { now: () => now, redispatchHours: 24 })
    expect(await g.stale(settled())).toBe(false)
    now += 23 * HOUR
    expect(await g.stale(settled()), '23 hours of nothing is still nothing').toBe(true)
    now += 2 * HOUR
    expect(await g.stale(settled()), 'the valve is due, so one worker goes out').toBe(false)
    now += 23 * HOUR
    expect(await g.stale(settled()), 'the valve restarts from that dispatch').toBe(true)
  })

  it('a pass that offers the same ticket twice reads GitHub once', async () => {
    const fakes = api(pullState(), [])
    const { g } = gate(fakes, { memoMs: 60_000 })
    expect(await g.stale(settled())).toBe(false)
    expect(await g.stale(settled())).toBe(false)
    expect(fakes.reads.pulls).toHaveLength(1)
    expect(fakes.reads.asks).toHaveLength(1)
  })

  it('the verdict survives a router restart, because it is the record and not the memory', async () => {
    const positions = store()
    const first = new FreshnessGate({ home: 'o/r', api: { pull: () => Promise.resolve(pullState()), comments: () => Promise.resolve([]) },
      positions, self: 'me', warn: () => {}, now: () => Date.parse(at), memoMs: 0 })
    expect(await first.stale(settled())).toBe(false)
    const second = new FreshnessGate({ home: 'o/r', api: { pull: () => Promise.resolve(pullState()), comments: () => Promise.resolve([]) },
      positions, self: 'me', warn: () => {}, now: () => Date.parse(at) + HOUR, memoMs: 0 })
    expect(await second.stale(settled()), 'a restart does not buy a session for a state that has not moved').toBe(true)
  })

  it('a pull request GitHub has no answer for is not the same state as an open one', () => {
    expect(pullSnapshot(undefined)).toBe('gone')
    expect(pullSnapshot(pullState())).toBe('open/22f2b15/0/2026-11-09T09:00:00.000Z')
    expect(pullSnapshot({ open: false, merged: true, createdAt: at })).toBe('merged/?/0/?')
  })
})
