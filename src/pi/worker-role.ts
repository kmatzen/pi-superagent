/** The superagent inside a worker's own pi: report tool, guard, and a file bridge to the router in another process. */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { reportTool } from './report-tool.ts'
import { guardExtension } from './workspace.ts'

export interface WorkerPi {
  registerTool(tool: ReturnType<typeof reportTool>): void
  on(event: string, handler: (event?: unknown) => unknown): unknown
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): Promise<void> | void
}

export const ACTIVITY_EVERY_MS = 5000
export const SILENT_FINISH = 'the worker finished its run without calling ticket_report'

export function workerRole(pi: WorkerPi, env: NodeJS.ProcessEnv, pollMs = 1000): boolean {
  const dir = env.PI_SUPERAGENT_WORKER_DIR
  if (env.PI_SUPERAGENT_ROLE !== 'worker' || !dir) return false
  const inbox = join(dir, 'inbox')
  mkdirSync(inbox, { recursive: true })
  const append = (file: string, record: object): void =>
    appendFileSync(join(dir, file), `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`)

  // Counted per settle cycle, not per run: an automatic retry starts a new run after a report already filed.
  let reported = false
  pi.registerTool(reportTool((state, summary, question, _origin, pullRequests) => {
    reported = true
    append('reports.jsonl', { state, summary, question: question ?? null, ...(pullRequests?.length ? { pullRequests } : {}) })
  }))
  guardExtension({
    blocked: (env.PI_SUPERAGENT_BLOCKED ?? '').split(',').map(s => s.trim()).filter(Boolean),
    workspace: env.PI_SUPERAGENT_WORKSPACE ?? process.cwd(),
    allowDelegation: env.PI_SUPERAGENT_ALLOW_DELEGATION === '1',
  })(pi as never)

  // Inputs are kept in the inbox until a run takes them. pi queues a message sent into a running turn and hands
  // the queue back to the human's input box when that turn is aborted, so a file deleted at send time is a message
  // the model never read: the router marked it delivered, the ticket waited on its worker, and nothing retried it.
  const inflight = new Map<string, string>()
  pi.on('agent_start', () => append('events.jsonl', { type: 'turnStarted' }))
  pi.on('agent_settled', (event) => {
    // Filed here, before the settle: only this process knows the order of a run's events for certain.
    if (!reported) append('reports.jsonl', { state: 'failed', summary: SILENT_FINISH, question: null, origin: 'silent' })
    reported = false
    const aborted = Boolean((event as { aborted?: boolean } | undefined)?.aborted)
    for (const [name, file] of inflight) {
      // Aborted: the run gave the message back, so the next drain sends it to the idle session as its own turn.
      if (aborted) continue
      rmSync(file, { force: true })
      append('events.jsonl', { type: 'input_read', name })
    }
    inflight.clear()
    append('events.jsonl', { type: 'settled' })
  })
  let lastActivity = 0
  const activity = (): void => {
    const now = Date.now()
    if (now - lastActivity < ACTIVITY_EVERY_MS) return
    lastActivity = now
    append('events.jsonl', { type: 'activity' })
  }
  pi.on('tool_execution_start', activity)
  pi.on('message_update', activity)

  // Not awaited: sendUserMessage can resolve only when the run ends, and a steer must land mid-run.
  const drain = (): void => {
    for (const name of readdirSync(inbox).filter(n => n.endsWith('.json')).sort()) {
      const file = join(inbox, name)
      let input: { text: string; mode?: 'steer' | 'followUp' }
      try {
        input = JSON.parse(readFileSync(file, 'utf8')) as typeof input
      } catch {
        continue
      }
      if (inflight.has(name)) continue // sent, waiting for the run that reads it
      inflight.set(name, file)
      Promise.resolve(pi.sendUserMessage(input.text, { deliverAs: input.mode ?? 'followUp' }))
        .catch((error: unknown) => {
          inflight.delete(name)
          append('events.jsonl', { type: 'inbox_error', error: String(error).slice(0, 200) })
        })
    }
  }
  let timer: NodeJS.Timeout | undefined
  pi.on('session_start', () => {
    if (timer) return
    timer = setInterval(drain, pollMs)
    timer.unref()
  })
  pi.on('session_shutdown', () => {
    if (timer) clearInterval(timer)
    timer = undefined
  })
  return true
}
