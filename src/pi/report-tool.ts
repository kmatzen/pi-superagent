export interface ReportTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute(id: string, args: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }> }
}

/** Who ended a run: the worker, a crash, a run with no report ('silent'), or a launch that failed. */
export type ReportOrigin = 'worker' | 'crash' | 'silent' | 'launch'

export type Reporter = (state: string, summary: string, question?: string | null, origin?: ReportOrigin,
                        pullRequests?: readonly string[]) => void

export function reportTool(report: Reporter): ReportTool {
  return {
    name: 'ticket_report', label: 'Report the ticket result',
    description: 'Report the result of this ticket. Call it once, at the end. state=blocked requires one yes/no question for the operator. '
      + 'pullRequests lists the URLs of the pull requests this work opened; leave it out when the work changed no repository.',
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
      report(a.state, a.summary, a.question ?? null, undefined, pulls.length ? pulls : undefined)
      return { content: [{ type: 'text', text: 'reported' }] }
    },
  }
}
