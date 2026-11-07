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

export interface PullApi {
  /** Undefined when GitHub has no such pull request. */
  pull(repo: string, number: number): Promise<PullState | undefined>
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
  closed(thread: ThreadRef, pull: PullRef, outcome: 'merged' | 'closed', at: string): void
  receive(trigger: Trigger): void
  warn(event: string, fields: Record<string, unknown>): void
  now?: () => number
  /** How often a pull request outside the watched repository is read: three calls each time, against GitHub's hourly limit. */
  everyMs?: number
}

export class PullFollower {
  private readonly polled = new Map<string, number>()

  constructor(private readonly options: FollowerOptions) {}

  /** Closed pull requests end their tickets' wait; talk on those outside the watched repository becomes triggers. */
  async reconcile(tickets: readonly Ticket[]): Promise<void> {
    const { home, api } = this.options
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
    for (const [id, pull] of followed) {
      const local = id.startsWith('#')
      if (local && (!open || open.has(id))) continue
      if (!local) {
        if (now - (this.polled.get(id) ?? -Infinity) < (this.options.everyMs ?? 120_000)) continue
        this.polled.set(id, now)
      }
      let state: PullState | undefined
      try {
        state = await api.pull(pull.repo, pull.number)
      } catch (error) {
        this.options.warn('pull.read_failed', { thread: id, error: String(error).slice(0, 200) })
        continue
      }
      // A pull request GitHub no longer has cannot be merged: waiting for it would keep the ticket open forever.
      if (!state || !state.open) {
        this.options.closed({ source: 'github', id }, pull, state?.merged ? 'merged' : 'closed', state?.closedAt ?? new Date(now).toISOString())
        continue
      }
      if (!local) await this.listen(id, pull, state.createdAt)
    }
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
    } catch (error) {
      this.options.warn('pull.listen_failed', { thread: id, error: String(error).slice(0, 200) })
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
