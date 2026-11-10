/** GitHub as a Source: issues, comments and reviews become Triggers with content-derived ids and durable
 *  read positions. */
import { isListed } from './authors.ts'
import { createHash } from 'node:crypto'
import type { Trigger } from '../core/index.ts'

export interface IssueComment {
  issue: number
  author: string
  /** GitHub's author_association (OWNER, MEMBER, COLLABORATOR, NONE...): the router's scope reads write access from it. */
  association: string
  at: string
  body: string
}

export interface IssueState {
  issue: number
  title: string
  body?: string
  labels: string[]
  author: string
  association: string
  createdAt: string
  updatedAt: string
}

export interface GithubApi {
  comments(since?: string): Promise<IssueComment[]>
  issues(state: 'open' | 'closed'): Promise<IssueState[]>
  /** `repo` names a repository other than the watched one, for a conversation on a pull request there. */
  postComment(issue: number, body: string, repo?: string): Promise<void>
  /** Newest-first page of one issue's comments; a retried post looks here before speaking twice. */
  commentsFor?(issue: number, repo?: string): Promise<IssueComment[]>
  /** Open pull-request numbers: their conversations are threads a ticket can own, so closing them counts. */
  pullsOpen?(): Promise<number[]>
  /** Submitted reviews (approve / request changes) with ids above the cursor, oldest first. */
  reviews?(sinceId: number): Promise<PrReview[]>
  /** Puts a label on an issue: the standing-ask re-grant, where the router hands the launch back. */
  addLabel?(issue: number, label: string): Promise<void>
  /** Takes a label off an issue. The router uses it to spend the intake grant it has just heard. */
  removeLabel?(issue: number, label: string): Promise<void>
  /** One issue's state, asked directly: 'unknown' when the read failed, which is never a reason to stop. */
  issueState?(issue: number): Promise<'open' | 'closed' | 'unknown'>
  /**
   * Who applied a label, and when — the newest `labeled` event naming it, the only read GitHub offers for
   * "who asked". Absent, the label path falls back to the grant journal alone.
   */
  labelEvent?(issue: number, label: string): Promise<{ actor: string, at: string } | undefined>
  /** Closes an issue: the terminal end of a ticket that finished with nothing left to wait on. */
  closeIssue?(issue: number): Promise<void>
}

export interface PrReview {
  pr: number
  /** The repository the review lives in: a ticket follows pull requests beyond the watched one. */
  repo: string
  id: number
  author: string
  association: string
  state: string
  at: string
  body: string
}

export interface GithubSourceOptions {
  repo: string
  self: string
  bots?: ReadonlySet<string>
  people?: ReadonlySet<string>
  selfMarker?: string
  /** Label that turns an already-seen issue into a request; `superagent intake` puts it there. */
  requestLabel?: string
  /** Says so when a label the router has spent cannot be taken off the issue. */
  onWarn?: (event: string, fields: Record<string, unknown>) => void
  /**
   * The standing queue re-earns its launch. `agent-ready` says an issue wants an agent now; the
   * `agent-requested` grant it carries is one-shot, so a standing ask whose worker ended was entitled to
   * nothing (measured 2026-11-10: 5 standing asks queued 57 hours with 8 free slots). The router answers
   * yes within a cap and says no after it, and the counter lives in the router's store, because a label
   * the router adds and removes without memory is a surface that lies to the board.
   */
  regrant?: (issue: number, key: string) => boolean
  /** The standing queue marker, `QUEUE_LABEL` on the board. */
  queueLabel?: string
  /** The open board on every poll. The router publishes how much labelled work waits for a slot, and this is
   *  the only place that has the labels: nobody downstream may re-read GitHub to find out. */
  onOpen?: (open: readonly IssueState[]) => void
}

/** What the label path makes of one `agent-requested` label: fire the ask, or refuse it as already answered.
 *  `ask` carries who applied the label and when, when GitHub could name them. */
export type LabelGrant = { fire: true, ask?: { actor: string, at: string } } | { fire: false }

export const REQUEST_LABEL = 'agent-requested'
/** The board's standing queue marker. `REQUEST_LABEL` is a one-shot grant the router spends and takes off after
 *  each ask, so counting it measures nothing; `agent-ready` is what says an issue wants an agent right now. */
export const QUEUE_LABEL = 'agent-ready'

const sinceKey = (repo: string) => `source:github:${repo}:since`
/** Group rows by a key, keeping the order in which the keys first appear. */
const groupRows = <T,>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> =>
  rows.reduce((map, row) => map.set(key(row), [...map.get(key(row)) ?? [], row]), new Map<string, T[]>())
