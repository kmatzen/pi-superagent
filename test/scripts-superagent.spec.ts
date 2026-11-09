import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs: string[] = []
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'superagent')
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-herdr')
chmodSync(FAKE, 0o755)

// One panel port for this run of the file, taken from the ephemeral range the way scripts/check-packed takes
// its own. 8799 was a box-wide constant, so every case wanted the same port: a second run of this file on the
// box — a gate and a worker, which is the normal case here — collided with the squatter case, which owns the
// port for its whole duration by design, and the loser's start cases failed the refuse-to-start path in ~200 ms.
// A green commit read red, and no reader could tell that from a broken start script.
const PANEL_PORT = await new Promise<number>(resolve => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const port = (probe.address() as AddressInfo).port
    probe.close(() => resolve(port))
  })
})
// Who holds the panel's port right now, for a failing start to name: "pid 4242 is holding it" reads as a
// second run on this box, where exit code 1 alone reads as "the commit broke the start script".
const portHolders = () => spawnSync('lsof', ['-nP', '-ti', `tcp:${PANEL_PORT}`], { encoding: 'utf8' }).stdout.trim().replace(/\s+/g, ' ') || 'nobody'
const portHint = () => `panel port ${PANEL_PORT} is held by pid(s): ${portHolders()}`
const portFree = () => vi.waitFor(() => new Promise<void>((resolve, reject) => {
  const probe = createServer()
  probe.once('error', e => reject(new Error(`${portHint()}: ${(e as NodeJS.ErrnoException).code}`)))
  probe.listen(PANEL_PORT, '127.0.0.1', () => probe.close(() => resolve()))
}), { timeout: 5000 })

