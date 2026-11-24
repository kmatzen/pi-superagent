import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createRouterExtension, type PiLike, type RegisteredTool } from '../src/pi/extension.ts'
import { createPanelServer, type PanelSource } from '../src/pi/server.ts'
import type { IssueComment, IssueState } from '../src/pi/source-github.ts'
import type { RouterConfig, SdkSurface } from '../src/pi/router.ts'

async function serve(src: PanelSource): Promise<{ port: number; close: () => Promise<void> }> {
const { server } = createPanelServer(src)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as net.AddressInfo).port
return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

const source = (over: Record<string, unknown>): PanelSource => ({
now: () => new Date().toISOString(),
repos: { tickets: { list: () => [], get: () => undefined }, threads: { list: () => [] }, decisions: { byThread: () => [] }, triggersOfThread: () => [], triggers: { disposition: () => undefined }, kv: { get: () => undefined, set: () => {} } },
load: () => ({ running: 0, parked: 0, queued: 0, maxWorkers: 4 }),
workers: () => [],
log: () => {},
health: () => ({}),
isPaused: () => false,
setPaused: () => {},
token: () => 'sekret',
config: { githubRepo: 'o/r' },
assessor: { waiting: () => [] },
...over,
} as unknown as PanelSource)

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
    pullApi: { pull: async () => ({ open: true, merged: false, createdAt: new Date().toISOString() }), comments: async () => [], reviews: async () => [] } })
  await new Promise(r => running.tick().then(() => setTimeout(r as () => void, 30)))
  const addComment = (n: number, body: string) => {
    if (!issues.some(i => i.issue === n)) issues.push({ issue: n, title: 'DO: the thing', author: 'pi', association: 'OWNER',
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
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
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
    const res = await fetch(`http://127.0.0.1:${f.port}/api/tickets/${open!.id}/stop`, {
      method: 'POST', headers: { host: `127.0.0.1:${f.port}`, 'x-superagent-request': '1', 'x-superagent-token': panelSecret(f.dir), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'it duplicates ticket 695488 on issue #145' }),
    })
    expect(res.status).toBe(200)
    expect(String((await res.json() as { reason?: string }).reason), "the caller's reason reaches the engine").toContain('duplicates ticket')
    expect((await f.api('/api/tickets', '1')).json()).toEqual([])
    await new Promise(r => setTimeout(r, 30))
    expect(f.running.workers(), 'the stop reached the worker').toEqual([])
    const ticket = (await f.api(`/api/ticket?id=${open!.id}`, '1')).json() as { ended?: { reason?: string } }
    expect(ticket.ended?.reason, 'the reason lands on the ticket record').toContain('duplicates ticket')
    // A stop of a ticket that has already ended refuses instead of answering 200 over a lever that moved
    // nothing: the ticket keeps its own end, and the caller is told (audit 2026-11-11).
    const again = await fetch(`http://127.0.0.1:${f.port}/api/tickets/${open!.id}/stop`, {
      method: 'POST', headers: { host: `127.0.0.1:${f.port}`, 'x-superagent-request': '1', 'x-superagent-token': panelSecret(f.dir), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'late' }),
    })
    expect(again.status).toBe(409)
    expect(String((await again.json() as { error?: string }).error)).toContain('Ticket has ended')
    const badBody = await fetch(`http://127.0.0.1:${f.port}/api/tickets/${open!.id}/stop`, {
      method: 'POST', headers: { host: `127.0.0.1:${f.port}`, 'x-superagent-request': '1', 'x-superagent-token': panelSecret(f.dir), 'content-type': 'application/json' }, body: '{oops',
    })
    expect(badBody.status, 'a malformed body never blocks the refusal the caller gets').toBe(409)
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
    expect(raw).toMatch(/is not localhost and not in PI_SUPERAGENT_PANEL_HOSTS/)
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

  it('refuses a POST whose token is wrong, not only one that is missing', async () => {
    // Only the missing-token path was pinned; a present-but-wrong token is the shape a confused caller
    // (or a guesser) actually sends (audit 2026-11-11).
    const f = await boot(true)
    const before = (await f.api('/api/state', '1')).json() as { paused: boolean }
    const res = await fetch(`http://127.0.0.1:${f.port}/api/executor/pause`, {
      method: 'POST', body: '{"paused":true}',
      headers: { host: `127.0.0.1:${f.port}`, 'x-superagent-request': '1', 'x-superagent-token': 'not-the-secret' },
    })
    expect(res.status).toBe(403)
    const after = (await f.api('/api/state', '1')).json() as { paused: boolean }
    expect(after.paused, 'a refused pause leaves the router running the same work').toBe(before.paused)
  })
})