const issuesKey = (repo: string) => `source:github:${repo}:issues`
/**
 * Which `agent-requested` grants this router has already taken, as issue keys (`#255`). The label is intake
 * handing one issue over — an act, not a state — so it asks once. Without this journal the label path is a
 * standing order: the trigger id carries `updatedAt`, GitHub moves `updatedAt` when a comment lands, and the
 * router's own receipt is a comment, so every receipt re-asked for the whole labelled backlog. Measured
 * 2026-11-09 on matzen_adobe/superagent-board-spike: 26-31 label triggers in a burst, every completed tick,
 * #255 waking to a fourth worker hours after its work merged, #227 posting its 93rd receipt.
 */
const grantsKey = (repo: string) => `source:github:${repo}:label-grants`
const reviewsKey = (repo: string) => `source:github:${repo}:reviews`
/** Where a source persists its read positions (the SQLite kv table in practice). */
export interface PositionStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
}

const DAY_MS = 86_400_000

/** A solo operator posts from the same login the agent replies from, so the author cannot identify the
 *  agent's own writing; the footer can. */
export const REPLY_MARKER = '<!-- superagent -->'

export const commentTriggerId = (c: IssueComment): string =>
  `github:#${c.issue}:${createHash('sha1').update(`${c.author}\u0000${c.at}\u0000${c.body}`).digest('hex').slice(0, 16)}`

export class GithubSource {
  /** Deferred commit (Intake.tla C3): positions land at the next poll, once the triggers they
   *  produced are in the engine — commit-at-emit + crash = cursor past a request never accepted. */
  private staged: Array<[string, unknown]> = []
  private lastOpen: ReadonlySet<string> | undefined
  /** Issues to take the intake label off, staged with the positions so a crash re-fires, never drops. */
  private spending: number[] = []
  /** Issues to put the request label back on, at the same deferral point as the spending. */
  private regranting: number[] = []
  /** Issues whose label write has already been complained about: a token without rights fails every poll. */
  private readonly labelWarned = new Set<number>()
  /** Issues whose label author has already been complained about: an unreadable events feed is one fact, not a poll's worth of them. */
  private readonly actorWarned = new Set<number>()
  private actorReadWarned = false

  constructor(private readonly api: GithubApi, private readonly options: GithubSourceOptions,
              private readonly store: PositionStore, private readonly now: () => number = () => Date.now()) {}

  /** Threads open as of the last poll ('#N', issues and pull requests): absence is how GitHub says
   *  a conversation ended — merged, closed, or deleted all look the same from here, and all mean stop. */
  openThreads(): ReadonlySet<string> | undefined { return this.lastOpen }

  /** One thread's state, asked of GitHub directly. 'unknown' when the read failed: a ticket stays alive on an
   *  unreadable answer, because the inference this replaces stopped a live ticket whose issue was open. */
  issueState(issue: number): Promise<'open' | 'closed' | 'unknown'> {
    return this.api.issueState?.(issue) ?? Promise.resolve('unknown')
  }

  /** A cold start reads a day back: enough to catch a request made while the router was down. */
  bootstrap(): void {
    if (this.store.get<string>(sinceKey(this.options.repo))) return
    this.store.set(sinceKey(this.options.repo), new Date(this.now() - DAY_MS).toISOString())
  }

  async poll(): Promise<Trigger[]> {
    for (const [key, value] of this.staged) this.store.set(key, value)
    this.staged = []
    // Spend the grant the previous poll heard, at the same deferral point as the positions: the engine has its
    // trigger, so taking the label off now cannot lose a mandate. A removal that fails (a token without label
    // rights) costs the label's visibility on GitHub only — the grant journal above is what stops the re-ask.
    const spending = this.spending
    this.spending = []
    for (const issue of spending) {
      try {
        await this.api.removeLabel?.(issue, this.options.requestLabel ?? REQUEST_LABEL)
        this.labelWarned.delete(issue)
      } catch (error) {
        // Said once per issue, retried every poll: a router that spent a grant it cannot take off leaves the
        // label sitting on the issue, and the journal is what keeps that quiet from becoming a re-dispatch.
        if (this.labelWarned.has(issue)) continue
        this.labelWarned.add(issue)
        this.options.onWarn?.('intake.label_failed', { issue: `#${issue}`, error: String(error).slice(0, 200) })
      }
    }

    for (const issue of this.regranting) {
      // The board shows the launch coming too. A token without label rights costs visibility only: the
      // trigger fired in the poll that queued this, and the journal is the guard against a second fire.
      try { await this.api.addLabel?.(issue, this.options.requestLabel ?? REQUEST_LABEL) }
      catch (error) {
        if (!this.labelWarned.has(issue)) {
          this.labelWarned.add(issue)
          this.options.onWarn?.('regrant.label_failed', { issue, error: String(error).slice(0, 200) })
        }
      }
    }
    this.regranting = []
    return [...(await this.issueTriggers()), ...(await this.commentTriggers()), ...(await this.reviewTriggers())]
  }

