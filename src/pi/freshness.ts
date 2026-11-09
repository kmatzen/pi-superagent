/**
 * Pre-dispatch freshness: the two reads that say whether a finished ticket has moved.
 *
 * Measured on the live router 2026-11-09: ticket `#213` ran seven workers in 15 hours, and `#289` thirteen, each
 * one woken by an intake trigger whose only novelty was the `updated_at` the router's own receipt had just put on
 * the issue. Every one of those runs began by checking what the router could have checked for it: the pull request
 * it was waiting on was open, unreviewed and at the same head, and nobody had answered the ask. A run costs a
 * session, a herdr tab and a receipt in the operator's queue; the check costs two `gh api` reads.
 *
 * So the router takes the cheap side of that trade: before it starts a worker on a ticket whose last word is
 * `ready` or `blocked` on a pull request it opened, it re-reads that pull request (state, head, comment count,
 * `updated_at`) and the last person to speak on the ask. Unchanged since the last dispatch means the last receipt
 * *is* the current state, and the dispatch is withheld — the inputs stay queued, so the first real move starts the
 * worker on the next pass.
 *
 * Two rules keep the gate from becoming a silence machine:
 * - it fails open. A GitHub read that throws is never a reason to withhold work; the dispatch goes out.
 * - it is not forever. `redispatchHours` (24 by default) passes, and the ticket gets a worker on the unchanged
 *   state, so a ticket cannot be quieted permanently by a fingerprint that stops moving.
 */
import { isListed } from './authors.ts'
import { latestReport, type Ticket } from '../core/index.ts'
import { REPLY_MARKER, type IssueComment, type PositionStore } from './source-github.ts'
import { parseThread, pullUrl, type PullRef, type PullState } from './pulls.ts'

/** The last reports that mean "the worker has said everything it has to say". */
const SETTLED = new Set(['ready', 'blocked'])

export interface FreshnessApi {
  /** Undefined when GitHub has no such pull request. */
  pull(repo: string, number: number): Promise<PullState | undefined>
  /** One thread's comments, in any order; the gate takes the newest that is not the router's own. */
  comments(issue: number, repo?: string): Promise<IssueComment[]>
}

export interface FreshnessOptions {
  home: string
  api: FreshnessApi
  positions: PositionStore
  self: string
  bots?: ReadonlySet<string>
  warn(event: string, fields: Record<string, unknown>): void
  now?: () => number
  /** How long a read is trusted: the same ticket is offered a dispatch by more than one path in a pass, and the
   *  loop that woke it wakes it again on every pass. An answer that lands inside the window starts the worker on
   *  the first pass after it, so the window is the worst delay this gate puts on a person. */
  memoMs?: number
  /** An unchanged ticket gets a worker this often anyway, so a gate can never mute one for good. */
  redispatchHours?: number
}

interface Stored { fp: string; at: string }

const key = (ticketId: string): string => `freshness:${ticketId}`
const iso = (ms: number): string => new Date(ms).toISOString()

