/** What a person reads on the thread when a worker's run ends: what happened, and what they can do next. */
import type { ReportOrigin } from './report-tool.ts'

export interface ReportedRun {
  state: string
  summary: string
  question?: string | null
  /** The pull requests the ticket now follows, by URL. */
  pullRequests?: readonly string[]
}

const STILL_OPEN = 'The worker is still open: reply here to steer it, or close the issue to drop the ticket.'
const IN_REVIEW = 'This ticket stays open until the pull request is merged or closed; comments and reviews on it go to the worker.'
/**
 * The terminal end, said out loud. A `ready` report with no pull request ends the ticket in the engine and
 * left nothing to read on the issue: no merge to wait for, no door closed, so the board kept asking (measured
 * 2026-11-09, #255 dispatched four workers after its merge). The router closes the issue with these words;
 * `superagent restart` is not a door, and neither is a label that stays on.
 */
const FINISHED = 'This ticket ends with the report: no pull request is open on it, so nothing runs it now, and this issue closes with it. '
  + 'A comment on the closed issue, or reopening it, starts the work again; nothing else does.'

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
      if (run.state === 'ready' && !pulls) return `${head}\n\n${FINISHED}`
      return run.state === 'ready' && pulls ? `${head}${pulls}\n\n${IN_REVIEW}` : `${head}${pulls}`
    }
  }
}

/**
 * The engine ends a ticket with its pull requests without a word; this is the word, on the issue. Each pull
 * carries its own outcome, because a ticket can open several: the engine ends it on the LAST close, and
 * naming every pull by that one outcome told the person that a merged pull request had been closed.
 *
 * `confirmed: false` says the outcome is a record, not an observation: the state of a pull request in a repository
 * this account cannot read (GitHub answers 404) is exactly the fact the router cannot see, and the record it holds
 * was written by a read that failed. Measured 2026-11-09 on board #309: the router closed the ticket's issue with
 * "pull/31 closed without merging, so this ticket ends" about a pull request that merged, in a repository it cannot
 * read. An outcome nobody observed is stated as one, and the operator acts on it.
 */
export function pullEndText(thread: string,
  pulls: ReadonlyArray<{ url: string; outcome: 'merged' | 'closed'; confirmed?: boolean }>): string {
  const urls = (list: string[]): string => list.join(', ') || 'its pull request'
  const merged = pulls.filter(p => p.outcome === 'merged').map(p => p.url)
  const closed = pulls.filter(p => p.outcome === 'closed' && p.confirmed !== false).map(p => p.url)
  const unverified = pulls.filter(p => p.outcome === 'closed' && p.confirmed === false).map(p => p.url)
  const seen = merged.length + closed.length
  const blind = unverified.length
    ? `I cannot read ${urls(unverified)}: the account I run as gets 404 from that repository, so the record that `
      + 'it closed came from a read that failed, not from GitHub, and I have not seen it end. If it merged, say so '
      + 'here and I will record the merge; grant my account read on that repository and I will read it myself.'
    : ''
  const head = !seen
    ? `${thread}: this ticket ends.`
    : !closed.length
      ? `${thread} merged: ${urls(merged)}. This ticket is done.`
      : !merged.length
        ? `${thread}: ${urls(closed)} closed without merging, so this ticket ends. A comment here starts the work again.`
        : `${thread}: ${urls(merged)} merged and ${urls(closed)} closed without merging, so this ticket ends with the work that landed. A comment here starts the work again.`
  return unverified.length ? (seen ? `${head}\n\n${blind}` : `${head} ${blind}`) : head
}

