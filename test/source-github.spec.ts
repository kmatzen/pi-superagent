import { describe, expect, it } from 'vitest'
import { GithubSource, REPLY_MARKER, type GithubApi, type IssueComment, type IssueState, type PrReview } from '../src/pi/source-github.ts'

// Dates live one hour back from the run: a cold start reads a day, and pinned fixture dates expire.
const HOUR = 3_600_000
const at = new Date(Date.now() - HOUR).toISOString()
const comment = (over: Partial<IssueComment> = {}): IssueComment => ({
  issue: 12, author: 'octocat', association: 'OWNER', at: at, body: 'ship the panel tonight', ...over,
})
const issue = (over: Partial<IssueState> = {}): IssueState => ({
  issue: 12, title: 'DO: ship the panel', author: 'octocat', association: 'OWNER',
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

  it("every issue the agent's own account opens is a request, whatever its title", async () => {
    // Agents file the bugs they find as the engine's account (2026-11-11, issue 369), and the ask system that once
    // shared this board is gone, so no title verb keeps an issue out.
    const issues: IssueState[] = []
    const f = fixture([], issues)
    f.source.bootstrap()
    await f.source.poll()
    issues.push(issue({ issue: 30, author: 'superagent[bot]', title: 'DECIDE: which proxy tier to keep' }))
    issues.push(issue({ issue: 31, author: 'superagent[bot]', title: 'Fix the node graph outputs reading 0.0' }))
    expect((await f.source.poll()).map(t => t.text)).toEqual(['DECIDE: which proxy tier to keep', 'Fix the node graph outputs reading 0.0'])
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

  it('an issue missing from one short listing is not new when it comes back: only a confirmed close forgets it', async () => {
    // 2026-11-11 01:18:52: one listing came back short, the seen set was pruned to it, and the next poll re-fired 12
    // live issues as new requests, each one landing on its ticket as fresh input.
    const issues: IssueState[] = []
    const f = fixture([], issues)
    const states = new Map<number, 'open' | 'closed'>([[40, 'open']])
    let reads = 0
    f.api.issueState = async n => { reads++; return states.get(n) ?? 'unknown' }
    f.source.bootstrap()
    await f.source.poll()
    issues.push(issue({ issue: 40, title: 'Fix the flaky export test' }))
    expect(await f.source.poll(), 'first sight').toHaveLength(1)
    issues.length = 0
    expect(await f.source.poll(), 'a short listing fires nothing').toHaveLength(0)
    issues.push(issue({ issue: 40, title: 'Fix the flaky export test', updatedAt: new Date(Date.now() + HOUR).toISOString() }))
    expect(await f.source.poll(), 'GitHub said it was open, so it is not new when the listing recovers').toHaveLength(0)
    issues.length = 0
    states.set(40, 'closed')
    await f.source.poll()
    issues.push(issue({ issue: 40, title: 'Fix the flaky export test', updatedAt: new Date(Date.now() + 2 * HOUR).toISOString() }))
    expect(await f.source.poll(), 'a confirmed close, then a reopen, is a person saying go again').toHaveLength(1)
    issues.length = 0
    states.delete(40)
    reads = 0
    for (let n = 0; n < 25; n++) await f.source.poll()
    expect(reads, 'an issue that never answers costs a bounded number of reads, then is forgotten').toBe(20)
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

  it('a standing ask gets its launch back when the router says yes, and nothing is written to the board', async () => {
    // Labels are gone (operator, 2026-11-10): the re-grant is a trigger and nothing else. The api here has no
    // label write at all, so a source that still tried to make one would fail this test by throwing.
    const f = fixture([], [issue({ issue: 214, title: 'Keep the panel green' })])
    f.store.set('source:github:o/r:issues', ['#214'])
    const asked: string[] = []
    const source = new GithubSource(f.api, {
      repo: 'o/r', self: 'superagent[bot]',
      regrant: (_issue, key) => { const yes = asked.length === 0; asked.push(key); return yes },
    }, f.store)
    source.bootstrap()
    const fired = await source.poll()
    expect(fired.map(tr => tr.text), 'the ask fires again').toEqual(['Keep the panel green'])
    expect(fired[0]).toMatchObject({ id: expect.stringMatching(/^github:#214:grant:/), meta: { via: 'grant', author: 'octocat' } })
    expect(await source.poll(), 'the counter says no the second time').toHaveLength(0)
    expect(f.kv.has('source:github:o/r:label-grants'), 'no grant journal is kept').toBe(false)
  })

  it('every open issue is standing work, whatever its title or author; a bot\'s issue is not', async () => {
    // Operator, 2026-11-10: "unlabeled issues should absolutely be processed"; 2026-11-11: the ask system is gone,
    // and with it the title verbs that kept its issues out. A bot's issue is not a person's request, as on first sight.
    const f = fixture([], [
      issue({ issue: 220, title: 'rename the Export button to Ship' }),
      issue({ issue: 221, title: 'MERGE widget 1290 once its gates are green' }),
      issue({ issue: 222, title: 'Fix the panel going blank after a reload', author: 'superagent[bot]' }),
      issue({ issue: 223, title: 'Bump the base image', author: 'github-actions[bot]' }),
      issue({ issue: 224, title: 'DO pick the compute route for the run', author: 'superagent[bot]' }),
      issue({ issue: 225, title: 'RUN /reload in the three sessions', author: 'superagent[bot]' }),
    ])
    f.store.set('source:github:o/r:issues', ['#220', '#221', '#222', '#223', '#224', '#225'])
    const asked: string[] = []
    const source = new GithubSource(f.api, {
      repo: 'o/r', self: 'superagent[bot]', bots: new Set(['github-actions[bot]']),
      regrant: (_issue, key) => { asked.push(key); return true },
    }, f.store)
    source.bootstrap()
    const fired = (await source.poll()).map(tr => tr.text)
    expect(fired, 'every open issue is work, whatever its title').toEqual(['rename the Export button to Ship',
      'MERGE widget 1290 once its gates are green', 'Fix the panel going blank after a reload',
      'DO pick the compute route for the run', 'RUN /reload in the three sessions'])
    expect(asked, 'only a bot\'s issue is never offered to the router').toEqual(['#220', '#221', '#222', '#224', '#225'])
  })

  it('the router is the only thing that says no to standing work, and a no fires nothing', async () => {
    // What keeps a finished issue from churning is the router's predicate (an ended assignment whose worker
    // released, no live worker, no ticket that already ended) and REGRANT_CAP of two launches a day.
    const f = fixture([], [issue({ issue: 216, title: 'DONE: shipped last week' })])
    f.store.set('source:github:o/r:issues', ['#216'])
    let called = 0
    const source = new GithubSource(f.api, {
      repo: 'o/r', self: 'superagent[bot]',
      regrant: () => { called++; return false },
    }, f.store)
    source.bootstrap()
    expect(await source.poll(), 'the source asks, and the router answers no').toHaveLength(0)
    expect(called).toBe(1)
  })
})
