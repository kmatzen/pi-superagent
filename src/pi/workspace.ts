/** A workspace per ticket, a prepare command that must succeed, and blocked names that refuse on its PATH. */
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

export interface WorkspaceRequest {
  root: string
  ticketId: string
  /** Runs in the workspace before the session starts, with PI_SUPERAGENT_* set. */
  prepare?: string
  /** Personal CLIs and publishers: names that must not run under the operator's identity. */
  blockedCommands?: readonly string[]
  stateDir: string
  extra?: Record<string, string>
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
  if (!SAFE.test(request.ticketId)) throw new WorkspaceError('bad-ticket-id', `refusing a workspace named ${request.ticketId}`)
  const dir = join(request.root, request.ticketId)
  try {
    mkdirSync(request.root, { recursive: true, mode: 0o700 })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new WorkspaceError('workspace-unwritable', `cannot create ${dir}`, error instanceof Error ? error.message : String(error))
  }
  const bin = shims(request.stateDir, request.blockedCommands ?? [])
  const path = `${bin}:${process.env.PATH ?? ''}`
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: path,
    PI_SUPERAGENT_TICKET: request.ticketId,
    PI_SUPERAGENT_DIR: dir,
    ...request.extra,
  }
  if (request.prepare) {
    try {
      execFileSync('/bin/bash', ['-lc', request.prepare], { cwd: dir, env, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const e = error as { stderr?: string; message?: string; signal?: string }
      throw new WorkspaceError('prepare-failed', `prepare command failed for ${request.ticketId}`, e.stderr || e.message || e.signal || 'unknown')
    }
  }
  return { dir, path, env }
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
