/** GitHub as a Source: issues, comments and reviews become Triggers with content-derived ids and durable
 *  read positions. */
import { isListed } from './authors.ts'
import { createHash } from 'node:crypto'
import { countCredentials, redactCredentials } from './git-credentials.ts'
import { normalizePost } from './firstpost.ts'
import type { SweepCandidate, Trigger } from '../core/index.ts'

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
  author: string
  association: string
  createdAt: string
  updatedAt: string
  /** Labels as GitHub spells them. Two are read: `PRIORITY_LABEL` ranks a slot, `HUMAN_LABEL` parks an issue. */
  labels?: string[]
}

/** The one label the router obeys: the operator put this issue in the next free worker slot. */
export const PRIORITY_LABEL = 'priority:high'
/** The board's park-on-a-person label, read by the ready sweep alone: a parked issue's next move is a human's. */
export const HUMAN_LABEL = 'waiting-on-human'
/** One priority launch per pass: 38 pending tickets share 4 slots, and a priority lane that takes them all is a new starvation. */
export const PRIORITY_GRANTS_PER_POLL = 1
type WonSlot = 'priority' | 'unanswered' | 'oldest-starved' | 'swept'
/** Why a thread took the slot, named for the operator: the label wins (`priority`); in the standing queue a
 *  thread with undelivered operator input is the parked-thread relaunch (`unanswered`, measured 2026-11-19:
 *  #593 relaunched on undelivered replies), and a plain win by age is `oldest-starved`. The names report the
 *  ranking — label first, then oldest updated — they never change it. `swept` is written by the ready sweep,
 *  which ranks the same way and asks the judge first, so it names a different road to the slot, not a new rule. */
export const wonSlotReason = (priority: boolean, hasUndeliveredInput: boolean): WonSlot =>
  priority ? 'priority' : hasUndeliveredInput ? 'unanswered' : 'oldest-starved'
/** kv key: thread key → the reason it last won a slot, so the panel row can say it after the log scrolled. */
export const WON_SLOT_KEY = 'router:wonslot'
const priorityOf = (issue: IssueState): boolean => !!issue.labels?.includes(PRIORITY_LABEL)
export const byPriorityThenOldest = (issues: readonly IssueState[]): IssueState[] =>
  [...issues].sort((a, b) =>
    (Number(priorityOf(b)) - Number(priorityOf(a))) || a.updatedAt.localeCompare(b.updatedAt))

export interface GithubApi {
  comments(since?: string): Promise<IssueComment[]>
  issues(state: 'open' | 'closed'): Promise<IssueState[]>
  /** `repo` names a repository other than the watched one, for a conversation on a pull request there. */
  postComment(issue: number, body: string, repo?: string): Promise<void>
  /** Writes one comment the router keeps editing: posted when `commentId` is unset, edited in place after. */
  upsertComment?(issue: number, commentId: number | undefined, body: string, repo?: string): Promise<{ id: number; url: string }>
  /** Newest-first page of one issue's comments; a retried post looks here before speaking twice. */
  commentsFor?(issue: number, repo?: string): Promise<IssueComment[]>
  /** Open pull-request numbers: their conversations are threads a ticket can own, so closing them counts. */
  pullsOpen?(): Promise<number[]>
  /** Submitted reviews (approve / request changes) with ids above the cursor, oldest first. */
  reviews?(sinceId: number): Promise<PrReview[]>
  /** One issue's state, asked directly: 'unknown' when the read failed, which is never a reason to stop. */
  issueState?(issue: number): Promise<'open' | 'closed' | 'unknown'>
  /** Closes an issue: the terminal end of a ticket that finished with nothing left to wait on. */
  closeIssue?(issue: number): Promise<void>
  /** Files an issue and returns its number: how a fleet fault reaches a person who is not ssh'd in. */
  createIssue?(title: string, body: string, repo?: string): Promise<number>
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

/** Where an incoming body entered the inbox: the surface a mask alert names. */
export type IngestSurface = 'issue' | 'comment' | 'review'

export interface GithubSourceOptions {
  repo: string
  self: string
  bots?: ReadonlySet<string>
  people?: ReadonlySet<string>
  selfMarker?: string
  /**
   * The standing queue re-earns its launch: an open issue with no worker
   * on it, is work. The router answers yes within a cap and says no after it, and the counter lives in the
   * router's store. No label marks it: labels are gone (operator, 2026-11-10, "These labels are obsolete").
   * A string names the grant: trigger ids are kept forever, so a second grant of an untouched issue needs a new name.
   * `priority` says the issue carries `PRIORITY_LABEL`, so the router can log why that thread won the slot.
   */
  regrant?: (issue: number, key: string, priority?: boolean) => boolean | string
  /** The open board on every poll: the router publishes how much open work waits for a slot, and nobody
   *  downstream may re-read GitHub to find out. */
  onOpen?: (open: readonly IssueState[]) => void
  /** Count of credentials masked on the way in, never the value: a silent mask is indistinguishable from no secret arriving. */
  onCredentialMasked?: (count: number, where: IngestSurface) => void
}


const sinceKey = (repo: string) => `source:github:${repo}:since`
/** Group rows by a key, keeping the order in which the keys first appear. */
const groupRows = <T,>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> =>
  rows.reduce((map, row) => map.set(key(row), [...map.get(key(row)) ?? [], row]), new Map<string, T[]>())
const issuesKey = (repo: string) => `source:github:${repo}:issues`
const reviewsKey = (repo: string) => `source:github:${repo}:reviews`
/** Where a source persists its read positions (the SQLite kv table in practice). */
export interface PositionStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  /** Optional: the SQLite store has it, a test double often not. A park is forgotten once it no longer holds. */
  delete?(key: string): void
}

