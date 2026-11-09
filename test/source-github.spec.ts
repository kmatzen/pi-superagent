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
  const labelsOff: Array<{ issue: number; label: string }> = []
  const api: GithubApi = {
    comments: async since => comments.filter(c => !since || Date.parse(c.at) >= Date.parse(since)),
    issues: async () => issues,
    postComment: async (issue, body) => { posted.push({ issue, body }) },
    reviews: async sinceId => reviews.filter(r => r.id > sinceId),
    // The label write the router makes to spend an intake grant; a test that wants the write to fail deletes it.
    removeLabel: async (issue, label) => { labelsOff.push({ issue, label }) },
  }
  const source = new GithubSource(api, { repo: 'o/r', self: 'superagent[bot]', bots: new Set(['github-actions[bot]']) }, store)
  return { source, api, kv, store, posted, labelsOff }
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

  it('labels do not gate the intake: an issue opened after the first look is a request whatever it carries', async () => {
    const f = fixture([], [issue({ issue: 300, title: 'DO: cut 0.1.3' })])
    f.source.bootstrap()
    expect(await f.source.poll(), 'the first look is history, not a backlog').toHaveLength(0)
    const next = fixture([], [issue({ issue: 300, title: 'DO: cut 0.1.3' }),
                             issue({ issue: 301, title: 'DO: ship the panel', labels: ['agent-ready'] })])
    next.store.set('source:github:o/r:issues', ['#300'])
    next.source.bootstrap()
    expect((await next.source.poll()).map(t => t.text), 'no label stands between an open issue and the fleet')
      .toEqual(['DO: ship the panel'])
  })

  it('a label on an issue the seed recorded as history is the request the operator meant', async () => {
    // Measured 2026-11-08: issues 205-268 opened before the router's first look, so the seed wrote them down as
    // history and no worker took them for three days. `superagent intake` labels them; the label fires once.
    const seed = fixture([], [issue({ issue: 205, title: 'DO: rotate the deploy keys' })])
    seed.source.bootstrap()
    expect(await seed.source.poll(), 'the first look stays history').toHaveLength(0)

    // Every imported issue in that backlog is authored by the engine's own account, which the author guard
    // rejects: the label is what makes it a request.
    const f = fixture([], [issue({ issue: 205, title: 'DO: rotate the deploy keys', author: 'superagent[bot]',
                                   labels: ['agent-requested'] })])
    f.store.set('source:github:o/r:issues', ['#205'])
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', requestLabel: 'agent-requested' }, f.store)
    const fired = await f.source.poll()
    expect(fired.map(t => t.text), 'the labelled issue enters the queue')
      .toEqual(['DO: rotate the deploy keys'])
    expect(fired[0]!.meta).toMatchObject({ via: 'label', author: 'superagent[bot]' })

    const again = await f.source.poll()
    expect(again, 'the grant is spent: the label asks once, and the router takes it off the issue').toHaveLength(0)
    expect(f.labelsOff, 'the label leaves the issue with the request').toEqual([{ issue: 205, label: 'agent-requested' }])
  })

  it('a spent grant is taken off the issue, and a router that died mid-write finishes the job', async () => {
    // The grant journal commits with the positions, at the next poll; a router that died before making the
    // label write left the label sitting on an issue it had already heard, and a label on an issue is how the
    // board says "ask". The next router takes it off. The one that died before the journal committed re-fires
    // the ask, which is the at-least-once rule the read cursors follow, and the engine's id dedup swallows it.
    const rows = [issue({ issue: 207, title: 'DO: rotate the deploy keys', author: 'superagent[bot]', labels: ['agent-requested'] })]
    const f = fixture([], rows)
    f.store.set('source:github:o/r:issues', ['#207'])
    // The stand-in GitHub: taking the label off moves it out of the issue, as the write does there.
    const api: GithubApi = {
      ...f.api,
      removeLabel: async (issue, label) => {
        f.labelsOff.push({ issue, label })
        const row = rows.find(i => i.issue === issue)
        if (row) row.labels = row.labels.filter(l => l !== label)
      },
    }
    const opts = { repo: 'o/r', self: 'superagent[bot]', requestLabel: 'agent-requested' }
    const first = new GithubSource(api, opts, f.store)
    expect(await first.poll(), 'the label asks once').toHaveLength(1)
    expect(await first.poll(), 'the journal commits at the next poll, and the label comes off with it').toHaveLength(0)
    expect(rows[0]!.labels, 'the issue no longer carries the ask').toEqual([])

    const restarted = new GithubSource(api, opts, f.store)
    expect(await restarted.poll(), 'a restart hears nothing from an issue it already served').toHaveLength(0)
    expect(f.labelsOff, 'one label write, not one per poll').toEqual([{ issue: 207, label: 'agent-requested' }])

    rows[0]!.labels = ['agent-requested']
    expect((await restarted.poll()).map(t => t.text), 'a re-label asks again').toEqual(['DO: rotate the deploy keys'])
  })

  it('the intake grant is spent: the router\'s own receipt does not re-ask, and a new label does', async () => {
    // The loop issue #309 is about: GitHub moves an issue's updated_at when a comment lands, and the router's
    // receipt is a comment. Measured 2026-11-09 on the live board, 26-31 label triggers fired in a burst every
    // completed poll, hours apart, each one waking a ticket whose work had finished.
    const rows = [issue({ issue: 205, title: 'DO: merge the pull request', author: 'superagent[bot]',
                          labels: ['agent-requested'] })]
    const f = fixture([], rows)
    f.store.set('source:github:o/r:issues', ['#205'])
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', requestLabel: 'agent-requested' }, f.store)
    expect(await f.source.poll()).toHaveLength(1)

    // The label came off with the request, and the receipt moved the issue's update time: intake hears nothing.
    rows[0]!.labels = []
    rows[0]!.updatedAt = new Date().toISOString()
    expect(await f.source.poll(), 'the router\'s own speech is not a request').toHaveLength(0)

    // The board labels it again: that is a person asking a second time, and it is heard.
    rows[0]!.labels = ['agent-requested']
    rows[0]!.updatedAt = new Date().toISOString()
    const second = await f.source.poll()
    expect(second.map(t => t.text), 'a re-label is a new grant, so it asks again').toEqual(['DO: merge the pull request'])
    expect(second[0]!.id).not.toEqual('github:#205:label:spent')
  })

  it('a label that cannot be taken off still asks only once', async () => {
    // A token without label rights, or a label write that fails: the journal, not the write, is the guard.
    const rows = [issue({ issue: 206, title: 'DO: rotate the keys', author: 'superagent[bot]', labels: ['agent-requested'] })]
    const f = fixture([], rows)
    f.store.set('source:github:o/r:issues', ['#206'])
    f.api.removeLabel = async () => { throw new Error('gh api -X DELETE exited 1: HTTP 403 (Forbidden)') }
    const warned: Array<Record<string, unknown>> = []
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', requestLabel: 'agent-requested',
                                         onWarn: (event, fields) => warned.push({ event, ...fields }) }, f.store)
    expect(await f.source.poll()).toHaveLength(1)
    rows[0]!.updatedAt = new Date().toISOString()
    expect(await f.source.poll(), 'the label is still on the issue, and the grant journal is what stops it').toHaveLength(0)
    expect(warned[0], 'this fixture has no label-actor read, and says so once').toMatchObject({ event: 'intake.label_actor_unavailable', issue: '#206' })
    expect(warned.find(w => w.event === 'intake.label_failed'), 'the label write is complained about too').toMatchObject({ issue: '#206' })
  })

  it('a label older than the router\'s own reply is an ask it answered, not a second one', async () => {
    // Lock 2, for the case the grant journal cannot outlive: the journal is gone (a rebuilt database, the
    // 4000-key cap, a router moved to a new machine) and the issue still carries the label its own receipts
    // followed. GitHub kept the order: the label at 21:46, and every one of #255's dispatches woke on a label
    // trigger its own receipt had just re-minted, all of them human:true.
    const rows = [issue({ issue: 255, title: 'MERGE: the pull request', author: 'superagent[bot]', labels: ['agent-requested'] })]
    const f = fixture([], rows)
    f.store.set('source:github:o/r:issues', ['#255'])
    f.api.labelEvent = async () => ({ actor: 'superagent[bot]', at: new Date(Date.now() - 3 * HOUR).toISOString() })
    f.api.commentsFor = async () => [comment({
      issue: 255, author: 'superagent[bot]', at: new Date(Date.now() - HOUR).toISOString(),
      body: '#255 ready: the pull request merged <!-- superagent -->',
    })]
    const warned: Array<Record<string, unknown>> = []
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', requestLabel: 'agent-requested',
                                         onWarn: (event, fields) => warned.push({ event, ...fields }) }, f.store)
    expect(await f.source.poll(), 'a receipt after the label proves the ask was answered').toHaveLength(0)
    expect(await f.source.poll(), 'a refused ask is spent, so it says nothing twice').toHaveLength(0)
    expect(f.labelsOff, 'and its label leaves the issue, so the board reads it as heard').toEqual([{ issue: 255, label: 'agent-requested' }])
    expect(warned[0]).toMatchObject({ event: 'intake.label_stale', issue: '#255', by: 'superagent[bot]' })
  })

  it('a label that lands after the router\'s last reply is a person asking a second time, and it names them', async () => {
    const rows = [issue({ issue: 255, title: 'MERGE: the pull request', author: 'superagent[bot]', labels: ['agent-requested'] })]
    const f = fixture([], rows)
    f.store.set('source:github:o/r:issues', ['#255'])
    const labeledAt = new Date(Date.now() - 30 * 60_000).toISOString()
    f.api.labelEvent = async () => ({ actor: 'octocat', at: labeledAt })
    f.api.commentsFor = async () => [comment({
      issue: 255, author: 'superagent[bot]', at: new Date(Date.now() - HOUR).toISOString(), body: 'ready: merged <!-- superagent -->',
    })]
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', bots: new Set(['ci-*']), requestLabel: 'agent-requested' }, f.store)
    const fired = await f.source.poll()
    expect(fired.map(t => t.text), 'a new label is the door intake keeps open').toEqual(['MERGE: the pull request'])
    // The asker is whoever applied the label, not the issue's author: crediting the author called the bot's
    // own login a human, which is how a receipt read as the operator asking again.
    expect(fired[0]).toMatchObject({ actor: { source: 'github', id: 'octocat' }, human: true,
      meta: { via: 'label', author: 'superagent[bot]', labelActor: 'octocat', labeledAt } })
  })

  it('a label a bot applied is a grant, not a person\'s ask', async () => {
    const rows = [issue({ issue: 256, title: 'DO: rescan the board', author: 'superagent[bot]', labels: ['agent-requested'] })]
    const f = fixture([], rows)
    f.store.set('source:github:o/r:issues', ['#256'])
    f.api.labelEvent = async () => ({ actor: 'ci-bot', at: new Date(Date.now() - 30 * 60_000).toISOString() })
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', bots: new Set(['ci-*']), requestLabel: 'agent-requested' }, f.store)
    const fired = await f.source.poll()
    expect(fired.map(t => t.text), 'the ask is heard: intake labels with the deployment token, so the label is a grant').toEqual(['DO: rescan the board'])
    expect(fired[0]!.human, 'a bot\'s label does not resume a ticket a person closed').toBe(false)
  })

  it('a label author GitHub cannot name costs the ask nothing, and one complaint', async () => {
    // Losing intake is worse than the loop lock 1 already stops: every unreadable answer fires the ask.
    const rows = [issue({ issue: 257, title: 'DO: rotate the keys', author: 'superagent[bot]', labels: ['agent-requested'] })]
    const f = fixture([], rows)
    f.store.set('source:github:o/r:issues', ['#257'])
    f.api.labelEvent = async () => { throw new Error('gh api exited 1: HTTP 500') }
    const warned: Array<Record<string, unknown>> = []
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', requestLabel: 'agent-requested',
                                         onWarn: (event, fields) => warned.push({ event, ...fields }) }, f.store)
    expect(await f.source.poll()).toHaveLength(1)
    expect(await f.source.poll(), 'the grant journal is spent, so the read is not made again').toHaveLength(0)
    expect(warned.filter(w => w.event === 'intake.label_actor_unreadable'), 'one complaint per issue, not one per poll').toHaveLength(1)
  })

  it('a source without the label-actor read asks on the grant journal alone, and says so once', async () => {
    const rows = [issue({ issue: 258, title: 'DO: rotate the keys', author: 'superagent[bot]', labels: ['agent-requested'] })]
    const f = fixture([], rows)
    f.store.set('source:github:o/r:issues', ['#258'])
    const warned: Array<Record<string, unknown>> = []
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', requestLabel: 'agent-requested',
                                         onWarn: (event, fields) => warned.push({ event, ...fields }) }, f.store)
    expect(await f.source.poll()).toHaveLength(1)
    expect(await f.source.poll()).toHaveLength(0)
    expect(warned.filter(w => w.event === 'intake.label_actor_unavailable')).toHaveLength(1)
  })

  it('an issue the seed recorded stays silent without the label', async () => {
    const f = fixture([], [issue({ issue: 206, title: 'DO: rotate the deploy keys', labels: ['agent-ready'] })])
    f.store.set('source:github:o/r:issues', ['#206'])
    f.source = new GithubSource(f.api, { repo: 'o/r', self: 'superagent[bot]', requestLabel: 'agent-requested' }, f.store)
    expect(await f.source.poll(), 'a label the engine does not grant is not a request').toHaveLength(0)
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
