import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createRouterExtension, type PiLike, type RegisteredTool } from '../src/pi/extension.ts'
import type { IssueComment, IssueState } from '../src/pi/source-github.ts'
import type { RouterConfig, SdkSurface } from '../src/pi/router.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pi-panel-')); dirs.push(d); return d }
// The POST routes take the panel secret from the state directory the router made on its first start.
const panelSecret = (dir: string) => readFileSync(join(dir, 'panel-token'), 'utf8').trim()
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const piStub = (): PiLike & { tools: Map<string, RegisteredTool> } => {
  const tools = new Map<string, RegisteredTool>()
  return {
    tools,
    registerTool: t => { tools.set(t.name, t) },
    sendUserMessage: () => {},
    on: () => () => {},
  }
}

// The router can fall back to an ephemeral port when the requested port is busy.
async function listeningPort(dir: string): Promise<number> {
  return vi.waitFor(() => {
    const log = readFileSync(join(dir, 'engine.log'), 'utf8')
    const bound = /panel\.bound port=(\d+)/.exec(log)
    if (!bound) throw new Error('Waiting for the panel to listen')
    return Number(bound[1])
  })
}

async function boot(withTicket: boolean) {
  const dir = tmp()
  const requestedPort = 43_000 + Math.floor((dirs.length * 37) % 400)
  const issues: IssueState[] = []
  const comments: IssueComment[] = []
  const config: RouterConfig = { dataDir: dir, worktreeRoot: join(dir, 'work'), self: 'pi', bots: new Set(['fleet-*']), githubRepo: 'o/r', prepare: 'true', tickMs: 600_000, panelPort: requestedPort }
  let reportTool: RegisteredTool | undefined
  const sdk: SdkSurface = {
    createAgentSession: async options => {
      const tool = (options.customTools as RegisteredTool[] | undefined)?.[0]
      if (tool?.name === 'ticket_report') reportTool = tool
      return { session: { sessionId: 'w', prompt: async () => {}, subscribe: () => () => {}, abort: () => {}, dispose: () => {} } }
    },
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    getAgentDir: () => dir,
  }
  const running = createRouterExtension(piStub(), { config, sdk, now: () => new Date().toISOString(),
    githubApi: { issues: async () => [...issues], comments: async () => [...comments], postComment: async () => {} },
    pullApi: { pull: async () => ({ read: 'found', pull: { open: true, merged: false, createdAt: new Date().toISOString() } }), comments: async () => [], reviews: async () => [] } })
  await new Promise(r => running.tick().then(() => setTimeout(r as () => void, 30)))
  const addComment = (n: number, body: string) => {
    if (!issues.some(i => i.issue === n)) issues.push({ issue: n, title: 'DO: the thing', labels: [], author: 'pi', association: 'OWNER',
      createdAt: '2026-11-04T09:00:00Z', updatedAt: new Date().toISOString() })
    comments.push({ issue: n, author: 'octocat', association: 'OWNER', at: new Date().toISOString(), body })
  }
  if (withTicket) {
    addComment(500, 'cut the release tonight')
    await running.tick()
    running.assessor.waiting().forEach(w => running.assessor.decide(w.evalId, { kind: 'accept', title: 'Cut the release', scope: 'tonight', reason: 'the operator asked', acknowledgement: 'on it' }))
    await running.tick()
  }
  const port = await listeningPort(dir)
  const api = async (path: string, header?: string) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(header ? { 'x-superagent-request': header } : {}) }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers })
    const text = await res.text()
    return { status: res.status, text, json: () => JSON.parse(text) as Record<string, any> }
  }
  return { running, dir, addComment, api, port, report: () => reportTool }
}

it('a ticket waiting on its pull request says so where the panel lists what each ticket waits for', async () => {
  const f = await boot(true)
  f.report()!.execute('r1', { state: 'ready', summary: 'opened it', pullRequests: ['https://github.com/o/r/pull/77'] })
  const [open] = (await f.api('/api/tickets', '1')).json() as unknown as Array<{ waitsFor: string }>
  expect(open!.waitsFor).toBe('review of #77')
  f.running.stop()
})

