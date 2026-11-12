/** One status comment per issue for a ticket with several pull requests, in the worker's merge order, edited in place:
 *  report comments' pull request lists drift between runs, and a person pieced the plan together (operator, 2026-11-12). */
import { createHash } from 'node:crypto'
import type { Ticket } from '../core/index.ts'
import { parsePull, parseThread, pullUrl, threadOfPull, type PullRef, type PullState } from './pulls.ts'

export interface TrackerRow {
  url: string
  label: string
  title?: string
  status: string
  next: string
  done: boolean
}

interface Kept { comment?: number; url?: string; hash?: string; order: string[]; declared?: boolean }

const key = (ticketId: string): string => `tracker:${ticketId}`

type Verdict = { status: string; done: boolean; you?: string; worker?: string }

function verdict(state: PullState | undefined, closed: 'merged' | 'closed' | undefined): Verdict {
  if (closed === 'merged' || state?.merged) return { status: 'merged', done: true }
  if (closed === 'closed' || (state && !state.open)) return { status: 'closed without merging', done: true }
  if (state?.draft) return { status: 'draft', done: false, you: 'review, then mark it ready' }
  if (state?.mergeable === false || state?.mergeableState === 'dirty') return { status: 'merge conflict', done: false, worker: 'resolve the conflict' }
  switch (state?.mergeableState) {
    case 'behind': return { status: 'behind its base branch', done: false, worker: 'update the branch' }
    case 'unstable': return { status: 'checks failing', done: false, worker: 'fix the checks' }
    case 'blocked': return { status: 'needs approval or checks', done: false, you: 'review' }
    case 'clean': case 'has_hooks': return { status: 'ready to merge', done: false, you: 'merge' }
    default: return { status: 'open', done: false, you: 'review' }
  }
}

const shortName = (pull: PullRef): string => `${pull.repo.split('/')[1] ?? pull.repo}#${pull.number}`
const cell = (text: string): string => text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').slice(0, 90)

/** Rows in the worker's merge order, then open pull requests the ticket follows that the latest report left out: an open
 *  one nobody mentions any more is what a person must see. Closed ones it left out are history. */
export function trackerRows(ticket: Ticket, order: readonly string[], state: (threadId: string) => PullState | undefined,
                            home: string, sequence = true): TrackerRow[] {
  const follows = new Map((ticket.follows ?? []).map(f => [f.thread, f]))
  const seen = new Set<string>()
  const refs: PullRef[] = []
  for (const url of order) {
    const pull = parsePull(url)
    const id = pull && threadOfPull(pull, home).id
    if (!pull || !id || seen.has(id) || !follows.has(`github:${id}`)) continue
    seen.add(id)
    refs.push(pull)
  }
  for (const follow of ticket.follows ?? []) {
    const id = follow.thread.replace(/^github:/, '')
    const pull = follow.thread.startsWith('github:') ? parseThread(id, home) : undefined
    if (!pull || seen.has(id) || follow.closed) continue
    seen.add(id)
    refs.push(pull)
  }
  // With no plan a report declared, a pull request closed unmerged is one the work dropped: a worker that folded nine
  // into one left eight rows of noise (2026-11-12). A declared plan keeps it: someone said no to a step of it.
  const kept = refs.filter(pull => sequence || follows.get(`github:${threadOfPull(pull, home).id}`)?.closed?.outcome !== 'closed')
  refs.splice(0, refs.length, ...kept)
  const verdicts = refs.map(pull => {
    const id = threadOfPull(pull, home).id
    return verdict(state(id), follows.get(`github:${id}`)?.closed?.outcome)
  })
  const first = verdicts.findIndex(v => !v.done)
  return refs.map((pull, i) => {
    const v = verdicts[i]!
    const title = state(threadOfPull(pull, home).id)?.title
    const next = v.done ? '' : v.worker ? `worker: ${v.worker}` : i === first || !sequence ? `**you: ${v.you}**` : `after #${first + 1}`
    return { url: pullUrl(pull), label: shortName(pull), ...(title ? { title } : {}), status: v.status, next, done: v.done }
  })
}

