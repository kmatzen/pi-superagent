import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  childDirs,
  countCredentials,
  credentialFix,
  credentialProblem,
  describeCredentials,
  findEmbeddedGitCredentials,
  gitConfigFiles,
  holdsCredential,
  maskSecret,
  redactCredentials,
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

  it('reports every credential in one config: two leaky remotes are two findings', () => {
    // A global regex plus `.test()` carries `lastIndex` between calls, so the second value can be scanned
    // from the middle of the file. Two remotes each holding the token is the shape the box had (origin plus
    // the backup a worker added), and dropping the second one is the guard saying "clean" about a leak.
    const first = `ghp_${'a'.repeat(36)}`
    const second = `ghp_${'b'.repeat(36)}`
    const dir = checkoutWith(
      `[remote "origin"]\n\turl = https://${first}@github.com/kmatzen/pi-superagent.git\n`
      + `[remote "backup"]\n\turl = https://${second}@github.com/kmatzen/b.git\n`,
    )
    const hits = scanGitConfig(join(dir, '.git', 'config'))
    expect(hits.map(h => h.key)).toEqual(['remote "origin".url', 'remote "backup".url'])
    const findings = findEmbeddedGitCredentials(dir)
    expect(findings).toHaveLength(2)
    expect(JSON.stringify(findings)).not.toContain(first)
    expect(JSON.stringify(findings)).not.toContain(second)
    // The order does not save it either: the helper line first, the URL second, is the deployment's shape.
    expect(holdsCredential(`helper = !f(){ echo password=${first}; }; f`)).toBe(true)
    expect(holdsCredential(`url = https://${second}@github.com/kmatzen/b.git`)).toBe(true)
    expect(holdsCredential(CLEAN)).toBe(false)
    expect(holdsCredential(`url = https://${second}@github.com/kmatzen/b.git`)).toBe(true)
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

describe('the mask, on the way out', () => {
  it('finds a credential baked into a section NAME, the url.<base>.insteadOf shape', () => {
    // `[url "https://x-access-token:ghp_…@github.com/"] insteadOf = git@github.com:` is a documented way to
    // make a token the credential store, and it puts the secret in a section header, not a `key = value` line.
    // Measured before the fix: the TS scanner returned [] for this file — `status` and the panel called it
    // clean — while the shell guard's line grep refused the same file. Two answers to one file is the bug.
    const dir = checkoutWith(`[remote "origin"]\n\turl = ${CLEAN}\n[url "${LEAKY.replace('/kmatzen/pi-superagent.git', '/')}"]\n\tinsteadOf = git@github.com:\n`)
    const findings = findEmbeddedGitCredentials(dir)
    expect(findings.length, 'the section-name credential is a finding').toBe(1)
    expect(findings[0]!.key).toBe('url (section name)')
    expect(findings[0]!.masked).toContain('x-access-token:***@github.com')
    expect(findings[0]!.masked).not.toContain(SECRET)
    // The clean half of the same file stays unreported, so the finding is the section name and nothing else.
    expect(findings.some(f => f.key === 'remote.origin.url')).toBe(false)
  })

  it('masks EVERY credential in one value, because the finding is what gets logged and posted', () => {
    // A masker that stops at the first match publishes the rest of the value into the report.
    const two = `https://a:${SECRET}@github.com/o/r -> https://b:${SECRET}@github.com/x/y`
    const masked = maskSecret(two)
    expect(masked.match(/:\*\*\*@/g)?.length, 'both credentials masked').toBe(2)
    expect(masked).not.toContain(SECRET)
  })

  it('masks the shapes a worker prints, and touches a body that has nothing to mask', () => {
    const printed = `pushed to origin https://x-access-token:${SECRET}@github.com/kmatzen/pi-superagent.git (token ${SECRET})`
    const masked = redactCredentials(printed)
    expect(masked).not.toContain(SECRET)
    expect(masked).toContain('https://x-access-token:***@github.com') // the shape stays readable
    expect(countCredentials(printed)).toBe(2)
    expect(countCredentials(masked)).toBe(0)

    // Clean text comes back byte-identical: URLs, an SSH remote, a bare user@host and a code fence untouched.
    const clean = ['See https://github.com/kmatzen/pi-superagent/pull/30 for the change.',
      'remote: git@github.com:kmatzen/pi-superagent.git',
      'ssh://git@github.com:22/org/repo',
      '```\ngit remote -v\norigin  https://github.com/kmatzen/pi-superagent.git (fetch)\n```'].join('\n')
    expect(redactCredentials(clean)).toBe(clean)
    expect(countCredentials(clean)).toBe(0)
  })
})

describe('the mask knows Slack token shapes too', () => {
  // Shape-true, value fake. Slack's shapes belong here because this pattern is the ingest guard's whole definition of "credential-shaped".
  // From repeats, not literals: a shape-true Slack fixture is a blocked push (GH013, measured here), and the guard scans the assembled string.
  const seg = (n: number, c: string) => c.repeat(n)
  const SLACK = [
    `xoxb-${seg(13, '1')}-${seg(13, '2')}-${seg(24, 'a')}`,
    `xoxp-${seg(13, '1')}-${seg(13, '2')}-${seg(13, '3')}-${seg(32, 'a')}`,
    `xapp-1-A${seg(11, '1')}-${seg(20, 'a')}-${seg(20, 'b')}`,
    `xoxe.1.A${seg(11, '1')}.${seg(24, 'a')}`,
  ]

  it.each(SLACK)('masks %s', token => {
    expect(holdsCredential(`bot token: ${token}`), 'recognised as a credential').toBe(true)
    const masked = redactCredentials(`bot token: ${token}`)
    expect(masked).not.toContain(token)
    expect(masked).toContain(token.slice(0, 4)) // the family stays readable: xoxb, xapp, xoxe
    expect(redactCredentials(masked), 'masking is idempotent: the mask is not a fresh finding').toBe(masked)
    expect(countCredentials(masked)).toBe(0)
  })

  it('leaves prose that merely starts with the prefix alone', () => {
    const prose = 'the xox package, the xoxb- notes file, xoxb-not-a-token'
    expect(countCredentials(prose)).toBe(0)
    expect(redactCredentials(prose)).toBe(prose)
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

  it('setupProblems reports a credential in the checkout a worker cloned itself, one level down', () => {
    // The product clones into <root>/<ticket>/. A worker told "clone into your workspace" clones into
    // <root>/<ticket>/repo/ — measured: 26 of the 29 live ticket checkouts are that shape, the 3 flat ones are
    // the product's own. A guard that stops at the ticket directory calls every worker clone clean.
    const root = tmp()
    const work = join(root, 'work')
    const state = join(root, 'state')
    mkdirSync(join(work, 'TK-3', 'repo', '.git'), { recursive: true })
    mkdirSync(state, { recursive: true })
    writeFileSync(join(work, 'TK-3', 'repo', '.git', 'config'), poisonedConfig())
    const problems = setupProblems({ root: work, stateDir: state })
    expect(problems.map(p => p.code)).toEqual(['git-credential-in-url'])
    expect(problems[0]!.detail).toContain(join('TK-3', 'repo', '.git', 'config'))
    expect(problems[0]!.detail).not.toContain(SECRET)
    // Depth is bounded: a node_modules tree full of nested `.git` dirs is not a deployment to walk.
    mkdirSync(join(work, 'TK-4', 'repo', 'node_modules', 'pkg', '.git'), { recursive: true })
    writeFileSync(join(work, 'TK-4', 'repo', 'node_modules', 'pkg', '.git', 'config'), poisonedConfig())
    expect(setupProblems({ root: work, stateDir: state })).toHaveLength(1)
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
