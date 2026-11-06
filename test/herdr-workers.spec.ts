import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { WorkerEvent } from '../src/pi/executor.ts'
import { HerdrError, type AgentInfo, type Herdr } from '../src/pi/herdr.ts'
import { agentName, HerdrWorkers } from '../src/pi/herdr-workers.ts'
import { openLog } from '../src/pi/log.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hworkers-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10))
}

function memoryHerdr(over: Partial<Herdr> = {}) {
  const agents = new Map<string, AgentInfo>()
  const calls: string[] = []
  let tabs = 0
  const herdr: Herdr = {
    workspaces: async () => [{ workspace_id: 'w1', label: 'superagent' }],
    workspaceCreate: async () => ({ workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' }),
    tabCreate: async o => { calls.push(`tabCreate ${o.label} ${JSON.stringify(o.env)}`); tabs += 1; return { tabId: `w1:t${tabs}`, paneId: `w1:p${tabs}` } },
    tabRename: async () => {},
    tabClose: async id => {
      calls.push(`tabClose ${id}`)
      for (const [name, agent] of agents) if (agent.pane_id.replace(/:p/, ':t') === id) agents.delete(name)
    },
    paneRun: async () => {},
    agentStart: async o => {
      calls.push(`agentStart ${o.name} ${o.args.join(' ')}`)
      const agent = { name: o.name, pane_id: o.pane, agent: 'pi', agent_status: 'idle' as const }
      agents.set(o.name, agent)
      return agent
    },
    agentGet: async name => agents.get(name),
    tabList: async () => [...agents.values()].map(a => ({
      tabId: a.pane_id.replace(/:p/, ':t'), label: a.name === 'superagent' ? 'engine' : `#1 · ${a.name}`,
      workspaceId: 'w1', agentStatus: a.agent_status,
    })),
    agentSendKeys: async (name, keys) => { calls.push(`sendKeys ${name} ${keys.join(' ')}`) },
    ...over,
  }
  return { herdr, agents, calls }
}

const ticket = { id: 'abcd1234ef', title: 'DO: rotate the keys', channels: [{ thread: '#7' }] } as never
const options = (dir: string, herdr: Herdr) => ({ herdr, stateDir: dir, log: openLog(dir), pollMs: 10, livenessMs: 20, lingerMs: 10 })

describe('herdr workers', () => {
  it('names a worker the way herdr requires, uniquely per launch', () => {
    expect(agentName('#159', '4f02aa')).toBe('sa-gh159-4f02')
    expect(agentName('#59', 'ab12cd')).toBe('sa-gh59-ab12')
    expect(agentName('#159', '4f02aa')).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
  })

  it('starts a worker as pi in its own tab, with the role and the bridge directory in its environment', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const session = await new HerdrWorkers(options(dir, m.herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    expect(m.calls[0]).toMatch(/^tabCreate #7 · DO: rotate the keys /)
    expect(m.calls[0]).toContain('"PI_SUPERAGENT_ROLE":"worker"')
    expect(m.calls[0]).toContain(`"PI_SUPERAGENT_WORKER_DIR":"${join(dir, 'workers', session.sessionId)}"`)
    expect(m.calls[1]).toBe(`agentStart ${agentName('#7', session.sessionId)} --session-id ${session.sessionId}`)
    expect(session.watch).toContain('superagent')
  })

  it('an input becomes a file in the inbox the worker drains, written whole', async () => {
    const dir = tmp()
    const session = await new HerdrWorkers(options(dir, memoryHerdr().herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    session.prompt('the brief', 'followUp')
    const inbox = join(dir, 'workers', session.sessionId, 'inbox')
    const [file] = readdirSync(inbox)
    expect(JSON.parse(readFileSync(join(inbox, file!), 'utf8'))).toEqual({ text: 'the brief', mode: 'followUp' })
  })

  it("a run the worker filed as a silent finish reaches the router as one, not as the worker's own report", async () => {
    const dir = tmp()
    const origins: string[] = []
    const session = await new HerdrWorkers(options(dir, memoryHerdr().herdr))
      .launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: (_s, _m, _q, origin) => origins.push(origin ?? 'none') })
    const off = session.subscribe(() => {})
    appendFileSync(join(dir, 'workers', session.sessionId, 'reports.jsonl'),
      '{"state":"blocked","summary":"need a key","question":"rotate prod too?"}\n{"state":"failed","summary":"no report","origin":"silent"}\n')
    await until(() => origins.length === 2)
    expect(origins).toEqual(['worker', 'silent'])
    off()
  })

  it('events and reports flow back, and a report is read once even across a takeover', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const workers = new HerdrWorkers(options(dir, m.herdr))
    const reports: string[] = []
    const session = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: (state, summary) => reports.push(`${state}: ${summary}`) })
    const events: WorkerEvent[] = []
    const off = session.subscribe(e => events.push(e))
    const bridge = join(dir, 'workers', session.sessionId)
    appendFileSync(join(bridge, 'events.jsonl'), '{"type":"turnStarted"}\n{"type":"activity"}\n')
    appendFileSync(join(bridge, 'reports.jsonl'), '{"state":"blocked","summary":"need a key","question":"rotate prod too?"}\n')
    await until(() => reports.length === 1 && events.length === 2)
    expect(events.map(e => e.type)).toEqual(['turnStarted', 'activity'])
    off()

    const record = await workers.find('abcd1234ef')
    expect(record?.sessionId).toBe(session.sessionId)
    const again: string[] = []
    const adopted = workers.attach(record!, (state, summary) => again.push(`${state}: ${summary}`))
    const stop = adopted.subscribe(() => {})
    appendFileSync(join(bridge, 'reports.jsonl'), '{"state":"ready","summary":"rotated"}\n')
    await until(() => again.length === 1)
    expect(again, 'the report from before the takeover is not replayed').toEqual(['ready: rotated'])
    stop()
  })

  it('a worker whose pi left its tab is reported failed, once', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const session = await new HerdrWorkers(options(dir, m.herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    const events: WorkerEvent[] = []
    const off = session.subscribe(e => events.push(e))
    m.agents.clear()
    await until(() => events.length > 0)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(events).toEqual([{ type: 'failed', error: expect.stringContaining('no longer running') }])
    off()
  })

  it('the record exists before pi starts, so a router that dies mid-launch leaves a findable worker', async () => {
    const dir = tmp()
    let seen = false
    const m = memoryHerdr({
      agentStart: async o => {
        seen = readdirSync(join(dir, 'workers')).some(id => existsSync(join(dir, 'workers', id, 'worker.json')))
        return { name: o.name, pane_id: o.pane, agent: 'pi', agent_status: 'idle' }
      },
    })
    await new HerdrWorkers(options(dir, m.herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    expect(seen).toBe(true)
  })

  it('a start that fails outright leaves no live record and no tab', async () => {
    const dir = tmp()
    const m = memoryHerdr({ agentStart: async () => { throw new HerdrError('spawn_failed', 'no pi on PATH') } })
    const workers = new HerdrWorkers(options(dir, m.herdr))
    await expect(workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })).rejects.toThrow(/no pi on PATH/)
    expect(m.calls.filter(c => c.startsWith('tabClose'))).toHaveLength(1)
    expect(await workers.retireOrphans(new Set())).toEqual([])
  })

  it("waits for a new tab's shell instead of failing the start", async () => {
    const dir = tmp()
    let busy = 2
    const m = memoryHerdr({
      agentStart: async o => {
        if (busy-- > 0) throw new HerdrError('agent_pane_busy', 'not an available shell')
        return { name: o.name, pane_id: o.pane, agent: 'pi', agent_status: 'idle' }
      },
    })
    const session = await new HerdrWorkers({ ...options(dir, m.herdr), shellWaitMs: 5 }).launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    expect(session.sessionId).toBeTruthy()
    expect(m.calls.some(c => c.startsWith('tabClose'))).toBe(false)
  })

  it('closes tabs no record owns, and leaves working agents and the engine alone', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const workers = new HerdrWorkers(options(dir, m.herdr))
    await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    m.agents.set('sa-old-1111', { name: 'sa-old-1111', pane_id: 'w1:p9', agent: 'pi', agent_status: 'idle' })
    m.agents.set('sa-busy-2222', { name: 'sa-busy-2222', pane_id: 'w1:p8', agent: 'pi', agent_status: 'working' })
    m.agents.set('superagent', { name: 'superagent', pane_id: 'w1:p7', agent: 'pi', agent_status: 'idle' })
    const dirB = join(dir, 'workers', 'sa-busy-2222')
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirB, 'worker.json'), JSON.stringify({
      dir: dirB, sessionId: 'busy', ticketId: 't-busy', agent: 'sa-busy-2222', tabId: 'w1:t8', paneId: 'w1:p8',
      workspace: '/w/busy', startedAt: new Date().toISOString(),
    }))
    const dirZ = join(dir, 'workers', 'sa-zombie-3333')
    mkdirSync(dirZ, { recursive: true })
    writeFileSync(join(dirZ, 'worker.json'), JSON.stringify({
      dir: dirZ, sessionId: 'zombie', ticketId: 't-zombie', agent: 'sa-zombie-3333', tabId: 'w1:t6', paneId: 'w1:p6',
      workspace: '/w/zombie', startedAt: new Date().toISOString(),
    }))
    m.agents.set('ghost', { name: 'ghost', pane_id: 'w1:p6', agent: 'pi', agent_status: 'unknown' })
    expect(await workers.closeStaleTabs('superagent')).toEqual(['w1:t9', 'w1:t6'])
    expect(m.calls.some(c => c.startsWith('tabClose w1:t9'))).toBe(true)
    expect(m.calls.some(c => c.includes('w1:t8') || c.includes('w1:t7'))).toBe(false)
  })

  it('a startup prompt is not a failed start: the worker exists and waits in its tab', async () => {
    const dir = tmp()
    const m = memoryHerdr({ agentStart: async () => { throw new HerdrError('agent_not_ready', 'blocked at startup') } })
    const session = await new HerdrWorkers(options(dir, m.herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    expect(session.sessionId).toBeTruthy()
    expect(m.calls.some(c => c.startsWith('tabClose'))).toBe(false)
  })

  it('a worker whose ticket ended while no router listened is interrupted and its tab closes', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const workers = new HerdrWorkers(options(dir, m.herdr))
    const kept = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    const retired = await workers.retireOrphans(new Set())
    expect(retired.map(r => r.sessionId)).toEqual([kept.sessionId])
    expect(m.calls).toContain(`sendKeys ${agentName('#7', kept.sessionId)} esc`)
    await until(() => m.calls.some(c => c.startsWith('tabClose')))
    expect(await workers.retireOrphans(new Set()), 'retired once').toEqual([])
    const adopted = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    expect(await workers.retireOrphans(new Set([adopted.sessionId])), 'a worker the router took over keeps running').toEqual([])
  })

  it('a close the previous router scheduled is not lost to a restart', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const before = new HerdrWorkers({ ...options(dir, m.herdr), lingerMs: 60_000 })
    const finished = await before.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    finished.dispose()
    expect(m.calls.some(c => c.startsWith('tabClose')), 'the router died inside the linger').toBe(false)
    const after = new HerdrWorkers({ ...options(dir, m.herdr), lingerMs: 0 })
    await after.retireOrphans(new Set())
    await until(() => m.calls.some(c => c.startsWith('tabClose')))
    expect(m.calls.filter(c => c.startsWith('tabClose'))).toEqual(['tabClose w1:t1'])
    await after.retireOrphans(new Set())
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(m.calls.filter(c => c.startsWith('tabClose')), 'settled once').toHaveLength(1)
  })

  it('a worker adopted between runs starts parked, so it holds no slot', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const workers = new HerdrWorkers(options(dir, m.herdr))
    const launched = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    const record = (await workers.find('abcd1234ef'))!
    const seen: string[] = []
    launched.subscribe(e => seen.push(`launched:${e.type}`))
    workers.attach(record, () => {}, { adopted: true }).subscribe(e => seen.push(`adopted:${e.type}`))
    await until(() => seen.includes('adopted:settled'))
    expect(seen, 'herdr says it is idle, so it starts parked').toContain('adopted:settled')
    expect(seen, 'only the adopted view asks herdr').not.toContain('launched:settled')
  })

  it('a tab kept for a busy agent is looked at again, and closes once the agent is idle', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const workers = new HerdrWorkers(options(dir, m.herdr))
    const busy = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    const agent = m.agents.get(agentName('#7', busy.sessionId))!
    agent.agent_status = 'working'
    busy.dispose()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(m.calls.filter(c => c.startsWith('tabClose')), 'kept while busy').toEqual([])
    agent.agent_status = 'idle'
    await until(() => m.calls.some(c => c.startsWith('tabClose')))
    expect(m.calls.filter(c => c.startsWith('tabClose'))).toEqual(['tabClose w1:t1'])
  })

  it('a finished worker tab closes only when its own pi sits idle in it', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const workers = new HerdrWorkers(options(dir, m.herdr))
    const idle = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    idle.dispose()
    await until(() => m.calls.some(c => c.startsWith('tabClose')))
    expect(m.calls.filter(c => c.startsWith('tabClose'))).toEqual(['tabClose w1:t1'])

    const busy = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    m.agents.get(agentName('#7', busy.sessionId))!.agent_status = 'working'
    busy.dispose()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(m.calls.filter(c => c.startsWith('tabClose')), 'the operator may be using it').toEqual(['tabClose w1:t1'])
  })
})
