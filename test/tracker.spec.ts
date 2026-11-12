import { describe, expect, it } from 'vitest'
import { PullTracker, trackerRows, trackerText } from '../src/pi/tracker.ts'
import type { PullState } from '../src/pi/pulls.ts'
import type { Ticket } from '../src/core/index.ts'

const created = '2026-11-12T00:00:00Z'
const ticket = (follows: Array<{ thread: string; closed?: 'merged' | 'closed' }>, issue = '382'): Ticket => ({
  id: 't1', channels: [{ source: 'github', thread: `#${issue}`, address: { issue } }],
  follows: follows.map(f => ({ thread: f.thread, own: true, ...(f.closed ? { closed: { at: created, outcome: f.closed } } : {}) })),
} as unknown as Ticket)
const states = (byId: Record<string, Partial<PullState>>) => (id: string): PullState | undefined =>
  byId[id] ? { open: true, merged: false, createdAt: created, ...byId[id] } : undefined

describe('the status of a ticket with several pull requests', () => {
  it('lists them in the worker\'s merge order across repositories, and names who acts next', () => {
    const t = ticket([{ thread: 'github:org/app#210' }, { thread: 'github:org/kit#345' }])
    const rows = trackerRows(t, ['https://github.com/org/kit/pull/345', 'https://github.com/org/app/pull/210'],
      states({ 'org/kit#345': { title: 'kit: build-heap CLI', mergeableState: 'clean' }, 'org/app#210': { title: 'app | uses it', draft: true } }), 'o/inbox')
    expect(rows.map(r => [r.label, r.status, r.next])).toEqual([
      ['kit#345', 'ready to merge', '**you: merge**'],
      ['app#210', 'draft', 'after #1'],
    ])
    const text = trackerText('#382', rows)
    expect(text).toContain('### Pull requests for #382: 0 of 2 merged')
    expect(text, 'a title cannot break the table').toContain('[app#210](https://github.com/org/app/pull/210) app \\| uses it | draft | after #1 |')
  })

  it('a fix the worker owns is the worker\'s whatever its place, and a merged one is done', () => {
    const t = ticket([{ thread: 'github:org/kit#1', closed: 'merged' }, { thread: 'github:org/app#2' }, { thread: 'github:org/doc#3' }])
    const rows = trackerRows(t, ['https://github.com/org/kit/pull/1', 'https://github.com/org/app/pull/2', 'https://github.com/org/doc/pull/3'],
      states({ 'org/app#2': { mergeableState: 'blocked' }, 'org/doc#3': { mergeable: false } }), 'o/inbox')
    expect(rows.map(r => [r.status, r.next])).toEqual([
      ['merged', ''], ['needs approval or checks', '**you: review**'], ['merge conflict', 'worker: resolve the conflict'],
    ])
    expect(trackerText('#382', rows)).toContain('1 of 3 merged')
  })

  it('shows an open pull request the latest report left out, and leaves out a closed one', () => {
    const t = ticket([{ thread: 'github:org/kit#343', closed: 'closed' }, { thread: 'github:org/kit#345' }, { thread: 'github:org/app#210' },
      { thread: 'github:org/app#199' }])
    const rows = trackerRows(t, ['https://github.com/org/kit/pull/345', 'https://github.com/org/app/pull/210'], states({}), 'o/inbox')
    expect(rows.map(r => r.label), 'the superseded close is history; the forgotten open one is news').toEqual(['kit#345', 'app#210', 'app#199'])
    const said = trackerRows(t, ['https://github.com/org/kit/pull/343', 'https://github.com/org/kit/pull/345'], states({}), 'o/inbox', true)
    expect(said.map(r => [r.label, r.status])[0], 'in a declared plan, a step someone closed unmerged stays said').toEqual(['kit#343', 'closed without merging'])
    expect(trackerRows(t, ['https://github.com/org/kit/pull/343', 'https://github.com/org/kit/pull/345'], states({}), 'o/inbox', false)
      .map(r => r.label), 'with no plan declared it is noise').not.toContain('kit#343')
  })

  it('names the order\'s pull requests only when the ticket follows them', () => {
    const t = ticket([{ thread: 'github:org/kit#5' }])
    expect(trackerRows(t, ['https://github.com/org/kit/pull/5', 'https://github.com/org/kit/pull/6', 'not a url'], states({}), 'o/inbox')
      .map(r => r.label)).toEqual(['kit#5'])
  })
})

