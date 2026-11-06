/** Workers as real pi sessions in herdr tabs, reached through files because each outlives the router's process. */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ticket } from '../core/index.ts'
import type { WorkerEvent, WorkerSession } from './executor.ts'
import { HerdrError, type AgentInfo, type Herdr } from './herdr.ts'
import type { EngineLog } from './log.ts'
import type { Reporter } from './report-tool.ts'

export interface WorkerRecord {
  ticketId: string
  sessionId: string
  agent: string
  paneId: string
  tabId: string
  workspace: string
  dir: string
  startedAt: string
  endedAt?: string
  /** When the router last decided about the tab: closed, or kept because someone was using it. */
  tabSettledAt?: string
}

export interface HerdrWorkersOptions {
  herdr: Herdr
  stateDir: string
  log: EngineLog
  workspaceLabel?: string
  pollMs?: number
  livenessMs?: number
  lingerMs?: number
  startTimeoutMs?: number
  shellWaitMs?: number
}

/** herdr agent names are `[a-z][a-z0-9_-]{0,31}` and unique among live agents, so each launch gets its own. */
export const agentName = (thread: string, sessionId: string): string =>
  `sa-${thread.replace(/^card:/, '').replace(/^#/, 'gh').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 22) || 'worker'}-${sessionId.slice(0, 4)}`

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export class HerdrWorkers {
  private workspaceId: string | undefined
  private readonly root: string

  constructor(private readonly options: HerdrWorkersOptions) {
    this.root = join(options.stateDir, 'workers')
  }

  async launch(input: { ticket: Ticket; thread: string; workspace: string; env: Record<string, string>; report: Reporter }): Promise<WorkerSession> {
    const { herdr, log } = this.options
    const sessionId = randomUUID()
    const dir = join(this.root, sessionId)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    const workspace = await this.workspace()
    // The record comes first: a sweep landing between tabCreate and the record write would find a
    // labelled tab that no record owns, and close it under the starting worker.
    writeFileSync(join(dir, 'worker.json'), JSON.stringify({ sessionId, ticketId: input.ticket.id, agent: '', tabId: '', paneId: '', workspace: input.workspace, startedAt: new Date().toISOString() }, null, 2))
    const tab = await herdr.tabCreate({
      workspace, cwd: input.workspace, label: `${input.thread} · ${input.ticket.title}`.slice(0, 60),
      env: { ...input.env, PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir, PI_SUPERAGENT_WORKSPACE: input.workspace },
    })
    const name = agentName(input.thread, sessionId)
    // Written before pi starts: a router that dies mid-launch otherwise leaves a pi no later router can find.
    const record: WorkerRecord = {
      ticketId: input.ticket.id, sessionId, agent: name, paneId: tab.paneId, tabId: tab.tabId,
      workspace: input.workspace, dir, startedAt: new Date().toISOString(),
    }
    writeFileSync(join(dir, 'worker.json'), JSON.stringify(record, null, 2))
    try {
      const agent = await this.startWhenShellReady(name, tab.paneId, sessionId)
      if (agent.pane_id && agent.pane_id !== record.paneId) {
        record.paneId = agent.pane_id
        writeFileSync(join(dir, 'worker.json'), JSON.stringify(record, null, 2))
      }
    } catch (error) {
      // Started but waiting on a startup prompt: the worker exists, and the operator answers it in its tab.
      if (!(error instanceof HerdrError && error.code === 'agent_not_ready')) {
        await herdr.tabClose(tab.tabId).catch(() => {})
        record.endedAt = record.tabSettledAt = new Date().toISOString()
        writeFileSync(join(dir, 'worker.json'), JSON.stringify(record, null, 2))
        throw error
      }
      log.line('warn', 'worker.start_blocked', { ticket: input.ticket.id, agent: name, tab: tab.tabId })
    }
    log.line('info', 'worker.started', { ticket: input.ticket.id, agent: name, tab: tab.tabId, session: sessionId })
    return this.attach(record, input.report)
  }

  // A new tab's shell takes a moment to reach its prompt, and herdr starts an agent only at a prompt.
  private async startWhenShellReady(name: string, pane: string, sessionId: string): Promise<AgentInfo> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.options.herdr.agentStart({
          name, kind: 'pi', pane, timeoutMs: this.options.startTimeoutMs ?? 120_000, args: ['--session-id', sessionId],
        })
      } catch (error) {
        if (!(error instanceof HerdrError && error.code === 'agent_pane_busy') || attempt >= 30) throw error
        await new Promise(resolve => setTimeout(resolve, this.options.shellWaitMs ?? 1000))
      }
    }
  }

  async find(ticketId: string): Promise<WorkerRecord | undefined> {
    for (const record of this.records().filter(r => r.ticketId === ticketId)) {
      if (await this.inTab(record)) return record
    }
    return undefined
  }

  /** Every worker this router did not take over: its ticket ended, or moved on to a newer worker, while no
   *  router was listening. Interrupt each, and let its tab close. */
  async retireOrphans(adopted: ReadonlySet<string>): Promise<WorkerRecord[]> {
    const retired: WorkerRecord[] = []
    for (const record of this.records().filter(r => !adopted.has(r.sessionId))) {
      if (!(await this.inTab(record))) continue
      const session = this.attach(record, () => {})
      session.abort()
      session.dispose()
      retired.push(record)
    }
    // Close timers die with the process, and a tab kept for a busy agent needs another look: re-check every open one.
    const linger = this.options.lingerMs ?? 600_000
    const open = new Set((await this.options.herdr.tabList().catch(() => [])).map(tab => tab.tabId))
    for (const record of this.records(true).filter(r => r.endedAt && open.has(r.tabId) && !retired.includes(r))) {
      const wait = Math.max(0, Date.parse(record.endedAt!) + linger - Date.now())
      setTimeout(() => { void this.closeIfIdle(record) }, wait).unref()
    }
    return retired
  }

  /** Tabs of this router's dead workers outlive their purpose. A tab is closed only when one of this state
   *  directory's records owns it and herdr no longer knows its agent: a tab with no record here may belong to
   *  another router sharing the workspace, and closing those killed every live worker whenever one started. */
  async closeStaleTabs(workspaceLabel: string): Promise<string[]> {
    const ws = (await this.options.herdr.workspaces()).find(w => w.label === workspaceLabel)?.workspace_id
    if (!ws) return []
    const records = [...this.records(false), ...this.records(true)]
    const closed: string[] = []
    for (const tab of await this.options.herdr.tabList().catch(() => [])) {
      if (tab.workspaceId !== ws || !tab.label.includes(' · ')) continue
      // A tab is kept only for an agent herdr answers for: working, idle, anything with a name. An agent it
      // no longer knows (`agent_not_found`) is a dead pi, and its record — live only because no one retired
      // it — is a zombie. Tab goes, record stays for the audit.
      const owner = records.find(r => r.tabId === tab.tabId)
      if (!owner) continue
      const live = await this.options.herdr.agentGet(owner.agent)
        .then(a => a !== undefined)
        .catch(e => !(e instanceof HerdrError && e.code === 'agent_not_found'))
      if (live) continue
      await this.options.herdr.tabClose(tab.tabId).catch(() => {})
      closed.push(tab.tabId)
    }
    return closed
  }

  private records(ended = false): WorkerRecord[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .map(id => join(this.root, id, 'worker.json'))
      .filter(file => existsSync(file))
      // A crash mid-write leaves half-written JSON; one bad file must not wedge every sweep forever.
      .map(file => { try { return JSON.parse(readFileSync(file, 'utf8')) as WorkerRecord } catch { this.options.log.line('warn', 'worker.record_unreadable', { file }); return null } })
      .filter((r): r is WorkerRecord => r !== null)
      .filter(r => ended ? Boolean(r.endedAt) : !r.endedAt)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  private async inTab(record: WorkerRecord): Promise<boolean> {
    const agent = await this.options.herdr.agentGet(record.agent).catch(() => undefined)
    return agent?.pane_id === record.paneId
  }

  attach(record: WorkerRecord, report: Reporter, { adopted = false }: { adopted?: boolean } = {}): WorkerSession {
    const { herdr, log } = this.options
    const cursorFile = join(record.dir, 'cursor.json')
    const cursor = existsSync(cursorFile)
      ? JSON.parse(readFileSync(cursorFile, 'utf8')) as { events: number; reports: number }
      : { events: 0, reports: 0 }
    let listener: ((event: WorkerEvent) => void) | undefined
    let failedSaid = false
    let seq = 0
    const timers: NodeJS.Timeout[] = []

    // Whole lines only: the worker may be mid-write.
    const fresh = (file: string, key: 'events' | 'reports'): Array<Record<string, unknown>> => {
      const path = join(record.dir, file)
      if (!existsSync(path)) return []
      const size = statSync(path).size
      if (size <= cursor[key]) return []
      const buffer = Buffer.alloc(size - cursor[key])
      const fd = openSync(path, 'r')
      try { readSync(fd, buffer, 0, buffer.length, cursor[key]) } finally { closeSync(fd) }
      const end = buffer.lastIndexOf(0x0a)
      if (end < 0) return []
      cursor[key] += end + 1
      return buffer.subarray(0, end).toString('utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
      })
    }
    const pump = (): void => {
      const before = `${cursor.events}/${cursor.reports}`
      for (const event of fresh('events.jsonl', 'events')) {
        if (event.type === 'turnStarted' || event.type === 'settled' || event.type === 'activity') listener?.({ type: event.type })
        else if (event.type === 'inbox_error') log.line('warn', 'worker.inbox_error', { agent: record.agent, error: String(event.error) })
      }
      for (const r of fresh('reports.jsonl', 'reports')) {
        const pulls = Array.isArray(r.pullRequests) ? r.pullRequests.filter((p): p is string => typeof p === 'string') : []
        report(String(r.state), String(r.summary), typeof r.question === 'string' ? r.question : null, r.origin === 'silent' ? 'silent' : 'worker',
          pulls.length ? pulls : undefined)
      }
      if (`${cursor.events}/${cursor.reports}` !== before) writeFileSync(cursorFile, JSON.stringify(cursor))
    }
    const alive = async (): Promise<void> => {
      try {
        const agent = await herdr.agentGet(record.agent)
        if (agent?.pane_id === record.paneId || failedSaid) return
        failedSaid = true
        listener?.({ type: 'failed', error: `its pi is no longer running in herdr tab ${record.tabId}` })
      } catch (error) {
        log.line('warn', 'worker.liveness_unknown', { agent: record.agent, error: String(error).slice(0, 160) })
      }
    }
    const stopTimers = (): void => { for (const t of timers.splice(0)) clearInterval(t) }

    return {
      sessionId: record.sessionId,
      workspace: record.workspace,
      watch: `herdr ${this.options.workspaceLabel ?? 'superagent'} › ${record.agent}`,
      prompt: (body, mode) => {
        const name = `${Date.now()}-${String(seq++).padStart(4, '0')}.json`
        writeFileSync(join(record.dir, `.${name}`), JSON.stringify({ text: body, mode }))
        renameSync(join(record.dir, `.${name}`), join(record.dir, 'inbox', name))
      },
      subscribe: next => {
        listener = next
        const pumping = setInterval(pump, this.options.pollMs ?? 1000)
        const watching = setInterval(() => { void alive() }, this.options.livenessMs ?? 15_000)
        pumping.unref()
        watching.unref()
        timers.push(pumping, watching)
        pump()
        // An adopted worker between runs sends nothing until its next one: ask herdr whether it is idle now.
        if (adopted) {
          void herdr.agentGet(record.agent).then(agent => {
            if (agent?.pane_id === record.paneId && ['idle', 'done'].includes(agent.agent_status)) listener?.({ type: 'settled' })
          }).catch(() => {})
        }
        return () => { stopTimers(); listener = undefined }
      },
      abort: () => { void herdr.agentSendKeys(record.agent, ['esc']).catch(() => {}) },
      dispose: () => {
        stopTimers()
        record.endedAt = new Date().toISOString()
        writeFileSync(join(record.dir, 'worker.json'), JSON.stringify(record, null, 2))
        setTimeout(() => { void this.closeIfIdle(record) }, this.options.lingerMs ?? 600_000).unref()
      },
    }
  }

  // herdr has no guarded close: re-check the recorded occupant is idle right before closing, else keep the tab.
  private async closeIfIdle(record: WorkerRecord): Promise<void> {
    const agent = await this.options.herdr.agentGet(record.agent).catch(() => undefined)
    const settle = (): void => {
      record.tabSettledAt = new Date().toISOString()
      writeFileSync(join(record.dir, 'worker.json'), JSON.stringify(record, null, 2))
    }
    if (agent?.pane_id === record.paneId && !['idle', 'done'].includes(agent.agent_status)) {
      // Still busy, whoever drives it: look again after another linger rather than keep the tab forever.
      this.options.log.line('info', 'worker.tab_kept', { agent: record.agent, tab: record.tabId, status: agent.agent_status })
      setTimeout(() => { void this.closeIfIdle(record) }, this.options.lingerMs ?? 600_000).unref()
      return
    }
    if (agent?.pane_id !== record.paneId) {
      this.options.log.line('info', 'worker.tab_kept', { agent: record.agent, tab: record.tabId, status: 'gone' })
      settle()
      return
    }
    await this.options.herdr.tabClose(record.tabId)
      .then(() => { settle(); this.options.log.line('info', 'worker.tab_closed', { agent: record.agent, tab: record.tabId }) })
      .catch((error: unknown) => this.options.log.line('warn', 'worker.tab_close_failed', { tab: record.tabId, error: String(error).slice(0, 160) }))
  }

  private async workspace(): Promise<string> {
    const { herdr, stateDir } = this.options
    const label = this.options.workspaceLabel ?? 'superagent'
    const list = await herdr.workspaces()
    const found = list.find(w => w.workspace_id === this.workspaceId) ?? list.find(w => w.label === label)
    if (found) return (this.workspaceId = found.workspace_id)
    const created = await herdr.workspaceCreate({ label, cwd: stateDir })
    await herdr.tabRename(created.tabId, 'engine log').catch(() => {})
    await herdr.paneRun(created.paneId, `tail -n 40 -F ${quote(join(stateDir, 'engine.log'))}`).catch(() => {})
    return (this.workspaceId = created.workspaceId)
  }
}