it('the panel links tickets to their GitHub issue and names the source', async () => {
  const dir = tmp()
  const requestedPort = 43_900 + Math.floor((dirs.length * 13) % 80)
  const issues: IssueState[] = []
  const config: RouterConfig = { dataDir: dir, worktreeRoot: join(dir, 'work'), self: 'pi', bots: new Set(['fleet-*']),
    tickMs: 600_000, panelPort: requestedPort, githubRepo: 'o/r', prepare: 'true' }
  const sdk: SdkSurface = {
    createAgentSession: async () => ({ session: { sessionId: 'w', prompt: async () => {}, subscribe: () => () => {}, abort: () => {}, dispose: () => {} } }),
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    getAgentDir: () => dir,
  }
  const running = createRouterExtension(piStub(), {
    config, sdk, now: () => new Date().toISOString(),
    githubApi: { comments: async () => [], issues: async () => [...issues], postComment: async () => {} },
  })
  await running.tick()
  issues.push({ issue: 150, title: 'DO: tidy the panel', body: 'Link tickets to issues.', author: 'octocat', association: 'OWNER',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), labels: [] })
  await running.tick()
  running.assessor.waiting().forEach(w => running.assessor.decide(w.evalId, { kind: 'accept', title: 'Tidy the panel', scope: 'links', reason: 'asked', acknowledgement: 'on it' }))
  await running.tick()
  const port = await listeningPort(dir)
  const html = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `127.0.0.1:${port}` } })).text()
  expect(html).toContain('GitHub issues: o/r')
  expect(html).toContain('href="https://github.com/o/r/issues/150"')
  running.stop()
})