  private async commentTriggers(): Promise<Trigger[]> {
    const since = this.store.get<string>(sinceKey(this.options.repo))
    const incoming = await this.api.comments(since)
    let newest = since ?? ''
    const out: Trigger[] = []
    for (const c of incoming) {
      if (c.at > newest) newest = c.at
      if (c.author === this.options.self || c.body.includes(this.options.selfMarker ?? REPLY_MARKER)) continue
      out.push(this.toTrigger(c))
    }
    if (newest) this.staged.push([sinceKey(this.options.repo), new Date(Date.parse(newest) + 1).toISOString()])
    return out
  }

  /** Opening an issue is the request — no label, no ceremony: a request must not require knowing the agent's conventions. */
  private async issueTriggers(): Promise<Trigger[]> {
    const stored = this.store.get<string[]>(issuesKey(this.options.repo))
    const open = await this.api.issues('open')
    const pulls = this.api.pullsOpen ? await this.api.pullsOpen() : []
    this.lastOpen = new Set<string>([...open.map(i => `#${i.issue}`), ...pulls.map(n => `#${n}`)])
    const seen = new Set(stored ?? [])
    // Issues already open at the first look are history: the first version fired them all as requests.
    if (!stored) {
      for (const issue of open) seen.add(`#${issue.issue}`)
      // The seed commits now, not at the next poll: losing it to a crash would fire the whole backlog.
      this.store.set(issuesKey(this.options.repo), [...seen])
      if (open.length > 0) return []
    }
    const out: Trigger[] = []
    const grants = new Set(this.store.get<string[]>(grantsKey(this.options.repo)) ?? [])
    const openKeys = new Set(open.map(i => `#${i.issue}`))
    this.options.onOpen?.(open)
    // A closed issue leaves the seen set, so reopening it fires afresh: closing, then reopening, is a person saying go again.
    for (const key of [...seen]) if (!openKeys.has(key)) seen.delete(key)
    for (const issue of open) {
      const key = `#${issue.issue}`
      if (!seen.has(key)) {
        seen.add(key)
        if (issue.author === this.options.self || !this.isHuman(issue.author)
          || (issue.body ?? '').includes(this.options.selfMarker ?? REPLY_MARKER)) continue
        out.push(this.requestTrigger(issue, 'issue', key))
      } else if (this.options.requestLabel && issue.labels.includes(this.options.requestLabel)) {
        // The label is the request for an issue the seed already recorded. Measured 2026-11-08: 64 real
        // requests (issues 205-268) opened hours before the router's first look, so the seed wrote them down as
        // history and no worker ever took them. `superagent intake` labels them using the operator's
        // credentials, so the label carries the authorization and the author guard must not: every one of those
        // issues is authored by the engine's own account, and labelling needs write access to the repository.
        //
        // And it carries it once. The grant journal is what makes `intake` one ask per label: the label leaves
        // the issue with the request, so the router's own receipt on that issue cannot be read as the operator
        // asking again. Re-labelling is the way to ask a second time, and it works — the journal entry goes
        // away with the label.
        if (grants.has(key)) {
          // The ask is spent. Ask GitHub once more to take the label off: a router that died between writing
          // the journal and making the write would otherwise leave the label on the issue forever, and a label
          // on an issue is how the board says "ask". An issue whose write keeps failing (a token without label
          // rights) is tried once per process, not once per poll: 76 labelled issues is 76 calls a poll.
          if (!this.spending.includes(issue.issue) && !this.labelWarned.has(issue.issue)) this.spending.push(issue.issue)
          continue
        }
        // The second lock, for the one case the journal cannot outlive: a rebuilt database (or its 4000-key
        // cap, or a router moved to a new machine) hands every open labelled issue back as a fresh ask, and a
        // label a token without rights could not take off is a standing ask with no journal behind it. There is
        // no author to check here — `superagent intake` labels with the deployment's own token, so a real ask
        // and the router's speech carry the same login (measured 2026-11-09 on the live board: #309 labelled by
        // matzen_adobe, #255 by matzenbot_adobe, both deliberate) — so the lock is TIME. A label that is not
        // newer than the router's own last reply on that issue is an ask it has already answered; a label that
        // is newer is a person asking a second time, which is the door intake must keep open. A refusal spends
        // the grant and takes the label off too, so a refused ask says nothing twice.
        const grant = await this.labelGrant(issue)
        grants.add(key)
        this.spending.push(issue.issue)
        if (grant.fire) out.push(this.requestTrigger(issue, 'label', key, grant.ask))
      } else if (this.options.regrant
        && issue.labels.includes(this.options.queueLabel ?? QUEUE_LABEL) && grants.has(key)) {
        // A standing ask with a spent grant and no live worker: the queue marker says it still wants an
        // agent, and the one-shot label said it could not have one. The router's counter decides. This
        // poll emits the trigger and queues the label write; the journal clears with the positions, the
        // same deferred commit the label path uses, so a crash re-fires the ask and never drops it.
        if (this.options.regrant(issue.issue, key)) {
          grants.delete(key)
          this.regranting.push(issue.issue)
          out.push(this.requestTrigger(issue, 'label', key))
        }
      }
    }
    // A grant is spent while the label sits on the issue, and is handed back when the label comes off: taking
    // it off is the board asking again, and the router takes the label off itself after each ask, so a spent
    // grant never outlives the label that granted it.
    if (this.options.requestLabel) {
      const labelled = new Set(open.filter(i => i.labels.includes(this.options.requestLabel!)).map(i => `#${i.issue}`))
      for (const key of [...grants]) if (!labelled.has(key)) grants.delete(key)
    }
    // The cap is a decision, not an accident: past 4000 open issues the oldest key is forgotten, and an issue
    // still open that far back fires once more as a request. The watched repository has tens, not thousands.
    this.staged.push([issuesKey(this.options.repo), [...seen].slice(-4000)])
    this.staged.push([grantsKey(this.options.repo), [...grants].slice(-4000)])
    return out
  }

