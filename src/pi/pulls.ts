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
}

/**
 * What one read of one pull request returned, and it is not two cases: GitHub answers HTTP 404 both for a
 * pull request that does not exist and for one the token cannot see — measured 2026-11-09, the router's
 * account `matzenbot_adobe` got 404 on `repos/kmatzen/pi-superagent` and on its pull requests #29/#30/#31,
 * which the owner's token read as open — and the second one ended six live tickets with "closed without
 * merging". So a read reports three things, and only the first two end a ticket's wait.
 */
export type PullRead =
  /** GitHub's body: `open`, and `closed_at`/`merged_at` when it stopped. The only positive signal there is. */
  | { read: 'found'; pull: PullState }
  /** GitHub has no such pull request, and this token can read the repository, so the answer is about the pull. */
  | { read: 'absent' }
  /** The read said nothing about the pull request: a 404 from a token that cannot see the repository, a 5xx, a 403 from an IP allowlist, a dead token. */
  | { read: 'unreadable'; reason: string }

export interface PullApi {
  /** `found` with GitHub's body, `absent` when the repository is readable and has no such number, `unreadable` when the read itself failed. See `PullRead`. */
  pull(repo: string, number: number): Promise<PullRead>
  comments(repo: string, number: number, since?: string): Promise<IssueComment[]>
  reviews(repo: string, number: number): Promise<PrReview[]>
}

/** One followed pull request the token cannot read, and how many reads in a row said so. */
export interface UnreadablePull { reason: string; reads: number; at: string; escalated: boolean }

/** Thread id (`owner/repo#29`) to the last unreadable read of it — the same list health.json and the end receipt read. */
export type UnreadablePulls = Record<string, UnreadablePull>

/** The durable position store key the follower keeps that list under, so a router restart does not forget it. */
export const UNREADABLE_PULLS = 'pulls:unreadable'

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
  closed(thread: ThreadRef, pull: PullRef, outcome: 'merged' | 'closed', at: string): void
  receive(trigger: Trigger): void
  warn(event: string, fields: Record<string, unknown>): void
  now?: () => number
  /** How often a pull request outside the watched repository is read: three calls each time, against GitHub's hourly limit. */
  everyMs?: number
  /**
   * Consecutive unreadable reads of one pull request before it escalates: one warning per pull request per
   * window of this many reads, and the count published for `health.json`. 40 at the read budget below is
   * about 80 minutes of a pull request nobody can read — long enough that a permission blip never escalates,
   * short enough that a pull request the token will never see is named the same working day. Default 40.
   */
  escalateAfter?: number
}

const ESCALATE_AFTER = 40

// Four `gh` round trips (~0.9 s each) at a time finishes a pass inside one tick; the cap overlaps the calls, it adds none.
const READS_AT_ONCE = 4

export class PullFollower {
  private readonly polled = new Map<string, number>()
  private readonly unreadable = new Set<string>()
  /** Consecutive reads of one pull request that said nothing, by thread id; 0 once a read has answered. */
  private readonly unreadReads = new Map<string, number>()

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
    // A follow nobody holds open any more has no ticket waiting on it: drop its count, so health.json names
    // the pull requests blocking a ticket NOW and the list cannot grow past the follows it is counting.
    const listed = this.options.positions.get<UnreadablePulls>(UNREADABLE_PULLS)
    if (listed) {
      const kept = Object.fromEntries(Object.entries(listed).filter(([thread]) => followed.has(thread)))
      if (Object.keys(kept).length !== Object.keys(listed).length) this.options.positions.set(UNREADABLE_PULLS, kept)
    }
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
      // Thrown reads count too: a 5xx, a dead token, an allowlist 403 — none of them an answer about the pull.
      this.countUnreadable(id, String(error).slice(0, 200), 'pull.read_failed')
      return
    }
    if (result.read === 'unreadable') {
      // Not a close. The ticket keeps waiting and the follow keeps being read; the next pass asks again.
      this.countUnreadable(id, result.reason, 'pull.unreadable')
      return
    }
    this.readableAgain(id)
    // A pull request GitHub has no more cannot be merged, so the ticket's wait ends: `absent` is only ever
    // reported for a repository this token CAN read (see `ghPulls.pull`), which is what makes it an answer.
    if (result.read === 'absent') {
      this.options.warn('pull.absent', { thread: id, reason: 'repository readable, GitHub has no such pull request' })
      this.options.closed({ source: 'github', id }, pull, 'closed', new Date(now).toISOString())
      return
    }
    const state = result.pull
    // The only path that ends a ticket's wait: GitHub's body, saying `state: closed`, with its own `closed_at`.
    if (!state.open) {
      this.options.closed({ source: 'github', id }, pull, state.merged ? 'merged' : 'closed', state.closedAt ?? new Date(now).toISOString())
      return
    }
    if (!local) await this.listen(id, pull, state.createdAt)
  }

  /**
   * One more read of this pull request that said nothing. Warned once, then once per escalation window —
   * 2880 polls a day is not a log — and kept in the durable list, which is what makes it countable from
   * health.json and sayable on the ticket's receipt.
   */
  private countUnreadable(id: string, reason: string, event: string): void {
    const reads = (this.unreadReads.get(id) ?? 0) + 1
    this.unreadReads.set(id, reads)
    const every = this.options.escalateAfter ?? ESCALATE_AFTER
    // Warned on the window's edge, once; the record keeps "it has been unreadable a whole window" so
    // health.json does not blink off between escalations.
    const due = reads % every === 0
    const list = this.options.positions.get<UnreadablePulls>(UNREADABLE_PULLS) ?? {}
    if (reads === 1) this.options.warn(event, { thread: id, reason, reads })
    if (due) this.options.warn('pull.unreadable_escalated', { thread: id, reason, reads, window: every })
    // `escalated` is monotonic: the counter is in memory, so a router restart starts `reads` at 1 again, and the
    // incident class here is a router that restarts. Losing the flag would hide a pull request that has been
    // blind for three hours behind reads=1; `since` and the flag stay, and only a read that answers clears them.
    const escalated = reads >= every || (list[id]?.escalated ?? false)
    this.options.positions.set(UNREADABLE_PULLS, { ...list, [id]: { reason, reads, at: list[id]?.at ?? new Date(this.options.now?.() ?? Date.now()).toISOString(), escalated } })
  }

  /** A read that answered: the count resets, the list drops it, and a pull request that came back says so once. */
  private readableAgain(id: string): void {
    const reads = this.unreadReads.get(id)
    if (reads) {
      this.unreadReads.delete(id)
      this.options.warn('pull.readable', { thread: id, reads })
    }
    const list = this.options.positions.get<UnreadablePulls>(UNREADABLE_PULLS)
    if (!list?.[id]) return
    const { [id]: dropped, ...rest } = list
    this.options.positions.set(UNREADABLE_PULLS, rest)
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