const DAY_MS = 86_400_000
/** Ten minutes of polls: past this, an issue missing from every listing is forgotten even without a close. */
const MISSING_POLLS = 20
/**
 * The comment cursor sits this far behind real time: it advances to `newest + 1ms` only once this much
 * wall clock has passed since the newest comment seen. GitHub timestamps to the second and a listing can
 * surface a comment a moment after a poll that moved the cursor past its second — a cursor at
 * `newest + 1ms` locked such a comment out forever (measured shape: a listing that came back short,
 * 2026-11-11 01:18:52). Keep the lag above the tick interval, so the next poll is still inside the window;
 * the cost is re-reading a few seconds of comments per poll, and the engine returns 'duplicate' for ids it
 * has stored. A clock skew between here and GitHub only slows the cursor; `newest + 1ms` is the ceiling.
 */
export const CURSOR_LAG_MS = 120_000

/** A solo operator posts from the same login the agent replies from, so the author cannot identify the
 *  agent's own writing; the footer can. */
export const REPLY_MARKER = '<!-- superagent -->'

/** The bytes every router post publishes. The router's retry dedupe compares this exact text, so the masking and
 *  the normalization live here rather than in the two callers that would drift apart. */
export const publishBody = (text: string): string => `${normalizePost(redactCredentials(text))}\n\n${REPLY_MARKER}`

export const commentTriggerId = (c: IssueComment): string =>
  // The id hashes the raw body: the cursor re-reads a two-minute window, so an id that moved with masking rules would re-fire stored comments.
  `github:#${c.issue}:${createHash('sha1').update(`${c.author}\u0000${c.at}\u0000${c.body}`).digest('hex').slice(0, 16)}`

export class GithubSource {
  /** Deferred commit (Intake.tla C3): positions land at the next poll, once the triggers they
   *  produced are in the engine — commit-at-emit + crash = cursor past a request never accepted. */
  private staged: Array<[string, unknown]> = []
  private lastOpen: ReadonlySet<string> | undefined
  /** The open issues of the last poll's listing: the sweep reads its board off the read the poll already made. */
  private board: readonly IssueState[] = []
  /** The board's `priority:high` threads as of the last poll, taken from the listing that poll already makes. */
  private priorityThreads: ReadonlySet<string> = new Set()
  /** Polls in a row a seen issue has been missing from the open listing without GitHub saying it closed. */
  private readonly missing = new Map<string, number>()