let state: string, herdrDir: string
// Every run of this file takes its env through here, so a case that needs its own setting says so in one
// place — and so the guard's cases can run the same command from a binary of their choosing.
const envFor = (extra: Record<string, string> = {}) => ({
  ...process.env, PI_SUPERAGENT_STATE: state, PI_SUPERAGENT_HERDR: FAKE, PI_SUPERAGENT_GRACE: '1', FAKE_HERDR_DIR: herdrDir,
  PI_SUPERAGENT_PANEL_PORT: String(PANEL_PORT), FAKE_HERDR_READY: join(state, 'ready'), ...extra,
})
const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(SCRIPT, args, { encoding: 'utf8', env: envFor(extra) })
/** The same command from a binary of the test's choosing: the guard must hold when `superagent` is a symlink. */
const runFrom = (bin: string, args: string[], extra: Record<string, string> = {}) => spawnSync(bin, args, { encoding: 'utf8', env: envFor(extra) })
// Every case that needs a router: a start that failed says what it hit, port and pid included.
const started = (extra: Record<string, string> = {}) => {
  const r = run(['start'], extra)
  expect(r.status, `${portHint()}\n${r.stderr}`).toBe(0)
  return r
}
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
    // The scheduled health check runs `start`, and `start` frees the panel's port. A dev server that owns the
    // port is the operator's work, not a stale panel, so killing it is the defect this guards. It squats this
    // run's port, so the squat cannot reach a concurrent run of this file — the port was the only shared name
    // these cases had, and the case that owns it is the one a second run used to trip over.
    const squatter = spawn(process.execPath,
      ['-e', `require('http').createServer((_q,r)=>r.end('mine')).listen(${PANEL_PORT},'127.0.0.1')`], { stdio: 'ignore' })
    try {
      await vi.waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${PANEL_PORT}`).catch(() => null)
        expect(r?.status, 'the squatter is listening').toBe(200)
      }, { timeout: 5000 })
      const out = run(['start'])
      expect(out.status, out.stderr).not.toBe(0)
      expect(out.stderr).toMatch(/not this router/)
      expect(out.stderr, 'the refusal names the port and the pid, so a worker reads "second run on this box"')
        .toMatch(new RegExp(`port ${PANEL_PORT} .*pid (\\d+)`))
      const alive = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${PANEL_PORT}').then(r=>r.text()).then(t=>process.exit(t==='mine'?0:1))`], { encoding: 'utf8' })
      expect(alive.status, 'the squatter stayed alive and answered').toBe(0)
    } finally {
      // Kill it and wait for the port: a case that starts while the squatter is still closing hits the same
      // refusal this file guards, and under a parallel load the close is not instantaneous.
      squatter.kill()
      await new Promise<void>(resolve => squatter.once('exit', () => resolve()))
      await portFree()
    }
  })

  it('every case starts on a port this run took, so two runs of this file cannot collide on one box', () => {
    expect(PANEL_PORT, 'an ephemeral port, not the box-wide constant the runs collided on').toBeGreaterThan(1024)
    started()
    expect(routerTab()).toContain(`--env PI_SUPERAGENT_PANEL_PORT=${PANEL_PORT}`)
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
    started()
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
    const healed = run(['remedy'], { FAKE_HERDR_DOWN: '1' })
    expect(healed.stdout + healed.stderr).toMatch(/herdr is not reachable/)
    expect(healed.status, 'a remedy that could not bring the router back is a failing health job').toBe(1)
  })

  it('reads deployment settings from the state dir, so the health check and a hand restart agree', () => {
    writeFileSync(join(state, 'config.env'), '# deployment\nPI_SUPERAGENT_GITHUB_REPO=o/spike\nPI_SUPERAGENT_GITHUB_SELF=bot\nPI_SUPERAGENT_GITHUB_TOKEN_FILE=/s/github-token\n'
      + 'PI_SUPERAGENT_MAX_WORKERS=2\nPI_SUPERAGENT_BLOCKED=gh,ssh\nPI_SUPERAGENT_JUDGE_THINKING=high\nPI_SUPERAGENT_ALLOWED=alice,bob\n')
    started()
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
    started()
    expect(routerTab()).toContain(`--env PI_SUPERAGENT_PANEL_PORT=${PANEL_PORT}`)
    expect(routerTab()).toContain(`--env PI_SUPERAGENT_HERDR_BIN=${FAKE}`)
    // A path from `npm root -g` named a second copy of pi, and a missing file for a pi installed any other way.
    expect(routerTab()).not.toContain('PI_SUPERAGENT_SDK_PATH')
  })

  it('an SDK entry file the operator sets still reaches the router', () => {
    expect(run(['start'], { PI_SUPERAGENT_SDK_PATH: '/opt/pi/dist/index.js' }).status, portHint()).toBe(0)
    expect(routerTab()).toContain('--env PI_SUPERAGENT_SDK_PATH=/opt/pi/dist/index.js')
  })

  it('starts pi in one stable session, because a router on the session picker answers nothing', () => {
    started()
    const id = /-- --session-id ([0-9a-f-]{36})/.exec(routerStart())?.[1]
    expect(id).toBeTruthy()
    // The extension refuses to be the router in any process whose command line lacks this id.
    expect(routerTab()).toContain(`--env PI_SUPERAGENT_SESSION_ID=${id}`)
    run(['stop']); run(['start'])
    expect(readFileSync(join(state, 'session-id'), 'utf8').trim()).toBe(id)
  })

  it('refuses to start a second router over a live one', () => {
    started()
    const r = run(['start'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/already running/)
  })

  it('reports a failing part with 4, and a setup requirement with 3', () => {
    started()
    writeFileSync(join(state, 'health.json'), '{"github":{"state":"error","detail":"cli offline"}}')
    expect(run(['status']).status, 'a part a restart cannot fix is not the stall a restart fixes').toBe(4)
    writeFileSync(join(state, 'setup.json'), '{"problem":{"code":"state-missing","place":"Deployment"}}')
    expect(run(['status']).status).toBe(3)
  })

  it('a stalled tick block is 2: up, and not beating, which is the fault a restart clears', () => {
    started()
    writeFileSync(join(state, 'health.json'), '{"runtime":{"state":"ready"},"tick":{"state":"error","stage":"poll","detail":"stalled in poll 240000ms"},"source":{"state":"ok"}}')
    const r = run(['status'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/running and not beating:.*stalled in poll/)
  })

  it('a health.json the router stopped writing is a failing part: a wedged loop reports nothing', () => {
    // The tick loop rewrites health.json on every pass, so the file going quiet is the same fault as a stalled
    // tick — and the only form visible when the router itself is the wedged thing, unable to report its stall.
    started()
    const file = join(state, 'health.json')
    writeFileSync(file, '{"runtime":{"state":"ready"},"tick":{"state":"ok","n":12}}')
    expect(run(['status']).status, 'a fresh file that says ok is healthy').toBe(0)
    const old = new Date(Date.now() - 20 * 60_000 - 5_000)   // 20 whole minutes, and the age line floors
    utimesSync(file, old, old)
    const r = run(['status'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/health.json is 20 min old: the tick loop that writes it is not running/)
    expect(run(['status'], { PI_SUPERAGENT_HEALTH_STALE_MIN: '60' }).status, 'the dial is the operator\'s').toBe(0)
  })

  it('remedy starts a router that is down, and leaves a healthy one untouched', () => {
    const up = run(['--respect-stop', 'remedy'])
    expect(up.stdout, up.stderr).toMatch(/not running: superagent start; starting the router/)
    expect(existsSync(join(herdrDir, 'agent.superagent'))).toBe(true)
    const before = readFileSync(join(herdrDir, 'calls'), 'utf8')
    const healthy = run(['--respect-stop', 'remedy'])
    expect(healthy.stdout).toMatch(/running: herdr agent superagent.*nothing to do/)
    expect(healthy.status).toBe(0)
    // status asks herdr one question; a healthy router costs the health check no change to herdr at all.
    const mutations = (s: string) => (s.match(/tab create|tab close|agent start|send-keys/g) ?? []).length
    expect(mutations(readFileSync(join(herdrDir, 'calls'), 'utf8')), 'no tab, no keys, no start').toBe(mutations(before))
    expect(existsSync(join(state, 'watchdog-restart')), 'no restart, so no restart record').toBe(false)
  })

  it('remedy restarts a router that is up and not beating: start refuses it, so only a restart recovers', () => {
    // The gap this closes: with the tick loop parked, `status` failed and the job's one remedy, `start`,
    // answered "already running" — every five minutes, forever, with the board stopped.
    started()
    writeFileSync(join(state, 'health.json'), '{"runtime":{"state":"ready"},"tick":{"state":"error","stage":"poll","detail":"stalled in poll 240000ms"}}')
    const r = run(['--respect-stop', 'remedy'])
    expect(r.stdout).toMatch(/running and not beating.*restarting the router/)
    const calls = readFileSync(join(herdrDir, 'calls'), 'utf8')
    expect(calls).toContain('tab close w1:t1')
    expect(calls.match(/agent start superagent/g), 'stopped, then started again').toHaveLength(2)
    expect(existsSync(join(herdrDir, 'agent.superagent')), 'and a router is running for the next pass').toBe(true)
    // The fake router writes no health of its own, so this pass ends on the old file and reports 2; a real
    // router rewrites health.json on its first beat, and the next pass reads 0 with no restart to make.
    expect(r.status).toBe(2)
    writeFileSync(join(state, 'health.json'), '{"runtime":{"state":"ready"},"tick":{"state":"ok","n":1}}')
    expect(run(['status']).status, 'the stall is gone, so the remedy is over').toBe(0)
  })

  it('a health.json nobody rewrote restarts too: the loop that writes it is the loop that died', () => {
    started()
    const file = join(state, 'health.json')
    writeFileSync(file, '{"runtime":{"state":"ready"},"tick":{"state":"ok","n":12}}')
    const old = new Date(Date.now() - 20 * 60_000 - 5_000)
    utimesSync(file, old, old)
    const r = run(['--respect-stop', 'remedy'])
    expect(r.stdout).toMatch(/health.json is 20 min old: the tick loop that writes it is not running.*restarting the router/)
    expect(existsSync(join(state, 'watchdog-restart'))).toBe(true)
  })

  it('the stall restart is rate limited, so a fault a restart cannot fix cannot restart the router forever', () => {
    started()
    const stalled = '{"runtime":{"state":"ready"},"tick":{"state":"error","stage":"poll"}}'
    writeFileSync(join(state, 'health.json'), stalled)
    expect(run(['--respect-stop', 'remedy']).stdout).toMatch(/restarting the router/)
    writeFileSync(join(state, 'health.json'), stalled)   // the new router never came up beating
    const second = run(['--respect-stop', 'remedy'])
    expect(second.stdout).toMatch(/restart suppressed, the last one was 0 min ago \(cooldown 30 min\)/)
    expect(second.status, 'a suppressed restart is not a failing health job').toBe(0)
    expect(readFileSync(join(herdrDir, 'calls'), 'utf8').match(/agent start superagent/g)).toHaveLength(2)
    writeFileSync(join(state, 'health.json'), stalled)
    expect(run(['--respect-stop', 'remedy'], { PI_SUPERAGENT_RESTART_COOLDOWN_MIN: '0' }).stdout)
      .toMatch(/restarting the router/)
  })

  it('remedy names a part a restart cannot fix and leaves it alone: code 4 is an alarm, not a restart', () => {
    started()
    writeFileSync(join(state, 'health.json'), '{"runtime":{"state":"ready"},"source":{"state":"error","detail":"github poll failed 3x"}}')
    const r = run(['--respect-stop', 'remedy'])
    expect(r.stdout).toMatch(/running with 1 failing part\(s\):.*github poll failed.*nothing to do, a restart will not fix it/)
    expect(readFileSync(join(herdrDir, 'calls'), 'utf8').match(/agent start superagent/g)).toHaveLength(1)
  })

  it('remedy keeps a deliberate stop deliberate, with no flag to remind it', () => {
    started(); run(['stop'])
    const calls = readFileSync(join(herdrDir, 'calls'), 'utf8')
    const r = run(['remedy'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/manual stop marker present, leaving the router stopped/)
    expect(readFileSync(join(herdrDir, 'calls'), 'utf8')).toBe(calls)
    expect(existsSync(join(herdrDir, 'agent.superagent'))).toBe(false)
  })

  it('a remedy whose restart fails leaves no stop marker, so the next pass sees a router that is down', () => {
    // `stop` writes the manual-stop marker as a matter of record. Left behind by a start that failed, it reads
    // as "the operator stopped this on purpose": code 0, and the health check goes quiet on a router that is
    // simply not running.
    started()
    writeFileSync(join(state, 'health.json'), '{"runtime":{"state":"ready"},"tick":{"state":"error","stage":"poll"}}')
    rmSync(join(state, 'ready'))   // so the start this restart performs cannot finish on the old ready file
    const r = run(['--respect-stop', 'remedy'], { PI_SUPERAGENT_READY_WAIT: '1', FAKE_HERDR_READY: state })
    expect(r.stdout + r.stderr).toMatch(/the router did not report ready/)
    expect(r.status, 'a pass that leaves the router not beating is not a clean bill of health').toBe(2)
    expect(existsSync(join(state, 'stopped'))).toBe(false)
    expect(run(['status']).status, 'the next pass keeps working on it, instead of honouring a stop nobody made').toBe(2)
  })

  it('a stop asks pi to exit, closes the router tab, leaves a marker, and the check respects it', () => {
    started()
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
    started()
    const r = run(['stop'], { FAKE_HERDR_STUCK: '1' })
    expect(r.stderr).toMatch(/did not exit/)
    expect(readFileSync(join(herdrDir, 'calls'), 'utf8')).toContain('tab close w1:t1')
    expect(run(['status']).stdout).toMatch(/stopped by request/)
  })

  it('start clears an intentional stop, so a human restart works', () => {
    started(); run(['stop'])
    expect(run(['start']).status, portHint()).toBe(0)
    expect(existsSync(join(state, 'stopped'))).toBe(false)
  })

  it('--state moves everything: the stop marker, the place file and the settings stay out of the default', () => {
    // The harness's state dir stands in for a live router's; this run must leave it untouched.
    const other = join(state, '..', 'other-state')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'config.env'), 'PI_SUPERAGENT_GITHUB_REPO=o/other\n')
    writeFileSync(join(state, 'config.env'), 'PI_SUPERAGENT_GITHUB_REPO=o/live\n')
    const flags = ['--state', other]
    expect(run([...flags, 'start'], { FAKE_HERDR_READY: join(other, 'ready') }).status, portHint()).toBe(0)
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

  it('refuses a leaked credential when the command it is running is a symlink into the checkout', () => {
    // The install shape the operator's PATH points at: `<prefix>/bin/superagent` is a LINK into the package
    // (npm's global install leaves one, and a hand link into a checkout is the documented alternative). Then
    // BASH_SOURCE names the link, and a REPO_ROOT built from its dirname is `<prefix>`: no checkout there, so
    // the scan finds nothing, prints nothing, and the deploy proceeds over the leaked checkout below. Measured
    // on a linked install before the fix: `start` exited 0. The guard's own path is part of what it guards.
    const root = mkdtempSync(join(tmpdir(), 'pi-sa-link-')); dirs.push(root)
    const checkout = join(root, 'prefix', 'lib', 'node_modules', 'pi-superagent')
    mkdirSync(join(checkout, 'scripts'), { recursive: true })
    mkdirSync(join(checkout, '.git'), { recursive: true })
    const secret = `ghp_${'s'.repeat(36)}`
    writeFileSync(join(checkout, '.git', 'config'), `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/kmatzen/pi-superagent.git\n`)
    const target = join(checkout, 'scripts', 'superagent')
    copyFileSync(SCRIPT, target); chmodSync(target, 0o755)
    const link = join(root, 'superagent')
    symlinkSync(target, link)

    const out = runFrom(link, ['start'])
    expect(out.status, out.stderr).toBe(1)
    expect(out.stderr).toMatch(/carries a git credential in the clear/)
    expect(out.stderr).toMatch(/pi-superagent\/\.git\/config line 2/) // realpath may add a /private prefix
    expect(out.stderr, 'the guard must not publish the token it found').not.toContain(secret)
    expect(existsSync(join(herdrDir, 'calls')), 'nothing was started').toBe(false)
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
    // With the ticket checkout's own URL cleaned, the tree deploys — the nested leak above is the depth bound.
    writeFileSync(join(state, 'work', 'TK-11', 'repo', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/kmatzen/pi-superagent.git\n')
    expect(run(['start']).status, 'a clean tree of checkouts deploys').toBe(0)
  })

  it('a restart on a box that leaked mid-life leaves the fleet down: the guard refuses to bring it back', () => {
    // The consequence of putting the guard in `start` has to be written down and pinned, because `restart` is
    // `stop; start` and the scheduled health check is `status || start`. A checkout that gains a credential
    // while the router runs therefore ENDS the fleet: the router is stopped, then the start is refused. That
    // is the intended posture — do not wake ~20 workers over a disclosed credential — but the operator has to
    // know the fix is the URL, not a second restart.
    const secret = `ghp_${'q'.repeat(36)}`
    mkdirSync(join(state, 'work', 'TK-14', 'repo', '.git'), { recursive: true })
    writeFileSync(join(state, 'work', 'TK-14', 'repo', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/kmatzen/pi-superagent.git\n')
    expect(run(['start']).status, 'the fleet comes up clean').toBe(0)
    expect(existsSync(join(herdrDir, 'agent.superagent'))).toBe(true)
    // A worker bakes the token into the remote while the router is live.
    writeFileSync(join(state, 'work', 'TK-14', 'repo', '.git', 'config'), `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/kmatzen/pi-superagent.git\n`)
    const out = run(['restart'])
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/carries a git credential in the clear/)
    expect(out.stderr).not.toContain(secret)
    expect(existsSync(join(herdrDir, 'agent.superagent')), 'the router is stopped, and the refusal is the whole message').toBe(false)
    const calls = readFileSync(join(herdrDir, 'calls'), 'utf8')
    expect(calls.match(/agent start superagent/g), 'no second start: the fleet stays down until the URL is fixed').toHaveLength(1)
    // Fix the URL and the same restart brings it back, so the guard is a door and not a wall.
    writeFileSync(join(state, 'work', 'TK-14', 'repo', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/kmatzen/pi-superagent.git\n')
    expect(run(['restart']).status, 'a clean URL restarts').toBe(0)
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
