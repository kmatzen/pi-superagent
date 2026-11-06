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

/** The engine ends a ticket with its pull request without a word; this is the word, on the issue. */
export function pullEndText(thread: string, outcome: 'merged' | 'closed', pulls: readonly string[]): string {
  const named = pulls.join(', ') || 'its pull request'
  return outcome === 'merged'
    ? `${thread} merged: ${named}. This ticket is done.`
    : `${thread}: ${named} closed without merging, so this ticket ends. A comment here starts the work again.`
}
