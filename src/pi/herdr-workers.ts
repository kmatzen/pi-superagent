/** Workers as real pi sessions in herdr tabs, reached through files because each outlives the router's process. */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stopWorkerScope } from './worker-limits.ts'
import { PERSON_FILE } from './worker-role.ts'
import { fileURLToPath } from 'node:url'
import type { Ticket } from '../core/index.ts'
import type { WorkerEvent, WorkerSession } from './executor.ts'
import { HerdrError, type AgentInfo, type Herdr } from './herdr.ts'
import type { EngineLog } from './log.ts'
import type { Reporter } from './report-tool.ts'

// The pane runs this package's own entry, which activates the worker role from PI_SUPERAGENT_ROLE.
export const roleModule = fileURLToPath(new URL('./worker-extension.ts', import.meta.url))

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

/** How many bounded keeps a retired tab gets before the sweep closes it at a busy agent. */
const RETIRE_CLOSE_TRIES = 3

export interface HerdrWorkersOptions {
  herdr: Herdr
  stateDir: string
  log: EngineLog
  workspaceLabel?: string
  pollMs?: number
  livenessMs?: number
  lingerMs?: number
  /** How long a retired worker's agent gets to wind down before its tab closes at a busy agent. */
  retireGraceMs?: number
  /** How long a freed tab a person typed in stays open once it falls quiet. */
  personLingerMs?: number
  /** Ends a worker's processes, background tasks included; defaults to stopping its systemd scope. */
  stopScope?: (sessionId: string) => void
  startTimeoutMs?: number
  shellWaitMs?: number
  /** How often a starting worker's tab is read for a pi that died at boot. */
  bootPollMs?: number
}

/** What a pi prints when it dies at startup, before its shell prompt comes back. */
const BOOT_FAILED = /Failed to load extension|Hint: Start without extensions|command not found: pi\b|Cannot find module/
/** The tab's last few non-empty lines, short enough to ride in a failure message on the issue. */
const lastWords = (text: string): string =>
  text.split('\n').map(line => line.trim()).filter(Boolean).slice(-4).join(' | ').slice(-400)

/** herdr agent names are `[a-z][a-z0-9_-]{0,31}` and unique among live agents, so each launch gets its own. */
export const agentName = (thread: string, sessionId: string): string =>
  `sa-${thread.replace(/^card:/, '').replace(/^#/, 'gh').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 22) || 'worker'}-${sessionId.slice(0, 4)}`

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** A cursor the disk truncated must not kill the router: on 2026-11-17 a full disk left a 0-byte `cursor.json`
 *  and every restart died in this `JSON.parse` for 8 hours. An unreadable cursor reads as end-of-log, which is
 *  what `resume` writes for the same reason — what the last assignment said must not settle the new one. */
const readCursor = (dir: string): { events: number; reports: number; rebuilt: boolean } => {
  try {
    const c = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8')) as Record<string, unknown>
    if (typeof c.events === 'number' && typeof c.reports === 'number') return { events: c.events, reports: c.reports, rebuilt: false }
  } catch { /* the disk decided this, not the fleet */ }
  const size = (name: string): number => { try { return statSync(join(dir, name)).size } catch { return 0 } }
  return { events: size('events.jsonl'), reports: size('reports.jsonl'), rebuilt: true }
}

export class HerdrWorkers {
  private workspaceId: string | undefined
  private readonly root: string
  private readonly born = Date.now()
  /** Workers this process released, whose own linger timers are running: by identity, since a clock cannot tell a
   *  release in this router's first millisecond from one the previous router made. */
  private readonly releasedHere = new Set<string>()

  constructor(private readonly options: HerdrWorkersOptions) {
    this.root = join(options.stateDir, 'workers')
  }

