/** A ticket's pull requests: their threads, their state, and what people say on those outside the watched repository. */
import { createHash } from 'node:crypto'
import { isListed } from './authors.ts'
import { CURSOR_LAG_MS, REPLY_MARKER, type IssueComment, type PositionStore, type PrReview } from './source-github.ts'
import type { Ticket, ThreadRef, Trigger } from '../core/index.ts'

export interface PullRef { repo: string; number: number }

export interface PullState {
  open: boolean
  merged: boolean
  /** GitHub's own verdict, and `null` while GitHub is still computing it. `false` is a merge conflict: nobody
   *  spoke on the thread, so no comment path fires, and a finished, unmergeable pull request sits unseen. */
  mergeable?: boolean | null
  createdAt: string
  closedAt?: string
  /** For the status a person reads: GitHub's title, draft flag, merge readiness (`mergeable_state`), and who merged. */
  title?: string
  draft?: boolean
  mergeableState?: string
  mergedBy?: string
}

export interface ReviewComment { path: string; line?: number; body: string; url: string }

export interface PullApi {
  /** Undefined when GitHub has no such pull request. A read this account cannot make — a private repository it
   *  cannot see, which GitHub answers with 404 — throws: the state is unknown, not absent. */
  pull(repo: string, number: number): Promise<PullState | undefined>
  comments(repo: string, number: number, since?: string): Promise<IssueComment[]>
  reviews(repo: string, number: number): Promise<PrReview[]>
  /** One review's comments on the code. */
  reviewComments?(repo: string, number: number, reviewId: number): Promise<ReviewComment[]>
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
  closed(thread: ThreadRef, pull: PullRef, outcome: 'merged' | 'closed', at: string, state?: PullState): void
  /** Every state a read returned, open or closed: the live status a ticket's tracker shows. */
  observed?(thread: ThreadRef, pull: PullRef, state: PullState): void
  /** A follow records a close GitHub denies: the pull request is open. Reopen the follow on the tickets waiting on
   *  it and return how many it reopened. Called on every read that finds a pull request open, so it is a no-op
   *  unless a recorded close is false; it posts nothing, because the router writing on a thread is what recruits a
   *  session (#309), and a repair of the router's own bookkeeping is not news to anyone. */
  reopened(thread: ThreadRef, pull: PullRef): number
  receive(trigger: Trigger): void
  warn(event: string, fields: Record<string, unknown>): void
  now?: () => number
  /** How often a pull request outside the watched repository is read: three calls each time, against GitHub's hourly limit. */
  everyMs?: number
  /**
   * How long a thread that this account cannot read stays out of the queue. Measured 2026-11-10: 330 read
   * failures in 4000 log lines, 42 on one thread, because a 404 is a permanent answer for a private
   * repository and the follower asked again every interval, and again after each of the day's 96 restarts.
   * The burn is what tripped the hourly API limit, and a tripped limit blinds the reads that DO matter.
   */
  cooldownMs?: number
  /** How often one stuck merge conflict is repeated to its ticket. Default 6 h. */
  conflictEveryMs?: number
  /**
   * Most pull requests one pass reads, whatever is due. The 120 s budget above is wall-clock, so it binds only
   * while the loop keeps its cadence; when a tick is entered late, every follow is due at once and the pass pays
   * the whole fan-out (measured 2026-11-09: 41 follows, 12.1 s per pass). The cap makes a pass's cost a property
   * of this number, not of the backlog, and the rotation below guarantees the deferred reads go first next pass.
   */
  maxReads?: number
  /** Wall-clock ceiling on starting new reads in one pass: a `gh` call that hangs cannot hold the tick open. */
  budgetMs?: number
  /** Reads to run at once; unset, `readsAtOnce(due)`. The ceiling is a shared-box dial, not a tuning knob. */
  maxAtOnce?: number
}

// Four `gh` round trips (~0.9 s each) at a time finished a pass inside one tick when seven pulls were live, and
// the cap overlaps calls so it adds none (measured live 2026-11-07). It was never a number for 41 follows: at 4
// the pass is ~31 sequential round trips, which is the 12.1 s above. Scale it with the fan-out, and clamp at 16
// because this box is shared with the workers every `gh` call competes with.
const readsAtOnce = (due: number): number => Math.min(16, Math.max(4, Math.ceil(due / 8)))

