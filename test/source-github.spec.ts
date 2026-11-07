import { describe, expect, it } from 'vitest'
import { GithubSource, REPLY_MARKER, type GithubApi, type IssueComment, type IssueState, type PrReview } from '../src/pi/source-github.ts'

// Dates live one hour back from the run: a cold start reads a day, and pinned fixture dates expire.
const HOUR = 3_600_000
const at = new Date(Date.now() - HOUR).toISOString()
const comment = (over: Partial<IssueComment> = {}): IssueComment => ({
  issue: 12, author: 'octocat', association: 'OWNER', at: at, body: 'ship the panel tonight', ...over,
})
const issue = (over: Partial<IssueState> = {}): IssueState => ({
  issue: 12, title: 'DO: ship the panel', labels: [], author: 'octocat', association: 'OWNER',
  createdAt: at, updatedAt: at, ...over,
})

const review = (over: Partial<PrReview> = {}): PrReview => ({
  pr: 77, repo: 'o/r', id: 500, author: 'octocat', association: 'OWNER', state: 'CHANGES_REQUESTED', at: at, body: 'use the cursor, not a scan', ...over,
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

  it('an ask-labelled issue is a question for the operator, never a request for the fleet', async () => {
    const ask = issue({ issue: 300, title: 'DECIDE the release scope', labels: ['needs-decision'] })
    const work = issue({ issue: 301, title: 'DO: ship the panel' })
    const f = fixture([], [ask, work])
    f.source.bootstrap()
    expect(await f.source.poll(), 'the first look is history, not a backlog').toHaveLength(0)
    expect(await f.source.poll(), 'an open ask must not start work, a poll after poll').toHaveLength(0)
    expect(f.source.openThreads()?.has('#300'), 'the ask thread is still a thread the router knows').toBe(true)
  })

  it("the operator's reply to an ask is an answer, not a new request", async () => {
    const ask = issue({ issue: 302, title: 'DECIDE the release scope', labels: ['needs-decision'] })
    const f = fixture([comment({ issue: 302, author: 'matzen_adobe', body: 'cut 0.1.3' })], [ask])
    f.source.bootstrap()
    expect(await f.source.poll()).toHaveLength(0)
    expect(await f.source.poll(), 'the ask channel delivers answers; the intake must not act on them').toHaveLength(0)
  })

  it('removing the label turns an answer into work, in the next poll', async () => {
    const f = fixture([], [issue({ issue: 303, title: 'DO: cut 0.1.3', labels: ['needs-decision'] })])
    f.source.bootstrap()
    await f.source.poll()
    expect(await f.source.poll()).toHaveLength(0)
    const unlabelled = fixture([], [issue({ issue: 303, title: 'DO: cut 0.1.3', labels: [] })])
    unlabelled.store.set('source:github:o/r:issues', [' #301'.trim()])
    unlabelled.source.bootstrap()
    const fired = await unlabelled.source.poll()
    expect(fired.map(t => t.text), 'the label is the fence: lift it and the request lands').toEqual(['DO: cut 0.1.3'])
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

  it("every trigger carries its author's standing in the repository, which is all the router's scope sees", async () => {
    const comments: IssueComment[] = []
    const issues: IssueState[] = []
    const reviews: PrReview[] = []
    const f = fixture(comments, issues, reviews)
    f.source.bootstrap()
    await f.source.poll()
    issues.push(issue({ issue: 13, author: 'stranger', association: 'NONE' }))
    comments.push(comment({ author: 'helper', association: 'COLLABORATOR' }))
    reviews.push(review({ author: 'teammate', association: 'MEMBER' }))
    const metas = (await f.source.poll()).map(t => t.meta)
    expect(metas).toEqual([
      expect.objectContaining({ via: 'issue', association: 'NONE', author: 'stranger' }),
      { association: 'COLLABORATOR', author: 'helper' },
      expect.objectContaining({ via: 'review', association: 'MEMBER', author: 'teammate' }),
    ])
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

  it("an issue opened from the agent's own account is not a request, so a worker cannot feed itself", async () => {
    const issues: IssueState[] = []
    const f = fixture([], issues)
    f.source.bootstrap()
    await f.source.poll()
    issues.push(issue({ author: 'superagent[bot]' }))
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
  it('a review in another repository names that repository, so its reply lands there', async () => {
    const reviews: PrReview[] = [review({ id: 30, repo: 'other/r', pr: 12 })]
    const f = fixture([], [], reviews)
    f.source.bootstrap()
    await f.source.poll()
    reviews.push(review({ id: 40, repo: 'other/r', pr: 12, body: 'ship it' }))
    const [trigger] = await f.source.poll()
    expect(trigger).toMatchObject({
      id: 'github:other/r#12:review:40',
      threads: [{ source: 'github', id: 'other/r#12' }],
      channel: { thread: 'other/r#12', address: { repo: 'other/r', issue: '12' } },
    })
  })

  it('a pull request joined late keeps its own cursor, so its history is not a replay', async () => {
    const reviews: PrReview[] = []
    const f = fixture([], [], reviews)
    f.source.bootstrap()
    await f.source.poll()
    reviews.push(review({ id: 100 }))
    expect(await f.source.poll()).toHaveLength(1)
    reviews.push(review({ id: 500, repo: 'other/r', pr: 12 }))
    expect(await f.source.poll(), 'the reviews it joined with are history, not new requests').toHaveLength(0)
    reviews.push(review({ id: 501, repo: 'other/r', pr: 12 }))
    expect((await f.source.poll()).map(t => t.id)).toEqual(['github:other/r#12:review:501'])
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
  it('a comment arrives clipped to the length an issue body gets', async () => {
    // Measured 2026-11-07 audit: a 900 KB CI log pasted into a ticket bought its own judge prompt and worker
    // brief, and the router shipped that text to GitHub in the receipt. An issue body is capped; a comment was not.
    const f = fixture([comment({ body: 'trace: at Frame()\n'.repeat(1000) })], [])
    f.source.bootstrap()
    const [trigger] = await f.source.poll()
    expect(trigger!.text).toHaveLength(4000)
  })

  it("the agent's own review and a bot's review are not requests", async () => {
    const f = fixture([], [], [review({ author: 'superagent[bot]' }), review({ id: 502, author: 'github-actions[bot]' })])
    f.source.bootstrap()
    await f.source.poll()
    expect(await f.source.poll()).toHaveLength(0)
  })
})
