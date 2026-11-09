import { parsePull } from './pulls.ts'

export interface ReportTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute(id: string, args: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
}

/** Who ended a run: the worker, a crash, a run with no report ('silent'), or a launch that failed. */
export type ReportOrigin = 'worker' | 'crash' | 'silent' | 'launch'

/**
 * Whether the router took the report. `dropped` is the answer a worker never used to get: the ticket it
 * reported on had no live worker, so nothing was recorded and no reply was posted, and the tool still said
 * `reported`. Measured 2026-11-09 on #255 — a report at 08:59:23Z ended the run, a queued copy of the mandate
 * surfaced at ~09:01Z, the worker ran again and reported, and the issue gained no comment. Every later run of
 * that ticket started from the belief that the previous one had spoken.
 */
export type ReportOutcome = 'recorded' | 'dropped'

export type Reporter = (state: string, summary: string, question?: string | null, origin?: ReportOrigin,
                        pullRequests?: readonly string[]) => ReportOutcome | void

const NOT_RECORDED = 'not recorded: this ticket has no running worker, so nothing was written to it and no reply was posted. '
  + 'End your turn now. A comment on the issue starts the work again; reporting again reaches nobody.'

/** Refused here, not in the router: `pullRequests` entries the router's `parsePull` rejects used to be skipped
 *  with one `pull.unreadable` WARN, so a `ready` report whose only URL was malformed completed its ticket with
 *  the pull request untracked and unreviewed — exit 0, no receipt, no signal. The worker is in its run at this
 *  boundary and can re-report; the router's warn is one process later and reaches nobody. Same parser, so the
 *  report is never stricter than the follow: trailing slash and query string stay valid, and a non-github.com
 *  host stays a rejection — by design, and now said out loud. */
const PULL_URL_HELP = 'report the URL gh pr create printed, e.g. https://github.com/<owner>/<repo>/pull/<number>'

export function reportTool(report: Reporter): ReportTool {
  return {
    name: 'ticket_report', label: 'Report the ticket result',
    description: 'Report the result of this ticket. Call it once, at the end. state=blocked requires one yes/no question for the operator. '
      + 'pullRequests lists the URLs of the pull requests this work opened; leave it out when the work changed no repository. '
      + 'Every entry must be the URL gh pr create printed, on github.com — an entry the router cannot follow refuses the report.',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['ready', 'blocked', 'failed', 'cancelled'] }, summary: { type: 'string' }, question: { type: 'string' },
        pullRequests: { type: 'array', items: { type: 'string' } },
      },
      required: ['state', 'summary'],
    },
    execute: (_id, args) => {
      const a = args as unknown as { state: string; summary: string; question?: string; pullRequests?: unknown }
      const pulls = Array.isArray(a.pullRequests) ? a.pullRequests.filter((p): p is string => typeof p === 'string') : []
      const unreadable = pulls.filter(url => !parsePull(url))
      if (unreadable.length) {
        return {
          isError: true,
          content: [{ type: 'text', text: `not a pull request URL: ${unreadable.map(u => u.slice(0, 200)).join(', ')} — ${PULL_URL_HELP}. Nothing was reported; fix the entry and call ticket_report again.` }],
        }
      }
      const outcome = report(a.state, a.summary, a.question ?? null, undefined, pulls.length ? pulls : undefined)
      // A reporter that answers nothing (the worker pane's file bridge) cannot know the verdict; say the plain
      // thing. The router process says `dropped` loudly in its own log, which is where the operator reads it.
      return { content: [{ type: 'text', text: outcome === 'dropped' ? NOT_RECORDED : 'reported' }] }
    },
  }
}