/** What one pass did, so the tick's log line can name its own cost. */
export interface ReconcileReport {
  /** Pull requests past their budget when the pass started. */
  due: number
  read: number
  /** Past their budget, left for a later pass by `maxReads` or `budgetMs`; a stalled cadence defers, it never drops. */
  deferred: number
  /** Reads running at once in this pass. */
  atOnce: number
}

/** Moving off the old id cursor, the reviews submitted this long ago are read again once: the ones it skipped are new. */
const REVIEW_CATCH_UP_MS = 6 * 3_600_000

/** A comment that opens with an HTML marker is one a tool keeps updating (a CI dashboard, a coverage bot), whoever's
 *  token posted it: it is automation, not the person, and it must not resume a ticket the way a person can. */
const MACHINE_WRITTEN = /^\s*<!--[\s\S]*?-->/

export class PullFollower {
  private readonly polled = new Map<string, number>()
  private readonly unreadable = new Set<string>()
  /** Thread id -> the moment it may be read again. In memory on purpose: a restart re-asks once, and once is
   *  what a repository that came back into sight deserves. */
  private readonly cooldown = new Map<string, number>()
  /** Consecutive failed reads per thread. The long backoff belongs to the PERMANENT answer (a private
   *  repository this account cannot see), not to a network blip: a repo that comes back into sight mid-day
   *  must be seen on the next interval: four consecutive failures is a permanent answer, three is a bad
   *  minute. */
  private readonly failures = new Map<string, number>()
  /** Threads whose state read has already been complained about: a follow in a repository the account cannot see
   *  fails every interval, and 720 identical lines a day is how the one real line gets buried. */
  private readonly unread = new Set<string>()
  /** Threads whose recorded close this process has already re-checked. A close is a fact about the past, so one
   *  look per start is enough to catch the ones a failed read wrote; re-checking them every poll would buy nothing. */
  private readonly probed = new Set<string>()

  constructor(private readonly options: FollowerOptions) {}

