import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SILENT_FINISH, SILENT_NUDGE_FILE, workerRole, type WorkerPi } from '../src/pi/worker-role.ts'

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
    const bad = 'https://github.comResearch-Adobe/caramel/pull/1994'
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
    const verdicts = f.emit('tool_call', {
      toolName: 'ask_user_question',
      input: { questions: [{ question: 'Fix the shared harness too?', options: [{ label: 'Just my PR' }, { label: 'A second PR' }] }] },
    })
    expect(verdicts.some(v => (v as { block?: boolean } | undefined)?.block), 'the ask cannot sit waiting for a keystroke in a headless tab').toBe(true)
    expect(lines(join(dir, 'reports.jsonl')).at(-1), 'the question, with its options, reaches the router').toMatchObject({
      state: 'blocked', question: 'Fix the shared harness too?\n1. Just my PR\n2. A second PR', origin: 'ask',
    })
    expect(f.emit('tool_call', { toolName: 'read', input: { path: '/w/a.ts' } }).every(v => v === undefined), 'every other tool is untouched').toBe(true)
  })

  it('the guard refuses delegation inside the worker, where it now runs', () => {
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: tmp(), PI_SUPERAGENT_WORKSPACE: '/w' })
    const [verdict] = f.emit('tool_call', { toolName: 'subagent', input: {} })
    expect(verdict).toMatchObject({ block: true })
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
    await until(() => f.sent.length === 2)
    expect(f.sent).toEqual([{ text: 'the brief', deliverAs: 'followUp' }, { text: 'also check CI', deliverAs: 'steer' }])
    expect(inboxFiles(dir), 'not read yet: the run has not taken them').toEqual(['1-0000.json', '2-0001.json'])
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
