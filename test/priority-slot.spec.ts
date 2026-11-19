import { describe, expect, it } from 'vitest'
import { GithubSource, wonSlotReason, type GithubApi, type IssueState } from '../src/pi/source-github.ts'

// agent-inbox#660: `priority:high` wins the next free slot; the lane behind it keeps the oldest-starved tie-break.
const HOUR = 3_600_000
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString()
const issue = (over: Partial<IssueState>): IssueState => ({
  issue: 1, title: `ask ${over.issue}`, labels: [], author: 'octocat', association: 'OWNER',
  createdAt: ago(100), updatedAt: ago(1), ...over,
})

function fixture(issues: IssueState[]) {
  const kv = new Map<string, unknown>()
  const store = { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k: string, v: unknown) => { kv.set(k, v) } }
  const api: GithubApi = {
    comments: async () => [],
    issues: async () => issues,
    postComment: async () => {},
  }
  const granted: Array<{ issue: number; priority: boolean }> = []
  // The router answers the grant per issue; here every eligible thread wins while the source is asked.
  const source = new GithubSource(api, {
    repo: 'o/r', self: 'superagent[bot]', bots: new Set(['github-actions[bot]']),
    regrant: (issue, _key, priority = false) => { granted.push({ issue, priority }); return true },
  }, store)
  return { source, kv, granted }
}

const grantThreads = (triggers: Awaited<ReturnType<GithubSource['poll']>>) =>
  triggers.filter(t => t.meta?.via === 'grant').map(t => t.threads[0]!.id)

describe('priority:high slot ranking', () => {
  it('the priority:high thread wins the grant, the second grant goes to the oldest starved', async () => {
    const f = fixture([
      issue({ issue: 100, updatedAt: ago(72) }),
      issue({ issue: 101, updatedAt: ago(48) }),
      issue({ issue: 102, updatedAt: ago(1), labels: ['priority:high'] }),
    ])
    f.source.bootstrap()
    await f.source.poll()
    expect(grantThreads(await f.source.poll())).toEqual(['#102', '#100', '#101'])
    expect(f.granted.map(g => g.priority)).toEqual([true, false, false])
  })

  it('one priority grant per poll: the second labelled thread waits its turn behind the oldest starved', async () => {
    const f = fixture([
      issue({ issue: 100, updatedAt: ago(72) }),
      issue({ issue: 102, updatedAt: ago(1), labels: ['priority:high'] }),
      issue({ issue: 103, updatedAt: ago(2), labels: ['priority:high'] }),
    ])
    f.source.bootstrap()
    await f.source.poll()
    // #102 is labelled too, but the lane's oldest wins and the cap gives the queue the next slot.
    expect(grantThreads(await f.source.poll())).toEqual(['#103', '#100'])
    expect(f.granted.map(g => g.issue)).toEqual([103, 100])
  })

  it('the win names its lane: priority over unanswered over a plain win by age', () => {
    expect(wonSlotReason(true, true)).toBe('priority')
    expect(wonSlotReason(false, true)).toBe('unanswered')
    expect(wonSlotReason(false, false)).toBe('oldest-starved')
  })
})
