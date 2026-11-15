import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AFTER_HANDOVER, PERSON_FILE, SILENT_FINISH, SILENT_NUDGE_FILE, workerRole, type WorkerPi } from '../src/pi/worker-role.ts'
import { NOT_ENGLISH } from '../src/pi/english.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wrole-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10))
}
// The worker's own nudge lives in the inbox beside router inputs; the input tests count router inputs.
const inboxFiles = (dir: string): string[] => readdirSync(join(dir, 'inbox')).filter((n: string) => n !== SILENT_NUDGE_FILE)
const lines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : []

function fakePi() {
  const handlers = new Map<string, Array<(event?: unknown) => unknown>>()
  const tools: Array<{ name: string; execute: (id: string, args: Record<string, unknown>) => unknown }> = []
  const sent: Array<{ text: string; deliverAs: string | undefined }> = []
  const pi: WorkerPi = {
    registerTool: tool => { tools.push(tool) },
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    sendUserMessage: (text, options) => { sent.push({ text, deliverAs: options?.deliverAs }) },
  }
  const emit = (event: string, payload?: unknown) => (handlers.get(event) ?? []).map(h => h(payload))
  return { pi, tools, sent, emit }
}

describe('the worker role', () => {
  it('is inert in any pi the router did not start as a worker', () => {
    const f = fakePi()
    expect(workerRole(f.pi, {})).toBe(false)
    expect(workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'router', PI_SUPERAGENT_WORKER_DIR: tmp() })).toBe(false)
    expect(f.tools).toHaveLength(0)
  })

  it('takes the role once when the harness and the launch both offer it, and again after a reload', () => {
    // Harness copy of the package plus the launch's --extension: two offers in one pi, which once failed its boot.
    const env = { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: tmp() }
    const launch = fakePi()
    const harness = fakePi()
    expect(workerRole(launch.pi, env)).toBe(true)
    expect(workerRole(harness.pi, env), 'still a worker, so the router must not start here').toBe(true)
    expect(launch.tools.map(t => t.name)).toEqual(['ticket_report'])
    expect(harness.tools, 'the second offer registers nothing').toHaveLength(0)
    launch.emit('session_shutdown')
    const reloaded = fakePi()
    expect(workerRole(reloaded.pi, env)).toBe(true)
    expect(reloaded.tools.map(t => t.name), 'a reload takes the role again').toEqual(['ticket_report'])
    reloaded.emit('session_shutdown')
  })

  it('takes the bot\'s token from the file the router names, so the token never rides in a command line', () => {
    const dir = tmp()
    const file = join(dir, 'bot-token')
    writeFileSync(file, 'ghp_bot\n')
    const env: NodeJS.ProcessEnv = { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir, PI_SUPERAGENT_WORKER_TOKEN_FILE: file }
    workerRole(fakePi().pi, env)
    expect(env.GH_TOKEN).toBe('ghp_bot')
  })

  it('ticket_report writes the report where the router reads it', () => {
    const dir = tmp()
    const f = fakePi()
    expect(workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })).toBe(true)
    f.tools.find(t => t.name === 'ticket_report')!.execute('c1', { state: 'ready', summary: 'merged the fix' })
    expect(lines(join(dir, 'reports.jsonl'))).toMatchObject([{ state: 'ready', summary: 'merged the fix', question: null }])
  })

  it('ticket_report carries the pull requests the work opened, and only strings', () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    const report = f.tools.find(t => t.name === 'ticket_report')!
    report.execute('c1', { state: 'ready', summary: 'opened the fix', pullRequests: ['https://github.com/o/r/pull/9', 7] })
    report.execute('c2', { state: 'ready', summary: 'answered the question' })
    expect(lines(join(dir, 'reports.jsonl'))).toMatchObject([
      { state: 'ready', pullRequests: ['https://github.com/o/r/pull/9'] },
      { state: 'ready', summary: 'answered the question' },
    ])
    expect(lines(join(dir, 'reports.jsonl'))[1]).not.toHaveProperty('pullRequests')
  })

  // The URL rules themselves are in test/report-tool.spec.ts; what the worker's own process proves is that a
  // refused report leaves no trace in the file the router reads, and so no report at all.
  it('refuses a report whose pull request URL the router cannot read, and names the entry', () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    const report = f.tools.find(t => t.name === 'ticket_report')!
    const bad = 'https://github.comExample-Corp/widget/pull/1994'
    const verdict = report.execute('c1', { state: 'ready', summary: 'opened it', pullRequests: [bad] }) as
      { isError?: boolean; content: { text: string }[] }
    expect(verdict.isError, 'the worker sees a failure, not "reported"').toBe(true)
    expect(verdict.content[0]!.text).toContain(bad)
    expect(verdict.content[0]!.text, 'the fix is written on the page the worker has open').toMatch(/gh pr create/)
    expect(lines(join(dir, 'reports.jsonl')), 'nothing reaches the router').toEqual([])
    f.emit('agent_start')
    f.emit('agent_settled')
    expect(existsSync(join(dir, 'inbox', SILENT_NUDGE_FILE)), 'a refused report is no report, so the first silence nudges').toBe(true)
    f.emit('agent_start')
    f.emit('agent_settled')
    expect(lines(join(dir, 'reports.jsonl')).at(-1), 'and the second silence files the silent finish').toMatchObject({ state: 'failed', summary: SILENT_FINISH })
  })

  it('turns a worker asking a person into a blocked report, and refuses the ask that has no keyboard', () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    expect(f.emit('tool_call', { toolName: 'read', input: { path: '/w/a.ts' } }).every(v => v === undefined), 'every other tool is untouched').toBe(true)
    const verdicts = f.emit('tool_call', {
      toolName: 'ask_user_question',
      input: { questions: [{ question: 'Fix the shared harness too?', options: [{ label: 'Just my PR' }, { label: 'A second PR' }] }] },
    })
    expect(verdicts.some(v => (v as { block?: boolean } | undefined)?.block), 'the ask cannot sit waiting for a keystroke in a headless tab').toBe(true)
    expect(lines(join(dir, 'reports.jsonl')).at(-1), 'the question, with its options, reaches the router').toMatchObject({
      state: 'blocked', question: 'Fix the shared harness too?\n1. Just my PR\n2. A second PR', origin: 'ask',
    })
  })

  it('a report that hands the ticket over is the last act: every tool after it is refused, with the reason', () => {
    // 2026-11-12: background-task wakes kept a worker running tools in its freed session after its ready report.
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: tmp(), PI_SUPERAGENT_WORKSPACE: '/w' })
    const report = f.tools.find(t => t.name === 'ticket_report')!
    expect(f.emit('tool_call', { toolName: 'bash', input: { command: 'make test' } }).some(v => v), 'before it, tools run').toBe(false)
    report.execute('c1', { state: 'failed', summary: 'tests red' })
    expect(f.emit('tool_call', { toolName: 'bash', input: { command: 'make test' } }).some(v => v), 'a failure hands nothing over').toBe(false)
    report.execute('c2', { state: 'ready', summary: 'all six answered' })
    const [verdict] = f.emit('tool_call', { toolName: 'read', input: { path: '/w/loaders.py' } })
    expect(verdict).toMatchObject({ block: true, reason: AFTER_HANDOVER })
    expect(f.emit('tool_call', { toolName: 'ticket_report', input: {} }).some(v => v), 'a correction can still be filed').toBe(false)
  })

  it('asking a person hands the ticket over too', () => {
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: tmp(), PI_SUPERAGENT_WORKSPACE: '/w' })
    f.emit('tool_call', { toolName: 'ask_user_question', input: { questions: [{ question: 'Make it uniform?' }] } })
    expect(f.emit('tool_call', { toolName: 'bash', input: { command: 'git push' } }).find(v => v)).toMatchObject({ block: true, reason: AFTER_HANDOVER })
  })

  it('refuses a report or a pull request that is not in English, and lets every other command through', () => {
    // 2026-11-12: the fleet's default model opened four pull requests with Chinese bodies.
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: tmp(), PI_SUPERAGENT_WORKSPACE: '/w' })
    const chinese = '## 这个 PR 是什么\n把注意力脚手架拆成五个按层的 PR，按顺序合并。'
    const verdict = (toolName: string, input: Record<string, unknown>) => f.emit('tool_call', { toolName, input }).find(v => v)
    expect(verdict('ticket_report', { state: 'ready', summary: chinese })).toMatchObject({ block: true, reason: NOT_ENGLISH })
    expect(verdict('ticket_report', { state: 'ready', summary: 'Split into five stacked pull requests.' })).toBeUndefined()
    expect(verdict('bash', { command: `gh pr create --title Split --body "${chinese}"` })).toMatchObject({ block: true, reason: NOT_ENGLISH })
    expect(verdict('bash', { command: 'gh pr create --title Split --body "Five stacked pull requests."' })).toBeUndefined()
    expect(verdict('bash', { command: `grep -rn "${chinese}" docs/` }), 'searching is not publishing').toBeUndefined()
  })

  it('with no claims ledger configured, no claim holds a report back: the engine names no ledger of its own', () => {
    const dir = tmp()
    const home = tmp()
    mkdirSync(join(home, '.pi'), { recursive: true })
    // The name config.example.env suggests: an engine that defaulted to it would read this live claim.
    writeFileSync(join(home, '.pi', 'job-claims.json'), JSON.stringify({ entries: [{ ref: 'job-1', session: basename(dir), expiresAt: '2999-01-01' }] }))
    const before = process.env.HOME
    process.env.HOME = home
    try {
      const f = fakePi()
      workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir, PI_SUPERAGENT_WORKSPACE: '/w' })
      expect(f.emit('tool_call', { toolName: 'ticket_report', input: { state: 'ready', summary: 'shipped' } }).find(v => v)).toBeUndefined()
    } finally {
      process.env.HOME = before
    }
  })

  it('a worker that still holds a GPU job claim cannot hand over or ask without a wake-up, and its wake-up reaches the router', () => {
    // Operator, 2026-11-12: there should always be someone watching. A worker reported ready with run 31 training.
    const dir = tmp()
    const ledger = join(tmp(), 'job-claims.json')
    const today = new Date().toISOString().slice(0, 10)
    const claim = (session: string, expiresAt: string) => ({ ref: `job-${session}`, session, authorizedBy: 'agent-self', reason: 'run 31', claimedAt: today, expiresAt })
    writeFileSync(ledger, JSON.stringify({ entries: [claim(basename(dir), '2999-01-01'), claim('another-session', '2999-01-01')] }))
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir, PI_SUPERAGENT_WORKSPACE: '/w', PI_SUPERAGENT_CLAIMS_FILE: ledger })
    const verdict = (toolName: string, input: Record<string, unknown>) => f.emit('tool_call', { toolName, input }).find(v => v)
    expect(verdict('ticket_report', { state: 'ready', summary: 'shipped' }), 'ready, with a job still held')
      .toMatchObject({ block: true, reason: expect.stringContaining(`job-${basename(dir)}`) })
    expect(verdict('ask_user_question', { questions: [{ question: 'Stop the pod?' }] }), 'an ask hands over too').toMatchObject({ block: true })
    expect(lines(join(dir, 'reports.jsonl')), 'the refused ask filed nothing').toEqual([])
    expect(verdict('ticket_report', { state: 'waiting', summary: 'run 31 trains', wakeInMinutes: 60 }), 'a wake-up keeps the watch').toBeUndefined()
    expect(verdict('ticket_report', { state: 'failed', summary: 'the pod died' }), 'failing hands nothing over').toBeUndefined()
    f.tools.find(t => t.name === 'ticket_report')!.execute('c1', { state: 'waiting', summary: 'run 31 trains', wakeInMinutes: 60, notes: 'check the dose curve' })
    expect(lines(join(dir, 'reports.jsonl'))).toMatchObject([{ state: 'waiting', wakeInMinutes: 60, notes: 'check the dose curve' }])
    writeFileSync(ledger, JSON.stringify({ entries: [claim(basename(dir), '2000-01-01')] }))
    expect(verdict('ticket_report', { state: 'ready', summary: 'shipped' }), 'an expired claim holds nothing').toBeUndefined()
  })

  it('refuses a pull request or commit that would close a board issue on merge, and lets a plain reference through', () => {
    // 2026-11-13: merging the first of five pull requests closed issue 340 through its "Closes" line.
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: tmp(), PI_SUPERAGENT_WORKSPACE: '/w', PI_SUPERAGENT_HOME_REPO: 'acme/board' })
    const verdict = (toolName: string, input: Record<string, unknown>) => f.emit('tool_call', { toolName, input }).find(v => v)
    expect(verdict('bash', { command: 'gh pr create --title Layer --body "Closes acme/board#340"' }))
      .toMatchObject({ block: true, reason: expect.stringContaining('Part of') })
    expect(verdict('bash', { command: 'git commit -m "fix acme/board#340"' }), 'a commit message closes it too').toMatchObject({ block: true })
    expect(verdict('bash', { command: 'gh pr create --title Layer --body "Part of acme/board#340"' })).toBeUndefined()
    expect(verdict('ticket_report', { state: 'ready', summary: 'This closes acme/board#340 once all five merge.' }),
      'a report is not a pull request').toBeUndefined()
  })

  it('a person typing in the tab lifts the handover, and leaves word for the router that a person is there', () => {
    // 2026-11-12, ticket 340: the operator drove a freed worker from its tab, and after the handover every tool was refused.
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir, PI_SUPERAGENT_WORKSPACE: '/w' })
    const report = f.tools.find(t => t.name === 'ticket_report')!
    const refused = () => f.emit('tool_call', { toolName: 'bash', input: { command: 'make test' } }).find(v => v)
    report.execute('c1', { state: 'ready', summary: 'all six answered' })
    f.emit('input', { type: 'input', text: 'Background task bg-3 finished.', source: 'extension' })
    expect(refused(), 'a wake that is not a person stays handed over').toMatchObject({ block: true, reason: AFTER_HANDOVER })
    expect(existsSync(join(dir, PERSON_FILE))).toBe(false)
    f.emit('input', { type: 'input', text: 'i dont care, just make it uniform', source: 'interactive' })
    expect(refused(), 'the person\'s request runs').toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, PERSON_FILE), 'utf8'))).toMatchObject({ at: expect.any(String) })
    report.execute('c2', { state: 'ready', summary: 'made it uniform' })
    expect(refused(), 'the next handover holds again').toMatchObject({ block: true })
  })

  it('new work from the router lifts the handover, and the worker\'s own nudge does not', async () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir, PI_SUPERAGENT_WORKSPACE: '/w' }, 10)
    const refused = () => f.emit('tool_call', { toolName: 'bash', input: { command: 'make test' } }).find(v => v)
    f.emit('session_start')
    f.tools.find(t => t.name === 'ticket_report')!.execute('c1', { state: 'ready', summary: 'done' })
    writeFileSync(join(dir, 'inbox', SILENT_NUDGE_FILE), JSON.stringify({ text: 'report your outcome', mode: 'followUp' }))
    await until(() => f.sent.length === 1)
    expect(refused(), 'the nudge is not new work').toMatchObject({ block: true })
    f.emit('agent_start')
    f.emit('agent_settled', { aborted: false })
    writeFileSync(join(dir, 'inbox', '1-0000.json'), JSON.stringify({ text: 'octocat: changes requested', mode: 'followUp' }))
    await until(() => f.sent.length === 2)
    expect(f.sent[1]!.text).toBe('octocat: changes requested')
    expect(refused(), 'a new message from the router is new work').toBeUndefined()
    f.emit('session_shutdown')
  })

  it('the guard refuses delegation inside the worker, where it now runs', () => {
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: tmp(), PI_SUPERAGENT_WORKSPACE: '/w' })
    expect(f.emit('tool_call', { toolName: 'subagent', input: {} }).find(Boolean)).toMatchObject({ block: true })
    expect(f.emit('tool_call', { toolName: 'read', input: { path: '/w/a.ts' } })[0]).toBeUndefined()
  })

  it('tells the router when a run starts and settles, and that it is busy at most every few seconds', () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    f.emit('agent_start')
    for (let i = 0; i < 50; i++) f.emit('message_update')
    f.emit('agent_settled')
    expect(lines(join(dir, 'events.jsonl')).map(e => e.type)).toEqual(['turnStarted', 'activity', 'selfNudge', 'settled'])
  })

  it('a command streaming output is activity, so a long build does not read as silence', () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    f.emit('tool_execution_update', { toolName: 'bash', partialResult: 'compiling 412 of 980' })
    expect(lines(join(dir, 'events.jsonl')).map(e => e.type)).toEqual(['activity'])
  })

  it('nudges a silent worker once, then files the failure, ahead of the settle that ends the run', () => {
    // The rule changed 2026-11-10 on the operator's word. Measured before it: 14 of 22 open tickets sat
    // parked on this one summary, so the fleet lost throughput to a forgotten tool call, and only a human
    // could restart it. One nudge per WORKER: a counter reset per run nudges a silent worker forever.
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    f.emit('agent_start')
    f.emit('agent_settled')
    expect(existsSync(join(dir, 'reports.jsonl')), 'the first silence files no report').toBe(false)
    expect(existsSync(join(dir, 'inbox', SILENT_NUDGE_FILE)), 'and queues one nudge the worker reads').toBe(true)
    expect(lines(join(dir, 'events.jsonl')).map(e => e.type), 'the router can see the nudge').toContain('selfNudge')
    f.emit('agent_start')
    f.emit('agent_settled')
    const reports = lines(join(dir, 'reports.jsonl'))
    expect(reports.length, 'one failure, never a second nudge').toBe(1)
    expect(reports).toMatchObject([{ state: 'failed', summary: SILENT_FINISH }])
    const at = (file: string) => String(lines(join(dir, file)).at(-1)!.at)
    expect(at('reports.jsonl') <= at('events.jsonl'), 'the report is written before the settle event').toBe(true)
  })

  it('a run that reported is not a silent finish, and the next silence is a nudge, not a report', () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    const report = f.tools.find(t => t.name === 'ticket_report')!
    f.emit('agent_start')
    report.execute('c1', { state: 'blocked', summary: 'needs a decision', question: 'Ship it?' })
    f.emit('agent_start')
    f.emit('agent_settled')
    expect(lines(join(dir, 'reports.jsonl')).map(r => r.origin ?? 'worker'), 'a retry after a report files nothing').toEqual(['worker'])
    expect(existsSync(join(dir, 'inbox', SILENT_NUDGE_FILE)), 'a run that reported is never nudged').toBe(false)
    f.emit('agent_start')
    f.emit('agent_settled')
    expect(lines(join(dir, 'reports.jsonl')).length, 'the next silence nudges first').toBe(1)
    expect(existsSync(join(dir, 'inbox', SILENT_NUDGE_FILE)), 'and the nudge is queued').toBe(true)
  })

  it('delivers inputs from the router once the session runs, in the order written, the way the router asked', async () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir }, 10)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    writeFileSync(join(dir, 'inbox', '1-0000.json'), JSON.stringify({ text: 'the brief', mode: 'followUp' }))
    writeFileSync(join(dir, 'inbox', '2-0001.json'), JSON.stringify({ text: 'also check CI', mode: 'steer' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.sent, 'nothing before the session starts').toEqual([])
    f.emit('session_start')
    await until(() => f.sent.length === 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.sent, 'idle: one input until the run it starts begins').toEqual([{ text: 'the brief', deliverAs: 'followUp' }])
    f.emit('agent_start')
    await until(() => f.sent.length === 2)
    expect(f.sent).toEqual([{ text: 'the brief', deliverAs: 'followUp' }, { text: 'also check CI', deliverAs: 'steer' }])
    expect(inboxFiles(dir), 'not read yet: the run has not taken them').toEqual(['1-0000.json', '2-0001.json'])
    f.emit('agent_settled', { aborted: false })
    expect(inboxFiles(dir)).toEqual([])
    f.emit('session_shutdown')
  })

  it('never sends into a run an idle send is still starting, where pi kills the input unread', async () => {
    // pi 1.5 marks a session busy only after its input handlers ran: a second send in one idle burst dies on
    // the screen ("Agent is already processing a prompt"), never to the sender. The fake orders it as pi does.
    const dir = tmp()
    const f = fakePi()
    let phase: 'idle' | 'starting' | 'running' = 'idle'
    const killed: string[] = []
    f.pi.sendUserMessage = (text, options) => {
      if (phase === 'starting') { killed.push(text); return }
      if (phase === 'idle') phase = 'starting'
      f.sent.push({ text, deliverAs: options?.deliverAs })
    }
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir }, 10)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    for (const [i, text] of ['continue', 'continue again', 'and CI'].entries()) {
      writeFileSync(join(dir, 'inbox', `${i + 1}-000${i}.json`), JSON.stringify({ text, mode: 'followUp' }))
    }
    f.emit('session_start')
    await until(() => f.sent.length === 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(killed, 'nothing sent while the first run is starting').toEqual([])
    phase = 'running'
    f.emit('agent_start')
    await until(() => f.sent.length === 3)
    expect(f.sent.map(s => s.text)).toEqual(['continue', 'continue again', 'and CI'])
    f.emit('agent_settled', { aborted: false })
    phase = 'idle'
    expect(inboxFiles(dir), 'all three read, none lost').toEqual([])
    expect(killed).toEqual([])
    f.emit('session_shutdown')
  })

  it('sends an idle input again when pi silently started no run with it', async () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir }, 10, 100)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    writeFileSync(join(dir, 'inbox', '1-0000.json'), JSON.stringify({ text: 'the brief', mode: 'followUp' }))
    writeFileSync(join(dir, 'inbox', '2-0001.json'), JSON.stringify({ text: 'the review', mode: 'followUp' }))
    f.emit('session_start')
    await until(() => f.sent.length === 2)
    expect(f.sent.map(s => s.text), 'the same input again, not the next one').toEqual(['the brief', 'the brief'])
    expect(lines(join(dir, 'events.jsonl')).some(e => e.type === 'inbox_error' && e.name === '1-0000.json'), 'the router can see it').toBe(true)
    f.emit('agent_start')
    await until(() => f.sent.length === 3)
    expect(f.sent[2]).toEqual({ text: 'the review', deliverAs: 'followUp' })
    f.emit('agent_settled', { aborted: false })
    expect(inboxFiles(dir)).toEqual([])
    f.emit('session_shutdown')
  })

  it('parks an inbox file it cannot read instead of reading it every second', async () => {
    // Measured 2026-11-07 audit: a half-written file was caught, skipped, and caught again at 1 Hz for the
    // whole life of the worker, with nothing to tell anyone. One rename, one event, and it stops happening.
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir }, 10)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    writeFileSync(join(dir, 'inbox', '1-0000.json'), '{ "text": "the brief is trunca')
    f.emit('session_start')
    await until(() => existsSync(join(dir, 'inbox', '1-0000.json.corrupt')))
    expect(inboxFiles(dir)).toEqual(['1-0000.json.corrupt'])
    expect(lines(join(dir, 'events.jsonl')).some(e => e.type === 'inbox_error'), 'the router can see it happened').toBe(true)
    f.emit('session_shutdown')
  })

  it('keeps an input the run was aborted before reading, and sends it again', async () => {
    // pi hands messages still queued when a run is aborted back to the human's input box: a router review
    // delivered into a long run died there, marked read, while the ticket waited for a worker that had it never.
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir }, 10)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    writeFileSync(join(dir, 'inbox', '1-0000.json'), JSON.stringify({ text: 'changes requested', mode: 'followUp' }))
    f.emit('session_start')
    await until(() => f.sent.length === 1)
    f.emit('agent_settled', { aborted: true })
    expect(inboxFiles(dir), 'the abort gave it back: keep the copy').toEqual(['1-0000.json'])
    await until(() => f.sent.length === 2)
    expect(f.sent[1]).toEqual({ text: 'changes requested', deliverAs: 'followUp' })
    f.emit('agent_settled', { aborted: false })
    expect(inboxFiles(dir), 'the second run read it').toEqual([])
    f.emit('session_shutdown')
  })

  it('reads an input when the run takes it into a step, not at a run start that never comes, and never sends it again', async () => {
    // 2026-11-12: a review steered into a busy worker counted as unread, and a fresh worker answered it again.
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir }, 10)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    writeFileSync(join(dir, 'inbox', '1-0000.json'), JSON.stringify({ text: 'the brief', mode: 'followUp' }))
    f.emit('session_start')
    await until(() => f.sent.length === 1)
    f.emit('agent_start')
    const user = (text: string) => ({ message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } })
    f.emit('message_end', user('the brief'))
    writeFileSync(join(dir, 'inbox', '2-0001.json'), JSON.stringify({ text: 'octocat: changes requested', mode: 'steer' }))
    await until(() => f.sent.length === 2)
    f.emit('message_end', user('typed into the tab'))
    f.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'octocat: changes requested' }] } })
    expect(inboxFiles(dir), 'only the user message that carries it reads it').toEqual(['2-0001.json'])
    f.emit('message_end', user('octocat: changes requested'))
    expect(lines(join(dir, 'events.jsonl')).filter(e => e.type === 'input_read').map(e => e.name), 'read mid-run, before any settle')
      .toEqual(['1-0000.json', '2-0001.json'])
    expect(inboxFiles(dir)).toEqual([])
    f.tools.find(t => t.name === 'ticket_report')!.execute('c1', { state: 'ready', summary: 'answered the review' })
    f.emit('agent_settled', { aborted: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.sent.map(s => s.text), 'an abort gives back only what the run had not taken').toEqual(['the brief', 'octocat: changes requested'])
    f.emit('session_shutdown')
  })

  it('keeps an input the session refused to take, and sends it again once it can', async () => {
    const dir = tmp()
    const f = fakePi()
    let deaf = true
    f.pi.sendUserMessage = (text, options) => {
      if (deaf) return Promise.reject(new Error('no active run'))
      f.sent.push({ text, deliverAs: options?.deliverAs })
    }
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir }, 10)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    writeFileSync(join(dir, 'inbox', '1-0000.json'), JSON.stringify({ text: 'the brief', mode: 'followUp' }))
    f.emit('session_start')
    await until(() => lines(join(dir, 'events.jsonl')).some(r => r.type === 'inbox_error'))
    expect(inboxFiles(dir), 'a refusal is not a delivery').toEqual(['1-0000.json'])
    deaf = false
    await until(() => f.sent.length === 1)
    expect(f.sent).toEqual([{ text: 'the brief', deliverAs: 'followUp' }])
    f.emit('session_shutdown')
  })
})
