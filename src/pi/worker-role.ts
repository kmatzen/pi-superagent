/** The superagent inside a worker's own pi: report tool, guard, and a file bridge to the router in another process. */
import {appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import { basename, join } from 'node:path'
import { reportTool } from './report-tool.ts'
import { guardExtension } from './workspace.ts'
import { NOT_ENGLISH, nonEnglish, publishedText } from './english.ts'
import { closesBoardIssue, closingRefused } from './closing.ts'

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
// An idle send that starts no run within this long counts as refused and is sent again.
export const START_GRACE_MS = 60_000

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

/** Wakes one worker gets to file what it forgot; past that, the next silence files the failure. */
export const MAX_SELF_NUDGES = 2

/** Written when a person types in the worker's tab: the router keeps a freed tab its person is still using. */
export const PERSON_FILE = 'person.json'

const HANDS_OVER = ['ready', 'blocked', 'waiting']
export const AFTER_HANDOVER = 'Your ticket_report handed this ticket to a person, and the router has freed this session: nothing you do '
  + 'from here is read, and the session is ended soon. End your turn now. More work belongs in a new report before you hand over, '
  + 'or in the fresh worker that a new message on the ticket starts in this same workspace.'

// One role per worker dir per process: the harness's copy of this package and the launch's --extension both offer
// it, and a second ticket_report registration makes pi refuse to boot (2026-11-11: every launch died at startup).
const ROLES_HELD = Symbol.for('pi-superagent.worker-roles-held')
const rolesHeld = (): Set<string> => {
  const host = globalThis as typeof globalThis & { [ROLES_HELD]?: Set<string> }
  return (host[ROLES_HELD] ??= new Set<string>())
}

export function workerRole(pi: WorkerPi, env: NodeJS.ProcessEnv, pollMs = 1000, startGraceMs = START_GRACE_MS): boolean {
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
  // A report that hands the ticket to a person frees this session at once: whatever the worker does after it, the router
  // never reads. Background-task wakes kept a freed worker running tools after its ready report (2026-11-12).
  let handedOver = false
  pi.registerTool(reportTool((state, summary, question, _origin, pullRequests, wakeInMinutes, notes) => {
    reported = true
    if (HANDS_OVER.includes(state)) handedOver = true
    append('reports.jsonl', { state, summary, question: question ?? null, ...(pullRequests?.length ? { pullRequests } : {}),
      ...(wakeInMinutes !== undefined ? { wakeInMinutes } : {}), ...(notes ? { notes } : {}) })
  }))
  pi.on('tool_call', (event?: unknown) => {
    if (!handedOver || (event as { toolName?: string }).toolName === 'ticket_report') return
    return { block: true, reason: AFTER_HANDOVER }
  })
  // Someone always watches what a worker leaves running (operator, 2026-11-12, after a training run went unwatched):
  // a worker that still holds a GPU job claim hands over only with a wake-up scheduled, or after releasing the claim.
  // The ledger is the deployment's to name (PI_SUPERAGENT_CLAIMS_FILE); with none, there is no claim to hold.
  const claimsFile = env.PI_SUPERAGENT_CLAIMS_FILE?.trim()
  const heldClaims = (): string[] => {
    if (!claimsFile) return []
    try {
      const today = new Date().toISOString().slice(0, 10)
      const ledger = JSON.parse(readFileSync(claimsFile, 'utf8')) as { entries?: Array<{ ref?: string; session?: string; expiresAt?: string }> }
      return (ledger.entries ?? []).filter(e => e.session === basename(dir) && (!e.expiresAt || e.expiresAt >= today)).map(e => String(e.ref))
    } catch { return [] }
  }
  const unwatched = (held: string[]): string => `Not reported: you still hold ${held.join(', ')}, and someone must keep watching what `
    + 'runs there. Report waiting (or blocked) with wakeInMinutes for when a fresh worker should check it, or stop it and '
    + 'release the claim first if it is done.'
  pi.on('tool_call', (event?: unknown) => {
    const call = event as { toolName?: string; input?: Record<string, unknown> }
    if (call.toolName !== 'ticket_report' || !HANDS_OVER.includes(String(call.input?.state))) return
    if (typeof call.input?.wakeInMinutes === 'number') return
    const held = heldClaims()
    if (held.length) return { block: true, reason: unwatched(held) }
  })
  pi.on('tool_call', (event?: unknown) => {
    const call = event as { toolName?: string; input?: Record<string, unknown> }
    const text = call.toolName === 'ticket_report' ? `${call.input?.summary ?? ''}\n${call.input?.question ?? ''}`
      : call.toolName === 'bash' && typeof call.input?.command === 'string'
        ? publishedText(call.input.command, env.PI_SUPERAGENT_WORKSPACE ?? process.cwd()) : undefined
    if (text && nonEnglish(text)) return { block: true, reason: NOT_ENGLISH }
    const closing = call.toolName === 'bash' && text ? closesBoardIssue(text, env.PI_SUPERAGENT_HOME_REPO ?? '') : undefined
    if (closing) return { block: true, reason: closingRefused(closing) }
  })
  // A person typing here is new work, not the worker running on alone: the handover refused the operator every tool (2026-11-12).
  pi.on('input', (event?: unknown) => {
    if ((event as { source?: string } | undefined)?.source !== 'interactive') return
    handedOver = false
    writeFileSync(join(dir, PERSON_FILE), JSON.stringify({ at: new Date().toISOString() }))
  })
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
    const held = heldClaims()
    if (held.length) return { block: true, reason: unwatched(held) }
    reported = true
    handedOver = true
    append('reports.jsonl', { state: 'blocked', summary: ask, question: ask, origin: 'ask' })
    return { block: true, reason: 'Filed on the ticket as a blocked report. End your turn now: the answer arrives as a new input. Asking again buries it.' }
  })

  // Inputs are kept in the inbox until a run takes them. pi queues a message sent into a running turn and hands
  // the queue back to the human's input box when that turn is aborted, so a file deleted at send time is a message
  // the model never read: the router marked it delivered, the ticket waited on its worker, and nothing retried it.
  // One nudge per WORKER, not per run: a counter reset on agent_start lets a worker that finishes
  // silently be nudged forever, which is worse than parking it. Proved by test on the first attempt.
  let silentStreak = 0
  let nudges = 0
  let silentFiled = false
  const inflight = new Map<string, { file: string; text: string }>()
  // pi 1.5 marks a session busy only after its input handlers ran: a second send in one idle burst starts a
  // second run that pi kills on screen, never through this file, and the next settle deleted it unread (24
  // multi-input deliveries on 2026-11-11). Idle, one input goes and the rest wait for agent_start.
  let running = false
  let starting: { name: string; at: number } | undefined
  pi.on('agent_start', () => {
    running = true
    starting = undefined
    append('events.jsonl', { type: 'turnStarted' })
  })
  pi.on('agent_settled', (event) => {
    // Filed here, before the settle: only this process knows the order of a run's events for certain.
    const silent = !reported
    if (silent && handedOver) {
      // A hand-over report frees this session and the router reads nothing after it, so this run is the worker's
      // own background task (a log tail, a finished pluto-run) waking a session that already answered: a nudge
      // buys a report nobody reads, and the round after files a false "finished without calling ticket_report"
      // over the real one. Measured 2026-11-14→21: all 46 workers with a REPEATED self-nudge had handed over,
      // as had 165 of the 259 with a single one; the 87 left are the forgotten call this watches for.
      append('events.jsonl', { type: 'silentAfterHandover' })
    } else if (silent && silentStreak === 0 && nudges < MAX_SELF_NUDGES) {
      // The first silence is a forgotten call: ask for the outcome, file nothing.
      silentStreak = 1
      nudges += 1
      writeFileSync(join(inbox, SILENT_NUDGE_FILE), JSON.stringify({ text: SILENT_NUDGE, mode: 'followUp' }))
      append('events.jsonl', { type: 'selfNudge' })
    } else if (silent && silentStreak === 0) {
      silentStreak = 1
      append('events.jsonl', { type: 'selfNudgeExhausted', nudges })
    } else if (silent && !silentFiled) {
      // Once per worker: 12 landed in 3 workers in a week, and the second buries the first.
      silentFiled = true
      append('reports.jsonl', { state: 'failed', summary: SILENT_FINISH, question: null, origin: 'silent' })
    } else if (!silent) {
      silentStreak = 0
    }
    reported = false
    const aborted = Boolean((event as { aborted?: boolean } | undefined)?.aborted)
    for (const [name, { file }] of inflight) {
      // Aborted: the run gave the message back, so the next drain sends it to the idle session as its own turn.
      if (aborted) continue
      rmSync(file, { force: true })
      append('events.jsonl', { type: 'input_read', name })
    }
    inflight.clear()
    running = false
    starting = undefined
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
  // A steer or follow-up joins the run without an agent_start, the router's only other sign of a read.
  pi.on('message_end', (event?: unknown) => {
    const message = (event as { message?: { role?: string; content?: unknown } } | undefined)?.message
    if (message?.role !== 'user') return
    const content = message.content
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map(part => (part as { type?: string; text?: string }).type === 'text' ? (part as { text?: string }).text ?? '' : '').join('\n') : ''
    for (const [name, sent] of inflight) {
      if (!text.includes(sent.text)) continue
      inflight.delete(name)
      rmSync(sent.file, { force: true })
      append('events.jsonl', { type: 'input_read', name })
      return
    }
  })

  // Not awaited: sendUserMessage can resolve only when the run ends, and a steer must land mid-run.
  const drain = (): void => {
    // pi can refuse an idle send without telling this file (mid-compaction): past the grace, send it again.
    if (starting && !running && Date.now() - starting.at >= startGraceMs) {
      inflight.delete(starting.name)
      append('events.jsonl', { type: 'inbox_error', name: starting.name, error: 'no run started; sending it again' })
      starting = undefined
    }
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
      if (starting && !running) return // the run the last idle send starts takes the rest as queued input
      // New work from the router lifts the handover; the worker's own nudge would lift it on every silent run.
      if (name !== SILENT_NUDGE_FILE) handedOver = false
      inflight.set(name, { file, text: input.text })
      if (!running) starting = { name, at: Date.now() }
      Promise.resolve(pi.sendUserMessage(input.text, { deliverAs: input.mode ?? 'followUp' }))
        .catch((error: unknown) => {
          inflight.delete(name)
          if (starting?.name === name) starting = undefined
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
