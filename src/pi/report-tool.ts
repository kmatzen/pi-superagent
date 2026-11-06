export interface ReportTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute(id: string, args: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }> }
}

export type Reporter = (state: string, summary: string, question?: string | null) => void

export function reportTool(report: Reporter): ReportTool {
  return {
    name: 'ticket_report', label: 'Report the ticket result',
    description: 'Report the result of this ticket. Call it once, at the end. state=blocked requires one yes/no question for the operator.',
    parameters: {
      type: 'object',
      properties: { state: { type: 'string', enum: ['ready', 'blocked', 'failed', 'cancelled'] }, summary: { type: 'string' }, question: { type: 'string' } },
      required: ['state', 'summary'],
    },
    execute: (_id, args) => {
      const a = args as unknown as { state: string; summary: string; question?: string }
      report(a.state, a.summary, a.question ?? null)
      return { content: [{ type: 'text', text: 'reported' }] }
    },
  }
}
