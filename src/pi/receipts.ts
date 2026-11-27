/** What a person reads on the thread when a worker's run ends: what happened, and what they can do next. */
import type { ReportOrigin } from './report-tool.ts'

export interface ReportedRun {
  state: string
  summary: string
  question?: string | null
  /** The pull requests the ticket now follows, by URL. */
  pullRequests?: readonly string[]
  /** When a fresh worker is called back to check what this run left running. */
  wakeAt?: string
  /** For the next worker on the ticket only: never part of a receipt. */
  notes?: string
}

const STILL_OPEN = 'The worker is still open: reply here to steer it, or close the issue to drop the ticket.'
const IN_REVIEW = 'This ticket stays open until the pull request is merged or closed; comments and reviews on it go to the worker.'
const IN_REVIEW_MANY = 'This ticket stays open until its pull requests are merged or closed; comments, reviews and each merge go to the worker.'

/** One pull request keeps its one line; several are numbered in the order the worker said to merge them. */
function pullLines(urls: readonly string[], tracker?: string): string {
  if (urls.length === 1) return `\n\n**Pull request:** ${urls[0]}`
  return `\n\n**Pull requests, in merge order:**\n${urls.map((url, i) => `${i + 1}. ${url}`).join('\n')}`
    + (tracker ? `\n\nEach one's state, kept current: ${tracker}` : '')
}
/**
 * The terminal end, said out loud. A `ready` report with no pull request ends the ticket in the engine and
 * left nothing to read on the issue: no merge to wait for, no door closed, so the board kept asking (measured
 * 2026-11-09, #255 dispatched four workers after its merge). The router closes the issue with these words;
 * `superagent restart` is not a door, and neither is a label that stays on.
 */
const FINISHED = 'This ticket ends with the report: no pull request is open on it, so nothing runs it now, and this issue closes with it. '
  + 'A comment on the closed issue, or reopening it, starts the work again; nothing else does.'

// checksPending (inbox#667): a followed pull's checks are still running, so an event, not the timer, is the next check.
export function receiptText(thread: string, origin: ReportOrigin, run: ReportedRun, relaunched = false, tracker?: string,
  checksPending = false): string {
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
      const pulls = run.pullRequests?.length ? pullLines(run.pullRequests, tracker) : ''
      const next = !run.wakeAt ? '' : checksPending
        ? `\n\nNext check: a fresh worker the moment its pull-request checks finish; a timed backstop looks at it at ${run.wakeAt.slice(11, 16)} UTC if nothing fires.`
        : `\n\nNext check: a fresh worker looks at it at ${run.wakeAt.slice(11, 16)} UTC.`
      if (run.state === 'blocked') {
        return `${head}${pulls}\n\n${run.question ? `**Question:** ${run.question}\n\n` : ''}Reply here; the worker reads every comment.${next}`
      }
      if (run.state === 'waiting') return `${head}${pulls}${next}`
      if (run.state === 'failed') return `${head}${pulls}\n\n${STILL_OPEN}`
      if (run.state === 'ready' && !pulls) return `${head}\n\n${FINISHED}`
      return run.state === 'ready' && pulls ? `${head}${pulls}\n\n${(run.pullRequests?.length ?? 0) > 1 ? IN_REVIEW_MANY : IN_REVIEW}` : `${head}${pulls}`
    }
  }
}

/**
 * The engine ends a ticket with its pull requests without a word; this is the word, on the issue. Each pull
 * carries its own outcome, because a ticket can open several: the engine ends it on the LAST close, and
 * naming every pull by that one outcome told the person that a merged pull request had been closed. A question the
 * worker asked and nobody answered rides along, because the ticket's end clears it and this is the thread's last word.
 */
export function pullEndText(thread: string, pulls: ReadonlyArray<{ url: string; outcome: 'merged' | 'closed'; confirmed?: boolean }>,
                            checkAt?: string, question?: string): string {
  const urls = (list: string[]): string => list.join(', ') || 'its pull request'
  const asked = question ? `\n\n**The question that was open when it ended:** ${question}` : ''
  // `confirmed: false` is a record a failed read left, not an outcome this account watched: GitHub answers 404 for a
  // repository it cannot see, and a board issue closed on "closed without merging" about a pull request that merged.
  const unseen = pulls.filter(p => p.confirmed === false).map(p => p.url)
  const seen = pulls.filter(p => p.confirmed !== false)
  const door = unseen.length
    ? `\n\n**I cannot see ${urls(unseen)}:** GitHub answers 404 for that repository, so its state is a record from a read `
      + 'I cannot repeat, not something I watched. Comment here when the work has landed and I will take your word for it.'
    : ''
  const merged = seen.filter(p => p.outcome === 'merged').map(p => p.url)
  const closed = seen.filter(p => p.outcome === 'closed').map(p => p.url)
  if (!seen.length && unseen.length) return `${thread}: this ticket ends, and I cannot say how ${urls(unseen)} ended.${door}${asked}`
  if (checkAt) {
    const what = [merged.length ? `${urls(merged)} merged` : '', closed.length ? `${urls(closed)} closed without merging` : ''].filter(Boolean).join(' and ')
    return `${thread}: ${what || `${urls([])} ended`}. A fresh worker still makes the check the last one asked for at ${checkAt.slice(11, 16)} UTC, `
      + 'and this issue stays open until it reports.' + door + asked
  }
  if (!closed.length) return `${thread} merged: ${urls(merged)}. This ticket is done.${door}${asked}`
  if (!merged.length) return `${thread}: ${urls(closed)} closed without merging, so this ticket ends. A comment here starts the work again.${door}${asked}`
  return `${thread}: ${urls(merged)} merged and ${urls(closed)} closed without merging, so this ticket ends with the work that landed. `
    + `A comment here starts the work again.${door}${asked}`
}