describe('the panel under a failing store', () => {
  it('answers 500 when its read fails, and the router it shares a process with keeps serving', async () => {
    // Measured 2026-11-11: /tmp filled, the panel's read threw SQLITE_FULL inside the request handler, and pi
    // exited on the uncaught exception, taking every worker the router supervised with it.
    const logged: string[] = []
    const full = Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
    const src = {
      now: () => new Date().toISOString(),
      repos: { tickets: { list: () => { throw full } } },
      log: (_level: string, event: string) => { logged.push(event) },
    } as unknown as PanelSource
    const { server } = createPanelServer(src)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const get = () => fetch(`http://127.0.0.1:${port}/`, { headers: { host: `127.0.0.1:${port}` } })
    const first = await get()
    expect(first.status).toBe(500)
    expect(await first.text()).toContain('the router is still running')
    expect((await get()).status, 'still answering: the failure did not take the process down').toBe(500)
    expect(logged).toEqual(['panel.failed', 'panel.failed'])
    await new Promise(resolve => server.close(resolve))
  })
})

describe('the panel worker screen', () => {
  const hdr = (token?: string) => ({ host: '127.0.0.1', 'x-superagent-request': '1', ...(token ? { 'x-superagent-token': token } : {}) })

  it('reads a worker screen, and typing needs the panel token', async () => {
    const prompts: string[] = []
    const s = await serve(source({
      workerPane: async () => ({ tab: 'w9:t3', agent: 'sa-1', text: 'thinking about the ticket' }),
      workerPrompt: async (_t: string, text: string) => { prompts.push(text) },
    }))
    const screen = await (await fetch(`http://127.0.0.1:${s.port}/api/worker?ticket=t1`, { headers: hdr() })).json() as Record<string, unknown>
    expect(screen.text, 'the operator sees the worker terminal').toBe('thinking about the ticket')
    const page = await (await fetch(`http://127.0.0.1:${s.port}/worker?ticket=t1`, { headers: { host: '127.0.0.1' } })).text()
    expect(page).toContain('id="screen"')
    const noToken = await fetch(`http://127.0.0.1:${s.port}/api/worker/prompt`, { method: 'POST', headers: hdr(), body: JSON.stringify({ ticket: 't1', text: 'do it' }) })
    expect(noToken.status, 'typing into a worker is a POST, so it needs the token').toBe(403)
    const sent = await fetch(`http://127.0.0.1:${s.port}/api/worker/prompt`, { method: 'POST', headers: hdr('sekret'), body: JSON.stringify({ ticket: 't1', text: 'do it' }) })
    expect(sent.status).toBe(200)
    expect(prompts).toEqual(['do it'])
    const empty = await fetch(`http://127.0.0.1:${s.port}/api/worker/prompt`, { method: 'POST', headers: hdr('sekret'), body: JSON.stringify({ ticket: 't1', text: '  ' }) })
    expect(empty.status, 'an empty prompt is the caller’s mistake').toBe(400)
    await s.close()
  })

  it('names a ticket with no worker, and a fleet with no herdr tabs', async () => {
    const missing = await serve(source({
      workerPane: async (ticketId: string) => { throw new Error(`no worker tab for ticket ${ticketId}`) },
    }))
    expect((await fetch(`http://127.0.0.1:${missing.port}/api/worker?ticket=t2`, { headers: hdr() })).status).toBe(404)
    await missing.close()
    const inProcess = await serve(source({}))
    const res = await fetch(`http://127.0.0.1:${inProcess.port}/api/worker?ticket=t1`, { headers: hdr() })
    expect(res.status, 'in-process workers have no terminal to read').toBe(501)
    const page = await (await fetch(`http://127.0.0.1:${inProcess.port}/worker?ticket=t1`, { headers: { host: '127.0.0.1' } })).text()
    expect(page).toContain('do not run in herdr tabs')
    await inProcess.close()
  })

  it('links the worker screen from every open ticket', async () => {
    const ticket = {
      id: 't1', title: 'Do the thing', channels: [{ source: 'github', thread: 'o/r#7' }], assignments: [],
    } as never
    const s = await serve(source({ repos: { tickets: { list: () => [ticket], get: () => ticket }, threads: { list: () => [] }, decisions: { byThread: () => [] }, triggersOfThread: () => [], triggers: { disposition: () => undefined }, kv: { get: () => undefined, set: () => {} } } }))
    const page = await (await fetch(`http://127.0.0.1:${s.port}/`, { headers: { host: '127.0.0.1' } })).text()
    expect(page, 'the execution table reaches the screen of the ticket it names').toContain('/worker?ticket=t1')
    await s.close()
  })
})

