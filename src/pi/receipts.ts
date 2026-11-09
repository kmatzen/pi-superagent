/** What a person reads on the thread when a worker's run ends: what happened, and what they can do next. */
import type { ReportOrigin } from './report-tool.ts'
import type { PullEvidence } from './pulls.ts'

export interface ReportedRun {
  state: string
  summary: string
  question?: string | null
  /** The pull requests the ticket now follows, by URL. */
  pullRequests?: readonly string[]
}

const STILL_OPEN = 'The worker is still open: reply here to steer it, or close the issue to drop the ticket.'
const IN_REVIEW = 'This ticket stays open until the pull request is merged or closed; comments and reviews on it go to the worker.'

export function receiptText(thread: string, origin: ReportOrigin, run: ReportedRun, relaunched = false): string {
  const head = `${thread} ${run.state}: ${run.summary}`
  switch (origin) {
    case 'crash':
      return relaunched
        ? `${head}\n\nThe router started a fresh worker on it. If that one crashes too, nothing runs this ticket until \`superagent restart\`, and closing the issue drops it.`
        : `${head}\n\nNothing is working on this ticket now: \`superagent restart\` gives it a fresh worker, and closing the issue drops it.`
    case 'launch':
      return `${head}\n\nThe router tries again on every poll until the cause is fixed or the issue is closed.`
    case 'silent':
      return `${thread}: the worker stopped without reporting a result.\n\n${STILL_OPEN}`
    case 'worker': {
      const pulls = run.pullRequests?.length ? `\n\n${run.pullRequests.map(url => `**Pull request:** ${url}`).join('\n')}` : ''
      if (run.state === 'blocked') {
        return `${head}${pulls}\n\n${run.question ? `**Question:** ${run.question}\n\n` : ''}Reply here; the worker reads every comment.`
      }
      if (run.state === 'failed') return `${head}${pulls}\n\n${STILL_OPEN}`
      return run.state === 'ready' && pulls ? `${head}${pulls}\n\n${IN_REVIEW}` : `${head}${pulls}`
    }
  }
}

/** A pull request that ended its ticket, with the read the ending was decided from. */
export interface EndedPull {
  url: string
  outcome: 'merged' | 'closed'
  /** The poll's own numbers: a receipt without them is an unfalsifiable claim about GitHub (board #235, 2026-11-09). */
  evidence?: PullEvidence
}

/** The line a reader checks the ending against: GitHub's fields, verbatim, plus the exit status of the read. */
function evidenceLine(pull: EndedPull): string {
  const e = pull.evidence
  if (!e) return `- ${pull.url}`
  const fields = [`gh exit ${e.status}`, `state=${e.state || '(none)'}`, `closed_at=${e.closedAt ?? 'null'}`, `merged_at=${e.mergedAt ?? 'null'}`,
    `head=${e.headRefOid ? e.headRefOid.slice(0, 10) : 'none'}`]
  if (e.reason) fields.push(`read=${e.reason}`)
  return `- ${pull.url} (#${e.number} in ${e.repo}): ${fields.join(', ')}`
}

/**
 * The engine ends a ticket with its pull requests without a word; this is the word, on the issue. Each pull
 * carries its own outcome, because a ticket can open several: the engine ends it on the LAST close, and
 * naming every pull by that one outcome told the person that a merged pull request had been closed.
 *
 * Every claim it makes about a pull request is quoted from the read that ended it, so the sentence can be
 * checked with `gh api repos/<repo>/pulls/<n>`: eight receipts telling a board its work was "closed without
 * merging" were accepted for nine hours because none of them carried a state, a time, or an exit status.
 */
export function pullEndText(thread: string, pulls: ReadonlyArray<EndedPull>): string {
  const urls = (list: string[]): string => list.join(', ') || 'its pull request'
  const merged = pulls.filter(p => p.outcome === 'merged').map(p => p.url)
  const closed = pulls.filter(p => p.outcome === 'closed').map(p => p.url)
  // A pull request GitHub has no number for is not a reviewer's refusal, and the ending says which of the two it saw.
  const gone = pulls.filter(p => p.outcome === 'closed' && p.evidence?.reason === 'no-such-pull-request').map(p => p.url)
  let head: string
  if (!closed.length) head = `${thread} merged: ${urls(merged)}. This ticket is done.`
  else if (gone.length === closed.length) head = `${thread}: ${urls(gone)} no longer exists on GitHub, so this ticket ends with nothing merged. A comment here starts the work again.`
  else if (!merged.length) head = `${thread}: ${urls(closed)} closed without merging, so this ticket ends. A comment here starts the work again.`
  else head = `${thread}: ${urls(merged)} merged and ${urls(closed)} closed without merging, so this ticket ends with the work that landed. A comment here starts the work again.`
  if (!pulls.some(p => p.evidence)) return head
  return `${head}\n\nThe router acted on this read:\n${pulls.map(evidenceLine).join('\n')}`
}
