import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { DELEGATION_TOOLS, decideToolCall, prepareWorkspace, setupProblems, WorkspaceError } from '../src/pi/workspace.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pi-ws-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('the worker environment', () => {
  it('leaves a ticket worker no GitHub credential: the router holds one, and it is not the worker to spend', () => {
    const root = tmp()
    const names = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'PI_SUPERAGENT_GITHUB_TOKEN_FILE']
    const saved = names.map(n => [n, process.env[n]] as const)
    for (const n of names) process.env[n] = 'ghp_secret'
    let w, env
    try {
      w = prepareWorkspace({ root, ticketId: 'TK-9', stateDir: root, prepare: 'env > env.txt' })
      env = readFileSync(join(w.dir, 'env.txt'), 'utf8')
    } finally { for (const [n, v] of saved) { if (v === undefined) delete process.env[n]; else process.env[n] = v } }
    for (const n of names) {
      expect(env, `${n} reached a worker's shell`).not.toContain(`${n}=ghp_secret`)
      expect(w!.env[n], `${n} reached the worker's env map`).toBeUndefined()
    }
  })

  it('binds relative paths to the workspace like absolute ones', () => {
    const policy = { blocked: ['gh'], workspace: '/ws/t1' }
    expect(decideToolCall({ toolName: 'write', args: { path: '../../.ssh/authorized_keys' } }, policy)).toBeDefined()
    expect(decideToolCall({ toolName: 'edit', args: { path: 'src/main.ts' } }, policy)).toBeUndefined()
  })
  it('blocks blocked commands through absolute paths and backticks', () => {
    const policy = { blocked: ['gh'], workspace: '/ws/t1' }
    expect(decideToolCall({ toolName: 'bash', args: { command: '/usr/bin/gh pr merge main' } }, policy)).toBeDefined()
    expect(decideToolCall({ toolName: 'bash', args: { command: '`which gh` api repos/x/y/issues' } }, policy)).toBeDefined()
    expect(decideToolCall({ toolName: 'bash', args: { command: 'git status' } }, policy)).toBeUndefined()
  })
  it('prepares a directory per ticket with the ticket variables set', () => {
    const root = tmp()
    const w = prepareWorkspace({ root, ticketId: 'TK-1', stateDir: root, prepare: 'echo "$PI_SUPERAGENT_TICKET in $PI_SUPERAGENT_DIR" > prepared.txt' })
    expect(readFileSync(join(w.dir, 'prepared.txt'), 'utf8')).toContain('TK-1 in')
    expect(w.dir).toBe(join(root, 'TK-1'))
  })

  it('a failed prepare is the ticket\'s failure, with the command\'s own words', () => {
    const root = tmp()
    expect(() => prepareWorkspace({ root, ticketId: 'TK-2', stateDir: root, prepare: 'echo "no such remote" >&2; exit 3' }))
      .toThrowError(WorkspaceError)
    try { prepareWorkspace({ root, ticketId: 'TK-2', stateDir: root, prepare: 'echo "no such remote" >&2; exit 3' }) }
    catch (e) { expect((e as WorkspaceError).code).toBe('prepare-failed'); expect((e as WorkspaceError).message).toMatch(/no such remote/) }
  })

  it('refuses a ticket id that would escape the workspace root', () => {
    const root = tmp()
    expect(() => prepareWorkspace({ root, ticketId: '../../etc', stateDir: root })).toThrow(/refusing a workspace named/)
  })

  it('a blocked command is a shim that says what it refused, first on PATH', () => {
    const root = tmp()
    const w = prepareWorkspace({ root, ticketId: 'TK-3', stateDir: root, blockedCommands: ['gh-publish'] })
    const ran = spawnSync('/bin/sh', ['-lc', 'gh-publish repo'], { env: { ...process.env, PATH: w.path }, encoding: 'utf8' })
    expect(ran.status).toBe(126)
    expect(ran.stderr).toMatch(/gh-publish is blocked for ticket workers/)
    expect(w.path.split(':')[0]!).toBe(join(root, 'worker-bin'))
    expect(existsSync(join(root, 'worker-bin', 'gh-publish'))).toBe(true)
    expect(statSync(join(root, 'worker-bin', 'gh-publish')).mode & 0o111).toBeTruthy()
  })

  it('setup problems name the place a person can fix', () => {
    const root = tmp()
    expect(setupProblems({ root: join(root, 'work'), stateDir: join(root, 'nope') })).toEqual([
      { code: 'state-missing', place: 'Deployment', detail: `no state directory at ${join(root, 'nope')}` },
    ])
  })
})

describe('the worker tool-call boundary', () => {
  const policy = { blocked: ['gh', 'kubectl'], workspace: '/ws/TK-9' }
  it('a ticket worker cannot hand the work to a session the ticket does not own', () => {
    for (const tool of DELEGATION_TOOLS) {
      expect(decideToolCall({ toolName: tool, args: {} }, policy)?.deny).toContain(tool)
    }
    expect(decideToolCall({ toolName: 'subagent', args: {} }, { ...policy, allowDelegation: true })).toBeUndefined()
  })

  const allow = (call: Parameters<typeof decideToolCall>[0]) => expect(decideToolCall(call, policy)).toBeUndefined()

  it('refuses a blocked command even when it is buried in a pipeline', () => {
    expect(decideToolCall({ toolName: 'bash', args: { command: 'cd /ws/TK-9 && git status | gh pr create' } }, policy)?.deny).toMatch(/gh is blocked/)
    expect(decideToolCall({ toolName: 'bash', args: { command: 'gh pr merge 9' } }, policy)?.deny).toMatch(/gh is blocked/)
  })

  it('does not refuse a word that merely contains the name', () => {
    allow({ toolName: 'bash', args: { command: 'git log --oneline | head' } })
    allow({ toolName: 'bash', args: { command: './gh-publish-dry --check' } })
  })

  it('keeps writes inside the ticket workspace', () => {
    allow({ toolName: 'write', args: { path: '/ws/TK-9/src/a.ts' } })
    expect(decideToolCall({ toolName: 'edit', args: { path: '/Users/octocat/git/other/x.ts' } }, policy)?.deny).toMatch(/outside this ticket's workspace/)
    allow({ toolName: 'edit', args: { path: 'relative/x.ts' } })
  })
})
