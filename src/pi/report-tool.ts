import { parsePull } from './pulls.ts'
import { VOICE_REFUSED, voiceProblems } from './voice.ts'

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
                        pullRequests?: readonly string[], wakeInMinutes?: number, notes?: string,
                        results?: readonly string[]) => ReportOutcome | void

/** Where experiment output goes, so a person can see it after the pod is gone. The prefix is per ticket, said in
 *  full in the brief; the operator moves the bucket by changing this one line. */
export const RESULTS_ROOT = 's3://matzen-adobe/superagent'

/** The per-ticket results prefix: the issue number for a human, the ticket id's head so two tickets with the
 *  same number in different repos cannot write over each other. */
export const resultsPrefix = (thread: string | undefined, ticketId: string): string =>
  `${RESULTS_ROOT}/${(thread ?? '').replace(/^#/, '') || 'ticket'}-${ticketId.slice(0, 8)}`

/** A results link is something a person can open: the bucket, or a plain http(s) URL. An entry the operator
 *  cannot follow is refused here, in the run, where the worker can fix it — not one process later in a log. */
const RESULT_URL = /^(s3:\/\/[\w.-]+\/[\w.\-~+/=%&@:!$'()*,;]+|https?:\/\/[^\s]+)$/
const RESULTS_URL_HELP = `report the object's own URL, e.g. ${RESULTS_ROOT}/<issue>-<ticket>/figures/curve.png`

/** How soon a fresh worker may be called back to check what a worker left running, in minutes. */
export const WAKE_MIN = 5
export const WAKE_MAX = 360

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
      + 'state=waiting means something you started still runs (CI, training, a deploy): set wakeInMinutes to when a fresh worker '
      + `should check on it (${WAKE_MIN}-${WAKE_MAX} minutes; for CI, how long the checks usually take, not ${WAKE_MIN}), and say in notes what to check. `
      + 'summary is posted on the issue for the person who asked, and is refused unless it reads plainly: line 1 is the news or the ask in '
      + 'plain words, then at most three short lines, then "Details (skippable):" and at most six bullets. notes is private: what the next '
      + 'worker on this ticket needs (where things are, commands, what to check). It is never posted. '
      + 'pullRequests lists the URLs of the pull requests this work opened; leave it out when the work changed no repository. '
      + 'Every entry must be the URL gh pr create printed, on github.com — an entry the router cannot follow refuses the report. '
      + `results lists the links a person opens to see the work: uploaded figures, sample videos, metric files, at ${RESULTS_ROOT}/. `
      + 'A run that started a GPU job must list them: visuals first, and the numbers they show.',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['ready', 'waiting', 'blocked', 'failed', 'cancelled'] }, summary: { type: 'string' }, question: { type: 'string' },
        pullRequests: { type: 'array', items: { type: 'string' } },
        results: { type: 'array', items: { type: 'string' } },
        wakeInMinutes: { type: 'number' }, notes: { type: 'string' },
      },
      required: ['state', 'summary'],
    },
    execute: (_id, args) => {
      const a = args as unknown as { state: string; summary: string; question?: string; pullRequests?: unknown; wakeInMinutes?: unknown; notes?: unknown, results?: unknown }
      const pulls = Array.isArray(a.pullRequests) ? a.pullRequests.filter((p): p is string => typeof p === 'string') : []
      const results = Array.isArray(a.results) ? a.results.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : []
      const unreachable = results.filter(r => !RESULT_URL.test(r.trim()))
      if (unreachable.length) {
        return {
          isError: true,
          content: [{ type: 'text', text: `not a results link: ${unreachable.map(u => u.slice(0, 200)).join(', ')} — ${RESULTS_URL_HELP}. Nothing was reported; fix the entry and call ticket_report again.` }],
        }
      }
      const unreadable = pulls.filter(url => !parsePull(url))
      if (unreadable.length) {
        return {
          isError: true,
          content: [{ type: 'text', text: `not a pull request URL: ${unreadable.map(u => u.slice(0, 200)).join(', ')} — ${PULL_URL_HELP}. Nothing was reported; fix the entry and call ticket_report again.` }],
        }
      }
      // The engine refuses a question on a ready result; saying so here lets the worker fix it in this turn, where the
      // router's refusal reached no one (2026-11-12: a ready report asking for owner approval was dropped unread).
      if (a.question && a.state === 'ready') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'a ready result cannot carry a question: report blocked with the question if you need a person, or put the follow-up in the summary. Nothing was reported; call ticket_report again.' }],
        }
      }
      const wake = typeof a.wakeInMinutes === 'number' && Number.isFinite(a.wakeInMinutes) ? a.wakeInMinutes : undefined
      const refuse = (why: string) => ({ isError: true, content: [{ type: 'text' as const, text: `${why} Nothing was reported; call ticket_report again.` }] })
      if (a.state === 'waiting' && wake === undefined) {
        return refuse(`waiting needs wakeInMinutes: when a fresh worker should check on what you left running (${WAKE_MIN}-${WAKE_MAX}).`)
      }
      if (wake !== undefined && (wake < WAKE_MIN || wake > WAKE_MAX)) return refuse(`wakeInMinutes must be ${WAKE_MIN}-${WAKE_MAX}.`)
      if (wake !== undefined && a.state !== 'waiting' && a.state !== 'blocked') {
        return refuse('only a waiting or blocked report schedules a wake-up: if something you started still runs, report waiting.')
      }
      const problems = voiceProblems(String(a.summary ?? ''), a.question)
      if (problems.length) return { isError: true, content: [{ type: 'text', text: VOICE_REFUSED(problems) }] }
      const notes = typeof a.notes === 'string' && a.notes.trim() ? a.notes.trim().slice(0, 8000) : undefined
      const outcome = report(a.state, a.summary, a.question ?? null, undefined, pulls.length ? pulls : undefined, wake, notes,
        results.length ? results.map(r => r.trim()) : undefined)
      // A reporter that answers nothing (the worker pane's file bridge) cannot know the verdict; say the plain
      // thing. The router process says `dropped` loudly in its own log, which is where the operator reads it.
      return { content: [{ type: 'text', text: outcome === 'dropped' ? NOT_RECORDED : 'reported' }] }
    },
  }
}
