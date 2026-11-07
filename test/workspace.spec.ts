import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { checkoutRepository, DELEGATION_TOOLS, decideToolCall, prepareWorkspace, setupProblems, workerBase, WorkspaceError } from '../src/pi/workspace.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pi-ws-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('the worker environment', () => {
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

  it('refuses a repository that is not one owner and one name', async () => {
    const root = tmp()
    const w = prepareWorkspace({ root, ticketId: 'TK-9', stateDir: root })
    for (const bad of ['../evil', 'org/..', 'org/.', '/repo', 'repo', 'org/repo/extra', 'org/repo;rm -rf /', 'org/_', 'ORG/REPO ']) {
      await expect(checkoutRepository(w, bad, 'TK-9'), bad).rejects.toThrow(/invalid GitHub repository/)
    }
  })

  it('publishes a complete ticket clone, retries failed clones and preserves edits on resume', async () => {
    const root = tmp()
    const source = join(root, 'source')
    execFileSync('git', ['init', '-q', source])
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'seed'], { cwd: source })
    const workspace = prepareWorkspace({ root, ticketId: 'TK-1', stateDir: root })
    const gh = join(root, 'gh')
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
    try {
      writeFileSync(gh, '#!/bin/sh\ntouch partial; exit 1\n', { mode: 0o755 })
      await expect(checkoutRepository(workspace, 'org/repo', 'TK-1')).rejects.toThrow(/cannot prepare/)
      expect(existsSync(join(workspace.dir, 'partial'))).toBe(false)
      writeFileSync(gh, `#!/bin/sh\n[ "$3" = github.com/org/repo ] && git clone -q "${source}" .\n`)
      await checkoutRepository(workspace, 'org/repo', 'TK-1')
      // Enterprise-managed accounts carry an underscore, and they are the accounts this board runs on.
      writeFileSync(gh, `#!/bin/sh\n[ "$3" = github.com/acme_corp/super-agent-board ] && git clone -q "${source}" .\n`)
      await checkoutRepository(prepareWorkspace({ root, ticketId: 'TK-2', stateDir: root }), 'acme_corp/super-agent-board', 'TK-2')
      expect(execFileSync('git', ['branch', '--show-current'], { cwd: workspace.dir, encoding: 'utf8' }).trim()).toBe('superagent/TK-1')
      writeFileSync(join(workspace.dir, 'unfinished'), 'draft')
      await checkoutRepository(workspace, 'org/repo', 'TK-1')
      expect(readFileSync(join(workspace.dir, 'unfinished'), 'utf8')).toBe('draft')
    } finally {
      vi.unstubAllEnvs()
    }
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

describe('what a worker is given', () => {
  it('carries no operator credential and a HOME of its own', () => {
    // Audit 2026-11-10: a worker runs prompt content from ticket text, and its environment used to carry the
    // operator's HOME, token paths and SSH agent, so a blocked `gh` only hid the name of the way out.
    const root = tmp()
    const keys = ['PI_SUPERAGENT_GITHUB_TOKEN_FILE', 'PI_SUPERAGENT_GITHUB_SELF', 'PI_OPS_TOKEN_FILE', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'] as const
    const saved = keys.map(k => [k, process.env[k]] as const)
    for (const k of keys) process.env[k] = '/leaky'
    try {
      const w = prepareWorkspace({ root, ticketId: 'TK-sec', stateDir: root })
      expect(w.env.HOME).toBe(join(root, 'worker-homes', 'TK-sec'))
      expect(w.env.GH_CONFIG_DIR).toContain('worker-homes')
      for (const k of keys) expect(w.env, k).not.toHaveProperty(k)
      expect(w.env.PI_SUPERAGENT_TICKET).toBe('TK-sec')
      expect(statSync(join(root, 'worker-homes', 'TK-sec')).mode & 0o077).toBe(0)
    } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })

  it('keeps the settings a prepare script needs, and gives the script the operator own environment', () => {
    const root = tmp()
    const w = prepareWorkspace({ root, ticketId: 'TK-prep', stateDir: root, prepare: 'echo "$HOME" > prep-home.txt' })
    expect(readFileSync(join(w.dir, 'prep-home.txt'), 'utf8').trim()).toBe(process.env.HOME)
    expect(w.env.HOME).not.toBe(process.env.HOME)
  })
})

describe('workerBase', () => {
  it('drops the credential names and keeps everything a build needs', () => {
    const out = workerBase({ PATH: '/bin', HOME: '/home/op', PI_SUPERAGENT_GITHUB_TOKEN_FILE: '/t', PI_OPS_REPO: 'a/b', PI_SUPERAGENT_MAX_WORKERS: '8' })
    expect(out.PATH).toBe('/bin')
    expect(out.PI_SUPERAGENT_MAX_WORKERS).toBe('8')
    expect('PI_OPS_REPO' in out).toBe(false)
    expect('PI_SUPERAGENT_GITHUB_TOKEN_FILE' in out).toBe(false)
  })
})
