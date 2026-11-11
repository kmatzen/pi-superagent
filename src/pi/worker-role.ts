/** The superagent inside a worker's own pi: report tool, guard, and a file bridge to the router in another process. */
import {appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import { join } from 'node:path'
import { reportTool } from './report-tool.ts'
import { guardExtension } from './workspace.ts'

export interface WorkerPi {
  registerTool(tool: ReturnType<typeof reportTool>): void
  on(event: string, handler: (event?: unknown) => unknown): unknown
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): Promise<void> | void
}

/** The ask's own words and its choices, as one block: the person answers on the issue, where the options
 *  have to be readable to be worth offering. */
function askText(questions: unknown): string {
  if (!Array.isArray(questions)) return ''
  return questions.map((q: { question?: string; options?: { label?: string }[] }) =>
    [q.question, ...(q.options ?? []).map((o, i) => `${i + 1}. ${o.label}`)].filter(Boolean).join('\n')
  ).join('\n\n')
}

export const ACTIVITY_EVERY_MS = 5000
export const SILENT_FINISH = 'the worker finished its run without calling ticket_report'

// A worker that ends its turn in silence is not a worker that needs a person. Measured 2026-11-10: 14 of 22
// open tickets sat parked on this one summary, so the fleet's lost throughput was a forgotten tool call, not
// capacity, and only a human could restart it. One nudge asks for the outcome; the second consecutive
// silence files the failure, which is the case a person owns. The nudge rides the inbox, so the model reads
// it the way it reads any other input, and the state machine sees one report per assignment, as upstream
// specifies it in 003-execution.
export const SILENT_NUDGE = 'You ended your turn without calling ticket_report, and the fleet cannot tell done from gone. '
  + 'Call ticket_report NOW with the true outcome: ready (work delivered, link the pull request), '
  + 'blocked (you need a person, with the question), or failed (what broke). One line is enough.'
export const SILENT_NUDGE_FILE = 'zz-self-nudge.json'

// One role per worker dir per process: the harness's copy of this package and the launch's --extension both offer
// it, and a second ticket_report registration makes pi refuse to boot (2026-11-11: every launch died at startup).
const ROLES_HELD = Symbol.for('pi-superagent.worker-roles-held')
const rolesHeld = (): Set<string> => {
  const host = globalThis as typeof globalThis & { [ROLES_HELD]?: Set<string> }
  return (host[ROLES_HELD] ??= new Set<string>())
}

export function workerRole(pi: WorkerPi, env: NodeJS.ProcessEnv, pollMs = 1000): boolean {
  const dir = env.PI_SUPERAGENT_WORKER_DIR
  if (env.PI_SUPERAGENT_ROLE !== 'worker' || !dir) return false
  // true, not false: this pi is a worker, and the caller must not go on to start a router in it.
  if (rolesHeld().has(dir)) return true
  rolesHeld().add(dir)
  // The worker's gh identity: the router names the bot's token file in the tab, never the token itself.
  const tokenFile = env.PI_SUPERAGENT_WORKER_TOKEN_FILE
  if (tokenFile) {
    try { const token = readFileSync(tokenFile, 'utf8').trim(); if (token) env.GH_TOKEN = token } catch { /* the shell's identity stands */ }
  }
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

  /** A worker has no person at its keyboard. `ask_user_question` renders in the herdr tab and waits for a
   *  keystroke that never comes: the run sits, the router gets no report and no question, and the ticket
   *  stalls with nothing on the issue to answer. Measured 2026-11-07, when a worker parked on a four-option
   *  harness question until a person read the tab. The ask becomes the blocked report the router already
   *  posts to the issue, and the reply comes back through the inbox as a normal input. */
  pi.on('tool_call', (event?: unknown) => {
    const call = event as { toolName?: string; input?: Record<string, unknown> }
    if (call.toolName !== 'ask_user_question') return
    const ask = askText(call.input?.questions)
    if (!ask) return
    reported = true
    append('reports.jsonl', { state: 'blocked', summary: ask, question: ask, origin: 'ask' })
    return { block: true, reason: 'Filed on the ticket as a blocked report. End your turn now: the answer arrives as a new input. Asking again buries it.' }
  })

  // Inputs are kept in the inbox until a run takes them. pi queues a message sent into a running turn and hands
  // the queue back to the human's input box when that turn is aborted, so a file deleted at send time is a message
  // the model never read: the router marked it delivered, the ticket waited on its worker, and nothing retried it.
  // One nudge per WORKER, not per run: a counter reset on agent_start lets a worker that finishes
  // silently be nudged forever, which is worse than parking it. Proved by test on the first attempt.
  let silentStreak = 0
  const inflight = new Map<string, string>()
  pi.on('agent_start', () => append('events.jsonl', { type: 'turnStarted' }))
  pi.on('agent_settled', (event) => {
    // Filed here, before the settle: only this process knows the order of a run's events for certain.
    if (!reported && silentStreak === 0) {
      // The first silence is a forgotten call: ask for the outcome, file nothing.
      silentStreak = 1
      writeFileSync(join(inbox, SILENT_NUDGE_FILE), JSON.stringify({ text: SILENT_NUDGE, mode: 'followUp' }))
      append('events.jsonl', { type: 'selfNudge' })
    } else if (!reported) {
      append('reports.jsonl', { state: 'failed', summary: SILENT_FINISH, question: null, origin: 'silent' })
    } else {
      silentStreak = 0
    }
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
  // A command streaming output is a worker at work: without this a long build read as 15 minutes of silence.
  pi.on('tool_execution_update', activity)
  pi.on('message_update', activity)

  // Not awaited: sendUserMessage can resolve only when the run ends, and a steer must land mid-run.
  const drain = (): void => {
    for (const name of readdirSync(inbox).filter(n => n.endsWith('.json')).sort()) {
      const file = join(inbox, name)
      let input: { text: string; mode?: 'steer' | 'followUp' }
      try {
        input = JSON.parse(readFileSync(file, 'utf8')) as typeof input
      } catch (error) {
        // Unreadable by this worker and by every later one: park it out of the scan and say so once.
        renameSync(file, `${file}.corrupt`)
        append('events.jsonl', { type: 'inbox_error', name, error: String(error).slice(0, 200) })
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
    // /reload emits this before loading the new copy, which must be free to take the role again.
    rolesHeld().delete(dir)
  })
  return true
}