describe('the panel and the API', () => {
  it('serves the newest open ticket first, where the operator is looking', async () => {
    const f = await boot(true)
    f.addComment(501, 'the newer ask')
    await f.running.tick()
    f.running.assessor.waiting().forEach(w => f.running.assessor.decide(w.evalId, { kind: 'accept', title: 'The newer ask', scope: 'now', reason: 'asked', acknowledgement: 'on it' }))
    await f.running.tick()
    const rows = (await f.api('/api/tickets', '1')).json() as unknown as Array<{ thread: string }>
    expect(rows.map(t => t.thread), 'the panel leads with what just landed, not with the oldest ticket').toEqual(['#501', '#500'])
    f.running.stop()
  })

  it('refuses a malformed pause request, and stays alive to say so', async () => {
    // Measured 2026-11-07 audit: this handler sat outside the request's try, so a body that was not JSON was an
    // uncaught exception in the router process — a curl typo from the panel killed every running worker.
    const f = await boot(true)
    const res = await fetch(`http://127.0.0.1:${f.port}/api/executor/pause`, {
      method: 'POST', body: '{paused', headers: { host: `127.0.0.1:${f.port}`, 'x-superagent-request': '1', 'x-superagent-token': panelSecret(f.dir) },
    })
    expect(res.status).toBe(400)
    const state = (await f.api('/api/state', '1')).json() as Record<string, unknown>
    expect(state, 'the panel shows the same health document `superagent status` reads').toHaveProperty('health')
    expect(f.running.workers(), 'the router is alive with its worker running').toHaveLength(1)
    f.running.stop()
  })

  it('the operator can stop a ticket, and its worker stops with it', async () => {
    const f = await boot(true)
    const [open] = (await f.api('/api/tickets', '1')).json() as unknown as Array<{ id: string }>
    expect(f.running.workers().map(w => w.ticketId)).toEqual([open!.id])
    const res = await fetch(`http://127.0.0.1:${f.port}/api/tickets/${open!.id}/stop`, { method: 'POST', headers: { host: `127.0.0.1:${f.port}`, 'x-superagent-request': '1', 'x-superagent-token': panelSecret(f.dir) } })
    expect(res.status).toBe(200)
    expect((await f.api('/api/tickets', '1')).json()).toEqual([])
    await new Promise(r => setTimeout(r, 30))
    expect(f.running.workers(), 'the stop reached the worker').toEqual([])
    const missing = await fetch(`http://127.0.0.1:${f.port}/api/tickets/nope/stop`, { method: 'POST', headers: { host: `127.0.0.1:${f.port}`, 'x-superagent-request': '1', 'x-superagent-token': panelSecret(f.dir) } })
    expect(missing.status).toBe(404)
    f.running.stop()
  })

  it('refuses a caller that did not say what it is, and any non-local host', async () => {
    const f = await boot(false)
    const anon = await api403(f)
    expect(anon.status).toBe(403)
    expect(anon.json().error).toMatch(/x-superagent-request/)
    // A browser cannot forge Host to a fetch, so the host rule is proved on a raw request: a page on
    // another site must not be able to read the queue by DNS-rebinding localhost.
    const raw = await rawRequest(f.port, 'GET /api/state HTTP/1.1\r\nHost: evil.example\r\nx-superagent-request: 1\r\nConnection: close\r\n\r\n')
    expect(raw.startsWith('HTTP/1.1 403')).toBe(true)
    expect(raw).toMatch(/127\.0\.0\.1 or localhost/)
    f.running.stop()
  })

  it('answers state, settings, and sources with honest counts', async () => {
    const f = await boot(true)
    const state = (await api2(f, '/api/state')).json()
    expect(state).toMatchObject({ paused: false, load: { maxWorkers: 4 } })
    const list = (await api2(f, '/api/tickets')).json()
    expect(list.length).toBe(state.counts.open ?? list.length)
    expect(list[0]).toMatchObject({ thread: '#500', title: 'Cut the release' })
    expect((await api2(f, '/api/sources')).json()[0]).toMatchObject({ id: 'github', state: 'ready' })
    const html = (await fetch(`http://127.0.0.1:${f.port}/`, { headers: { host: `127.0.0.1:${f.port}` } })).status
    expect(html).toBe(200)
    f.running.stop()
  })

  it('pause round-trips through the API and stops new work', async () => {
    const f = await boot(false)
    const res = await fetch(`http://127.0.0.1:${f.port}/api/executor/pause`, {
      method: 'POST', headers: { 'x-superagent-request': '1', host: `127.0.0.1:${f.port}`, 'content-type': 'application/json', 'x-superagent-token': panelSecret(f.dir) }, body: JSON.stringify({ paused: true }),
    })
    expect(await res.json()).toEqual({ paused: true })
    expect(f.running.isPaused()).toBe(true)
    f.addComment(501, 'do the thing')
    await f.running.tick()
    expect(f.running.assessor.waiting()).toHaveLength(0)
    f.running.stop()
  })

  it('serves one ticket as history and says so when it does not exist', async () => {
    const f = await boot(true)
    const id = (await api2(f, '/api/tickets')).json()[0].id
    expect((await api2(f, `/api/ticket?id=${id}`)).json()).toMatchObject({ id, title: 'Cut the release' })
    expect((await api2(f, '/api/ticket?id=nope')).json()).toMatchObject({ error: /no such ticket/ })
    const html = await fetch(`http://127.0.0.1:${f.port}/ticket?id=${id}`, { headers: { host: `127.0.0.1:${f.port}` } })
    expect(await html.text()).toContain('Cut the release')
    f.running.stop()
  })

  it('the panel page names the domain, not a status code, and shows what it waits for', async () => {
    const f = await boot(true)
    const res = await fetch(`http://127.0.0.1:${f.port}/`, { headers: { host: `127.0.0.1:${f.port}` } })
    const html = await res.text()
    expect(html).toContain('Needs a person')
    expect(html).toContain('Cut the release')
    expect(html).toMatch(/its worker|the router|a person/)
    expect(html, 'working and parked workers are counted apart').toMatch(/\d+\/\d+ working, \d+ parked, \d+ queued/)
    f.running.stop()
  })
})

type Api = { api: (p: string, h?: string) => Promise<{ status: number; text: string; json: () => Record<string, any> }> }
const api2 = (f: Api, p: string) => f.api(p, '1')
const api403 = (f: Api) => f.api('/api/state')

const rawRequest = (port: number, request: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
  let data = ''
  socket.on('data', c => { data += c })
  socket.on('end', () => resolve(data))
  socket.on('error', reject)
})

describe('the panel POST secret', () => {
  it('refuses a POST that carries no panel token, and changes nothing', async () => {
    // A localhost bind keeps remote callers out; it keeps a worker process out of nothing. Pause is a write.
    const f = await boot(true)
    const before = (await f.api('/api/state', '1')).json() as { paused: boolean }
    const res = await fetch(`http://127.0.0.1:${f.port}/api/executor/pause`, {
      method: 'POST', body: '{"paused":true}', headers: { host: `127.0.0.1:${f.port}`, 'x-superagent-request': '1' },
    })
    expect(res.status).toBe(403)
    const after = (await f.api('/api/state', '1')).json() as { paused: boolean }
    expect(after.paused, 'a refused pause leaves the router running the same work').toBe(before.paused)
  })
})
