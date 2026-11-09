import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  childDirs,
  credentialFix,
  credentialProblem,
  describeCredentials,
  findEmbeddedGitCredentials,
  gitConfigFiles,
  holdsCredential,
  maskSecret,
  scanGitConfig,
} from '../src/pi/git-credentials.ts'
import { checkoutRepository, prepareWorkspace, setupProblems, WorkspaceError } from '../src/pi/workspace.ts'

// Shape-true, value fake: 40 characters behind the `ghp_` prefix, exactly what the deployment box held.
const SECRET = `ghp_${'x'.repeat(36)}`
const LEAKY = `https://x-access-token:${SECRET}@github.com/kmatzen/pi-superagent.git`
const CLEAN = 'https://github.com/kmatzen/pi-superagent.git'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pi-cred-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A checkout whose .git/config is exactly the text under test. */
const checkoutWith = (config: string, mode = 0o644): string => {
  const dir = tmp()
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), config)
  chmodSync(join(dir, '.git', 'config'), mode)
  return dir
}

const poisonedConfig = (url = LEAKY) => `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`

describe('the credential guard', () => {
  it('finds the credential a `git remote -v` prints, and never repeats the secret', () => {
    const dir = checkoutWith(poisonedConfig())
    const findings = findEmbeddedGitCredentials(dir)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.key).toBe('remote "origin".url')
    expect(findings[0]!.masked).toContain('x-access-token:***@github.com/kmatzen/pi-superagent.git')
    expect(findings[0]!.masked).not.toContain(SECRET)
    expect(JSON.stringify(findings)).not.toContain(SECRET)
    // 0644 is the finding: every user on the box reads the file that stores the credential.
    expect(findings[0]!.mode).toBe('644')
    expect(findings[0]!.worldReadable).toBe(true)
  })

  it('leaves a URL with no password alone: a username names an account, it is not a secret', () => {
    for (const url of [CLEAN, 'https://x-access-token@github.com/kmatzen/pi-superagent.git', 'git@github.com:kmatzen/pi-superagent.git']) {
      expect(findEmbeddedGitCredentials(checkoutWith(poisonedConfig(url)))).toEqual([])
    }
  })

  it('reports a 0600 config too: the URL is still the store every `git remote -v` prints', () => {
    const findings = findEmbeddedGitCredentials(checkoutWith(poisonedConfig(), 0o600))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.mode).toBe('600')
    expect(findings[0]!.worldReadable).toBe(false)
    expect(findings[0]!.masked).not.toContain(SECRET)
  })

  it('catches a token a credential.helper carries with no URL around it', () => {
    const dir = checkoutWith(`[credential]\n\thelper = !f(){ echo username=x-access-token; echo password=${SECRET}; }; f\n`)
    const findings = findEmbeddedGitCredentials(dir)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.masked).toContain('password=ghp_***')
    expect(findings[0]!.masked).not.toContain(SECRET)
  })

  it('reads a linked worktree through the common dir, where its remotes live', () => {
    const source = tmp()
    execFileSync('git', ['init', '-q', source])
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'seed'], { cwd: source })
    const linked = join(tmp(), 'linked')
    execFileSync('git', ['-C', source, 'worktree', 'add', '-q', '-b', 'side', linked], { cwd: source })
    // A linked worktree keeps no config of its own: the file its remotes come from is the common dir's.
    const files = gitConfigFiles(linked)
    expect(files.map(f => basename(f))).toEqual(['config'])
    expect(findEmbeddedGitCredentials(linked)).toEqual([])
    execFileSync('git', ['-C', source, 'remote', 'add', 'origin', CLEAN], { cwd: source })
    expect(findEmbeddedGitCredentials(linked)).toEqual([])
    execFileSync('git', ['-C', source, 'remote', 'set-url', 'origin', LEAKY], { cwd: source })
    const findings = findEmbeddedGitCredentials(linked)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.file).toBe(files[0])
    expect(findings[0]!.masked).toContain('x-access-token:***@github.com')
    expect(findings[0]!.masked).not.toContain(SECRET)
  })

  it('masks every credential shape it knows, and says so for the plain token case', () => {
    expect(maskSecret(LEAKY)).toBe('https://x-access-token:***@github.com/kmatzen/pi-superagent.git')
    expect(maskSecret(`token=github_pat_${'y'.repeat(40)}`)).not.toContain(`${'y'.repeat(40)}`)
    expect(holdsCredential(CLEAN)).toBe(false)
    expect(credentialProblem(checkoutWith(poisonedConfig()), 'Deployment')?.code).toBe('git-credential-in-url')
    expect(credentialProblem(checkoutWith(poisonedConfig(CLEAN)), 'Deployment')).toBeUndefined()
  })

  it('names the line it found, so the operator edits one file', () => {
    const hits = scanGitConfig(join(checkoutWith(poisonedConfig()), '.git', 'config'))
    expect(hits[0]!.masked).toContain('***')
    const problem = credentialProblem(checkoutWith(poisonedConfig()), 'Deployment')!
    expect(problem.code).toBe('git-credential-in-url')
    expect(describeCredentials('/repo', findEmbeddedGitCredentials(checkoutWith(poisonedConfig())))).toContain('git -C /repo remote set-url origin')
    expect(credentialFix('/repo')).toContain('credential helper')
    expect(problem.detail).not.toContain(SECRET)
  })
})