describe('the panel behind a reverse proxy', () => {

  it('answers the proxy name it was configured with, and no other name', async () => {
    const s = await serve(source({ config: { githubRepo: 'o/r', panelHosts: ['superagent.example.net'] } }))
    const get = (host: string) => rawRequest(s.port, `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    expect((await get('superagent.example.net')).startsWith('HTTP/1.1 200'), 'the proxy Host is an answerable name').toBe(true)
    expect((await get('elsewhere.example.net')).startsWith('HTTP/1.1 403'), 'a name nobody configured is refused').toBe(true)
    expect((await get(`127.0.0.1:${s.port}`)).startsWith('HTTP/1.1 200'), 'localhost stays answerable, so the tunnel keeps working').toBe(true)
    await s.close()
  })

  it('demands the token on a read once the panel is exposed, and takes it as a Basic password', async () => {
    const s = await serve(source({ config: { githubRepo: 'o/r', panelHosts: ['superagent.example.net'], panelTokenAllRequests: true } }))
    const anon = await fetch(`http://127.0.0.1:${s.port}/`, { headers: { host: 'superagent.example.net' } })
    expect(anon.status, 'past localhost, a read needs the token').toBe(401)
    expect(anon.headers.get('www-authenticate'), 'the browser gets a prompt it can fill').toContain('Basic')
    const basic = Buffer.from(`:${'sekret'}`).toString('base64')
    const authed = await fetch(`http://127.0.0.1:${s.port}/`, { headers: { host: 'superagent.example.net', authorization: `Basic ${basic}` } })
    expect(authed.status).toBe(200)
    const write = await fetch(`http://127.0.0.1:${s.port}/api/executor/pause`, {
      method: 'POST', headers: { host: 'superagent.example.net', 'x-superagent-request': '1', 'content-type': 'application/json', authorization: `Basic ${basic}` },
      body: JSON.stringify({ paused: true }),
    })
    expect(write.status, 'the Basic password serves a write as well as the header does').toBe(200)
    const headerToken = await fetch(`http://127.0.0.1:${s.port}/api/state`, { headers: { host: 'superagent.example.net', 'x-superagent-request': '1', 'x-superagent-token': 'sekret' } })
    expect(headerToken.status, 'scripts keep the header path').toBe(200)
    await s.close()
  })

  it('leaves a panel with no proxy config alone', async () => {
    const s = await serve(source({}))
    const anon = await fetch(`http://127.0.0.1:${s.port}/`, { headers: { host: `127.0.0.1:${s.port}` } })
    expect(anon.status, 'unset means the localhost panel behaves exactly as before').toBe(200)
    await s.close()
  })
})

describe('what the panel says a person is needed for', () => {
  const ticket = (summary: string, question: string) => ({
    id: 't1', title: 'Fix the mirror', channels: [{ source: 'github', thread: 'o/r#924' }],
    assignments: [{ state: 'running', report: { state: 'blocked', summary, question, at: new Date().toISOString() } }],
    attention: { question },
  }) as never

  const page = async (t: never) => {
    const s = await serve(source({ repos: { tickets: { list: () => [t], get: () => t }, threads: { list: () => [] }, decisions: { byThread: () => [] }, triggersOfThread: () => [], triggers: { disposition: () => undefined }, kv: { get: () => undefined, set: () => {} } } }))
    const html = await (await fetch(`http://127.0.0.1:${s.port}/`, { headers: { host: '127.0.0.1' } })).text()
    await s.close()
    return html
  }

  it('names the router silence nudge as the router, not as a question from the worker', async () => {
    const nudge = await page(ticket('the worker sent no event for 16 minutes in /work/t1', 'steer it, stop it, or accept the work it has done'))
    expect(nudge, 'the operator reads why the row is there').toContain('quiet, no question from the worker')
    expect(nudge).toContain('sent no event for 16 minutes')
    const asked = await page(ticket('the prover is missing on the builder', 'should I install Lean 4.33.1 or skip the mirror?'))
    expect(asked).toContain('should I install Lean 4.33.1 or skip the mirror?')
    expect(asked).not.toContain('quiet, no question from the worker')
  })

  it('lists live workers with a screen link, and links the screen from each ask', async () => {
    const s = await serve(source({ workers: () => [{ ticketId: 't9', sessionId: 's9', workspace: '/work/t9', startedAt: 'x', lastEventAt: 'y', events: 4, quietSeconds: 12, ageSeconds: 60, watch: 'o/r#9', busy: true }] }))
    const html = await (await fetch(`http://127.0.0.1:${s.port}/`, { headers: { host: '127.0.0.1' } })).text()
    expect(html).toContain('id="workers"')
    expect(html).toContain('/worker?ticket=t9')
    expect(html.match(/\/worker\?ticket=/g)?.length ?? 0).toBeGreaterThan(0)
    await s.close()
    const ask = await page(ticket('the prover is missing', 'install Lean?'))
    expect(ask).toContain('/worker?ticket=t1')
  })
})

describe('what the panel offers for a ticket it says needs a person', () => {
  it('links the thread and gives one-click stop', async () => {
    const t = {
      id: 't7', title: 'Resolve merge conflict', channels: [{ source: 'github', thread: 'o/r#2249', address: { repo: 'o/r', issue: '2249' } }],
      assignments: [{ state: 'running', report: { state: 'blocked', summary: 'the merge is a wash', question: 'leave it closed?', at: new Date().toISOString() } }],
      attention: { question: 'leave it closed?' },
    } as never
    const s = await serve(source({ repos: { tickets: { list: () => [t], get: () => t }, threads: { list: () => [] }, decisions: { byThread: () => [] }, triggersOfThread: () => [], triggers: { disposition: () => undefined }, kv: { get: () => undefined, set: () => {} } } }))
    const html = await (await fetch(`http://127.0.0.1:${s.port}/`, { headers: { host: '127.0.0.1' } })).text()
    expect(html, 'the ask points at the thread it is about').toContain('github.com/o/r/')
    expect(html.match(/data-ticket="t7"/g)?.length ?? 0, 'both the ask row and the open row can stop it').toBe(2)
    expect(html).toContain('/api/tickets/')
    await s.close()
  })
})