  constructor(private readonly api: GithubApi, private readonly options: GithubSourceOptions,
              private readonly store: PositionStore, private readonly now: () => number = () => Date.now()) {}

  /** Threads open as of the last poll ('#N', issues and pull requests): absence is how GitHub says
   *  a conversation ended — merged, closed, or deleted all look the same from here, and all mean stop. */
  openThreads(): ReadonlySet<string> | undefined { return this.lastOpen }

  /** A thread the board labels `priority:high`. The answer is the poll's own listing, so ranking costs no request. */
  isPriority(thread: string): boolean { return this.priorityThreads.has(thread) }

  /** The open issues of the last poll, as the sweep's board; empty before the first poll, which is the honest answer. */
  sweepBoard(): SweepCandidate[] {
    return this.board.map(issue => ({
      thread: { source: 'github', id: `#${issue.issue}` },
      updatedAt: issue.updatedAt,
      priority: priorityOf(issue),
      waitingOnHuman: !!issue.labels?.includes(HUMAN_LABEL),
      actor: { source: 'github', id: issue.author },
      // Masked like every other ingest surface: a swept body is stored as the Trigger's text and reaches a worker.
      text: `${this.mask(issue.title, 'issue')}${issue.body ? `\n\n${this.mask(issue.body, 'issue').slice(0, 4000)}` : ''}`,
      channel: { source: 'github', thread: `#${issue.issue}`, address: { issue: String(issue.issue) } },
      meta: { association: issue.association, author: issue.author },
    }))
  }

  /** One thread's state, asked of GitHub directly. 'unknown' when the read failed: a ticket stays alive on an
   *  unreadable answer, because the inference this replaces stopped a live ticket whose issue was open. */
  issueState(issue: number): Promise<'open' | 'closed' | 'unknown'> {
    return this.api.issueState?.(issue) ?? Promise.resolve('unknown')
  }

  /** Mask before the text is stored: a trigger's text is what the engine keeps, and every later worker on the
   *  thread is handed it as "word for word" — one paste on 2026-11-24 reached three workers over two hours. */
  private mask(text: string, where: IngestSurface): string {
    const count = countCredentials(text)
    if (!count) return text
    this.options.onCredentialMasked?.(count, where)
    return redactCredentials(text)
  }

  /** A cold start reads a day back: enough to catch a request made while the router was down. */
  bootstrap(): void {
    if (this.store.get<string>(sinceKey(this.options.repo))) return
    this.store.set(sinceKey(this.options.repo), new Date(this.now() - DAY_MS).toISOString())
  }

  async poll(): Promise<Trigger[]> {
    for (const [key, value] of this.staged) this.store.set(key, value)
    this.staged = []
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
    if (newest) {
      // See CURSOR_LAG_MS: the ceiling keeps a skewed clock from re-reading history, the max keeps the cursor
      // from moving backwards, and the lag keeps the window in front of a comment that has not surfaced yet.
      const settled = Math.min(Date.parse(newest) + 1, this.now() - CURSOR_LAG_MS)
      this.staged.push([sinceKey(this.options.repo), new Date(since ? Math.max(Date.parse(since), settled) : settled).toISOString()])
    }
    return out
  }

