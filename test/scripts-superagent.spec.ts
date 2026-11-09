import { spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'superagent')
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-herdr')
chmodSync(FAKE, 0o755)

let state: string, herdrDir: string
const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(SCRIPT, args, {
  encoding: 'utf8',
  env: {
    ...process.env, PI_SUPERAGENT_STATE: state, PI_SUPERAGENT_HERDR: FAKE, PI_SUPERAGENT_GRACE: '1', FAKE_HERDR_DIR: herdrDir,
    PI_SUPERAGENT_PANEL_PORT: '8799', FAKE_HERDR_READY: join(state, 'ready'), ...extra,
  },
})
const routerTab = () => readFileSync(join(herdrDir, 'tab.1.args'), 'utf8')
const routerStart = () => readFileSync(join(herdrDir, 'start.superagent.args'), 'utf8')

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sa-')); dirs.push(root)
  state = join(root, 'state'); herdrDir = join(root, 'herdr')
  mkdirSync(state, { recursive: true }); mkdirSync(herdrDir, { recursive: true })
  for (const key of Object.keys(process.env)) if (key.startsWith('PI_SUPERAGENT_GITHUB')) delete process.env[key]
})
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

// Each run starts several processes (bash, node for herdr's JSON, the fake herdr): seconds under a full suite.
describe('scripts/superagent', { timeout: 30_000 }, () => {
  it('refuses to kill a process on the panel port that is not this router', async () => {
    // The scheduled health check runs `start`, and `start` frees the panel's port. A dev server that owns
    // 8799 is the operator's work, not a stale panel, so killing it is the defect this guards.
    const { spawn } = await import('node:child_process')
    const squatter = spawn(process.execPath, ['-e', "require('http').createServer((_q,r)=>r.end('mine')).listen(8799)"], { stdio: 'ignore' })
    await new Promise(r => setTimeout(r, 700))
    const out = run(['start'])
    expect(out.status, out.stderr).not.toBe(0)
    expect(out.stderr).toMatch(/not this router/)
    const alive = spawnSync(process.execPath, ['-e', "fetch('http://127.0.0.1:8799').then(r=>r.text()).then(t=>process.exit(t==='mine'?0:1))"], { encoding: 'utf8' })
    expect(alive.status, 'the squatter stayed alive and answered').toBe(0)
    squatter.kill()
  })

  it('treats a ready-wait of 0 as one second, not as a start that always fails', () => {
    // 0 reads as "do not wait"; without a floor the loop never runs, the ready check fires, and a scheduled
    // health check restarts a healthy router forever.
    const out = run(['start'], { PI_SUPERAGENT_READY_WAIT: '0', FAKE_HERDR_READY: state })
    expect(out.stderr).toMatch(/did not report ready within 1s/)
    expect(out.status).toBe(1)
  })

  it('exits 1 when the router never reports ready, because 0 promises healthy', () => {
    // The ready path is a directory here, so the fake herdr cannot write it and startup never completes.
    const out = run(['start'], { PI_SUPERAGENT_READY_WAIT: '1', FAKE_HERDR_READY: state })
    expect(out.status, out.stderr).toBe(1)
    expect(out.stderr).toMatch(/did not report ready/)
  })

  it('init validates access and keeps existing settings on repeat or conflict', () => {
    for (const [bin, body] of [['gh', 'echo "$PERMISSION"'], ['pi', 'exit 0']] as const) {
      writeFileSync(join(herdrDir, bin), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    }
    const env = { PATH: `${herdrDir}:${process.env.PATH}`, PERMISSION: 'WRITE' }
    const file = join(state, 'config.env')
    expect(run(['init', 'org/repo'], { ...env, PERMISSION: 'READ' }).status).toBe(1)
    expect(existsSync(file)).toBe(false)
    expect(run(['init', 'org/repo'], env).status).toBe(0)
    const saved = readFileSync(file, 'utf8') + 'PI_SUPERAGENT_MAX_WORKERS=2\n'
    writeFileSync(file, saved)
    expect(run(['init', 'org/repo'], env).status).toBe(0)
    expect(run(['init', 'org/other'], env).status).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(saved)
  })

  it('says not running with code 1 on a box with nothing started', () => {
    const r = run(['status'])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/not running/)
  })

  it('starts the router as a pi agent in a herdr tab, and reports it healthy', () => {
    expect(run(['start']).status).toBe(0)
    expect(routerStart()).toMatch(/^agent start superagent --kind pi --pane w1:p1 /)
    expect(routerTab()).toContain('--label engine')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_ROLE=router')
    expect(readFileSync(join(herdrDir, 'workspaces'), 'utf8').trim(), 'the router and its workers share one workspace').toBe('superagent')
    expect(run(['status']).status).toBe(0)
    expect(run(['status']).stdout).toMatch(/herdr agent superagent/)
  })

  it("waits for a new tab's shell instead of failing the start: that is how the first herdr restart failed", () => {
    expect(run(['start'], { FAKE_HERDR_BUSY: '2' }).status).toBe(0)
    expect(readFileSync(join(herdrDir, 'calls'), 'utf8').match(/agent start superagent/g)).toHaveLength(3)
  })

  it('without herdr there is no router: no other terminal to fall back to', () => {
    const r = run(['start'], { FAKE_HERDR_DOWN: '1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/herdr is not reachable/)
    expect(run(['status'], { FAKE_HERDR_DOWN: '1' }).status).toBe(1)
  })

  it('reads deployment settings from the state dir, so the health check and a hand restart agree', () => {
    writeFileSync(join(state, 'config.env'), '# deployment\nPI_SUPERAGENT_GITHUB_REPO=o/spike\nPI_SUPERAGENT_GITHUB_SELF=bot\nPI_SUPERAGENT_GITHUB_TOKEN_FILE=/s/github-token\n'
      + 'PI_SUPERAGENT_MAX_WORKERS=2\nPI_SUPERAGENT_BLOCKED=gh,ssh\nPI_SUPERAGENT_JUDGE_THINKING=high\nPI_SUPERAGENT_ALLOWED=alice,bob\n')
    expect(run(['start']).status).toBe(0)
    expect(routerTab()).toContain('--env PI_SUPERAGENT_GITHUB_REPO=o/spike')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_GITHUB_SELF=bot')
    expect(routerTab(), 'the path travels, never the token').toContain('--env PI_SUPERAGENT_GITHUB_TOKEN_FILE=/s/github-token')
    // herdr starts the tab from its own environment: a setting the script does not name never arrives.
    expect(routerTab()).toContain('--env PI_SUPERAGENT_MAX_WORKERS=2')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_BLOCKED=gh,ssh')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_JUDGE_THINKING=high')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_ALLOWED=alice,bob')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_HERDR_WORKSPACE=superagent')
  })

  it('starts the panel and hands the router herdr itself, but no SDK path: pi supplies its own', () => {
    expect(run(['start']).status).toBe(0)
    expect(routerTab()).toContain('--env PI_SUPERAGENT_PANEL_PORT=8799')
    expect(routerTab()).toContain(`--env PI_SUPERAGENT_HERDR_BIN=${FAKE}`)
    // A path from `npm root -g` named a second copy of pi, and a missing file for a pi installed any other way.
    expect(routerTab()).not.toContain('PI_SUPERAGENT_SDK_PATH')
  })

  it('an SDK entry file the operator sets still reaches the router', () => {
    expect(run(['start'], { PI_SUPERAGENT_SDK_PATH: '/opt/pi/dist/index.js' }).status).toBe(0)
    expect(routerTab()).toContain('--env PI_SUPERAGENT_SDK_PATH=/opt/pi/dist/index.js')
  })

  it('starts pi in one stable session, because a router on the session picker answers nothing', () => {
    expect(run(['start']).status).toBe(0)
    const id = /-- --session-id ([0-9a-f-]{36})/.exec(routerStart())?.[1]
    expect(id).toBeTruthy()
    // The extension refuses to be the router in any process whose command line lacks this id.
    expect(routerTab()).toContain(`--env PI_SUPERAGENT_SESSION_ID=${id}`)
    run(['stop']); run(['start'])
    expect(readFileSync(join(state, 'session-id'), 'utf8').trim()).toBe(id)
  })

  it('refuses to start a second router over a live one', () => {
    run(['start'])
    const r = run(['start'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/already running/)
  })

  it('reports a failing part with 2, and a setup requirement with 3', () => {
    run(['start'])
    writeFileSync(join(state, 'health.json'), '{"github":{"state":"error","detail":"cli offline"}}')
    expect(run(['status']).status).toBe(2)
    writeFileSync(join(state, 'setup.json'), '{"problem":{"code":"state-missing","place":"Deployment"}}')
    expect(run(['status']).status).toBe(3)
  })

  it('a stop asks pi to exit, closes the router tab, leaves a marker, and the check respects it', () => {
    run(['start'])
    expect(run(['stop']).status).toBe(0)
    const calls = readFileSync(join(herdrDir, 'calls'), 'utf8')
    expect(calls).toContain('agent send-keys superagent ctrl+c ctrl+c')
    expect(calls).toContain('tab close w1:t1')
    expect(existsSync(join(state, 'stopped'))).toBe(true)
    expect(run(['status']).status).toBe(0)
    expect(run(['status']).stdout).toMatch(/stopped by request/)
    expect(run(['--respect-stop', 'start']).stdout).toMatch(/left stopped/)
  })

  it('a router that will not exit loses its tab: its workers are their own sessions and stay', () => {
    run(['start'])
    const r = run(['stop'], { FAKE_HERDR_STUCK: '1' })
    expect(r.stderr).toMatch(/did not exit/)
    expect(readFileSync(join(herdrDir, 'calls'), 'utf8')).toContain('tab close w1:t1')
    expect(run(['status']).stdout).toMatch(/stopped by request/)
  })

  it('start clears an intentional stop, so a human restart works', () => {
    run(['start']); run(['stop'])
    expect(run(['start']).status).toBe(0)
    expect(existsSync(join(state, 'stopped'))).toBe(false)
  })

  it('--state moves everything: the stop marker, the place file and the settings stay out of the default', () => {
    // The harness's state dir stands in for a live router's; this run must leave it untouched.
    const other = join(state, '..', 'other-state')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'config.env'), 'PI_SUPERAGENT_GITHUB_REPO=o/other\n')
    writeFileSync(join(state, 'config.env'), 'PI_SUPERAGENT_GITHUB_REPO=o/live\n')
    const flags = ['--state', other]
    expect(run([...flags, 'start'], { FAKE_HERDR_READY: join(other, 'ready') }).status).toBe(0)
    expect(routerTab()).toContain('--env PI_SUPERAGENT_GITHUB_REPO=o/other')
    expect(existsSync(join(other, 'router.herdr'))).toBe(true)
    expect(run([...flags, 'stop']).status).toBe(0)
    expect(existsSync(join(other, 'stopped'))).toBe(true)
    expect(readdirSync(state).sort(), 'the default state dir gained nothing').toEqual(['config.env'])
  })

  it('an unknown flag is a usage error, not a silent success', () => {
    expect(run(['--deply', 'status']).status).toBe(2)
  })

  // Issue #314: the watched checkout kept its `repo`-scoped token in a 0644 .git/config, where all ~20 worker
  // sessions per run could read it and `git remote -v` could print it. The deploy is the last place that can
  // refuse it before the workers start.
  it('refuses to deploy over a watched checkout whose remote URL carries the credential', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-sa-watch-')); dirs.push(root)
    const watched = join(root, 'pi-superagent')
    mkdirSync(join(watched, '.git'), { recursive: true })
    const secret = `ghp_${'x'.repeat(36)}`
    writeFileSync(join(watched, '.git', 'config'), `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/kmatzen/pi-superagent.git\n`)
    const out = run(['start'], { PI_SUPERAGENT_WATCHED_CHECKOUTS: watched })
    expect(out.status, out.stderr).toBe(1)
    expect(out.stderr).toMatch(/carries a git credential in the clear/)
    expect(out.stderr).toMatch(/remote set-url origin/)
    expect(out.stderr).toContain('x-access-token:***@github.com')
    expect(out.stderr, 'the guard must not publish the token it found').not.toContain(secret)
    expect(existsSync(join(herdrDir, 'calls')), 'nothing was started').toBe(false)
    // The same checkout with the credential moved out of the URL deploys, so the guard costs nothing when clean.
    writeFileSync(join(watched, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/kmatzen/pi-superagent.git\n')
    expect(run(['start'], { PI_SUPERAGENT_WATCHED_CHECKOUTS: `${watched}:${watched}` }).status, 'a clean URL deploys').toBe(0)
  })

  it('refuses a ticket checkout that came back with a credential in its remote', () => {
    const secret = `ghp_${'y'.repeat(36)}`
    mkdirSync(join(state, 'work', 'TK-7', '.git'), { recursive: true })
    writeFileSync(join(state, 'work', 'TK-7', '.git', 'config'), `[credential]\n\thelper = !f(){ echo password=${secret}; }; f\n`)
    const out = run(['start'])
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/work\/TK-7\/\.git\/config/)
    expect(out.stderr).toContain('password=ghp_***')
    expect(out.stderr).not.toContain(secret)
  })

  it('refuses a ticket checkout that is a linked worktree, where the remotes live in the common dir', () => {
    // Measured: 2 of the live ticket checkouts are `git worktree add` checkouts, whose `.git` is a FILE
    // pointing at <repo>/.git/worktrees/<name>. Reading only <checkout>/.git/config walks straight past them,
    // and the credential sits in the COMMON dir's config.
    const secret = `ghp_${'z'.repeat(36)}`
    const source = join(state, 'source-repo')
    execFileSync('git', ['init', '-q', source])
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'seed'], { cwd: source })
    execFileSync('git', ['-C', source, 'remote', 'add', 'origin', `https://x-access-token:${secret}@github.com/kmatzen/pi-superagent.git`])
    mkdirSync(join(state, 'work'), { recursive: true })
    execFileSync('git', ['-C', source, 'worktree', 'add', '-q', '-b', 'ticket', join(state, 'work', 'TK-9')])
    expect(existsSync(join(state, 'work', 'TK-9', '.git', 'config')), 'a linked worktree has no config of its own').toBe(false)
    const out = run(['start'])
    expect(out.status, out.stderr).toBe(1)
    expect(out.stderr, 'the common dir is the file that holds the credential').toContain(join('source-repo', '.git', 'config'))
    expect(out.stderr).toContain('x-access-token:***@github.com')
    expect(out.stderr, 'the guard must not publish the token it found').not.toContain(secret)
    expect(existsSync(join(herdrDir, 'calls')), 'nothing was started').toBe(false)
  })

  it('refuses the checkout a worker cloned itself: work/<ticket>/repo, one level below the ticket dir', () => {
    // The ticket prompt tells a worker to clone into its workspace, so the checkout lands at
    // <worktrees>/<ticket>/repo/. Measured on the live box: 26 of the 29 ticket checkouts are that shape, and
    // the one holding the exposed token today is one of them. Scanning only <worktrees>/<ticket>/.git says
    // "clean" about the deployment as it actually runs, then starts the router over the leak.
    const secret = `ghp_${'w'.repeat(36)}`
    mkdirSync(join(state, 'work', 'TK-11', 'repo', '.git'), { recursive: true })
    writeFileSync(join(state, 'work', 'TK-11', 'repo', '.git', 'config'), `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/kmatzen/pi-superagent.git\n`)
    const out = run(['start'])
    expect(out.status, out.stderr).toBe(1)
    expect(out.stderr).toContain(join('work', 'TK-11', 'repo', '.git', 'config'))
    expect(out.stderr).toContain('x-access-token:***@github.com')
    expect(out.stderr, 'the guard must not publish the token it found').not.toContain(secret)
    expect(existsSync(join(herdrDir, 'calls')), 'nothing was started').toBe(false)
    // Depth is bounded: a nested `.git` three levels down (a vendored dependency) is not scanned, so the
    // guard costs one directory listing at start, not a walk of a 2 GB tree.
    mkdirSync(join(state, 'work', 'TK-12', 'repo', 'vendor', 'dep', '.git'), { recursive: true })
    writeFileSync(join(state, 'work', 'TK-12', 'repo', 'vendor', 'dep', '.git', 'config'), `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/o/r.git\n`)
    rmSync(join(state, 'work', 'TK-11', 'repo', '.git', 'config'), { force: true })
    mkdirSync(join(state, 'work', 'TK-11', 'repo', '.git'), { recursive: true })
    writeFileSync(join(state, 'work', 'TK-11', 'repo', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/kmatzen/pi-superagent.git\n')
    expect(run(['start']).status, 'a clean tree of checkouts deploys').toBe(0)
  })
})

  it('intake labels the issues it is asked for, in ranges and lists, and refuses a bad spec', () => {
    const bin = join(state, 'bin'); mkdirSync(bin, { recursive: true })
    const calls = join(state, 'curl.calls')
    writeFileSync(join(state, 'token'), 'secret-token\n')
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CURL_LOG"\n[ "$1" = "-s" ] && echo 200\nexit 0\n')
    chmodSync(join(bin, 'curl'), 0o755)
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`, CURL_LOG: calls,
      PI_SUPERAGENT_GITHUB_REPO: 'o/r', PI_SUPERAGENT_GITHUB_TOKEN_FILE: join(state, 'token'),
    }
    const ok = spawnSync(SCRIPT, ['intake', '3-5,7'], { encoding: 'utf8', env: { ...process.env, PI_SUPERAGENT_STATE: state, ...env } })
    expect(ok.stdout, ok.stderr).toContain('labelled 4 issue(s) as requests, 0 failed')
    const body = readFileSync(calls, 'utf8')
    expect(body.match(/issues\/[3-57]\/labels/g)?.sort(), 'every number, ranges expanded')
      .toEqual(['issues/3/labels', 'issues/4/labels', 'issues/5/labels', 'issues/7/labels'])
    expect(body).toContain('agent-requested')
    const bad = spawnSync(SCRIPT, ['intake', 'banana'], { encoding: 'utf8', env: { ...process.env, PI_SUPERAGENT_STATE: state, ...env } })
    expect(bad.status, 'a typo is not a request for 0 issues').toBe(2)
  })
