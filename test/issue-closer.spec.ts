import { describe, expect, it } from 'vitest'
import { IssueCloser } from '../src/pi/issue-closer.ts'
import type { Ticket } from '../src/core/index.ts'
import type { PullState } from '../src/pi/pulls.ts'

// Measured 2026-11-24 on agent-inbox#928: the fix merged upstream (kit#148) while the fork's duplicate (old/kit#14) sat
// open in an archived repository, which answers "read-only" to a close. The issue stayed open and intake asked again.
const ticket = (outcome: 'closed' | 'abandoned'): Ticket => ({
  id: 't1',
  channels: [{ source: 'github', thread: '#928', address: { issue: '928' } }],
  ended: { at: '2026-11-24T02:42:54Z', by: 'executor', outcome: 'merged' },
  follows: [{ thread: 'github:kmatzen/kit#148', own: true, closed: { at: '2026-11-24T02:42:54Z', outcome: 'merged' } },
    { thread: 'github:old/kit#14', own: true,
      closed: { at: '2026-11-24T03:00:00Z', outcome, ...(outcome === 'abandoned' ? { reason: 'the fork is archived' } : {}) } }],
} as unknown as Ticket)

const harness = (t: Ticket) => {
  const closed: number[] = []
  const asked: string[] = []
  const store = new Map<string, unknown>()
  const closer = new IssueCloser({
    tickets: { get: id => (id === t.id ? t : undefined), open: () => [] },
    kv: { get: <T,>(key: string) => store.get(key) as T | undefined, set: (key, value) => void store.set(key, value) },
    closeIssue: async issue => { closed.push(issue) },
    // GitHub's answers, per pull: #148 merged, the fork's duplicate open forever. The board issue answers "no such
    // pull", because a pull answer there makes the closer skip the issue entirely.
    pullApi: { pull: async (repo, number) => {
      asked.push(`${repo}#${number}`)
      if (repo === 'kmatzen/inbox') return undefined
      const merged = repo === 'kmatzen/kit'
      return { open: !merged, merged, createdAt: '2026-11-24T00:00:00Z' } satisfies PullState },
      comments: async () => [], reviews: async () => [] },
    home: 'kmatzen/inbox', flushReplies: async () => {}, log: { line: () => {}, path: 'engine.log' },
    now: () => '2026-11-24T03:00:00Z',
  })
  return { closer, closed, asked }
}

describe('the board issue a finished ticket leaves open', () => {
  it('holds the issue while a pull request it closed answers open, and asks GitHub, not its memory', async () => {
    const waiting = harness(ticket('closed'))
    waiting.closer.finish('t1')
    await waiting.closer.flush()
    expect(waiting.asked, 'GitHub answers for every linked pull request, and for the thread itself').toEqual(['kmatzen/inbox#928', 'kmatzen/kit#148', 'old/kit#14'])
    expect(waiting.closed, 'an open pull request holds the issue open').toEqual([])
  })

  it('closes the issue, and asks nothing, when the open one is a pull request a person wrote off', async () => {
    const done = harness(ticket('abandoned'))
    done.closer.finish('t1')
    await done.closer.flush()
    expect(done.asked, 'a pull request that can only answer "open" is not asked again').toEqual(['kmatzen/inbox#928', 'kmatzen/kit#148'])
    expect(done.closed, 'the board issue closes: the work landed, and the wait on the fork is over').toEqual([928])
  })
})