  async launch(input: { ticket: Ticket; thread: string; workspace: string; env: Record<string, string>; report: Reporter }): Promise<WorkerSession> {
    const { herdr, log } = this.options
    // One live worker per ticket. A released worker kept its tab while a background task kept it busy, woke on its
    // own, and worked the same checkout as the worker launched after it (2026-11-12, ticket 340).
    let resumable: WorkerRecord | undefined
    for (const old of [...this.records(), ...this.records(true)].filter(r => r.ticketId === input.ticket.id)) {
      if (!(await this.inTab(old))) continue
      // Ending it would end the person's session too: the ticket's next work goes to it instead.
      if (!resumable && old.endedAt && !old.tabSettledAt && this.held(old)) { resumable = old; continue }
      log.line('warn', 'worker.superseded', { ticket: input.ticket.id, agent: old.agent, tab: old.tabId })
      await this.end(old)
    }
    if (resumable) return this.resume(resumable, input.report)
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
        // The tab's last words are the cause: "timed out waiting for agent startup" alone sent a whole night's
        // diagnosis the wrong way (2026-11-10/11), while the tab said "Tool ticket_report conflicts".
        const said = error instanceof HerdrError && error.code === 'agent_boot_failed'
          ? '' : lastWords(await herdr.paneRead(tab.paneId, 20).catch(() => ''))
        await herdr.tabClose(tab.tabId).catch(() => {})
        record.endedAt = record.tabSettledAt = new Date().toISOString()
        writeFileSync(join(dir, 'worker.json'), JSON.stringify(record, null, 2))
        throw said ? new Error(`${error instanceof Error ? error.message : String(error)}; the tab said: ${said}`) : error
      }
      log.line('warn', 'worker.start_blocked', { ticket: input.ticket.id, agent: name, tab: tab.tabId })
    }
    log.line('info', 'worker.started', { ticket: input.ticket.id, agent: name, tab: tab.tabId, session: sessionId })
    return this.attach(record, input.report)
  }

  // A new tab's shell takes a moment to reach its prompt, and herdr starts an agent only at a prompt.
  private async startWhenShellReady(name: string, pane: string, sessionId: string): Promise<AgentInfo> {
    for (let attempt = 0; ; attempt++) {
      const watch = this.bootWatch(pane)
      try {
        return await Promise.race([watch.failed, this.options.herdr.agentStart({
          // The worker loads the operator's harness on purpose (operator, 2026-11-10: "agents should have all
          // the power"). Measured the same day, the cost of the old `--no-extensions`: a worker had no context
          // meter and no compaction affordance, so it packed up at a fraction of its window and the fleet read
          // that as early termination. The role module rides alongside, and the bot's token file is named in the
          // tab env at the launch site, not inherited.
          // 2 min vs a measured ~8 s full-harness boot; a launch that never starts holds the serial queue this long. A pi
          // that dies at boot (2026-11-11: a duplicate ticket_report) is a crash to fix, not a reason to raise this.
          name, kind: 'pi', pane, timeoutMs: this.options.startTimeoutMs ?? 120_000,
          args: ['--session-id', sessionId, '--extension', roleModule],
        })])
      } catch (error) {
        if (!(error instanceof HerdrError && error.code === 'agent_pane_busy') || attempt >= 30) throw error
        await new Promise(resolve => setTimeout(resolve, this.options.shellWaitMs ?? 1000))
      } finally {
        watch.stop()
      }
    }
  }

  /** Rejects as soon as the tab shows a pi that died at startup, rather than after herdr's whole start timeout. */
  private bootWatch(pane: string): { failed: Promise<never>; stop: () => void } {
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    const every = this.options.bootPollMs ?? 2000
    const failed = new Promise<never>((_, reject) => {
      const look = async (): Promise<void> => {
        const text = await this.options.herdr.paneRead(pane, 20).catch(() => '')
        if (stopped) return
        if (BOOT_FAILED.test(text)) { reject(new HerdrError('agent_boot_failed', `pi exited at startup: ${lastWords(text)}`)); return }
        timer = setTimeout(() => { void look() }, every)
        timer.unref?.()
      }
      timer = setTimeout(() => { void look() }, every)
      timer.unref?.()
    })
    failed.catch(() => {})
    return { failed, stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
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
    this.prune()
    const retired: WorkerRecord[] = []
    // A record this process wrote is no orphan: recovery relaunches workers before it sweeps, and a launch still in
    // flight is not adopted yet, so the sweep interrupted fresh workers and marked them ended.
    for (const record of this.records().filter(r => !adopted.has(r.sessionId) && Date.parse(r.startedAt) < this.born)) {
      if (!(await this.inTab(record))) continue
      const session = this.attach(record, () => {})
      session.abort()
      session.dispose()
      retired.push(record)
    }
    // Close timers die with the process, and a tab kept for a busy agent needs another look: re-check every open one.
    // A retired worker is work the engine has decided it does not want, and it held its tab open forever while
    // its agent stayed busy: measured 2026-11-10, 18 of 32 tabs belonged to ended tickets, three of them a second
    // agent on a ticket that had moved on. The interrupt above asks; a bounded grace then closes, even at a busy one.
    const retireGraceMs = this.options.retireGraceMs ?? 60_000
    const open = new Set((await this.options.herdr.tabList().catch(() => [])).map(tab => tab.tabId))
    // This router's own releases keep their own linger: run after a fresh release, this sweep closed a tab 65 s after
    // its worker's report (2026-11-12). The grace is for closes the previous router owed and the orphans retired above.
    const retiredIds = new Set(retired.map(r => r.sessionId))
    for (const record of this.records(true).filter(r => r.endedAt && open.has(r.tabId)
      && (!this.releasedHere.has(r.sessionId) || retiredIds.has(r.sessionId)))) {
      // A close the previous router owed is not lost to the restart: schedule it when it is due, and never later
      // than the retire grace, which is the budget that ends a busy agent's keep.
      const due = Math.max(0, Date.parse(record.endedAt!) + (this.options.lingerMs ?? 600_000) - Date.now())
      const delay = Math.min(due, retireGraceMs)
      setTimeout(() => { void this.closeIfIdle(record, retireGraceMs, RETIRE_CLOSE_TRIES) }, delay).unref()
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
      ;(this.options.stopScope ?? stopWorkerScope)(owner.sessionId)
      await this.options.herdr.tabClose(tab.tabId).catch(() => {})
      closed.push(tab.tabId)
    }
    return closed
  }

  /**
   * A worker's files are the audit trail for its ticket, for a while. Kept forever they grew by ~60 directories
   * a day, and every sweep reads every one of them, so the price of the trail landed on each router start.
   */
  private prune(olderThanMs = 30 * 86_400_000): void {
    const cutoff = Date.now() - olderThanMs
    if (!existsSync(this.root)) return
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(this.root, entry.name)
      let record: WorkerRecord | undefined
      try { record = JSON.parse(readFileSync(join(dir, 'worker.json'), 'utf8')) as WorkerRecord } catch { continue }
      // Both stamps: a worker the router stopped with its tab still open is not finished being auditable.
      if (!record.endedAt || !record.tabSettledAt || Date.parse(record.endedAt) > cutoff) continue
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Tickets with a worker record that has not ended, tracked by this router or not: a disk sweep must not pull a
   *  checkout out from under any of them. */
  openTickets(): Set<string> { return new Set(this.records().map(r => r.ticketId)) }

  /** Tickets whose agent herdr reports working now; an unreadable herdr answers every open record, the safe side. */
  async workingTickets(): Promise<Set<string>> {
    const records = this.records()
    try {
      const working = new Set((await this.options.herdr.tabList()).filter(t => t.agentStatus === 'working').map(t => t.tabId))
      return new Set(records.filter(r => working.has(r.tabId)).map(r => r.ticketId))
    } catch { return new Set(records.map(r => r.ticketId)) }
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
    const cursor = existsSync(cursorFile) ? readCursor(record.dir) : { events: 0, reports: 0, rebuilt: false }
    if (cursor.rebuilt) log.line('warn', 'worker.cursor_rebuilt', { ticket: record.ticketId, dir: record.dir })
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
        else if (event.type === 'input_read' && typeof event.name === 'string') listener?.({ type: 'inputRead', name: event.name })
        else if (event.type === 'inbox_error') log.line('warn', 'worker.inbox_error', { agent: record.agent, error: String(event.error) })
      }
      for (const r of fresh('reports.jsonl', 'reports')) {
        const pulls = Array.isArray(r.pullRequests) ? r.pullRequests.filter((p): p is string => typeof p === 'string') : []
        // A report the engine refuses is the worker's mistake and already logged as dropped. Thrown from this timer it
        // killed the router, and the unsaved cursor replayed it into every restart (2026-11-12: a ready with a question).
        try {
          report(String(r.state), String(r.summary), typeof r.question === 'string' ? r.question : null, r.origin === 'silent' ? 'silent' : 'worker',
            pulls.length ? pulls : undefined, typeof r.wakeInMinutes === 'number' ? r.wakeInMinutes : undefined,
            typeof r.notes === 'string' ? r.notes : undefined)
        } catch (error) {
          log.line('warn', 'worker.report_refused', { agent: record.agent, error: String(error).slice(0, 200) })
        }
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
        return name
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
        this.releasedHere.add(record.sessionId)
        record.endedAt = new Date().toISOString()
        writeFileSync(join(record.dir, 'worker.json'), JSON.stringify(record, null, 2))
        setTimeout(() => { void this.closeIfIdle(record) }, this.options.lingerMs ?? 600_000).unref()
        // The keep waits for idle, and a background task kept a released worker busy forever (2026-11-12): past the
        // deadline it ends, scope and tab, busy or not.
        setTimeout(() => { void this.endIfStill(record) },
          (this.options.lingerMs ?? 600_000) + RETIRE_CLOSE_TRIES * (this.options.retireGraceMs ?? 60_000)).unref()
      },
    }
  }

  private async endIfStill(record: WorkerRecord): Promise<void> {
    if (record.tabSettledAt || !this.stillReleased(record) || this.held(record) || !(await this.inTab(record))) return
    this.options.log.line('info', 'worker.tab_closed_busy', { agent: record.agent, tab: record.tabId, ticket: record.ticketId, after: 'release deadline' })
    await this.end(record)
  }

  /** A freed tab a person typed in, shortly before its release or since, is theirs: the release deadline ended two
   *  mid-task on 2026-11-12 (ticket 340), each running an instruction typed in its tab. */
  private held(record: WorkerRecord): boolean {
    if (!record.endedAt) return false
    const at = this.personAt(record)
    return at !== undefined && at > Date.parse(record.endedAt) - (this.options.lingerMs ?? 600_000)
  }

  private personAt(record: WorkerRecord): number | undefined {
    try {
      const at = Date.parse((JSON.parse(readFileSync(join(record.dir, PERSON_FILE), 'utf8')) as { at?: string }).at ?? '')
      return Number.isNaN(at) ? undefined : at
    } catch { return undefined }
  }

  private lastTouch(record: WorkerRecord): number {
    let events = 0
    try { events = statSync(join(record.dir, 'events.jsonl')).mtimeMs } catch { /* no events yet */ }
    return Math.max(this.personAt(record) ?? 0, events, Date.parse(record.endedAt ?? '') || 0)
  }

  /** A release's timers stop once the tab is settled, or a launch gave the record work again or freed it anew. */
  private stillReleased(record: WorkerRecord): boolean {
    try {
      const disk = JSON.parse(readFileSync(join(record.dir, 'worker.json'), 'utf8')) as WorkerRecord
      return disk.endedAt === record.endedAt && !disk.tabSettledAt
    } catch { return true }
  }

  /** What the worker said while no router listened stays unread: a stale report would settle the new assignment at once. */
  private resume(record: WorkerRecord, report: Reporter): WorkerSession {
    delete record.endedAt
    delete record.tabSettledAt
    writeFileSync(join(record.dir, 'worker.json'), JSON.stringify(record, null, 2))
    const size = (file: string): number => { try { return statSync(join(record.dir, file)).size } catch { return 0 } }
    writeFileSync(join(record.dir, 'cursor.json'), JSON.stringify({ events: size('events.jsonl'), reports: size('reports.jsonl') }))
    this.options.log.line('info', 'worker.resumed', { ticket: record.ticketId, agent: record.agent, tab: record.tabId })
    return this.attach(record, report)
  }

  /** Ends a worker now: its scope (pi and background tasks), then its tab. */
  private async end(record: WorkerRecord): Promise<void> {
    ;(this.options.stopScope ?? stopWorkerScope)(record.sessionId)
    await this.options.herdr.tabClose(record.tabId)
      .catch((error: unknown) => this.options.log.line('warn', 'worker.tab_close_failed', { tab: record.tabId, error: String(error).slice(0, 160) }))
    const now = new Date().toISOString()
    record.endedAt ??= now
    record.tabSettledAt = now
    writeFileSync(join(record.dir, 'worker.json'), JSON.stringify(record, null, 2))
  }

  // A bounded keep: without the budget a busy agent holds a retired tab forever, which is the leak being closed.
  private async closeIfIdle(
    record: WorkerRecord,
    forceAfter?: number,
    tries = (forceAfter === undefined ? 0 : RETIRE_CLOSE_TRIES),
  ): Promise<void> {
    if (!this.stillReleased(record)) return
    const agent = await this.options.herdr.agentGet(record.agent).catch(() => undefined)
    const settle = (): void => {
      record.tabSettledAt = new Date().toISOString()
      writeFileSync(join(record.dir, 'worker.json'), JSON.stringify(record, null, 2))
    }
    if (agent?.pane_id === record.paneId && this.held(record)) {
      const busy = !['idle', 'done'].includes(agent.agent_status)
      const linger = this.options.personLingerMs ?? 3_600_000
      const quiet = Date.now() - this.lastTouch(record)
      if (busy || quiet < linger) {
        this.options.log.line('info', 'worker.tab_kept', { agent: record.agent, tab: record.tabId, status: agent.agent_status, for: 'person' })
        setTimeout(() => { void this.closeIfIdle(record) }, busy ? this.options.lingerMs ?? 600_000 : linger - quiet).unref()
        return
      }
    }
    if (agent?.pane_id === record.paneId && !['idle', 'done'].includes(agent.agent_status)) {
      if (forceAfter !== undefined && tries > 0) {
        this.options.log.line('info', 'worker.tab_closed_busy', {
          agent: record.agent, tab: record.tabId, status: agent.agent_status, ticket: record.ticketId,
        })
        ;(this.options.stopScope ?? stopWorkerScope)(record.sessionId)
        await this.options.herdr.tabClose(record.tabId)
          .then(() => { settle() })
          .catch((error: unknown) => this.options.log.line('warn', 'worker.tab_close_failed', { tab: record.tabId, error: String(error).slice(0, 160) }))
        return
      }
      this.options.log.line('info', 'worker.tab_kept', { agent: record.agent, tab: record.tabId, status: agent.agent_status })
      setTimeout(() => { void this.closeIfIdle(record, forceAfter, tries - 1) }, forceAfter ?? this.options.lingerMs ?? 600_000).unref()
      return
    }
    if (agent?.pane_id !== record.paneId) {
      // Its pi is gone, and since OOMPolicy=continue the scope outlives it: jobs it started would run on, unowned.
      ;(this.options.stopScope ?? stopWorkerScope)(record.sessionId)
      this.options.log.line('info', 'worker.tab_kept', { agent: record.agent, tab: record.tabId, status: 'gone' })
      settle()
      return
    }
    ;(this.options.stopScope ?? stopWorkerScope)(record.sessionId)
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
