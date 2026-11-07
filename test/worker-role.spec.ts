import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SILENT_FINISH, workerRole, type WorkerPi } from '../src/pi/worker-role.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wrole-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10))
}
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
    expect(lines(join(dir, 'events.jsonl')).map(e => e.type)).toEqual(['turnStarted', 'activity', 'settled'])
  })

  it('files a run that ends without ticket_report as a failure, ahead of the settle that ends it', () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    f.emit('agent_start')
    f.emit('agent_settled')
    expect(lines(join(dir, 'reports.jsonl'))).toMatchObject([{ state: 'failed', summary: SILENT_FINISH, origin: 'silent' }])
    const at = (file: string) => String(lines(join(dir, file)).at(-1)!.at)
    expect(at('reports.jsonl') <= at('events.jsonl'), 'the report is written before the settle').toBe(true)
  })

  it('a run that reported is not a silent finish, even when pi retries after the report; the next run must report again', () => {
    const dir = tmp()
    const f = fakePi()
    workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir })
    const report = f.tools.find(t => t.name === 'ticket_report')!
    f.emit('agent_start')
    report.execute('c1', { state: 'blocked', summary: 'needs a decision', question: 'Ship it?' })
    f.emit('agent_start')
    f.emit('agent_settled')
    expect(lines(join(dir, 'reports.jsonl')).map(r => r.origin ?? 'worker')).toEqual(['worker'])
    f.emit('agent_start')
    f.emit('agent_settled')
    expect(lines(join(dir, 'reports.jsonl')).map(r => r.origin ?? 'worker')).toEqual(['worker', 'silent'])
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
    expect(readdirSync(join(dir, 'inbox')), 'not read yet: the run has not taken them').toEqual(['1-0000.json', '2-0001.json'])
    f.emit('agent_settled', { aborted: false })
    expect(readdirSync(join(dir, 'inbox'))).toEqual([])
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
    expect(readdirSync(join(dir, 'inbox')), 'the abort gave it back: keep the copy').toEqual(['1-0000.json'])
    await until(() => f.sent.length === 2)
    expect(f.sent[1]).toEqual({ text: 'changes requested', deliverAs: 'followUp' })
    f.emit('agent_settled', { aborted: false })
    expect(readdirSync(join(dir, 'inbox')), 'the second run read it').toEqual([])
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
    expect(readdirSync(join(dir, 'inbox')), 'a refusal is not a delivery').toEqual(['1-0000.json'])
    deaf = false
    await until(() => f.sent.length === 1)
    expect(f.sent).toEqual([{ text: 'the brief', deliverAs: 'followUp' }])
    f.emit('session_shutdown')
  })
})
