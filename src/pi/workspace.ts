/** A workspace per ticket, a prepare command that must succeed, and blocked names that refuse on its PATH. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile, execFileSync } from 'node:child_process'

export interface WorkspaceRequest {
  root: string
  ticketId: string
  /** Runs in the workspace before the session starts, with PI_SUPERAGENT_* set. */
  prepare?: string
  /** Personal CLIs and publishers: names that must not run under the operator's identity. */
  blockedCommands?: readonly string[]
  stateDir: string
  extra?: Record<string, string>
  /**
   * A scoped token for this worker's GitHub work. The worker's HOME is its own, so it has no login: without
   * this it writes code it cannot hand over, which is what the brief tells every code ticket to do.
   */
  workerToken?: string
  /** What git records on the worker's commits: a worker with no git config gets `user@host.local`. */
  identity?: { name: string, email: string }
}

/** Names that hand a worker the operator's identity: token paths, agent config, cloud credentials. */
const LEAKS = /^(PI_SUPERAGENT_(GITHUB_TOKEN_FILE|GITHUB_SELF|STATE|WORKTREES)|PI_OPS_|SSH_AUTH_SOCK|AWS_|GOOGLE_|GH_TOKEN|GITHUB_TOKEN)/

/** The base of a worker's environment: the operator's secrets stay in the router's process. */
export function workerBase(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !LEAKS.test(entry[0])))
}

export interface PreparedWorkspace {
  dir: string
  path: string
  env: Record<string, string>
}

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: string) {
    super(detail ? `${message}: ${detail.split('\n').slice(-3).join(' / ')}` : message)
  }
}

const SAFE = /^[A-Za-z0-9._-]+$/

export function prepareWorkspace(request: WorkspaceRequest): PreparedWorkspace {
  if (!SAFE.test(request.ticketId) || ['.', '..'].includes(request.ticketId)) throw new WorkspaceError('bad-ticket-id', `refusing a workspace named ${request.ticketId}`)
  const dir = join(request.root, request.ticketId)
  try {
    mkdirSync(request.root, { recursive: true, mode: 0o700 })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new WorkspaceError('workspace-unwritable', `cannot create ${dir}`, error instanceof Error ? error.message : String(error))
  }
  const bin = shims(request.stateDir, request.blockedCommands ?? [])
  const path = `${bin}:${process.env.PATH ?? ''}`
  // A ticket's text is prompt content, so a worker's HOME is its own: the real HOME holds the gh keychain,
  // ~/.ssh and the token files the blocked-command shims only paper over. Outside the checkout, because a
  // checkout directory that is not empty means "already cloned" to checkoutRepository.
  const home = join(request.stateDir, 'worker-homes', request.ticketId)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  seedHome(home, request.workerToken, request.identity)
  const env: Record<string, string> = {
    ...workerBase(process.env),
    PATH: path,
    ...(request.workerToken ? { GH_TOKEN: request.workerToken } : {}),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GH_CONFIG_DIR: join(home, '.config', 'gh'),
    PI_SUPERAGENT_TICKET: request.ticketId,
    PI_SUPERAGENT_DIR: dir,
    ...request.extra,
  }
  // The prepare script is the operator's own file, so it runs with the operator's environment.
  const prepareEnv = { ...process.env as Record<string, string>, PATH: path, PI_SUPERAGENT_TICKET: request.ticketId, PI_SUPERAGENT_DIR: dir }
  if (request.prepare) {
    try {
      execFileSync('/bin/bash', ['-lc', request.prepare], { cwd: dir, env: prepareEnv, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const e = error as { stderr?: string; message?: string; signal?: string }
      throw new WorkspaceError('prepare-failed', `prepare command failed for ${request.ticketId}`, e.stderr || e.message || e.signal || 'unknown')
    }
  }
  return { dir, path, env }
}

const run = promisify(execFile)

/** Publish only a complete checkout. Resumed workers keep their branch, edits and any legacy workspace. */
export async function checkoutRepository(workspace: PreparedWorkspace, repo: string, ticketId: string) {
  if (readdirSync(workspace.dir).length) return
  // An enterprise-managed account name carries an underscore: the watched board's own account is one, and a
  // stricter owner pattern refused to clone it, so no worker could start.
  const [owner, name] = repo.split('/')
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9_.-]+$/.test(repo) || [owner, name].some(part => !part || !/[A-Za-z0-9]/.test(part) || ['.', '..'].includes(part))) {
    throw new WorkspaceError('prepare-failed', `invalid GitHub repository: ${repo}`)
  }
  const stage = mkdtempSync(`${workspace.dir}.clone-`)
  const options = { cwd: stage, timeout: 300_000 }
  try {
    await run('gh', ['repo', 'clone', `github.com/${repo}`, '.', '--', '--quiet'], options)
    await run('git', ['switch', '-c', `superagent/${ticketId}`], options)
    renameSync(stage, workspace.dir)
  } catch (error) {
    throw new WorkspaceError('prepare-failed', `cannot prepare ${repo} for ${ticketId}`, (error as Error).message)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** The worker's own HOME, seeded so its commits carry an identity and its scoped token can reach GitHub. */
function seedHome(home: string, token?: string, identity?: { name: string, email: string }): void {
  const name = identity?.name ?? 'pi-superagent'
  const gitconfig = ['[user]', `\tname = ${name}`, `\temail = ${identity?.email ?? `${name}@users.noreply.github.com`}`]
  if (token) {
    writeFileSync(join(home, '.git-credentials'), `https://x-access-token:${token}@github.com\n`, { mode: 0o600 })
    gitconfig.push('[credential]', '\thelper = store')
  }
  writeFileSync(join(home, '.gitconfig'), `${gitconfig.join('\n')}\n`, { mode: 0o600 })
}

/** One directory, first on PATH, holding a refusal for every blocked name. A shim says what it refused. */
export function shims(stateDir: string, blocked: readonly string[]): string {
  const bin = join(stateDir, 'worker-bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  for (const name of blocked) {
    if (!SAFE.test(name)) throw new WorkspaceError('bad-command-name', `refusing to shim a command named ${name}`)
    const file = join(bin, name)
    writeFileSync(file, '#!/bin/sh\n'
      + `echo "superagent: ${name} is blocked for ticket workers (the operator's identity is not yours to use)" >&2\n`
      + 'exit 126\n')
    chmodSync(file, 0o755)
  }
  return bin
}

/** What `superagent status` reads as code 3: a router that cannot start its work is not a healthy one. */
export function setupProblems(request: { root: string; stateDir: string }): Array<{ code: string; place: string; detail: string }> {
  const problems: Array<{ code: string; place: string; detail: string }> = []
  if (!existsSync(request.stateDir)) problems.push({ code: 'state-missing', place: 'Deployment', detail: `no state directory at ${request.stateDir}` })
  if (!writable(request.root)) problems.push({ code: 'worktrees-unwritable', place: 'Execution', detail: `cannot write ${request.root}` })
  return problems
}

const writable = (dir: string): boolean => {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); return existsSync(dir) } catch { return false }
}

