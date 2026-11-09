/** A ticket's pull requests: their threads, their state, and what people say on those outside the watched repository. */
import { createHash } from 'node:crypto'
import { isListed } from './authors.ts'
import { REPLY_MARKER, type IssueComment, type PositionStore, type PrReview } from './source-github.ts'
import type { Ticket, ThreadRef, Trigger } from '../core/index.ts'

export interface PullRef { repo: string; number: number }

export interface PullState {
  open: boolean
  merged: boolean
  createdAt: string
  closedAt?: string
  mergedAt?: string
  /** GitHub's own `state` string, kept verbatim, so a receipt can be checked against the API. */
  rawState: string
  /** The commit at the tip of the branch at the moment of the read: what the ticket's work was judged against. */
  headRefOid: string
}

/**
 * What a pull-state read produced, in the words a person can check on GitHub: the poll's exit status, and the
 * fields the ending is claimed from. A receipt that only says "closed" is how eight false closings of one open
 * pull request ran for nine hours unnoticed (board #235 against `fleet-board#74`, 2026-11-09).
 */
export interface PullEvidence {
  repo: string
  number: number
  /** The poll's exit status: 0 when `gh` answered, the code it died with when it did not, -1 when it never ran. */
  status: number
  /** The raw `state` field, verbatim; empty when the read produced no body to read a state out of. */
  state: string
  closedAt: string | null
  mergedAt: string | null
  headRefOid: string
  /** Why the read decided nothing (`repo-invisible`, `empty-output`, `gh-exit-1`, `unrecognised-state:…`). */
  reason?: string
}

/**
 * A pull-state read answers three ways, and only two of them say the pull request finished:
 * `found` carries GitHub's own state, `absent` is GitHub saying it has no such number in a repository this same
 * token can read, and `unknown` is a read that said nothing — a non-zero exit, empty stdout, a body with no
 * state, an unrecognised state, a rate limit, a 404 from an account the repository is invisible to. The third
 * is not a close, and a poller that reads it as one ends live tickets on a network blip.
 */
export type PullRead =
  | { read: 'found'; state: PullState; evidence: PullEvidence }
  | { read: 'absent'; evidence: PullEvidence }
  | { read: 'unknown'; reason: string; evidence: PullEvidence }

export interface PullApi {
  /** The pull request's state, or the fact that this read decided nothing; it never answers "closed" for a failure. */
  pull(repo: string, number: number): Promise<PullRead>
  comments(repo: string, number: number, since?: string): Promise<IssueComment[]>
  reviews(repo: string, number: number): Promise<PrReview[]>
}

