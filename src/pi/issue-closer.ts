/** A finished ticket closes its issue: an open one is a request intake hears again (2026-11-09: #255 was dispatched
 *  a fourth time nine hours after its merge). A comment on a closed issue, or a reopen, still starts work. */
import type { Ticket } from '../core/index.ts'
import type { EngineLog } from './log.ts'
import { parseThread, pullUrl, type PullApi } from './pulls.ts'

export interface IssueCloserOptions {
  tickets: { get(id: string): Ticket | undefined; open(): readonly Ticket[] }
  kv: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
  /** Absent when the router has no GitHub to write to: then nothing closes. */
  closeIssue?: (issue: number) => Promise<void>
  pullApi: PullApi
  /** The watched repository, `owner/name`: a bare `#7` thread lives in it. */
  home: string
  flushReplies: () => Promise<void>
  log: EngineLog
  keepIssuesOpen?: boolean
  now: () => string
  /** A check the ticket's last worker asked for, still to run: the issue stays open until it reports. */
  pendingCheck?: (ticketId: string) => boolean
  /** How long a close that waits on an open pull request waits before GitHub is asked again. Default 10 min. */
  recheckMs?: number
}

const CLOSED_KEY = 'closed-issues'
const WAITING_KEY = 'closing-waits'

export class IssueCloser {
  private readonly queued: string[] = []

  constructor(private readonly o: IssueCloserOptions) {}

  finish(ticketId: string): void {
    if (this.closable(ticketId) !== undefined && !this.queued.includes(ticketId)) this.queued.push(ticketId)
  }

  /** A close a pull request still holds is kept and asked again: dropped, it waited forever, because a finished
   *  ticket is no longer followed and nothing else notices the merge. */
  async flush(): Promise<void> {
    if (!this.o.closeIssue) return
    const nowMs = Date.parse(this.o.now())
    const waits = this.o.kv.get<Record<string, string>>(WAITING_KEY) ?? {}
    const due = Object.entries(waits)
      .filter(([, at]) => nowMs - Date.parse(at) >= (this.o.recheckMs ?? 600_000)).map(([id]) => id)
    const batch = [...new Set([...this.queued.splice(0), ...due])]
    if (!batch.length) return
    // The words first, then the door: the thread reads as an answer that ended, not a request that vanished.
    await this.o.flushReplies()
    for (const ticketId of batch) {
      const issue = this.closable(ticketId)
      if (issue === undefined) { delete waits[ticketId]; continue }
      try {
        // `#7` names an issue and a pull request in the same repository, and PATCH state=closed on the pull
        // number closes the pull request: only a number GitHub does not know as a pull is safe to close here.
        if (await this.o.pullApi.pull(this.o.home, issue)) {
          this.o.log.line('info', 'issue.close_skipped', { ticket: ticketId, issue: `#${issue}`, why: 'the thread is a pull request' })
          delete waits[ticketId]
          continue
        }
        const blocking = await this.openPullsOn(this.o.tickets.get(ticketId))
        if (blocking.length > 0) {
          if (!waits[ticketId]) {
            this.o.log.line('info', 'issue.close_skipped', { ticket: ticketId, issue: `#${issue}`,
              why: `open or unreadable, asked again later: ${blocking.join(' ').slice(0, 160)}` })
          }
          waits[ticketId] = this.o.now()
          continue
        }
        await this.o.closeIssue(issue)
        this.o.kv.set(CLOSED_KEY, { ...this.closedHere(), [ticketId]: this.o.now() })
        delete waits[ticketId]
        this.o.log.line('info', 'issue.closed', { ticket: ticketId, issue: `#${issue}`, outcome: this.o.tickets.get(ticketId)?.ended?.outcome })
      } catch (error) {
        this.o.log.line('warn', 'issue.close_failed', { ticket: ticketId, issue: `#${issue}`, error: String(error).slice(0, 200) })
        waits[ticketId] = this.o.now()
      }
    }
    this.o.kv.set(WAITING_KEY, waits)
  }

  private closedHere(): Record<string, string> { return this.o.kv.get<Record<string, string>>(CLOSED_KEY) ?? {} }

  private closable(ticketId: string): number | undefined {
    if (this.o.keepIssuesOpen) return undefined
    const ticket = this.o.tickets.get(ticketId)
    const channel = ticket?.channels[0]
    if (!ticket?.ended || ticket.ended.by !== 'executor' || !channel || channel.source !== 'github') return undefined
    // Work still owed: a pull request that has not landed is the ticket waiting on a person, not finished.
    if ((ticket.follows ?? []).some(f => !f.closed)) return undefined
    const address = channel.address as { issue?: string; repo?: string }
    // Only the watched repository's issues: an issue in another repository belongs to that repository's board.
    if (!address.issue || address.repo) return undefined
    // Closed for this end only: a ticket resumed on a reopened issue that ends again closes it again (2026-11-13, #387).
    const closedAt = this.closedHere()[ticket.id]
    if (closedAt && closedAt >= ticket.ended.at) return undefined
    if (this.o.pendingCheck?.(ticket.id)) return undefined
    // A newer ticket owns the issue now; closing it would stop that ticket's work.
    if (this.o.tickets.open().some(t => t.channels[0]?.thread === channel.thread)) return undefined
    return Number(address.issue) || undefined
  }

  /** Operator, 2026-11-10: an issue stays open until every linked pull request is merged or closed. GitHub answers,
   *  not the ticket's memory (a failed read can record a close), and an unknown is not a merge. One exception: a pull a
   *  person abandoned is never asked again, because GitHub answers "open" to that one forever. */
  private async openPullsOn(ticket: Ticket | undefined): Promise<string[]> {
    const blocking: string[] = []
    for (const follow of ticket?.follows ?? []) {
      if (!follow.thread.startsWith('github:') || follow.closed?.outcome === 'abandoned') continue
      const pull = parseThread(follow.thread.slice('github:'.length), this.o.home)
      if (!pull) continue
      try {
        const state = await this.o.pullApi.pull(pull.repo, pull.number)
        if (!state || state.open) blocking.push(pullUrl(pull))
      } catch { blocking.push(pullUrl(pull)) }
    }
    return blocking
  }
}