/**
 * The part of the worker's boundary pi can enforce: a tool call is allowed, or refused with a reason.
 * A PATH shim cannot reach a worker's shell through the SDK today, so the rule lives at the tool call,
 * where an extension does have a veto.
 */
export interface ToolCallPolicy {
  blocked: readonly string[]
  workspace: string
  allowDelegation?: boolean
}

export type ToolCall = { toolName: string; args: Record<string, unknown> }

type ToolCallHook = (event: { toolName: string; input?: Record<string, unknown> }) => { block: true; reason: string } | undefined

/** The policy as an inline pi extension: `tool_call` is where pi lets an extension refuse a call before it runs. */
export function guardExtension(policy: ToolCallPolicy): (pi: { on(event: 'tool_call', handler: ToolCallHook): void }) => void {
  return pi => pi.on('tool_call', event => {
    const verdict = decideToolCall({ toolName: event.toolName, args: event.input ?? {} }, policy)
    return verdict ? { block: true, reason: verdict.deny } : undefined
  })
}

/** Delegated work leaves the mandate, the workspace bound and the report behind. */
export const DELEGATION_TOOLS = ['subagent', 'workflow', 'workflow_control', 'session_spawn', 'session_bus']

export function decideToolCall(call: ToolCall, policy: ToolCallPolicy): { deny: string } | undefined {
  if (!policy.allowDelegation && DELEGATION_TOOLS.includes(call.toolName)) {
    return { deny: `${call.toolName} is closed to a ticket worker: work outside this session has no mandate, no workspace bound, and no report` }
  }
  if (call.toolName === 'bash') {
    const command = String(call.args.command ?? '')
    for (const name of policy.blocked) {
      // The boundary includes / and backticks: /usr/bin/gh and `gh` rode past the old set.
      const re = new RegExp(`(^|[;&|\\s(/\x60])(sudo\\s+)?${name}(\\s|$|\x60)`)
      if (re.test(command)) return { deny: `${name} is blocked for ticket workers; the operator's identity is not yours to use` }
    }
    return undefined
  }
  if (call.toolName === 'edit' || call.toolName === 'write') {
    const path = String(call.args.path ?? '')
    // Resolve first: ../../.ssh/x is relative and passed straight through an absolute-only check.
    const abs = path.startsWith('/') ? path : resolve(policy.workspace, path)
    if (!abs.startsWith(`${policy.workspace}/`)) return { deny: `${path} is outside this ticket's workspace ${policy.workspace}` }
  }
  return undefined
}
