import { describe, expect, it } from 'vitest'
import { GithubSource, REPLY_MARKER, type GithubApi, type IssueComment, type IssueState, type PrReview } from '../src/pi/source-github.ts'

// Dates live one hour back from the run: a cold start reads a day, and pinned fixture dates expire.
const HOUR = 3_600_000
const at = new Date(Date.now() - HOUR).toISOString()
const comment = (over: Partial<IssueComment> = {}): IssueComment => ({
  issue: 12, author: 'octocat', at: at, body: 'ship the panel tonight', ...over,
})
const issue = (over: Partial<IssueState> = {}): IssueState => ({
  issue: 12, title: 'DO: ship the panel', labels: [], author: 'octocat',
  createdAt: at, updatedAt: at, ...over,
})

const review = (over: Partial<PrReview> = {}): PrReview => ({
  pr: 77, id: 500, author: 'octocat', state: 'CHANGES_REQUESTED', at: at, body: 'use the cursor, not a scan', ...over,
})

function fixture(comments: IssueComment[], issues: IssueState[], reviews: PrReview[] = []) {
  const kv = new Map<string, unknown>()
  const store = { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k: string, v: unknown) => { kv.set(k, v) } }
  const posted: Array<{ issue: number; body: string }> = []
  const api: GithubApi = {
    comments: async since => comments.filter(c => !since || Date.parse(c.at) >= Date.parse(since)),
    issues: async () => issues,
    postComment: async (issue, body) => { posted.push({ issue, body }) },
    reviews: async sinceId => reviews.filter(r => r.id > sinceId),
  }
  const source = new GithubSource(api, { repo: 'o/r', self: 'superagent[bot]', bots: new Set(['github-actions[bot]']) }, store)
  return { source, api, kv, store, posted }
}