// URLs only: `#5` or `owner/repo#5` may be an issue, whose thread never merges, so its ticket would wait forever.
export function parsePull(text: string): PullRef | undefined {
  const match = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i.exec(text.trim())
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** A pull request in the watched repository is the source's own `#N` thread, so its comments and reviews arrive there. */
export const threadOfPull = (pull: PullRef, home: string): ThreadRef =>
  ({ source: 'github', id: same(pull.repo, home) ? `#${pull.number}` : `${pull.repo.toLowerCase()}#${pull.number}` })

/** Any GitHub thread id, an issue's or a pull request's: `#N` in the watched repository, `owner/repo#N` elsewhere. */
export function parseThread(id: string, home: string): PullRef | undefined {
  const match = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(id)
  if (!match || (!match[1] && !home)) return undefined
  return { repo: match[1] ?? home, number: Number(match[2]) }
}

/**
 * The pull requests tickets are waiting on. A review read costs one call per pull, so the router reads these
 * and nothing else; it lives here because a follow's thread takes two shapes in the database
 * (`github:o/r#12`, and `github:#12` for the home repository) and that parsing must not be repeated at the
 * call site, where a missed shape silently returns an empty set and no review is ever read again.
 */
export function followedPulls(tickets: readonly Ticket[], home: string): PullRef[] {
  const out: PullRef[] = []
  for (const ticket of tickets) {
    for (const follow of ticket.follows ?? []) {
      if (follow.closed) continue
      const ref = follow.thread.startsWith('github:') ? parseThread(follow.thread.slice('github:'.length), home) : undefined
      if (ref && !out.some(p => p.repo === ref.repo && p.number === ref.number)) out.push(ref)
    }
  }
  return out
}

export const pullUrl = (pull: PullRef): string => `https://github.com/${pull.repo}/pull/${pull.number}`
/** GitHub sends /issues/N on to /pull/N, so this one link serves both. */
export const threadUrl = (id: string, home: string): string | undefined => {
  const target = parseThread(id, home)
  return target && `https://github.com/${target.repo}/issues/${target.number}`
}

export interface FollowerOptions {
  home: string
  api: PullApi
  openThreads(): ReadonlySet<string> | undefined
  positions: PositionStore
  self: string
  bots?: ReadonlySet<string>
  /** `evidence` is the read the ending acted on, and it travels with the close so the receipt can quote it. */
  closed(thread: ThreadRef, pull: PullRef, outcome: 'merged' | 'closed', at: string, evidence: PullEvidence): void
  receive(trigger: Trigger): void
  warn(event: string, fields: Record<string, unknown>): void
  now?: () => number
  /** How often a pull request outside the watched repository is read: three calls each time, against GitHub's hourly limit. */
  everyMs?: number
}

// Four `gh` round trips (~0.9 s each) at a time finishes a pass inside one tick; the cap overlaps the calls, it adds none.
const READS_AT_ONCE = 4

export class PullFollower {
  private readonly polled = new Map<string, number>()
  private readonly unreadable = new Set<string>()
  private readonly stateUnknown = new Set<string>()

  constructor(private readonly options: FollowerOptions) {}

  /** Closed pull requests end their tickets' wait; talk on those outside the watched repository becomes triggers. */
  async reconcile(tickets: readonly Ticket[]): Promise<void> {
    const { home } = this.options
    const now = this.options.now?.() ?? Date.now()
    const followed = new Map<string, PullRef>()
    for (const ticket of tickets) {
      for (const follow of ticket.follows ?? []) {
        if (follow.closed || !follow.thread.startsWith('github:')) continue
        const id = follow.thread.slice('github:'.length)
        const pull = parseThread(id, home)
        if (pull) followed.set(id, pull)
      }
    }
    const open = this.options.openThreads()
    const due: Array<{ id: string; pull: PullRef; local: boolean }> = []
    for (const [id, pull] of followed) {
      const local = id.startsWith('#')
      if (local && (!open || open.has(id))) continue
      if (!local) {
        if (now - (this.polled.get(id) ?? -Infinity) < (this.options.everyMs ?? 120_000)) continue
        this.polled.set(id, now)
      }
      due.push({ id, pull, local })
    }
    // Side by side, because serially seven follows serialized one tick out to 20 s (measured live 2026-11-07, every 120 s) and every worker launch in that window waited on GitHub.
    const queue = [...due]
    await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await this.read(next.id, next.pull, next.local, now)
    }))
  }

  private async read(id: string, pull: PullRef, local: boolean, now: number): Promise<void> {
    let result: PullRead
    try {
      result = await this.options.api.pull(pull.repo, pull.number)
    } catch (error) {
      this.options.warn('pull.read_failed', { thread: id, error: String(error).slice(0, 200) })
      return
    }
    // A read that said nothing ends nothing. The follow stays open, the next pass asks again, and no receipt is
    // written: measured 2026-11-09, every one of the eight "closed without merging" receipts on board #235
    // followed a failed read of `fleet-board#74`, which GitHub says is open and unchanged since 06:00:01Z.
    if (result.read === 'unknown') {
      if (!this.stateUnknown.has(id)) {
        this.stateUnknown.add(id)
        this.options.warn('pull.state_unknown', { thread: id, reason: result.reason, status: result.evidence.status,
          state: result.evidence.state, closedAt: result.evidence.closedAt, mergedAt: result.evidence.mergedAt })
      }
      return
    }
    if (this.stateUnknown.delete(id)) this.options.warn('pull.state_readable', { thread: id })
    // A pull request GitHub has no number for cannot be merged, so the ticket's wait ends here — and only here:
    // `absent` is readable only out of a repository this same token read, so it is a fact about the pull request.
    if (result.read === 'absent') {
      this.options.closed({ source: 'github', id }, pull, 'closed', new Date(now).toISOString(), result.evidence)
      return
    }
    const state = result.state
    if (state.open) {
      if (!local) await this.listen(id, pull, state.createdAt)
      return
    }
    // Only an explicit terminal state ends a ticket: MERGED, or CLOSED with its own `closed_at` (gh-api.ts answers
    // `unknown` for a closed pull request whose body carries no time, and for any state string it does not know).
    const at = (state.merged ? state.mergedAt : state.closedAt) ?? new Date(now).toISOString()
    this.options.closed({ source: 'github', id }, pull, state.merged ? 'merged' : 'closed', at, result.evidence)
  }

  private async listen(id: string, pull: PullRef, createdAt: string): Promise<void> {
    const sinceKey = `pulls:${id}:since`
    const reviewKey = `pulls:${id}:review`
    try {
      const since = this.options.positions.get<string>(sinceKey) ?? createdAt
      let newest = since
      for (const c of await this.options.api.comments(pull.repo, pull.number, since)) {
        if (c.at > newest) newest = c.at
        if (this.ours(c.author, c.body)) continue
        this.options.receive(this.trigger(id, pull, c.author, c.association, c.at, c.body, 'comment',
          `github:${id}:${createHash('sha1').update(`${c.author}\u0000${c.at}\u0000${c.body}`).digest('hex').slice(0, 16)}`))
      }
      // Committed once the engine holds what it produced: a crash before this line replays, and ids make replays free.
      if (newest !== since) this.options.positions.set(sinceKey, new Date(Date.parse(newest) + 1).toISOString())
      const seen = this.options.positions.get<number>(reviewKey) ?? 0
      let top = seen
      for (const r of await this.options.api.reviews(pull.repo, pull.number)) {
        if (r.id <= seen) continue
        top = Math.max(top, r.id)
        if (this.ours(r.author, r.body)) continue
        const said = `${pull.repo}#${pull.number}: ${r.author} ${r.state.toLowerCase().replace(/_/g, ' ')}${r.body ? `\n\n${r.body.slice(0, 4000)}` : ''}`
        this.options.receive(this.trigger(id, pull, r.author, r.association, r.at, said, 'review', `github:${id}:review:${r.id}`))
      }
      if (top !== seen) this.options.positions.set(reviewKey, top)
      if (this.unreadable.delete(id)) this.options.warn('pull.listen_readable', { thread: id })
    } catch (error) {
      // Once per pull request, not once per poll: 720 identical lines a day bury the one that is new.
      if (!this.unreadable.has(id)) {
        this.unreadable.add(id)
        this.options.warn('pull.listen_failed', { thread: id, error: String(error).slice(0, 200) })
      }
    }
  }

  private ours(author: string, body: string): boolean {
    return author === this.options.self || body.includes(REPLY_MARKER)
  }

  private trigger(id: string, pull: PullRef, author: string, association: string, at: string, text: string,
                  via: 'comment' | 'review', triggerId: string): Trigger {
    return {
      id: triggerId,
      source: 'github',
      threads: [{ source: 'github', id }],
      actor: { source: 'github', id: author },
      human: !isListed(author, this.options.bots),
      at,
      text,
      // The repository rides in the address: the outbox posts to the repository a channel names, not the watched one.
      channel: { source: 'github', thread: id, address: { repo: pull.repo, issue: String(pull.number) } },
      meta: { via, association, author, repo: pull.repo },
    }
  }
}