describe('the guard where the router reads', () => {
  it('setupProblems reports a credential in a ticket checkout and a named watched checkout', () => {
    const root = tmp()
    const state = join(root, 'state'); mkdirSync(state, { recursive: true })
    const work = join(root, 'work')
    mkdirSync(join(work, 'TK-1'), { recursive: true })
    // A clean deployment reports nothing: the guard must not cost a healthy router its health code.
    expect(setupProblems({ root: work, stateDir: state })).toEqual([])
    const board = tmp()
    mkdirSync(join(board, '.git'), { recursive: true })
    writeFileSync(join(board, '.git', 'config'), poisonedConfig())
    const problems = setupProblems({ root: work, stateDir: state, checkouts: [board] })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.code).toBe('git-credential-in-url')
    expect(problems[0]!.place).toBe('Deployment')
    expect(problems[0]!.detail).toContain(join(board, '.git', 'config'))
    expect(problems[0]!.detail).not.toContain(SECRET)
  })

  it('a poisoned clone is never published into the workspace the worker reads', async () => {
    const root = tmp()
    const source = join(root, 'source')
    execFileSync('git', ['init', '-q', source])
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'seed'], { cwd: source })
    const workspace = prepareWorkspace({ root, ticketId: 'TK-1', stateDir: root })
    const gh = join(root, 'gh')
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'gh'), `#!/bin/sh\n[ "$3" = github.com/org/repo ] && { git clone -q "${source}" .; git remote set-url origin "${LEAKY}"; }\n`, { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${join(root, 'bin')}:${savedPath}`
    try {
      const failure = await checkoutRepository(workspace, 'org/repo', 'TK-1').catch(error => error)
      expect(failure).toBeInstanceOf(WorkspaceError)
      expect((failure as WorkspaceError).code).toBe('git-credential-in-url')
      expect((failure as Error).message).toContain('carries a credential')
      expect((failure as Error).message).not.toContain(SECRET)
      expect(existsSync(join(workspace.dir, '.git')), 'no checkout reaches the worker workspace').toBe(false)
      expect(readdirSync(workspace.dir)).toEqual([])
      expect(childDirs(root).filter(d => d.includes('.clone-'))).toEqual([])
      // The same clone with a clean remote is published, so the guard costs nothing when nothing is wrong.
      writeFileSync(join(root, 'bin', 'gh'), `#!/bin/sh\n[ "$3" = github.com/org/repo ] && { git clone -q "${source}" .; git remote set-url origin "${CLEAN}"; }\n`, { mode: 0o755 })
      await checkoutRepository(workspace, 'org/repo', 'TK-1')
      expect(existsSync(join(workspace.dir, '.git', 'config'))).toBe(true)
    } finally {
      process.env.PATH = savedPath
    }
  })
})