  /**
   * Lock 2 on the label path: who applied the intake label, and whether it is an ask this router has not
   * answered yet. The events feed is GitHub's only answer to "who labelled this", and its moment is compared
   * with the router's own last writing on the thread — the router cannot answer an ask before it happens, so a
   * label older than its last reply is one it heard, answered and has just been handed back by a lost journal.
   *
   * Every unreadable answer fails OPEN. Losing intake — the door a person uses to ask about work the seed
   * filed as history — costs more than the loop lock 1 already stops, so a missing method, a failed read, and
   * an issue with no `labeled` event left in it all fire the ask and say so once.
   */
  private async labelGrant(issue: IssueState): Promise<LabelGrant> {
    const label = this.options.requestLabel ?? REQUEST_LABEL
    if (!this.api.labelEvent) {
      if (!this.actorReadWarned) { this.actorReadWarned = true; this.options.onWarn?.('intake.label_actor_unavailable', { issue: `#${issue.issue}` }) }
      return { fire: true }
    }
    let event: { actor: string, at: string } | undefined
    try { event = await this.api.labelEvent(issue.issue, label) }
    catch (error) {
      if (!this.actorWarned.has(issue.issue)) {
        this.actorWarned.add(issue.issue)
        this.options.onWarn?.('intake.label_actor_unreadable', { issue: `#${issue.issue}`, error: String(error).slice(0, 200) })
      }
      return { fire: true }
    }
    if (!event) {
      if (!this.actorWarned.has(issue.issue)) {
        this.actorWarned.add(issue.issue)
        this.options.onWarn?.('intake.label_actor_unknown', { issue: `#${issue.issue}`, label })
      }
      return { fire: true }
    }
    const repliedAt = await this.lastReply(issue.issue)
    if (repliedAt && Date.parse(event.at) <= Date.parse(repliedAt)) {
      this.options.onWarn?.('intake.label_stale', { issue: `#${issue.issue}`, by: event.actor, labeledAt: event.at, repliedAt })
      return { fire: false }
    }
    return { fire: true, ask: event }
  }

  /** When the router last spoke on this issue (its own login, or the footer it signs with): the line a fresh
   *  ask has to be after. A read that fails says "no speech", which lets the ask through. */
  private async lastReply(issue: number): Promise<string | undefined> {
    if (!this.api.commentsFor) return undefined
    let rows: IssueComment[]
    try { rows = await this.api.commentsFor(issue) } catch { return undefined }
    return rows
      .filter(c => c.author === this.options.self || c.body.includes(this.options.selfMarker ?? REPLY_MARKER))
      .map(c => c.at).sort().at(-1)
  }