  /** Opening an issue is the request — no label, no ceremony: a request must not require knowing the agent's conventions. */
  private async issueTriggers(): Promise<Trigger[]> {
    const stored = this.store.get<string[]>(issuesKey(this.options.repo))
    const open = await this.api.issues('open')
    this.board = open
    const pulls = this.api.pullsOpen ? await this.api.pullsOpen() : []
    this.lastOpen = new Set<string>([...open.map(i => `#${i.issue}`), ...pulls.map(n => `#${n}`)])
    this.priorityThreads = new Set(open.filter(priorityOf).map(i => `#${i.issue}`))
    const seen = new Set(stored ?? [])
    // Issues already open at the first look are history: the first version fired them all as requests.
    if (!stored) {
      for (const issue of open) seen.add(`#${issue.issue}`)
      // The seed commits now, not at the next poll: losing it to a crash would fire the whole backlog.
      this.store.set(issuesKey(this.options.repo), [...seen])
      if (open.length > 0) return []
    }
    const out: Trigger[] = []
    const openKeys = new Set(open.map(i => `#${i.issue}`))
    this.options.onOpen?.(open)
    // A closed issue leaves the seen set, so reopening it fires afresh: closing, then reopening, is a person saying go again.
    // Closed means GitHub says so: absence from one listing is a hint, and the listing has come back short (2026-11-11
    // 01:18:52, six unanswered issues read as none), after which the next poll re-fired 12 live issues as new requests.
    for (const key of [...seen]) {
      if (openKeys.has(key)) { this.missing.delete(key); continue }
      // Bounded: an issue deleted or moved away answers no close forever, and costs a read on every poll.
      const misses = (this.missing.get(key) ?? 0) + 1
      const state = misses > MISSING_POLLS ? 'closed' : this.api.issueState ? await this.api.issueState(Number(key.slice(1))) : 'closed'
      if (state === 'closed') { seen.delete(key); this.missing.delete(key) } else this.missing.set(key, misses)
    }
    // Queue order, not listing order: a free slot goes to `priority:high` first, then to the oldest ask.
    let priorityGrants = 0
    for (const issue of byPriorityThenOldest(open)) {
      const key = `#${issue.issue}`
      if (!seen.has(key)) {
        seen.add(key)
        // Every open issue is a request, whoever opened it: agents file their work as the engine's own account.
        // The ask system that once shared this board is gone (operator, 2026-11-11), and with it the ask verbs.
        if (!this.isHuman(issue.author)
          || (issue.body ?? '').includes(this.options.selfMarker ?? REPLY_MARKER)) continue
        out.push(this.requestTrigger(issue, 'issue', key))
      } else if (this.options.regrant && this.isHuman(issue.author)) {
        // A standing ask is any open issue a person or an agent filed. The ROUTER decides, because it is
        // the only party that knows whether a worker is or was on this thread; the counter there caps the loop.
        const priority = priorityOf(issue)
        if (priority && priorityGrants >= PRIORITY_GRANTS_PER_POLL) continue
        const grant = this.options.regrant(issue.issue, key, priority)
        if (!grant) continue
        if (priority) priorityGrants += 1
        out.push(this.requestTrigger(issue, 'grant', key, typeof grant === 'string' ? grant : undefined))
      }
    }
    // The cap is a decision, not an accident: past 4000 open issues the oldest key is forgotten, and an issue
    // still open that far back fires once more as a request. The watched repository has tens, not thousands.
    this.staged.push([issuesKey(this.options.repo), [...seen].slice(-4000)])
    return out
  }

  /** A request that comes from an issue itself. The id carries `via` and the issue's update time, so a reopen,
   *  or an edit is a new request: the engine dedups trigger ids forever. */
  private requestTrigger(issue: IssueState, via: 'issue' | 'grant', key: string, name?: string): Trigger {
    return {
      id: `github:#${issue.issue}:${via}:${createHash('sha1').update(`${issue.title}\u0000${issue.updatedAt}`).digest('hex').slice(0, 8)}${name ? `:${name}` : ''}`,
      source: 'github',
      threads: [{ source: 'github', id: key }],
      actor: { source: 'github', id: issue.author },
      human: this.isHuman(issue.author),
      at: issue.createdAt,
      text: `${this.mask(issue.title, 'issue')}${issue.body ? `\n\n${this.mask(issue.body, 'issue').slice(0, 4000)}` : ''}`,
      channel: { source: 'github', thread: key, address: { issue: String(issue.issue) } },
      meta: { via, association: issue.association, author: issue.author },
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
          text: `PR ${key}: ${r.author} ${state}${r.body ? `\n\n${this.mask(r.body, 'review').slice(0, 4000)}` : ''}`,
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
      text: this.mask(c.body, 'comment').slice(0, 4000),
      channel: { source: 'github', thread: `#${c.issue}`, address: { issue: String(c.issue) } },
      // The scope sees a trigger's source and meta only, so who wrote it travels in meta as well.
      meta: { association: c.association, author: c.author },
    }
  }
}
