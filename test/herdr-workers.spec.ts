import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { WorkerEvent } from '../src/pi/executor.ts'
import { HerdrError, type AgentInfo, type Herdr } from '../src/pi/herdr.ts'
import { agentName, HerdrWorkers, roleModule } from '../src/pi/herdr-workers.ts'
import { openLog } from '../src/pi/log.ts'
import { PERSON_FILE } from '../src/pi/worker-role.ts'

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
    paneRead: async () => '',
    ...over,
  }
  return { herdr, agents, calls }
}

const ticket = { id: 'abcd1234ef', title: 'DO: rotate the keys', channels: [{ thread: '#7' }] } as never
const options = (dir: string, herdr: Herdr) => ({ herdr, stateDir: dir, log: openLog(dir), pollMs: 10, livenessMs: 20, lingerMs: 10 })

describe('herdr workers', () => {
  it('closes a retired worker\'s tab at a busy agent, and never touches a live worker\'s', async () => {
    // Measured 2026-11-10: 18 of 32 worker tabs belonged to ended tickets, three of them a second agent still
    // working a ticket that had moved on. The keep-on-busy rule had no end, so retirement never finished.
    const dir = tmp()
    const m = memoryHerdr()
    const retiredDir = join(dir, 'workers', 'sa-old-1111')
    mkdirSync(retiredDir, { recursive: true })
    writeFileSync(join(retiredDir, 'worker.json'), JSON.stringify({
      dir: retiredDir, sessionId: 'old', ticketId: 't-old', agent: 'sa-old-1111', tabId: 'w1:t9', paneId: 'w1:p9',
      workspace: '/w/old', startedAt: new Date(Date.now() - 3.6e6).toISOString(),
      endedAt: new Date(Date.now() - 3.6e6).toISOString(),
    }))
    const liveDir = join(dir, 'workers', 'sa-live-5555')
    mkdirSync(liveDir, { recursive: true })
    writeFileSync(join(liveDir, 'worker.json'), JSON.stringify({
      dir: liveDir, sessionId: 'live', ticketId: 't-live', agent: 'sa-live-5555', tabId: 'w1:t7', paneId: 'w1:p7',
      workspace: '/w/live', startedAt: new Date(Date.now() - 3.6e6).toISOString(),
    }))
    m.agents.set('sa-old-1111', { name: 'sa-old-1111', pane_id: 'w1:p9', agent: 'pi', agent_status: 'working' })
    m.agents.set('sa-live-5555', { name: 'sa-live-5555', pane_id: 'w1:p7', agent: 'pi', agent_status: 'working' })
    const workers = new HerdrWorkers({ ...options(dir, m.herdr), retireGraceMs: 10, lingerMs: 10 })
    await workers.retireOrphans(new Set(['live']))
    await until(() => m.calls.includes('tabClose w1:t9'))
    expect(m.calls.filter(c => c === 'tabClose w1:t9'), 'the retired tab closes at a busy agent').toHaveLength(1)
    expect(m.calls, 'a worker this router adopted is never interrupted, busy or not').not.toContain('tabClose w1:t7')
  })

  it('a new worker for a ticket first ends the one still in its tab, scope and tab', async () => {
    // 2026-11-12, ticket 340: a released worker, kept busy by its own background task, worked the same checkout as the
    // worker launched after it.
    const m = memoryHerdr()
    const stopped: string[] = []
    const workers = new HerdrWorkers({ ...options(tmp(), m.herdr), lingerMs: 60_000, stopScope: id => { stopped.push(id) } })
    const first = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    first.dispose()
    for (const a of m.agents.values()) a.agent_status = 'working'
    const second = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    expect(stopped, 'the old worker\'s processes ended, background tasks included').toEqual([first.sessionId])
    const closed = m.calls.indexOf('tabClose w1:t1')
    const started = m.calls.findIndex(c => c.startsWith('agentStart') && c.includes(second.sessionId))
    expect(closed, 'its tab closed').toBeGreaterThan(-1)
    expect(closed, 'before the new worker started').toBeLessThan(started)
    expect([...m.agents.keys()].filter(n => n.startsWith('sa-')), 'one live worker on the ticket').toHaveLength(1)
  })

  it('a released worker whose pi died has its scope stopped, so the jobs it left run on for no one', async () => {
    // OOMPolicy=continue keeps a scope alive after its pi is the process killed, background jobs and all.
    const m = memoryHerdr()
    const stopped: string[] = []
    const workers = new HerdrWorkers({ ...options(tmp(), m.herdr), lingerMs: 10, stopScope: id => { stopped.push(id) } })
    const s = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    m.agents.clear()
    s.dispose()
    await until(() => stopped.length === 1)
    expect(stopped).toEqual([s.sessionId])
  })

  it('a released worker a background task keeps busy is closed after its bounded keep, scope included', async () => {
    const m = memoryHerdr()
    const stopped: string[] = []
    const workers = new HerdrWorkers({ ...options(tmp(), m.herdr), lingerMs: 10, retireGraceMs: 10, stopScope: id => { stopped.push(id) } })
    const s = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    for (const a of m.agents.values()) a.agent_status = 'working'
    s.dispose()
    await until(() => stopped.length === 1)
    expect(stopped).toEqual([s.sessionId])
    expect(m.calls, 'and its tab closed, busy or not').toContain('tabClose w1:t1')
  })

  it('a freed worker a person typed in is theirs: no release deadline while it works, and its tab closes once quiet', async () => {
    // 2026-11-12, ticket 340: the release deadline ended two freed workers mid-task, each running an instruction typed in its tab.
    const m = memoryHerdr()
    const stopped: string[] = []
    const stateDir = tmp()
    const workers = new HerdrWorkers({ ...options(stateDir, m.herdr), lingerMs: 10, retireGraceMs: 10, personLingerMs: 200, stopScope: id => { stopped.push(id) } })
    const s = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    for (const a of m.agents.values()) a.agent_status = 'working'
    s.dispose()
    writeFileSync(join(stateDir, 'workers', s.sessionId, PERSON_FILE), JSON.stringify({ at: new Date().toISOString() }))
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(stopped, 'working on the person\'s request, past the release deadline').toEqual([])
    expect(m.calls).not.toContain('tabClose w1:t1')
    for (const a of m.agents.values()) a.agent_status = 'idle'
    await until(() => stopped.length === 1)
    expect(stopped, 'quiet past its linger: closed').toEqual([s.sessionId])
    expect(m.calls).toContain('tabClose w1:t1')
  })

  it('a router restart leaves a freed tab its person is using, and closes one a person left long before its release', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const endedAt = Date.now() - 60_000
    const record = (id: string, tab: number, personAt: number) => {
      const at = join(dir, 'workers', id)
      mkdirSync(at, { recursive: true })
      writeFileSync(join(at, 'worker.json'), JSON.stringify({
        dir: at, sessionId: id, ticketId: `t-${id}`, agent: `sa-${id}`, tabId: `w1:t${tab}`, paneId: `w1:p${tab}`,
        workspace: `/w/${id}`, startedAt: new Date(endedAt - 7_200_000).toISOString(), endedAt: new Date(endedAt).toISOString(),
      }))
      writeFileSync(join(at, PERSON_FILE), JSON.stringify({ at: new Date(personAt).toISOString() }))
      m.agents.set(`sa-${id}`, { name: `sa-${id}`, pane_id: `w1:p${tab}`, agent: 'pi', agent_status: 'working' })
    }
    record('steered', 9, endedAt - 5)
    record('stale', 8, endedAt - 3_600_000)
    const workers = new HerdrWorkers({ ...options(dir, m.herdr), retireGraceMs: 10, lingerMs: 10 })
    await workers.retireOrphans(new Set())
    await until(() => m.calls.includes('tabClose w1:t8'))
    expect(m.calls, 'typed in an hour before its release: closed at a busy agent').toContain('tabClose w1:t8')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(m.calls, 'typed in just before its release, still working on it: kept').not.toContain('tabClose w1:t9')
  })

  it('the ticket\'s next work goes to the freed tab its person is using, and nothing said meanwhile is read', async () => {
    const m = memoryHerdr()
    const stopped: string[] = []
    const stateDir = tmp()
    const workers = new HerdrWorkers({ ...options(stateDir, m.herdr), lingerMs: 10, retireGraceMs: 10, personLingerMs: 30, stopScope: id => { stopped.push(id) } })
    const first = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    const dir = join(stateDir, 'workers', first.sessionId)
    first.dispose()
    for (const a of m.agents.values()) a.agent_status = 'working'
    writeFileSync(join(dir, PERSON_FILE), JSON.stringify({ at: new Date().toISOString() }))
    appendFileSync(join(dir, 'reports.jsonl'), `${JSON.stringify({ state: 'ready', summary: 'said in the tab while freed' })}\n`)
    const reports: string[] = []
    const second = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: (state, summary) => { reports.push(`${state}: ${summary}`) } })
    expect(second.sessionId, 'the same session takes the work').toBe(first.sessionId)
    expect(m.calls.filter(c => c.startsWith('agentStart')), 'no second worker on the checkout').toHaveLength(1)
    expect(stopped, 'and the person\'s session is not ended').toEqual([])
    second.subscribe(() => {})
    second.prompt('the brief', 'followUp')
    expect(readdirSync(join(dir, 'inbox')), 'the work lands in its inbox').toHaveLength(1)
    appendFileSync(join(dir, 'reports.jsonl'), `${JSON.stringify({ state: 'ready', summary: 'the new work' })}\n`)
    await until(() => reports.length > 0)
    expect(reports, 'only what it says after the resume is read').toEqual(['ready: the new work'])
    for (const a of m.agents.values()) a.agent_status = 'idle'
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(stopped, 'the first release\'s timers leave the resumed worker alone').toEqual([])
    expect(m.calls).not.toContain('tabClose w1:t1')
  })

  it('names a worker the way herdr requires, uniquely per launch', () => {
    expect(agentName('#159', '4f02aa')).toBe('sa-gh159-4f02')
    expect(agentName('#59', 'ab12cd')).toBe('sa-gh59-ab12')
    expect(agentName('#159', '4f02aa')).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
  })

  it('a router start forgets a worker directory 40 days old, and keeps a fresh one', async () => {
    // Measured 2026-11-07 audit: 120 directories in two days, every one of them read by every sweep, forever.
    const dir = tmp()
    const stamp = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
    const record = (id: string, days: number) => ({
      ticketId: 'T', sessionId: id, agent: `sa-${id}`, paneId: 'p', tabId: 't', workspace: '/w', dir: join(dir, 'workers', id),
      startedAt: stamp(days + 1), endedAt: stamp(days), tabSettledAt: stamp(days),
    })
    for (const [id, days] of [['aaaa1111', 40], ['bbbb2222', 2]] as const) {
      mkdirSync(join(dir, 'workers', id), { recursive: true })
      writeFileSync(join(dir, 'workers', id, 'worker.json'), JSON.stringify(record(id, days)))
    }
    await new HerdrWorkers(options(dir, memoryHerdr().herdr)).retireOrphans(new Set())
    expect(existsSync(join(dir, 'workers', 'aaaa1111')), 'the 40-day trail is gone').toBe(false)
    expect(existsSync(join(dir, 'workers', 'bbbb2222')), 'a month of trail is kept').toBe(true)
  })

  it('starts a worker as pi in its own tab, with the role and the bridge directory in its environment', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const session = await new HerdrWorkers(options(dir, m.herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: { GH_TOKEN: 'bot-token' }, report: () => {} })
    expect(m.calls[0]).toMatch(/^tabCreate #7 · DO: rotate the keys /)
    expect(m.calls[0]).toContain('"PI_SUPERAGENT_ROLE":"worker"')
    expect(m.calls[0]).toContain(`"PI_SUPERAGENT_WORKER_DIR":"${join(dir, 'workers', session.sessionId)}"`)
    expect(m.calls[0], 'the bot token the router named reaches the tab env')
      .toContain('"GH_TOKEN":"bot-token"')
    // The worker loads the operator's harness (operator, 2026-11-10: "agents should have all the power"): a
    // session with no context meter and no compaction skill packs up at a fraction of its window, and the fleet
    // read that as early termination. The bot's GH_TOKEN is named in the tab env at the launch site.
    // It must load this package's own entry: measured 2026-11-08, three prompts sat undrained in a worker's inbox and the pane never reported, because nothing in the pane read them.
    expect(m.calls[1]).toBe(`agentStart ${agentName('#7', session.sessionId)} --session-id ${session.sessionId} --extension ${roleModule}`)
    expect(session.watch).toContain('superagent')
  })

  it('gives pi two minutes to reach its prompt, and the setting overrides it', async () => {
    const seen: number[] = []
    for (const startTimeoutMs of [undefined, 45_000]) {
      const m = memoryHerdr()
      const start = m.herdr.agentStart
      m.herdr.agentStart = async o => { seen.push(o.timeoutMs); return start(o) }
      await new HerdrWorkers({ ...options(tmp(), m.herdr), ...(startTimeoutMs ? { startTimeoutMs } : {}) })
        .launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    }
    expect(seen).toEqual([120_000, 45_000])
  })

  it('a pi that dies at startup fails its launch in seconds, saying what the tab said', async () => {
    // 2026-11-10/11: every launch died in its first second on "Tool ticket_report conflicts", and the router waited
    // out herdr's whole start timeout on each one before reporting only "timed out waiting for agent startup".
    const m = memoryHerdr({
      agentStart: () => new Promise(() => {}),
      paneRead: async () => 'Error: Failed to load extension "/x/extension.ts": Tool "ticket_report" conflicts with /x/worker-extension.ts\n'
        + 'Hint: Start without extensions using "pi -ne".\n% ',
    })
    const started = Date.now()
    await expect(new HerdrWorkers({ ...options(tmp(), m.herdr), bootPollMs: 10 })
      .launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} }))
      .rejects.toThrow(/pi exited at startup: .*ticket_report" conflicts/)
    expect(Date.now() - started, 'seconds, not the start timeout').toBeLessThan(2000)
    expect(m.calls.some(c => c.startsWith('tabClose')), 'and its tab is closed').toBe(true)
  })

  it('a start that fails carries the tab\'s last words', async () => {
    const m = memoryHerdr({
      agentStart: async () => { throw new HerdrError('timeout', 'herdr agent start: timed out waiting for agent startup') },
      paneRead: async () => 'loading 23 extensions\nmcp: scout ready\nzsh: killed     pi\n',
    })
    await expect(new HerdrWorkers(options(tmp(), m.herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} }))
      .rejects.toThrow(/timed out waiting for agent startup; the tab said: .*zsh: killed/)
  })

  it('an input becomes a file in the inbox the worker drains, written whole', async () => {
    const dir = tmp()
    const session = await new HerdrWorkers(options(dir, memoryHerdr().herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    session.prompt('the brief', 'followUp')
    const inbox = join(dir, 'workers', session.sessionId, 'inbox')
    const [file] = readdirSync(inbox)
    expect(JSON.parse(readFileSync(join(inbox, file!), 'utf8'))).toEqual({ text: 'the brief', mode: 'followUp' })
  })

  it('a wake-up the worker set crosses the file bridge to the router', async () => {
    const dir = tmp()
    const wakes: Array<number | undefined> = []
    const session = await new HerdrWorkers(options(dir, memoryHerdr().herdr))
      .launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: (_s, _m, _q, _o, _p, wake) => { wakes.push(wake) } })
    const off = session.subscribe(() => {})
    appendFileSync(join(dir, 'workers', session.sessionId, 'reports.jsonl'),
      '{"state":"waiting","summary":"run 31 trains","wakeInMinutes":60}\n{"state":"ready","summary":"done"}\n')
    await until(() => wakes.length === 2)
    expect(wakes).toEqual([60, undefined])
    off()
  })

  it("a run the worker filed as a silent finish reaches the router as one, not as the worker's own report", async () => {
    const dir = tmp()
    const origins: string[] = []
    const session = await new HerdrWorkers(options(dir, memoryHerdr().herdr))
      .launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: (_s, _m, _q, origin) => { origins.push(origin ?? 'none') } })
    const off = session.subscribe(() => {})
    appendFileSync(join(dir, 'workers', session.sessionId, 'reports.jsonl'),
      '{"state":"blocked","summary":"need a key","question":"rotate prod too?"}\n{"state":"failed","summary":"no report","origin":"silent"}\n')
    await until(() => origins.length === 2)
    expect(origins).toEqual(['worker', 'silent'])
    off()
  })

  it('a report the engine refuses is skipped: the pump lives, the next report arrives, and a restart cannot replay it', async () => {
    // 2026-11-12: a ready report carrying a question threw out of this timer, killed the router, and its unsaved cursor
    // replayed it into every restart.
    const dir = tmp()
    const filed: string[] = []
    const session = await new HerdrWorkers(options(dir, memoryHerdr().herdr)).launch({ ticket, thread: '#7', workspace: '/w/7', env: {},
      report: (state, summary) => {
        if (state === 'ready' && summary === 'asks') throw new Error('A question for a person cannot also be a ready result')
        filed.push(summary)
      } })
    const off = session.subscribe(() => {})
    const bridge = join(dir, 'workers', session.sessionId)
    appendFileSync(join(bridge, 'reports.jsonl'),
      '{"state":"ready","summary":"asks","question":"approve?"}\n{"state":"blocked","summary":"asks properly","question":"approve?"}\n')
    await until(() => filed.length === 1)
    expect(filed).toEqual(['asks properly'])
    const saved = () => (JSON.parse(readFileSync(join(bridge, 'cursor.json'), 'utf8')) as { reports: number }).reports
    await until(() => existsSync(join(bridge, 'cursor.json')) && saved() > 0)
    expect(saved(), 'saved past both lines').toBe(statSync(join(bridge, 'reports.jsonl')).size)
    off()
  })

  it('events and reports flow back, and a report is read once even across a takeover', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const workers = new HerdrWorkers(options(dir, m.herdr))
    const reports: string[] = []
    const session = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: (state, summary) => { reports.push(`${state}: ${summary}`) } })
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
    const adopted = workers.attach(record!, (state, summary) => { again.push(`${state}: ${summary}`) })
    const stop = adopted.subscribe(() => {})
    appendFileSync(join(bridge, 'reports.jsonl'), '{"state":"ready","summary":"rotated"}\n')
    await until(() => again.length === 1)
    expect(again, 'the report from before the takeover is not replayed').toEqual(['ready: rotated'])
    stop()
  })

  it("a report's pull requests reach the router with it", async () => {
    const dir = tmp()
    const pulls: Array<readonly string[] | undefined> = []
    const session = await new HerdrWorkers(options(dir, memoryHerdr().herdr))
      .launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: (_s, _m, _q, _o, p) => { pulls.push(p) } })
    const stop = session.subscribe(() => {})
    appendFileSync(join(dir, 'workers', session.sessionId, 'reports.jsonl'),
      '{"state":"ready","summary":"opened it","pullRequests":["https://github.com/o/r/pull/9"]}\n{"state":"ready","summary":"no repo"}\n')
    await until(() => pulls.length === 2)
    expect(pulls).toEqual([['https://github.com/o/r/pull/9'], undefined])
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

  it("closes its own dead workers' tabs, and never a tab it has no record of: another router's worker may live there", async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const stopped: string[] = []
    const workers = new HerdrWorkers({ ...options(dir, m.herdr), stopScope: id => { stopped.push(id) } })
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
    expect(await workers.closeStaleTabs('superagent')).toEqual(['w1:t6'])
    expect(stopped, 'and what the dead pi left running in its scope').toEqual(['zombie'])
    expect(m.calls.some(c => c.includes('w1:t9')), 'no record here: a test router once killed every live worker this way').toBe(false)
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
    const before = new HerdrWorkers(options(dir, m.herdr))
    const kept = await before.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    const adopted = await before.launch({ ticket: { ...(ticket as object), id: 'T8' } as typeof ticket, thread: '#8', workspace: '/w/8', env: {}, report: () => {} })
    await new Promise(resolve => setTimeout(resolve, 5))
    const workers = new HerdrWorkers(options(dir, m.herdr))
    const retired = await workers.retireOrphans(new Set([adopted.sessionId]))
    expect(retired.map(r => r.sessionId), 'a worker the router took over keeps running').toEqual([kept.sessionId])
    expect(m.calls).toContain(`sendKeys ${agentName('#7', kept.sessionId)} esc`)
    await until(() => m.calls.some(c => c.startsWith('tabClose')))
    expect(await workers.retireOrphans(new Set([adopted.sessionId])), 'retired once').toEqual([])
  })

  it('a worker this router launched is never its orphan, however early the sweep runs', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const workers = new HerdrWorkers(options(dir, m.herdr))
    // Recovery relaunches a lost worker, then sweeps before that launch is adopted: the sweep used to interrupt it.
    const fresh = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    expect(await workers.retireOrphans(new Set())).toEqual([])
    expect(m.calls).not.toContain(`sendKeys ${agentName('#7', fresh.sessionId)} esc`)
  })

  it('an orphan the startup sweep retires closes within the retire grace, busy or not', async () => {
    const dir = tmp()
    const m = memoryHerdr()
    const stopped: string[] = []
    const before = new HerdrWorkers(options(dir, m.herdr))
    const orphan = await before.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    for (const a of m.agents.values()) a.agent_status = 'working'
    await new Promise(resolve => setTimeout(resolve, 5))
    const workers = new HerdrWorkers({ ...options(dir, m.herdr), lingerMs: 60_000, retireGraceMs: 10, stopScope: id => { stopped.push(id) } })
    expect((await workers.retireOrphans(new Set())).map(r => r.sessionId)).toEqual([orphan.sessionId])
    await until(() => stopped.length > 0, 1000)
    expect(stopped, 'ended at the grace, not after a ten-minute linger').toEqual([orphan.sessionId])
  })

  it('a release this router made keeps its full linger, however late the startup sweep runs', async () => {
    // 2026-11-12: the first sweep after a restart ran 5 s after a worker's report and closed its tab 60 s later.
    const m = memoryHerdr()
    const workers = new HerdrWorkers({ ...options(tmp(), m.herdr), lingerMs: 2000, retireGraceMs: 10 })
    const s = await workers.launch({ ticket, thread: '#7', workspace: '/w/7', env: {}, report: () => {} })
    s.dispose()
    await workers.retireOrphans(new Set())
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(m.calls, 'inside its linger the tab stays').not.toContain('tabClose w1:t1')
    await until(() => m.calls.includes('tabClose w1:t1'), 6000)
    expect(m.calls, 'and closes when the linger ends').toContain('tabClose w1:t1')
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
