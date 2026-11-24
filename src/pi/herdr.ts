/** The herdr CLI as an async client. Asynchronous on purpose: a synchronous call holds the router's event loop. */
import { spawn } from 'node:child_process'

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface AgentInfo {
  name: string | null
  pane_id: string
  tab_id?: string
  agent: string | null
  agent_status: AgentStatus
  agent_session?: { value?: string } | null
}

export interface Herdr {
  workspaces(): Promise<Array<{ workspace_id: string; label: string }>>
  workspaceCreate(o: { label: string; cwd: string }): Promise<{ workspaceId: string; tabId: string; paneId: string }>
  tabCreate(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }): Promise<{ tabId: string; paneId: string }>
  tabRename(tabId: string, label: string): Promise<void>
  tabClose(tabId: string): Promise<void>
  tabList(): Promise<Array<{ tabId: string; label: string; workspaceId: string; agentStatus: string }>>
  paneRun(paneId: string, command: string): Promise<void>
  agentStart(o: { name: string; kind: string; pane: string; timeoutMs: number; args: string[] }): Promise<AgentInfo>
  agentGet(name: string): Promise<AgentInfo | undefined>
  agentSendKeys(name: string, keys: string[]): Promise<void>
  agentPrompt(name: string, text: string): Promise<void>
  /** The tab's last lines of terminal text: what a pi that died at startup printed before its shell came back. */
  paneRead(paneId: string, lines: number): Promise<string>
}

export class HerdrError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function herdrCli(bin = 'herdr', timeoutMs = 60_000): Herdr {
  // Every call is time-limited: launches run one at a time, so a herdr that stops answering held every launch
  // behind it, for good.
  const run = (args: string[], limitMs = timeoutMs): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new HerdrError('timeout', `herdr ${args.slice(0, 2).join(' ')}: no answer in ${limitMs} ms`))
      }, limitMs)
      timer.unref?.()
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }) })
    })
  const call = async (args: string[], limitMs?: number): Promise<Record<string, unknown>> => {
    const { code, out, err } = await run(args, limitMs)
    if (code === 0) {
      try { return (JSON.parse(out || '{}') as { result?: Record<string, unknown> }).result ?? {} } catch { return {} }
    }
    let failure: { code?: string; message?: string } = {}
    try { failure = (JSON.parse(err) as { error?: typeof failure }).error ?? {} } catch { /* not JSON: keep the raw text */ }
    throw new HerdrError(failure.code ?? `exit_${code}`, `herdr ${args.slice(0, 2).join(' ')}: ${failure.message ?? err.trim().slice(0, 300)}`)
  }
  const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])

  return {
    async workspaces() {
      return ((await call(['workspace', 'list'])).workspaces ?? []) as Array<{ workspace_id: string; label: string }>
    },
    async workspaceCreate(o) {
      const r = await call(['workspace', 'create', '--label', o.label, '--cwd', o.cwd, '--no-focus']) as {
        workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: { pane_id: string }
      }
      return { workspaceId: r.workspace.workspace_id, tabId: r.tab.tab_id, paneId: r.root_pane.pane_id }
    },
    async tabCreate(o) {
      const r = await call(['tab', 'create', '--workspace', o.workspace, '--cwd', o.cwd, '--label', o.label, ...envArgs(o.env), '--no-focus']) as {
        tab: { tab_id: string }; root_pane: { pane_id: string }
      }
      return { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id }
    },
    async tabRename(tabId, label) { await call(['tab', 'rename', tabId, label]) },
    async tabClose(tabId) { await call(['tab', 'close', tabId]) },
    async tabList() {
      const r = await call(['tab', 'list']) as {
        tabs: Array<{ tab_id: string; label: string; workspace_id: string; agent_status: string }>
      }
      return (r.tabs ?? []).map(t => ({ tabId: t.tab_id, label: t.label, workspaceId: t.workspace_id, agentStatus: t.agent_status }))
    },
    async paneRun(paneId, command) { await call(['pane', 'run', paneId, command]) },
    async agentStart(o) {
      const r = await call(['agent', 'start', o.name, '--kind', o.kind, '--pane', o.pane, '--timeout', String(o.timeoutMs), '--', ...o.args],
        o.timeoutMs + 30_000)
      return (r as { agent: AgentInfo }).agent
    },
    async agentGet(name) {
      try {
        return ((await call(['agent', 'get', name])) as { agent?: AgentInfo }).agent
      } catch (error) {
        if (error instanceof HerdrError && /not_found|unknown_agent|no_such/i.test(`${error.code} ${error.message}`)) return undefined
        throw error
      }
    },
    async agentSendKeys(name, keys) { await call(['agent', 'send-keys', name, ...keys]) },
    async agentPrompt(name, text) { await call(['agent', 'prompt', name, text]) },
    async paneRead(paneId, lines) {
      const { code, out } = await run(['pane', 'read', paneId, '--lines', String(lines)])
      return code === 0 ? out : ''
    },
  }
}
