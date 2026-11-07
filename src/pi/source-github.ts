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

  constructor(private readonly api: GithubApi, private readonly options: GithubSourceOptions,
              private readonly store: PositionStore, private readonly now: () => number = () => Date.now()) {}

  /** Threads open as of the last poll ('#N', issues and pull requests): absence is how GitHub says
   *  a conversation ended — merged, closed, or deleted all look the same from here, and all mean stop. */
  openThreads(): ReadonlySet<string> | undefined { return this.lastOpen }

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
    const openKeys = new Set(open.map(i => `#${i.issue}`))
    // A closed issue leaves the seen set, so reopening it fires afresh: closing, then reopening, is a person saying go again.
    for (const key of [...seen]) if (!openKeys.has(key)) seen.delete(key)
    for (const issue of open) {
      const key = `#${issue.issue}`
      if (!seen.has(key)) {
        seen.add(key)
        if (issue.author === this.options.self || !this.isHuman(issue.author)
          || (issue.body ?? '').includes(this.options.selfMarker ?? REPLY_MARKER)) continue
        out.push({
          // updatedAt joins the hash so a reopen (a new open interval) is a new trigger id:
          // the engine dedups ids forever, and title-only ids made reopening a dead signal.
          id: `github:#${issue.issue}:issue:${createHash('sha1').update(`${issue.title}\u0000${issue.updatedAt}`).digest('hex').slice(0, 8)}`,
          source: 'github',
          threads: [{ source: 'github', id: key }],
          actor: { source: 'github', id: issue.author },
          human: true,
          at: issue.createdAt,
          text: `${issue.title}${issue.body ? `\n\n${issue.body.slice(0, 4000)}` : ''}`,
          channel: { source: 'github', thread: key, address: { issue: String(issue.issue) } },
          meta: { labels: issue.labels, via: 'issue', association: issue.association, author: issue.author },
        })
      }
    }
    // The cap is a decision, not an accident: past 4000 open issues the oldest key is forgotten, and an issue
    // still open that far back fires once more as a request. The watched repository has tens, not thousands.
    this.staged.push([issuesKey(this.options.repo), [...seen].slice(-4000)])
    return out
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
