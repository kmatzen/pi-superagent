/** What a person reads on the thread when a worker's run ends: what happened, and what they can do next. */
import type { ReportOrigin } from './report-tool.ts'

export interface ReportedRun {
  state: string
  summary: string
  question?: string | null
}

const STILL_OPEN = 'The worker is still open: reply here to steer it, or close the issue to drop the ticket.'

export function receiptText(thread: string, origin: ReportOrigin, run: ReportedRun): string {
  const head = `${thread} ${run.state}: ${run.summary}`
  switch (origin) {
    case 'crash':
      return `${head}\n\nNothing is working on this ticket now: \`superagent restart\` gives it a fresh worker, and closing the issue drops it.`
    case 'launch':
      return `${head}\n\nThe router tries again on every poll until the cause is fixed or the issue is closed.`
    case 'silent':
      return `${thread}: the worker stopped without reporting a result.\n\n${STILL_OPEN}`
    case 'worker':
      if (run.state === 'blocked') {
        return `${head}\n\n${run.question ? `**Question:** ${run.question}\n\n` : ''}Reply here; the worker reads every comment.`
      }
      return run.state === 'failed' ? `${head}\n\n${STILL_OPEN}` : head
  }
}
