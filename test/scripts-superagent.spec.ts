import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    writeFileSync(join(state, 'config.env'), '# deployment\nPI_SUPERAGENT_GITHUB_REPO=o/spike\nPI_SUPERAGENT_GITHUB_SELF=bot\n'
      + 'PI_SUPERAGENT_MAX_WORKERS=2\nPI_SUPERAGENT_BLOCKED=gh,ssh\nPI_SUPERAGENT_JUDGE_THINKING=high\n')
    expect(run(['start']).status).toBe(0)
    expect(routerTab()).toContain('--env PI_SUPERAGENT_GITHUB_REPO=o/spike')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_GITHUB_SELF=bot')
    // herdr starts the tab from its own environment: a setting the script does not name never arrives.
    expect(routerTab()).toContain('--env PI_SUPERAGENT_MAX_WORKERS=2')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_BLOCKED=gh,ssh')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_JUDGE_THINKING=high')
    expect(routerTab()).toContain('--env PI_SUPERAGENT_HERDR_WORKSPACE=superagent')
  })

  it('starts the panel, and gives the router the SDK entry file and herdr itself', () => {
    expect(run(['start']).status).toBe(0)
    expect(routerTab()).toContain('--env PI_SUPERAGENT_PANEL_PORT=8799')
    expect(routerTab()).toMatch(/--env PI_SUPERAGENT_SDK_PATH=\S*pi-coding-agent\/dist\/index\.js/)
    expect(routerTab()).toContain(`--env PI_SUPERAGENT_HERDR_BIN=${FAKE}`)
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

  it('an unknown flag is a usage error, not a silent success', () => {
    expect(run(['--deply', 'status']).status).toBe(2)
  })

  it('hands the router the token file path: the path is a setting, the token in it is not', () => {
    writeFileSync(join(state, 'config.env'), 'PI_SUPERAGENT_GITHUB_REPO=o/spike\n'
      + 'PI_SUPERAGENT_GITHUB_TOKEN_FILE=/etc/superagent/github.token\n')
    expect(run(['start']).status).toBe(0)
    expect(routerTab()).toContain('--env PI_SUPERAGENT_GITHUB_TOKEN_FILE=/etc/superagent/github.token')
  })

  // A fake `gh` on PATH answers `api user --jq .login`, the only question `identity` asks GitHub.
  const withGh = (login: string, rc = 0) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pi-sa-gh-')), 'bin')
    mkdirSync(dir, { recursive: true }); dirs.push(join(dir, '..'))
    writeFileSync(join(dir, 'gh'), `#!/bin/bash\n[ "$2" = user ] || exit 0\n[ "${rc}" = 0 ] && echo ${login} && exit 0\necho "bad credentials" >&2\nexit ${rc}\n`)
    chmodSync(join(dir, 'gh'), 0o755)
    return { PATH: `${dir}:${process.env.PATH}` }
  }

  it('identity asks GitHub whose account the agent will post from', () => {
    const token = join(state, 'github.token')
    writeFileSync(token, 'ghp_agent\n'); chmodSync(token, 0o600)
    const r = run(['identity'], { ...withGh('agent-bot'), PI_SUPERAGENT_GITHUB_SELF: 'agent-bot',
      PI_SUPERAGENT_GITHUB_REPO: 'o/spike' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/speaks as: agent-bot \(token file .*github\.token\)/)
    expect(r.stdout).toMatch(/repo: +o\/spike/)
    expect(r.stdout).toMatch(/PI_SUPERAGENT_GITHUB_SELF=agent-bot matches/)
  })

  it('identity refuses a credential that is not the account the config names: that is a receipt by the wrong author', () => {
    const token = join(state, 'github.token')
    writeFileSync(token, 'ghp_operator\n'); chmodSync(token, 0o600)
    const r = run(['identity'], { ...withGh('matzen_adobe'), PI_SUPERAGENT_GITHUB_SELF: 'agent-bot' })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/speaks as: matzen_adobe/)
    expect(r.stderr).toMatch(/does NOT match/)
  })

  it('identity says when GitHub will not accept the credential, instead of claiming an identity', () => {
    const token = join(state, 'github.token')
    writeFileSync(token, 'ghp_revoked\n'); chmodSync(token, 0o600)
    const r = run(['identity'], { ...withGh('agent-bot', 4) })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/GitHub refused the credential/)
  })

  it('identity names the shared-account default it is running under', () => {
    const r = run(['identity'], withGh('matzen_adobe'))
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/speaks as: matzen_adobe \(gh's own sign-in/)
    expect(r.stdout).toMatch(/share an account/)
  })

  it('warns when the token file is readable by anyone but you', () => {
    const token = join(state, 'github.token')
    writeFileSync(token, 'ghp_agent\n'); chmodSync(token, 0o644)
    const r = run(['identity'], withGh('agent-bot'))
    expect(r.stderr).toMatch(/not mode 600/)
  })
})
