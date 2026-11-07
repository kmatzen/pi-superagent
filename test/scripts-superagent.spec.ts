import { spawnSync } from 'node:child_process'
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
})