describe('the status comment on the issue', () => {
  const board = (write?: (issue: number, id: number | undefined, body: string) => Promise<{ id: number; url: string }>,
                 byId: Record<string, Partial<PullState>> = {}) => {
    const kv = new Map<string, unknown>()
    const logged: string[] = []
    const tracker = new PullTracker({
      kv: { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k, v) => { kv.set(k, v) } },
      home: 'o/inbox', state: id => states(byId)(id), log: event => logged.push(event), now: () => new Date('2026-11-12T03:41:00Z'),
      ...(write ? { write } : {}),
    })
    return { tracker, logged, byId, kv }
  }
  const two = ticket([{ thread: 'github:org/kit#345' }, { thread: 'github:org/app#210' }])

  it('is posted once, edited only when its text changes, and never for a single pull request', async () => {
    const writes: Array<{ id: number | undefined; body: string }> = []
    const b = board(async (_issue, id, body) => { writes.push({ id, body }); return { id: id ?? 77, url: 'https://github.com/o/inbox/issues/382#issuecomment-77' } })
    await b.tracker.refresh(ticket([{ thread: 'github:org/kit#345' }]))
    expect(writes, 'one pull request is its own status').toEqual([])
    b.tracker.ordered(two, ['https://github.com/org/kit/pull/345', 'https://github.com/org/app/pull/210'])
    await b.tracker.refresh(two)
    await b.tracker.refresh(two)
    expect(writes.map(w => w.id), 'posted, then unchanged').toEqual([undefined])
    expect(writes[0]!.body).toContain('last changed 03:41 UTC')
    expect(b.tracker.url('t1')).toBe('https://github.com/o/inbox/issues/382#issuecomment-77')
    b.byId['org/kit#345'] = { mergeableState: 'clean' }
    await b.tracker.refresh(two)
    expect(writes.map(w => w.id), 'a changed state edits the same comment').toEqual([undefined, 77])
    expect(writes[1]!.body).toContain('ready to merge')
  })

  it('with no order from a report, each pull request names its own next step, and a merge stays on the list', async () => {
    const writes: string[] = []
    const b = board(async (_issue, id, body) => { writes.push(body); return { id: id ?? 9, url: 'u' } },
      { 'org/kit#345': { mergeableState: 'clean' }, 'org/app#210': { mergeableState: 'clean' } })
    await b.tracker.refresh(two)
    expect(writes.at(-1), 'independent pull requests are not a sequence nobody declared').toContain('| ready to merge | **you: merge** |\n| 2 |')
    expect(writes.at(-1)).not.toContain('after #')
    await b.tracker.refresh(ticket([{ thread: 'github:org/kit#345', closed: 'merged' }, { thread: 'github:org/app#210' }]))
    expect(writes.at(-1), 'the merged one is still there, counted').toContain('1 of 2 merged')
    await b.tracker.refresh(ticket([{ thread: 'github:org/kit#345', closed: 'merged' }, { thread: 'github:org/app#210', closed: 'closed' }]))
    expect(writes.at(-1), 'one the work dropped, with no plan declared, drops off').toContain('1 of 1 merged')
    expect(writes.at(-1)).not.toContain('app#210')
    expect(writes.at(-1)).toContain('[kit#345](https://github.com/org/kit/pull/345) | merged | - |')
  })

  it('a new report keeps what already merged at the top, and drops what closed unmerged', () => {
    const b = board()
    const landed = ticket([{ thread: 'github:org/kit#343', closed: 'closed' }, { thread: 'github:org/kit#345', closed: 'merged' },
      { thread: 'github:org/app#210' }, { thread: 'github:org/doc#7' }])
    b.tracker.ordered(landed, ['https://github.com/org/kit/pull/343', 'https://github.com/org/kit/pull/345', 'https://github.com/org/app/pull/210'])
    b.tracker.ordered(landed, ['https://github.com/org/app/pull/210', 'https://github.com/org/doc/pull/7'])
    const order = (b.kv.get('tracker:t1') as { order: string[] }).order
    expect(trackerRows(landed, order, () => undefined, 'o/inbox').map(r => r.label)).toEqual(['kit#345', 'app#210', 'doc#7'])
  })

  it('a write that fails is said and tried again on the next change, not lost', async () => {
    let fail = true
    const writes: Array<number | undefined> = []
    const b = board(async (_issue, id) => { if (fail) throw new Error('HTTP 502'); writes.push(id); return { id: 5, url: 'u' } })
    b.tracker.ordered(two, ['https://github.com/org/kit/pull/345', 'https://github.com/org/app/pull/210'])
    await b.tracker.refresh(two)
    expect(b.logged).toEqual(['tracker.write_failed'])
    fail = false
    await b.tracker.refresh(two)
    expect(writes, 'the next refresh posts it').toEqual([undefined])
  })
})