  /** Closed pull requests end their tickets' wait; talk on those outside the watched repository becomes triggers. */
  async reconcile(tickets: readonly Ticket[]): Promise<ReconcileReport> {
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
    const due: Array<{ id: string; pull: PullRef; local: boolean; reopen?: boolean }> = []
    for (const [id, pull] of followed) {
      const local = id.startsWith('#')
      if (local && (!open || open.has(id))) continue
      if (!local && now - (this.polled.get(id) ?? -Infinity) < (this.options.everyMs ?? 120_000)) continue
      // A thread in backoff is not due: the answer that put it there (a repository this account cannot read)
      // does not change between passes, and asking again is the burn, not the fix.
      if (!local && (this.cooldown.get(id) ?? 0) > now) continue
      due.push({ id, pull, local })
    }
    // A follow recorded closed is not in `followed`, so nothing reads it again: a close a read *failed* to make —
    // the 404 GitHub answers for a repository this account cannot see — is written into the ticket for good.
    // Measured 2026-11-09 on the live board: 21 live tickets hold a closed follow on a pull request that is open,
    // with no open follow left, so they are followed by nothing, end by nothing, and no review on their own pull
    // request is ever read; 39 ended tickets took the same false close as their terminal end. A close recorded as
    // `merged` is not a suspect: that outcome needs a read that succeeded and read `merged_at`. Re-check each thread
    // once, on the first pass that sees it, and reopen the ones GitHub denies.
    const recorded = new Map<string, PullRef>()
    for (const ticket of tickets) {
      for (const follow of ticket.follows ?? []) {
        if (follow.closed?.outcome !== 'closed' || !follow.thread.startsWith('github:')) continue
        const id = follow.thread.slice('github:'.length)
        const pull = this.probed.has(id) || followed.has(id) ? undefined : parseThread(id, home)
        if (pull) recorded.set(id, pull)
      }
    }
    for (const [id, pull] of recorded) {
      this.probed.add(id)
      if ((this.cooldown.get(id) ?? 0) > now) continue
      // The watched repository answers this from the poll already in hand: a thread open there denies the close, so
      // that reopen costs no API call. Its absence proves nothing — the list answers issues, and a pull request
      // thread missing from it is not a closed pull request — so the rest are read, once each.
      if (id.startsWith('#') && open?.has(id)) { this.heal(id, pull); continue }
      due.push({ id, pull, local: id.startsWith('#'), reopen: true })
    }
    // The watched repository's own threads cost nothing extra (the source has already read them), so they are
    // never the part a cap defers. The rest go least-recently-read first: with a per-pass cap, that rotation is
    // what guarantees a deferred pull request is read on a pass soon, not starved by a busier one forever.
    // A recorded close awaiting repair goes to the head of the queue, above that rotation: on the first pass after
    // a start nothing carries a `polled` stamp, so a repair sorting only by staleness ties with every follow and
    // lands last of a full fan-out, and the row it is repairing is the one followed by nothing and ended by nothing.
    const stamp = (id: string): number => this.polled.get(id) ?? -1
    const local = due.filter(entry => entry.local)
    const external = due.filter(entry => !entry.local)
      .sort((a, b) => (a.reopen ? 0 : 1) - (b.reopen ? 0 : 1) || stamp(a.id) - stamp(b.id))
    const maxReads = this.options.maxReads ?? 16
    const budgetMs = this.options.budgetMs ?? 10_000
    const queue = [...local, ...external.slice(0, maxReads)]
    const skipped = external.length - Math.min(external.length, maxReads)
    if (queue.length === 0) return { due: due.length, read: 0, deferred: skipped, atOnce: 0 }
    // The width follows the fan-out, not the cap: 41 due reads get six at a time, which is three rounds of the
    // 16 a pass is allowed, and 7 get four as they always did.
    const atOnce = Math.min(this.options.maxAtOnce ?? readsAtOnce(due.length), queue.length)
    let read = 0
    // Side by side, because serially seven follows serialized one tick out to 20 s (measured live 2026-11-07, every 120 s) and every worker launch in that window waited on GitHub.
    const clock = () => this.options.now?.() ?? Date.now()
    await Promise.all(Array.from({ length: atOnce }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        // The budget is the pass's, not the pull's: past it the rest is deferred to a pass that reads them
        // first, which is the difference between a slow tick and a tick that never ends.
        if (!next.local && clock() - now >= budgetMs) { queue.unshift(next); break }
        // Polled when the read starts, not when it is scheduled: a read this pass deferred stays due, and a
        // timestamp for a read that never ran is how a follow goes twenty minutes without one look.
        if (!next.local) this.polled.set(next.id, now)
        read += 1
        await this.read(next.id, next.pull, next.local, now, next.reopen)
      }
    }))
    return { due: due.length, read, deferred: skipped + queue.length, atOnce }
  }

  /** The tickets holding a close on this thread that GitHub says is open get their wait back. */
  private heal(id: string, pull: PullRef): void {
    const thread = threadOfPull(pull, this.options.home)
    const tickets = this.options.reopened(thread, pull)
    if (tickets <= 0) return
    // The wait just changed, so the next pass reads it: `polled` holds the throttle of the read that recorded the
    // false close, and holding a ticket to that clock would leave its reopened pull request unread for the interval.
    this.polled.delete(thread.id)
    this.options.warn('pull.reopened', { thread: thread.id, url: pullUrl(pull), tickets })
  }

  /** `reopen` marks a thread read only because its recorded close is suspect: finding it closed confirms that
   *  close, so it ends nothing — the wait was already ended when it was written down. */
  private async read(id: string, pull: PullRef, local: boolean, now: number, reopen = false): Promise<void> {
    let state: PullState | undefined
    try {
      state = await this.options.api.pull(pull.repo, pull.number)
    } catch (error) {
      // Unknown is not closed. Ending the wait on a read that failed posts "closed without merging, so this ticket
      // ends" on a pull request that is open and ready — measured 2026-11-09, twice in one day, on the router's
      // own fix, because its account cannot see the private repository that pull lives in.
      const fails = (this.failures.get(id) ?? 0) + 1
      this.failures.set(id, fails)
      const ms = this.options.cooldownMs ?? 30 * 60_000
      if (!local && ms > 0 && fails >= 4) this.cooldown.set(id, now + ms)
      // Said once per thread, with the backoff on the same line: the router already counts this event, and a
      // second event per failure doubles the noise for the one fact a reader needs.
      if (!this.unread.has(id)) {
        this.unread.add(id)
        this.options.warn('pull.read_failed', {
          thread: id, error: String(error).slice(0, 200), backoffMinutes: ms > 0 ? Math.round(ms / 60_000) : 0,
        })
      }
      return
    }
    this.cooldown.delete(id)
    this.failures.delete(id)
    if (this.unread.delete(id)) this.options.warn('pull.read_readable', { thread: id })
    if (state) this.options.observed?.({ source: 'github', id }, pull, state)
    // A pull request GitHub no longer has cannot be merged, so the ticket's wait ends here. `undefined` is GitHub's
    // answer for one *to a reader that can see the repository*: a repository this account cannot read throws above
    // and returns here as an untouched follow, because 404 is also what GitHub says about a private repository.
    if (!state || !state.open) {
      if (!reopen) this.options.closed({ source: 'github', id }, pull, state?.merged ? 'merged' : 'closed', state?.closedAt ?? new Date(now).toISOString(), state)
      return
    }
    // Open: any ticket holding a close on this thread holds one that never happened.
    this.heal(id, pull)
    await this.conflict(id, pull, state, now)
    // The reopened follow is in `followed` from the next pass; reading its talk here as well would read it twice.
    if (reopen || local) return
    await this.listen(id, pull, state.createdAt)
  }

  /** A pull request that stopped merging cleanly is a fact the ticket never hears from a comment: no person
   *  spoke, so nothing launched a worker. Measured 2026-11-10 — one fleet pull request sat unmergeable for
   *  16 hours and a second for 15, work finished and unreachable, because the follower reads talk for review
   *  and merge state for closing, and a conflict is neither. One notice, then silence for `conflictEveryMs`:
   *  a conflict repeated every 120 s launches a worker every 120 s on news that has not changed. */
  private conflict(id: string, pull: PullRef, state: PullState, now: number): void {
    const key = `pulls:${id}:conflict`
    if (state.mergeable !== false) {
      if (this.options.positions.get<string>(key) !== 'clean') this.options.positions.set(key, 'clean')
      return
    }
    const last = Number(this.options.positions.get<string>(key) ?? 0)
    if (now - last < (this.options.conflictEveryMs ?? 6 * 60 * 60_000)) return
    this.options.positions.set(key, String(now))
    this.options.receive(this.trigger(id, pull, 'github', 'None', new Date(now).toISOString(),
      'GitHub reports this pull request no longer merges cleanly: it has a merge conflict against its base. '
        + 'Rebase or merge the base branch, resolve the conflict, push the branch, and report the new head.',
      'conflict', `conflict:${id}:${now}`))
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
        // GitHub's `since` is last-update time, so an edited comment comes back; one created before the cursor was
        // already read. Its new body made a new trigger id: a CI dashboard edited in place reached a worker as a fresh
        // message from the operator on every CI run (2026-11-12).
        if (Date.parse(c.at) < Date.parse(since)) continue
        this.options.receive(this.trigger(id, pull, c.author, c.association, c.at, c.body, 'comment',
          `github:${id}:${createHash('sha1').update(`${c.author}\u0000${c.at}\u0000${c.body}`).digest('hex').slice(0, 16)}`))
      }
      // Committed once the engine holds what it produced: a crash before this line replays, and ids make replays free.
      // The cursor sits CURSOR_LAG_MS behind real time (see source-github.ts), so a same-second comment that
      // surfaces after this read is still ahead of the cursor on the next poll; the dedup makes the re-read free.
      if (newest !== since) {
        const settled = Math.min(Date.parse(newest) + 1, (this.options.now?.() ?? Date.now()) - CURSOR_LAG_MS)
        this.options.positions.set(sinceKey, new Date(Math.max(Date.parse(since), settled)).toISOString())
      }
      // By submission time: GitHub numbers a review when it is started, so an id cursor skipped a person's review submitted
      // after the fleet's own (2026-11-12). Trigger ids carry the review id, so a re-read inside the lag is a dropped duplicate.
      const reviewSince = `${reviewKey}-since`
      const nowMs = this.options.now?.() ?? Date.now()
      const reviewedTo = this.options.positions.get<string>(reviewSince)
        ?? (this.options.positions.get<number>(reviewKey) !== undefined ? new Date(nowMs - REVIEW_CATCH_UP_MS).toISOString() : undefined)
      let latest = reviewedTo
      for (const r of await this.options.api.reviews(pull.repo, pull.number)) {
        if (reviewedTo && Date.parse(r.at) <= Date.parse(reviewedTo)) continue
        if (!latest || Date.parse(r.at) > Date.parse(latest)) latest = r.at
        if (this.ours(r.author, r.body)) continue
        const said = `${pull.repo}#${pull.number}: ${r.author} ${r.state.toLowerCase().replace(/_/g, ' ')}${r.body ? `\n\n${r.body.slice(0, 4000)}` : ''}`
          + await this.onTheCode(pull, r.id)
        this.options.receive(this.trigger(id, pull, r.author, r.association, r.at, said, 'review', `github:${id}:review:${r.id}`))
      }
      if (latest && latest !== reviewedTo) {
        const settled = Math.min(Date.parse(latest) + 1, nowMs - CURSOR_LAG_MS)
        this.options.positions.set(reviewSince, new Date(Math.max(reviewedTo ? Date.parse(reviewedTo) : 0, settled)).toISOString())
      }
      if (this.unreadable.delete(id)) this.options.warn('pull.listen_readable', { thread: id })
    } catch (error) {
      // Once per pull request, not once per poll: 720 identical lines a day bury the one that is new.
      if (!this.unreadable.has(id)) {
        this.unreadable.add(id)
        this.options.warn('pull.listen_failed', { thread: id, error: String(error).slice(0, 200) })
      }
    }
  }

  /** A review's comments on the code are most of what a person says in it: its summary alone read "changes requested"
   *  with no words, and workers left points unanswered (operator, 2026-11-12). Numbered, so a report can answer each. */
  private async onTheCode(pull: PullRef, reviewId: number): Promise<string> {
    if (!this.options.api.reviewComments) return ''
    try {
      const rows = await this.options.api.reviewComments(pull.repo, pull.number, reviewId)
      if (!rows.length) return ''
      return `\n\n${rows.length} comment${rows.length === 1 ? '' : 's'} on the code, numbered so your report can answer each:\n`
        + rows.map((c, i) => `${i + 1}. ${c.path}${c.line ? `:${c.line}` : ''}: ${c.body.slice(0, 1500)}${c.url ? `\n   ${c.url}` : ''}`).join('\n')
    } catch {
      return `\n\nIts comments on the code could not be read here; read every one with \`gh api repos/${pull.repo}/pulls/${pull.number}/reviews/${reviewId}/comments\`.`
    }
  }

  private ours(author: string, body: string): boolean {
    return author === this.options.self || body.includes(REPLY_MARKER)
  }

  private trigger(id: string, pull: PullRef, author: string, association: string, at: string, text: string,
                  via: 'comment' | 'review' | 'conflict', triggerId: string): Trigger {
    return {
      id: triggerId,
      source: 'github',
      threads: [{ source: 'github', id }],
      actor: { source: 'github', id: author },
      human: !isListed(author, this.options.bots) && !MACHINE_WRITTEN.test(text),
      at,
      text,
      // The repository rides in the address: the outbox posts to the repository a channel names, not the watched one.
      channel: { source: 'github', thread: id, address: { repo: pull.repo, issue: String(pull.number) } },
      meta: { via, association, author, repo: pull.repo },
    }
  }
}