  /** A request that comes from an issue itself. The id carries `via` and the issue's update time, so a reopen,
   *  an edit, or a relabel is a new request: the engine dedups trigger ids forever. */
  private requestTrigger(issue: IssueState, via: 'issue' | 'label', key: string, grant?: { actor: string, at: string }): Trigger {
    // On the label path the asker is whoever applied the label, not the issue's author. The intake label is
    // applied with the deployment's own token, so a trigger that credits the issue's author calls the router's
    // own login a human: measured 2026-11-09, every one of the 8 label triggers on #255 carried human=1.
    const asker = grant?.actor ?? issue.author
    return {
      id: `github:#${issue.issue}:${via}:${createHash('sha1').update(`${issue.title}\u0000${issue.updatedAt}`).digest('hex').slice(0, 8)}`,
      source: 'github',
      threads: [{ source: 'github', id: key }],
      actor: { source: 'github', id: asker },
      human: this.isHuman(asker),
      at: issue.createdAt,
      text: `${issue.title}${issue.body ? `\n\n${issue.body.slice(0, 4000)}` : ''}`,
      channel: { source: 'github', thread: key, address: { issue: String(issue.issue) } },
      meta: { labels: issue.labels, via, association: issue.association, author: issue.author,
        ...(grant ? { labelActor: grant.actor, labeledAt: grant.at } : {}) },
    }
  }

  /** The thread key of a pull request: bare `#n` in the watched repository, `owner/repo#n` anywhere else. */
  private pullKey(repo: string, pr: number): string {
    return repo === this.options.repo ? `#${pr}` : `${repo}#${pr}`
  }

  /**
   * A submitted review is a person speaking about delivered work: "request changes" must not be invisible.
   * Every repository gets its own cursor, because review ids rise per deployment and a pull request joined
   * later brings reviews with LOWER ids than the watched repository has already seen: one shared cursor
   * filed a foreign review as history it had never read.
   */
  private async reviewTriggers(): Promise<Trigger[]> {
    if (!this.api.reviews) return []
    const incoming = await this.api.reviews(0)
    const out: Trigger[] = []
    if (!incoming.length) {
      // Nothing to seed from, and the watched repository's cursor still seeds once: a cursor that
      // stays undefined makes its first real review history nobody asked to skip.
      if (this.store.get<number>(reviewsKey(this.options.repo)) === undefined) this.store.set(reviewsKey(this.options.repo), 0)
      return out
    }
    for (const [repo, rows] of groupRows(incoming, r => r.repo)) {
      const newest = Math.max(...rows.map(r => r.id))
      const seen = this.store.get<number>(reviewsKey(repo))
      // A first look seeds the cursor silent — even with nothing to seed, the seed lands: a cursor that
      // stays undefined would make the repo's first real review "history".
      if (seen === undefined) {
        this.store.set(reviewsKey(repo), newest)
        continue
      }
      this.staged.push([reviewsKey(repo), Math.max(seen, newest)])
      for (const r of rows.filter(row => row.id > seen)) {
        if (r.author === this.options.self || r.body.includes(this.options.selfMarker ?? REPLY_MARKER)) continue
        if (!this.isHuman(r.author)) continue
        const key = this.pullKey(repo, r.pr)
        const state = r.state.toLowerCase().replace(/_/g, ' ')
        out.push({
          id: `github:${key}:review:${r.id}`,
          source: 'github',
          threads: [{ source: 'github', id: key }],
          actor: { source: 'github', id: r.author },
          human: true,
          at: r.at,
          text: `PR ${key}: ${r.author} ${state}${r.body ? `\n\n${r.body.slice(0, 4000)}` : ''}`,
          // The address carries the repository, or the reply posts the number into the watched one:
          // measured 2026-11-07, 12 HTTP 404s, and any watched issue with that number would have taken it.
          channel: {
            source: 'github',
            thread: key,
            address: repo === this.options.repo ? { issue: String(r.pr) } : { repo, issue: String(r.pr) },
          },
          meta: { via: 'review', state: r.state, association: r.association, author: r.author },
        })
      }
    }
    return out
  }

  private isHuman(author: string): boolean {
    return this.options.people?.has(author) ?? !isListed(author, this.options.bots)
  }

  private toTrigger(c: IssueComment): Trigger {
    const human = this.isHuman(c.author)
    return {
      id: commentTriggerId(c),
      source: 'github',
      threads: [{ source: 'github', id: `#${c.issue}` }],
      actor: { source: 'github', id: c.author },
      human,
      at: c.at,
      // Bounded like an issue body: one pasted CI log would otherwise buy its own judge prompt and worker brief.
      text: c.body.slice(0, 4000),
      channel: { source: 'github', thread: `#${c.issue}`, address: { issue: String(c.issue) } },
      // The scope sees a trigger's source and meta only, so who wrote it travels in meta as well.
      meta: { association: c.association, author: c.author },
    }
  }
}
