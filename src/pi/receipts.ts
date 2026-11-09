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

/**
 * The engine ends a ticket with its pull requests without a word; this is the word, on the issue. Each pull
 * carries its own outcome, because a ticket can open several: the engine ends it on the LAST close, and
 * naming every pull by that one outcome told the person that a merged pull request had been closed.
 *
 * `unreadable` names the followed pull requests the router's GitHub token cannot read (HTTP 404 to an account
 * it gives no access — measured 2026-11-09, board ticket #303 ended "closed without merging" three times
 * while its pull request sat open and unread). An ending is a claim about GitHub, so the message says which
 * part of it the router verified and which part it could not read.
 */
export function pullEndText(thread: string, pulls: ReadonlyArray<{ url: string; outcome: 'merged' | 'closed' }>,
                           unreadable: ReadonlyArray<{ url: string; reason: string }> = []): string {
  const urls = (list: string[]): string => list.join(', ') || 'its pull request'
  const merged = pulls.filter(p => p.outcome === 'merged').map(p => p.url)
  const closed = pulls.filter(p => p.outcome === 'closed').map(p => p.url)
  const body = !closed.length ? `${thread} merged: ${urls(merged)}. This ticket is done.`
    : !merged.length ? `${thread}: ${urls(closed)} closed without merging, so this ticket ends. A comment here starts the work again.`
    : `${thread}: ${urls(merged)} merged and ${urls(closed)} closed without merging, so this ticket ends with the work that landed. A comment here starts the work again.`
  if (!unreadable.length) return body
  // `github-has-no-such-pull` is GitHub answering for the repository and having no such number: a deleted pull
  // request, most likely. That is not "unreadable", and saying it was would be its own unverified claim.
  const gone = unreadable.filter(p => p.reason.startsWith('github-has-no-such-pull')).map(p => p.url)
  const blind = unreadable.filter(p => !p.reason.startsWith('github-has-no-such-pull'))
  const parts = [body]
  if (blind.length) {
    parts.push(`The router could NOT read ${blind.map(p => `${p.url} (${p.reason})`).join(', ')} with its GitHub token, so nothing above is verified against that pull request: it may be open. Look for \`pull.unreadable\` in the router's engine.log, and grant the router's GitHub account read access to that repository.`)
  }
  if (gone.length) {
    parts.push(`GitHub has no pull request at ${gone.join(', ')} (the router can read that repository), so the router cannot see it merged or closed. It ended this ticket on the signal above, not on that pull request. If that pull request was deleted on purpose, this is the right ending; if not, the number moved and the router was never told where.`)
  }
  return parts.join('\n\n')
}