/** The comment's text, without the time it was written: that part changes on every write and would defeat the hash. */
export function trackerText(thread: string, rows: readonly TrackerRow[]): string {
  const merged = rows.filter(r => r.status === 'merged').length
  return [
    `### Pull requests for ${thread}: ${merged} of ${rows.length} merged`,
    '',
    '| # | Pull request | State | Next |',
    '|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | [${r.label}](${r.url})${r.title ? ` ${cell(r.title)}` : ''} | ${r.status} | ${r.next || '-'} |`),
  ].join('\n')
}

export interface TrackerOptions {
  kv: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
  home: string
  write?: (issue: number, commentId: number | undefined, body: string, repo?: string) => Promise<{ id: number; url: string }>
  state(threadId: string): PullState | undefined
  log(event: string, fields: Record<string, unknown>): void
  now(): Date
}

export class PullTracker {
  private readonly writing = new Set<string>()
  constructor(private readonly o: TrackerOptions) {}

  /** The pull requests a report named, in the order it named them: the order a person merges them in. Ones that merged
   *  since the last report stay first, so the status keeps saying how much of the plan has landed. */
  ordered(ticket: Ticket, urls: readonly string[]): void {
    const kept = this.o.kv.get<Kept>(key(ticket.id)) ?? { order: [] }
    const merged = (url: string): boolean => {
      const pull = parsePull(url)
      return !!pull && ticket.follows?.find(f => f.thread === `github:${threadOfPull(pull, this.o.home).id}`)?.closed?.outcome === 'merged'
    }
    const landed = kept.order.filter(url => !urls.includes(url) && merged(url))
    this.o.kv.set(key(ticket.id), { ...kept, order: [...landed, ...urls], declared: true })
  }

  url(ticketId: string): string | undefined { return this.o.kv.get<Kept>(key(ticketId))?.url }

  /** Writes the ticket's status comment when its text changed; one pull request alone gets none. */
  async refresh(ticket: Ticket): Promise<void> {
    const channel = ticket.channels[0]
    const address = channel?.address as { issue?: string; repo?: string } | undefined
    const issue = Number(address?.issue)
    if (!this.o.write || channel?.source !== 'github' || !issue || this.writing.has(ticket.id)) return
    const kept = this.o.kv.get<Kept>(key(ticket.id)) ?? { order: [] }
    const rows = trackerRows(ticket, kept.order, this.o.state, this.o.home, kept.declared === true)
    if (!kept.comment && rows.length < 2) return
    const text = trackerText(channel.thread, rows)
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 16)
    if (hash === kept.hash) return
    this.writing.add(ticket.id)
    try {
      const at = this.o.now().toISOString().slice(11, 16)
      const body = `${text}\n\n<sub>Kept current by the fleet, last changed ${at} UTC: this comment is edited in place, and each report is a comment below.</sub>`
      const written = await this.o.write(issue, kept.comment, body, address?.repo)
      // No report has ordered them yet: the set the comment first showed is the plan, so a merge stays on it as merged.
      const order = kept.order.length ? {} : { order: rows.map(r => r.url) }
      this.o.kv.set(key(ticket.id), { ...(this.o.kv.get<Kept>(key(ticket.id)) ?? kept), ...order, comment: written.id, url: written.url, hash })
      this.o.log('tracker.written', { ticket: ticket.id, thread: channel.thread, comment: written.id, pulls: rows.length, merged: rows.filter(r => r.status === 'merged').length })
    } catch (error) {
      this.o.log('tracker.write_failed', { ticket: ticket.id, thread: channel.thread, error: String(error).slice(0, 200) })
    } finally {
      this.writing.delete(ticket.id)
    }
  }
}