describe('GithubSource', () => {
  it('a comment becomes a trigger on the issue thread, addressed for the reply', async () => {
    const f = fixture([comment()], [])
    f.source.bootstrap()
    const [trigger] = await f.source.poll()
    expect(trigger).toMatchObject({
      source: 'github', human: true, at: at, text: 'ship the panel tonight',
      threads: [{ source: 'github', id: '#12' }],
      channel: { source: 'github', thread: '#12', address: { issue: '12' } },
    })
  })

  it('a crash before the next poll rewinds the cursor: the request replays, same id — never lost', async () => {
    // Intake.tla C3/C6 in code: poll 1 emits and STAGES the cursor; the process dies
    // before poll 2 commits it. The fresh source must re-emit the very same trigger
    // (engine.receive dedups by this id) — a committed-at-emit cursor loses it forever.
    const f = fixture([comment()], [])
    f.source.bootstrap()
    const first = await f.source.poll()
    expect(first).toHaveLength(1)
    const survivor = new GithubSource(f.api,
      { repo: 'o/r', self: 'superagent[bot]', bots: new Set() }, f.store)
    survivor.bootstrap()
    const replay = await survivor.poll()
    expect(replay.map(t => t.id)).toEqual(first.map(t => t.id))
    expect(await survivor.poll()).toHaveLength(0)  // now committed: committed-once stays once
  })

  it('the read position means a restart reads nothing twice', async () => {
    const f = fixture([comment()], [])
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(1)
    expect(await f.source.poll()).toHaveLength(0)
  })

  it("the router's own comment is not a request", async () => {
    const f = fixture([comment({ author: 'superagent[bot]' })], [])
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(0)
  })

  it('a reply from the agent is not a request, even when the operator shares its login', async () => {
    const f = fixture([comment({ author: 'octocat_dev', body: 'accepted: opening a ticket\n\n' + REPLY_MARKER })], [])
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(0)
  })

  it('a bot comment arrives as work nobody was asked for, so the gate can filter it', async () => {
    const f = fixture([comment({ author: 'github-actions[bot]', body: 'build red' })], [])
    f.source.bootstrap()
    const [trigger] = await f.source.poll()
    expect(trigger?.human).toBe(false)
  })

  it('a cold start reads a day back, not the whole repository history', () => {
    const f = fixture([], [])
    f.source.bootstrap()
    const since = String(f.kv.get('source:github:o/r:since'))
    expect(Date.parse(since)).toBeGreaterThan(Date.now() - 90_000_000)
    f.source.bootstrap()
    expect(String(f.kv.get('source:github:o/r:since'))).toBe(since)
  })

  it('opening an issue is the request: title and body, no label needed, fired once', async () => {
    const issues: IssueState[] = []
    const f = fixture([], issues)
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(0)
    issues.push(issue({ body: 'Ship the panel before the review on Friday.' }))
    const triggers = await f.source.poll()
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({
      human: true, source: 'github', at: at,
      actor: { source: 'github', id: 'octocat' },
      text: 'DO: ship the panel\n\nShip the panel before the review on Friday.',
      channel: { source: 'github', thread: '#12', address: { issue: '12' } },
      meta: { via: 'issue' },
    })
    expect(await f.source.poll()).toHaveLength(0)
  })

  it('an issue already open when the source first looks is not a request: that was the import replay', async () => {
    const issues = [issue()]
    const f = fixture([], issues)
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(0)
    expect(await f.source.poll()).toHaveLength(0)
  })

  it('an issue opened by a bot is not a request, and the gate sees why', async () => {
    const issues: IssueState[] = []
    const f = fixture([], issues)
    f.source.bootstrap()
    await f.source.poll()
    issues.push(issue({ author: 'github-actions[bot]' }))
    expect(await f.source.poll()).toHaveLength(0)
  })

  it('an issue carrying the agent\'s own footer is not a request', async () => {
    const issues: IssueState[] = []
    const f = fixture([], issues)
    f.source.bootstrap()
    await f.source.poll()
    issues.push(issue({ body: 'accepted: opening a ticket\n\n' + REPLY_MARKER }))
    expect(await f.source.poll()).toHaveLength(0)
  })

  it('reopening an issue is a person saying go again', async () => {
    const issues: IssueState[] = []
    const f = fixture([], issues)
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(0)
    issues.push(issue())
    expect(await f.source.poll()).toHaveLength(1)
    issues.pop()
    expect(await f.source.poll()).toHaveLength(0)
    issues.push(issue())
    expect(await f.source.poll()).toHaveLength(1)
  })

  it('a new issue and a comment on it are two triggers on one thread, for the one-ticket rule', async () => {
    const issues: IssueState[] = []
    const f = fixture([comment()], issues)
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(1)
    issues.push(issue())
    const triggers = await f.source.poll()
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.id.startsWith('github:#12:issue:')).toBe(true)
  })
  it('fires again when an issue is closed and reopened with the same title', async () => {
    const issues: IssueState[] = []
    const f = fixture([], issues)
    f.source.bootstrap()
    await f.source.poll()
    issues.push(issue())
    expect(await f.source.poll()).toHaveLength(1)
    issues.length = 0
    expect(await f.source.poll()).toHaveLength(0)
    issues.push(issue({ updatedAt: new Date(Date.now() + HOUR).toISOString() }))
    expect(await f.source.poll()).toHaveLength(1)
  })

  it('a submitted review is a trigger on the PR thread, addressed for the reply', async () => {
    const reviews: PrReview[] = []
    const f = fixture([], [], reviews)
    f.source.bootstrap()
    await f.source.poll()
    reviews.push(review())
    const triggers = await f.source.poll()
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.id).toBe('github:#77:review:500')
    expect(triggers[0]!.text).toContain('changes requested')
    expect(triggers[0]!.channel).toMatchObject({ thread: '#77', address: { issue: '77' } })
  })
  it('the first look at reviews is silent history, not a replay of requests', async () => {
    const f = fixture([], [], [review(), review({ id: 501 })])
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(0)
    expect(await f.source.poll()).toHaveLength(0)
  })
  it('a crash before the next poll rewinds the review cursor: the request is seen again', async () => {
    const reviews = [] as PrReview[]
    const f = fixture([], [], reviews)
    f.source.bootstrap()
    await f.source.poll()
    reviews.push(review())
    expect(await f.source.poll()).toHaveLength(1)
    // A restart is a fresh source over the same store: the cursor never reached it, so the review fires again.
    const api: GithubApi = { comments: async () => [], issues: async () => [], postComment: async () => {}, reviews: async sinceId => reviews.filter(r => r.id > sinceId) }
    const restarted = new GithubSource(api, { repo: 'o/r', self: 'superagent[bot]' }, f.store)
    expect(await restarted.poll()).toHaveLength(1)
  })
  it("the agent's own review and a bot's review are not requests", async () => {
    const f = fixture([], [], [review({ author: 'superagent[bot]' }), review({ id: 502, author: 'github-actions[bot]' })])
    f.source.bootstrap()
    await f.source.poll()
    expect(await f.source.poll()).toHaveLength(0)
  })
})