/** The pull requests a ticket is waiting on that it opened itself, and the ask its receipts land on. */
export function watched(ticket: Ticket, home: string): { pulls: PullRef[]; ask?: { issue: number; repo?: string } } | undefined {
  const report = latestReport(ticket)
  if (!report || !SETTLED.has(report.state)) return undefined
  const pulls: PullRef[] = []
  for (const follow of ticket.follows ?? []) {
    if (follow.closed || !follow.own || !follow.thread.startsWith('github:')) continue
    const pull = parseThread(follow.thread.slice('github:'.length), home)
    if (pull && !pulls.some(p => p.repo === pull.repo && p.number === pull.number)) pulls.push(pull)
  }
  if (!pulls.length) return undefined
  const channel = ticket.channels[0]
  if (channel?.source !== 'github') return { pulls }
  const address = channel.address as { issue?: string; repo?: string } | undefined
  const issue = Number(address?.issue ?? /^#(\d+)$/.exec(channel.thread)?.[1] ?? '')
  return Number.isInteger(issue) && issue > 0 ? { pulls, ask: { issue, ...(address?.repo ? { repo: address.repo } : {}) } } : { pulls }
}

/** The state the gate compares: one string per pull request, then who last answered the ask. */
export const fingerprint = (pulls: readonly string[], ask: string): string => `${pulls.join('|')}#${ask}`

/** What one pull request looks like to the gate: enough to say nobody has touched it. */
export const pullSnapshot = (state: PullState | undefined): string => {
  if (!state) return 'gone'
  const status = state.open ? 'open' : state.merged ? 'merged' : 'closed'
  return `${status}/${state.headSha ?? '?'}/${state.comments ?? 0}/${state.updatedAt ?? '?'}`
}

/**
 * A pre-dispatch gate: `stale(ticket)` answers whether starting a worker on this ticket would repeat work the last
 * receipt already reported. It reads only what the mandate of a finished ticket is waiting on, and nothing else.
 */
export class FreshnessGate {
  private readonly memo = new Map<string, { at: number; stale: boolean }>()
  private readonly unreadable = new Set<string>()
  /** A report's baseline that is still being read. Registered synchronously, so the pass that lands in the
   *  same tick as the report measures itself against that baseline and not against a missing record. */
  private readonly noting = new Map<string, Promise<void>>()

  constructor(private readonly options: FreshnessOptions) {}

  /**
   * Whether to withhold this dispatch. False means: start the worker — it is not a settled ticket waiting on a
   * pull request, something moved, the first look at it, the valve is due, or the read failed.
   */
  async stale(ticket: Ticket): Promise<boolean> {
    const now = this.options.now?.() ?? Date.now()
    const target = watched(ticket, this.options.home)
    if (!target) return false
    const memo = this.memo.get(ticket.id)
    if (memo && now - memo.at < (this.options.memoMs ?? 120_000)) return memo.stale
    // The last report's baseline wins the race with this pass: a report commits, its read is in flight, and the
    // pass that follows it is the one whose session this gate is meant to save.
    await this.noting.get(ticket.id)
    let fp: string
    try {
      const pulls = await Promise.all(target.pulls.map(async pull => `${pull.repo}#${pull.number}:${pullSnapshot(await this.options.api.pull(pull.repo, pull.number))}`))
      fp = fingerprint(pulls, await this.ask(target.ask))
    } catch (error) {
      // A GitHub hiccup is not a reason to withhold work, and once per ticket is the report: a poll that cannot
      // read is a poll that dispatches, and 2880 of them a day bury the outage.
      if (!this.unreadable.has(ticket.id)) {
        this.unreadable.add(ticket.id)
        this.options.warn('dispatch.freshness_unreadable', { ticket: ticket.id, error: String(error).slice(0, 200) })
      }
      this.memo.set(ticket.id, { at: now, stale: false })
      return false
    }
    this.unreadable.delete(ticket.id)
    const held = this.options.positions.get<Stored>(key(ticket.id))
    // A record this gate cannot read as its own (none, or a corrupt stamp) is a ticket that has not run yet.
    const unchanged = held?.fp === fp && (now - Date.parse(held.at)) / 3_600_000 < (this.options.redispatchHours ?? 24)
    this.memo.set(ticket.id, { at: now, stale: unchanged })
    if (!unchanged) this.options.positions.set(key(ticket.id), { fp, at: iso(now) })
    return unchanged
  }

  /**
   * The baseline a settled report writes down: read the pull request and the ask at the moment the worker says
   * it is done, so the FIRST redundant dispatch is the one withheld, not the second. Measured 2026-11-09: #213's
   * three sessions in 25 minutes and #289's thirteen all began as run 2 — the first dispatch after a receipt the
   * operator had not answered. Without this stamp the gate has to spend that one session to learn the state the
   * worker just reported; with it the ticket's own report is the state, which is what the mandate asked for.
   *
   * Called after the report committed, never in front of it: a read that fails leaves the stored stamp alone,
   * and the next dispatch is judged against the last state the gate did see.
   */
  note(ticket: Ticket): Promise<void> {
    const running = this.noting.get(ticket.id) ?? this.write(ticket)
    this.noting.set(ticket.id, running)
    void running.finally(() => { if (this.noting.get(ticket.id) === running) this.noting.delete(ticket.id) })
    return running
  }

  private async write(ticket: Ticket): Promise<void> {
    const target = watched(ticket, this.options.home)
    if (!target) return
    try {
      const pulls = await Promise.all(target.pulls.map(async pull => `${pull.repo}#${pull.number}:${pullSnapshot(await this.options.api.pull(pull.repo, pull.number))}`))
      const fp = fingerprint(pulls, await this.ask(target.ask))
      this.options.positions.set(key(ticket.id), { fp, at: iso(this.options.now?.() ?? Date.now()) })
      this.memo.delete(ticket.id)
    } catch (error) {
      if (!this.unreadable.has(ticket.id)) {
        this.unreadable.add(ticket.id)
        this.options.warn('dispatch.freshness_unreadable', { ticket: ticket.id, at: 'report', error: String(error).slice(0, 200) })
      }
    }
  }

  /** Who last answered the ask, as a fact that only a person can change. The router's own receipts do not count. */
  private async ask(target: { issue: number; repo?: string } | undefined): Promise<string> {
    if (!target) return 'no-ask'
    const rows = await this.options.api.comments(target.issue, target.repo)
    const mine = (c: IssueComment): boolean => c.author === this.options.self || bodyHasMarker(c.body) || isListed(c.author, this.options.bots)
    const last = rows.filter(c => !mine(c)).sort((a, b) => b.at.localeCompare(a.at))[0]
    return last ? `${last.author}@${last.at}` : 'none'
  }

  /** The URL an operator reads when the gate tells them a ticket has not moved. */
  urls(ticket: Ticket): string[] {
    return (watched(ticket, this.options.home)?.pulls ?? []).map(pullUrl)
  }
}

const bodyHasMarker = (body: string): boolean => body.includes(REPLY_MARKER)
