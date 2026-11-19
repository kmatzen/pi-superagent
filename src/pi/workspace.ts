/** A workspace per ticket, a prepare command that must succeed, and blocked names that refuse on its PATH. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile, execFileSync } from 'node:child_process'
import { checkoutDirs, describeCredentials, findEmbeddedGitCredentials } from './git-credentials.ts'

export interface WorkspaceRequest {
  root: string
  ticketId: string
  /** Runs in the workspace before the session starts, with PI_SUPERAGENT_* set. */
  prepare?: string
  /** Personal CLIs and publishers: names that must not run under the operator's identity. */
  blockedCommands?: readonly string[]
  stateDir: string
}

/**
 * A worker runs as the operator: in a herdr tab, with the operator's HOME, harness, keys and logins (operator,
 * 2026-11-10: agents have all the power). What bounds it is the guard in its own pi: blocked commands, writes
 * kept in the workspace. A per-worker HOME was built here once and never reached a herdr worker, so it is gone.
 */
export interface PreparedWorkspace {
  dir: string
  path: string
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
  return { dir, path }
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
    // A checkout that carries a credential in its remote URL hands that secret to the worker session, which
    // prints `git remote -v` in the ordinary course of work and puts it in a transcript. Refuse the checkout.
    const leaked = findEmbeddedGitCredentials(stage)
    if (leaked.length) {
      throw new WorkspaceError('git-credential-in-url', `refusing to hand ${repo} to ${ticketId}: the clone's git config carries a credential`, describeCredentials(stage, leaked))
    }
    renameSync(stage, workspace.dir)
  } catch (error) {
    // A guard's refusal is its own reason: wrapping it in `prepare-failed` hides the credential from the log.
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('prepare-failed', `cannot prepare ${repo} for ${ticketId}`, (error as Error).message)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
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
export function setupProblems(request: { root: string; stateDir: string; checkouts?: readonly string[] }): Array<{ code: string; place: string; detail: string }> {
  const problems: Array<{ code: string; place: string; detail: string }> = []
  if (!existsSync(request.stateDir)) problems.push({ code: 'state-missing', place: 'Deployment', detail: `no state directory at ${request.stateDir}` })
  if (!writable(request.root)) problems.push({ code: 'worktrees-unwritable', place: 'Execution', detail: `cannot write ${request.root}` })
  // Every checkout this deployment reads: the ones the operator named, the one the router runs from, and the
  // ticket checkouts under the worktree root. A credential in any of them is readable by every user on the
  // box and printed by every worker that runs `git remote -v`, so it is a setup problem, not a lint.
  for (const dir of new Set([...(request.checkouts ?? []), ...checkoutDirs(request.root)])) {
    const findings = findEmbeddedGitCredentials(dir)
    if (findings.length) problems.push({ code: 'git-credential-in-url', place: 'Deployment', detail: describeCredentials(dir, findings) })
  }
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

/** pi hands a worker new messages only between tool calls, so one command that waits minutes holds a person's review
 *  back that long (2026-11-12: workers slept 300-600 s per command polling CI while the operator's reviews queued). */
export const MAX_WAIT_S = 60
const WAIT_HELP = `poll in steps instead: one \`gh pr checks\` (or \`gh run view\`) per command, then \`sleep ${MAX_WAIT_S}\` at most, and look again. A person's review reaches you only between commands`
const UNIT_S: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }

export function longWait(command: string): string | undefined {
  for (const m of command.matchAll(/(?:^|[;&|\s(`])sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=$|[\s;&|)`])/g)) {
    if (Number(m[1]) * UNIT_S[m[2] ?? '']! > MAX_WAIT_S) return `sleep ${m[1]}${m[2]} waits past ${MAX_WAIT_S} s in one command; ${WAIT_HELP}`
  }
  if (/\bgh\s+(pr\s+checks\b[^;&|]*--watch|run\s+watch)\b/.test(command)) return `a watch blocks until CI finishes; ${WAIT_HELP}`
  if (/\b(while|until|for)\b[\s\S]*\bsleep\b/.test(command) && /\bgh\s+(pr|run|api)\b/.test(command)) {
    return `a loop that polls GitHub inside one command waits as long as CI does; ${WAIT_HELP}`
  }
  return undefined
}

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
    const wait = longWait(command)
    return wait ? { deny: wait } : undefined
  }
  if (call.toolName === 'edit' || call.toolName === 'write') {
    const path = String(call.args.path ?? '')
    // Resolve first: ../../.ssh/x is relative and passed straight through an absolute-only check.
    const abs = path.startsWith('/') ? path : resolve(policy.workspace, path)
    if (!abs.startsWith(`${policy.workspace}/`)) return { deny: `${path} is outside this ticket's workspace ${policy.workspace}` }
  }
  return undefined
}
