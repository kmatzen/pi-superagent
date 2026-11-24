import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
// The probe counts an engine by name (`comm`), so the pilot is a copy of /bin/sleep named `pi`: without it
// every `started()` here is a tab with no engine behind it, which `status` now calls code 2, not healthy.
const pilotDir = mkdtempSync(join(tmpdir(), 'pi-sa-pilot-'))
const PILOT = join(pilotDir, 'pi')
copyFileSync('/bin/sleep', PILOT)
// Every run of this file takes its env through here, so a case that needs its own setting says so in one
// place — and so the guard's cases can run the same command from a binary of their choosing.
const envFor = (extra: Record<string, string> = {}) => ({
  ...process.env, PI_SUPERAGENT_STATE: state, PI_SUPERAGENT_HERDR: FAKE, PI_SUPERAGENT_GRACE: '1', FAKE_HERDR_DIR: herdrDir,
  PI_SUPERAGENT_PANEL_PORT: String(PANEL_PORT), FAKE_HERDR_READY: join(state, 'ready'),
  FAKE_HERDR_ENGINE: PILOT,
  // The checkout these tests run from is often mid-edit; the guard on it has its own test.
  PI_SUPERAGENT_ALLOW_DIRTY: '1', ...extra,
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
afterAll(() => {
  // The fixture's engine names itself only in the file it records, and a `sleep 600` left per case is a leak.
  for (const d of dirs) {
    try { process.kill(Number(readFileSync(join(d, 'herdr', 'engine.pid'), 'utf8')), 'SIGKILL') } catch { /* never started */ }
    rmSync(d, { recursive: true, force: true })
  }
  rmSync(pilotDir, { recursive: true, force: true })
})

// Each run starts several processes (bash, node for herdr's JSON, the fake herdr): seconds under a full suite.
// A restart now proves the engine stopped — SIGTERM, the grace, SIGKILL, the panel port — so
// the cases that run several of them need more than the file's 30s when the box is busy.
const restartCase = { timeout: 90_000 }

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

  it('frees the panel port when the router recorded that pid as its own panel', async () => {
    // The refusal above is right about a stranger and fatal about us: our router rewrites its process title, so
    // `ps` shows no environment, the guard saw a squatter, and `restart` (stop, then refuse) left the fleet on
    // the old build. The pid the router recorded when it bound the panel is the second proof, and it is the
    // narrowest question available: this exact pid. The squatter reports its own, as the router does — lsof mixes clients with listeners.
    const selfPid = join(state, 'squatter.pid')
    const squatter = spawn(process.execPath,
      ['-e', `require('fs').writeFileSync(process.argv[1], String(process.pid));`
        + `require('http').createServer((_q,r)=>r.end('mine')).listen(${PANEL_PORT},'127.0.0.1'); setInterval(()=>{},1000)`,
        selfPid], { stdio: 'ignore' })
    try {
      await vi.waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${PANEL_PORT}`).catch(() => null)
        expect(r?.status, 'the panel is listening').toBe(200)
      }, { timeout: 5000 })
      await vi.waitFor(() => expect(existsSync(selfPid), 'the panel recorded its pid').toBe(true), { timeout: 5000 })
      const holder = readFileSync(selfPid, 'utf8').trim()
      expect(holder, 'the port owner knows its own pid').toMatch(/^\d+$/)
      writeFileSync(join(state, 'panel.pid'), `${holder}\n`) // what the router wrote when it bound this port
      const out = run(['start'])
      expect(out.status, `${portHint()}\n${out.stderr}`).toBe(0)
      expect(routerTab(), 'the new router starts on the port the old one held').toContain(`PI_SUPERAGENT_PANEL_PORT=${PANEL_PORT}`)
      expect(squatter.pid, 'the recorded pid is the process that held the port').toBe(Number(holder))
      await vi.waitFor(() => expect(portHolders(), 'the recorded panel was freed for the new one').not.toContain(holder),
        { timeout: 10_000 })
    } finally {
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

  it('remedy restarts a router that is up and not beating: start refuses it, so only a restart recovers', restartCase, () => {
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

  it('a health.json nobody rewrote restarts too: the loop that writes it is the loop that died', restartCase, () => {
    started()
    const file = join(state, 'health.json')
    writeFileSync(file, '{"runtime":{"state":"ready"},"tick":{"state":"ok","n":12}}')
    const old = new Date(Date.now() - 20 * 60_000 - 5_000)
    utimesSync(file, old, old)
    const r = run(['--respect-stop', 'remedy'])
    expect(r.stdout).toMatch(/health.json is 20 min old: the tick loop that writes it is not running.*restarting the router/)
    expect(existsSync(join(state, 'watchdog-restart'))).toBe(true)
  })

  it('a healthy beat clears the restart cooldown: a loop that dies in the boot after a watchdog restart dies within reach of the watchdog again', restartCase, () => {
    // The 2026-11-11 outage lasted 25 min: the watchdog restarted the router, the loop died in that boot, and
    // the cooldown refused to touch it for its full window.
    started()
    const stalled = '{"runtime":{"state":"ready"},"tick":{"state":"error","stage":"poll"}}'
    writeFileSync(join(state, 'health.json'), stalled)
    expect(run(['--respect-stop', 'remedy']).stdout).toMatch(/restarting the router/)
    expect(existsSync(join(state, 'watchdog-restart'))).toBe(true)
    writeFileSync(join(state, 'health.json'), '{"runtime":{"state":"ready"},"tick":{"state":"ok","n":1}}')
    expect(run(['--respect-stop', 'remedy']).stdout).toMatch(/nothing to do/)
    expect(existsSync(join(state, 'watchdog-restart')), 'the beat proved the restart worked').toBe(false)
    writeFileSync(join(state, 'health.json'), stalled)
    expect(run(['--respect-stop', 'remedy']).stdout, 'a second death is not swallowed by the cooldown of the recovery that preceded it').toMatch(/restarting the router/)
  })

  it('backup keeps one sqlite-safe copy of the database per day, and the last 14 days', () => {
    execFileSync('sqlite3', [join(state, 'tickets.db'), 'create table t(x); insert into t values (42);'])
    expect(run(['backup']).status).toBe(0)
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const dest = join(state, 'archive', `tickets-${day}.db`)
    expect(existsSync(dest), "today's copy").toBe(true)
    expect(execFileSync('sqlite3', [dest, 'select x from t']).toString().trim(), 'the copy is readable').toBe('42')
    expect(run(['backup']).stdout).toMatch(/today's copy exists/)
    rmSync(dest)
    for (let i = 1; i <= 15; i++) {
      const old = join(state, 'archive', `tickets-202610${String(i).padStart(2, '0')}.db`)
      writeFileSync(old, 'x')
      const when = new Date(Date.parse('2026-10-01T00:00:00Z') + i * 86_400_000)
      utimesSync(old, when, when)
    }
    run(['backup'])
    expect(readdirSync(join(state, 'archive')).length, 'today plus the 13 newest').toBe(14)
  })

  it('the stall restart is rate limited, so a fault a restart cannot fix cannot restart the router forever', restartCase, () => {
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

  it('a remedy whose restart fails leaves no stop marker, so the next pass sees a router that is down', restartCase, () => {
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
    // The pilot engine names the state directory it serves, so it has to be told the one --state moved to.
    const startOther = { FAKE_HERDR_READY: join(other, 'ready'), PI_SUPERAGENT_STATE: other }
    expect(run([...flags, 'start'], startOther).status, portHint()).toBe(0)
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

  it('refuses a watched checkout even inside the state dir: the operator\'s checkouts are never edited', () => {
    const secret = `ghp_${'u'.repeat(36)}`
    const watched = join(state, 'operator-repo')
    mkdirSync(join(watched, '.git'), { recursive: true })
    writeFileSync(join(watched, '.git', 'config'), `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/o/r.git\n`)
    const out = run(['start'], { PI_SUPERAGENT_WATCHED_CHECKOUTS: watched })
    expect(out.status, out.stderr).toBe(1)
    expect(out.stderr).toMatch(/carries a git credential in the clear/)
    expect(readFileSync(join(watched, '.git', 'config'), 'utf8'), 'left as it was').toContain(secret)
    expect(existsSync(join(herdrDir, 'calls')), 'nothing was started').toBe(false)
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

  it('cleans a ticket checkout that came back with a credential, and starts (operator, 2026-11-15)', () => {
    // A worker pushes with the box's GitHub login; refusing here kept the fleet down 15 hours after a reboot.
    const secret = `ghp_${'y'.repeat(36)}`
    const config = join(state, 'work', 'TK-7', '.git', 'config')
    mkdirSync(join(state, 'work', 'TK-7', '.git'), { recursive: true })
    writeFileSync(config, `[remote "origin"]\n\turl = ssh://git@github.com/o/r.git\n[credential]\n\thelper = !f(){ echo password=${secret}; }; f\n`)
    const out = run(['start'])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stderr).toMatch(/removed a git credential from \S*work\/TK-7\/\.git\/config line 4/)
    expect(out.stderr).toContain('password=ghp_***')
    expect(out.stderr, 'the clean-up must not publish the token it removed').not.toContain(secret)
    expect(readFileSync(config, 'utf8'), 'the token is gone; an ssh user is an account, not a secret')
      .toBe('[remote "origin"]\n\turl = ssh://git@github.com/o/r.git\n[credential]\n')
    expect(readFileSync(join(herdrDir, 'calls'), 'utf8')).toMatch(/agent start superagent/)
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
    expect(out.status, out.stderr).toBe(0)
    expect(out.stderr, 'the common dir is the file that holds the credential').toContain(join('source-repo', '.git', 'config'))
    expect(out.stderr).toContain('x-access-token:***@github.com')
    expect(out.stderr, 'the clean-up must not publish the token it removed').not.toContain(secret)
    expect(execFileSync('git', ['-C', source, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())
      .toBe('https://github.com/kmatzen/pi-superagent.git')
  })

  it('refuses a ticket worktree linked to a repository outside the state dir: that one is not the fleet\'s to edit', () => {
    const secret = `ghp_${'v'.repeat(36)}`
    const outside = mkdtempSync(join(tmpdir(), 'pi-sa-outside-')); dirs.push(outside)
    execFileSync('git', ['init', '-q', outside])
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'seed'], { cwd: outside })
    execFileSync('git', ['-C', outside, 'remote', 'add', 'origin', `https://x-access-token:${secret}@github.com/o/r.git`])
    mkdirSync(join(state, 'work'), { recursive: true })
    execFileSync('git', ['-C', outside, 'worktree', 'add', '-q', '-b', 'ticket', join(state, 'work', 'TK-10')])
    const out = run(['start'])
    expect(out.status, out.stderr).toBe(1)
    expect(out.stderr).toMatch(/carries a git credential in the clear/)
    expect(out.stderr).not.toContain(secret)
    expect(readFileSync(join(outside, '.git', 'config'), 'utf8'), 'left as it was').toContain(secret)
    expect(existsSync(join(herdrDir, 'calls')), 'nothing was started').toBe(false)
  })

  it('cleans the checkout a worker cloned itself: work/<ticket>/repo, one level below the ticket dir', () => {
    // The ticket prompt tells a worker to clone into its workspace, so the checkout lands at
    // <worktrees>/<ticket>/repo/. Measured on the live box: 26 of the 29 ticket checkouts are that shape, and
    // the one holding the exposed token today is one of them. Scanning only <worktrees>/<ticket>/.git says
    // "clean" about the deployment as it actually runs, then starts the router over the leak.
    const secret = `ghp_${'w'.repeat(36)}`
    mkdirSync(join(state, 'work', 'TK-11', 'repo', '.git'), { recursive: true })
    writeFileSync(join(state, 'work', 'TK-11', 'repo', '.git', 'config'), `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/kmatzen/pi-superagent.git\n`)
    // Depth is bounded: a nested `.git` three levels down (a vendored dependency) is not scanned, so the
    // guard costs one directory listing at start, not a walk of a 2 GB tree.
    const nested = join(state, 'work', 'TK-12', 'repo', 'vendor', 'dep', '.git', 'config')
    mkdirSync(dirname(nested), { recursive: true })
    writeFileSync(nested, `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/o/r.git\n`)
    const out = run(['start'])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stderr).toContain(join('work', 'TK-11', 'repo', '.git', 'config'))
    expect(out.stderr).toContain('x-access-token:***@github.com')
    expect(out.stderr, 'the clean-up must not publish the token it removed').not.toContain(secret)
    expect(readFileSync(join(state, 'work', 'TK-11', 'repo', '.git', 'config'), 'utf8'))
      .toBe('[remote "origin"]\n\turl = https://github.com/kmatzen/pi-superagent.git\n')
    expect(readFileSync(nested, 'utf8'), 'below the depth bound nothing is read or written').toContain(secret)
  })

  it('a restart on a box that leaked mid-life cleans the worker\'s clone and brings the fleet back', () => {
    // `restart` is `stop; start`, and the boot service and the scheduled health check both start. Refusing here
    // ended the fleet until a person fixed the URL: after the 2026-11-15 reboot that was 15 hours with nobody told.
    const secret = `ghp_${'q'.repeat(36)}`
    const config = join(state, 'work', 'TK-14', 'repo', '.git', 'config')
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, '[remote "origin"]\n\turl = https://github.com/kmatzen/pi-superagent.git\n')
    expect(run(['start']).status, 'the fleet comes up clean').toBe(0)
    // A worker bakes the token into the remote while the router is live.
    writeFileSync(config, `[remote "origin"]\n\turl = https://x-access-token:${secret}@github.com/kmatzen/pi-superagent.git\n`)
    const out = run(['restart'])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stderr).toMatch(/removed a git credential from/)
    expect(out.stderr).not.toContain(secret)
    expect(readFileSync(config, 'utf8')).toBe('[remote "origin"]\n\turl = https://github.com/kmatzen/pi-superagent.git\n')
    expect(readFileSync(join(herdrDir, 'calls'), 'utf8').match(/agent start superagent/g), 'started again').toHaveLength(2)
  })

  it('start refuses a checkout whose code has uncommitted changes, unless told otherwise', () => {
    // 2026-11-10: an edit to this script, never committed, ran live and posted on the board.
    const repo = mkdtempSync(join(tmpdir(), 'sa-guard-'))
    mkdirSync(join(repo, 'scripts'))
    mkdirSync(join(repo, 'src'))
    copyFileSync(SCRIPT, join(repo, 'scripts', 'superagent'))
    chmodSync(join(repo, 'scripts', 'superagent'), 0o755)
    writeFileSync(join(repo, 'src', 'x.ts'), 'export const x = 1\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed')
    writeFileSync(join(repo, 'src', 'x.ts'), 'export const x = 2\n')
    const bin = join(repo, 'scripts', 'superagent')
    const refused = runFrom(bin, ['start'], { PI_SUPERAGENT_ALLOW_DIRTY: '' })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('uncommitted changes to the code it runs')
    expect(refused.stderr).toContain('src/x.ts')
    const forced = runFrom(bin, ['--allow-dirty', 'start'], { PI_SUPERAGENT_ALLOW_DIRTY: '' })
    expect(forced.stderr, 'the override gets past the guard').not.toContain('uncommitted changes')
    runFrom(bin, ['stop'], { PI_SUPERAGENT_ALLOW_DIRTY: '' })
    rmSync(repo, { recursive: true, force: true })
  })

  it('intake is gone with the labels: it says so, exits non-zero, and touches nothing on GitHub', () => {
    const bin = join(state, 'bin'); mkdirSync(bin, { recursive: true })
    const calls = join(state, 'curl.calls')
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CURL_LOG"\nexit 0\n')
    chmodSync(join(bin, 'curl'), 0o755)
    const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, CURL_LOG: calls, PI_SUPERAGENT_GITHUB_REPO: 'o/r' }
    const run = spawnSync(SCRIPT, ['intake', '3-5,7'], { encoding: 'utf8', env: { ...process.env, PI_SUPERAGENT_STATE: state, ...env } })
    expect(run.status, 'a removed verb is not a request that went through').toBe(2)
    expect(run.stderr).toContain('superagent intake is gone with the labels')
    expect(existsSync(calls), 'no GitHub write at all').toBe(false)
  })

  it('stop-ticket posts the reason to the panel and answers on its exit code', () => {
    // The operator's shell lever for the duplicate-worker case: untested since it shipped (audit 2026-11-11).
    const bin = join(state, 'bin'); mkdirSync(bin, { recursive: true })
    const calls = join(state, 'curl.calls')
    writeFileSync(join(bin, 'curl'), `#!/bin/bash
printf '%s\\n' "$*" >> "$CURL_LOG"
if [ -f "$(dirname "$0")/refuse" ]; then echo 'stop-ticket: the panel refused' >&2; exit 1; fi
echo '{"stopped":"TK-1"}'
`)
    chmodSync(join(bin, 'curl'), 0o755)
    writeFileSync(join(state, 'panel.port'), String(PANEL_PORT))
    writeFileSync(join(state, 'panel-token'), 'sekrit')
    const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, CURL_LOG: calls }
    const ok = spawnSync(SCRIPT, ['stop-ticket', 'TK-1', 'duplicate worker'], { encoding: 'utf8', env: { ...process.env, PI_SUPERAGENT_STATE: state, ...env } })
    expect(ok.status, ok.stderr).toBe(0)
    const logged = readFileSync(calls, 'utf8')
    expect(logged).toContain('-X POST')
    expect(logged).toContain(`api/tickets/TK-1/stop`)
    expect(logged).toContain('x-superagent-token: sekrit')
    expect(logged).toContain('duplicate worker')
    // The panel's refusal is the caller's answer: a stop that did not happen exits non-zero.
    writeFileSync(join(bin, 'refuse'), '1')
    const refused = spawnSync(SCRIPT, ['stop-ticket', 'TK-1'], { encoding: 'utf8', env: { ...process.env, PI_SUPERAGENT_STATE: state, ...env } })
    expect(refused.status).toBe(1)
  })

  it('abandon-pull posts the thread and the reason, and answers on its exit code', () => {
    // The shell lever for a pull request that can never close (an archived fork): the panel has the endpoint, the
    // operator's shell had no way to ask it, so the ticket sat waiting on a read-only repository.
    const bin = join(state, 'bin2'); mkdirSync(bin, { recursive: true })
    const calls = join(state, 'abandon.calls')
    writeFileSync(join(bin, 'curl'), `#!/bin/bash
printf '%s\n' "$*" >> "$CURL_LOG"
if [ -f "$(dirname "$0")/refuse" ]; then echo '{"error":"Ticket has ended"}'; exit 0; fi
echo '{"abandoned":"github:o/r#14","reason":"the fork is archived"}'
`)
    chmodSync(join(bin, 'curl'), 0o755)
    writeFileSync(join(state, 'panel.port'), String(PANEL_PORT))
    writeFileSync(join(state, 'panel-token'), 'sekrit')
    const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, CURL_LOG: calls }
    const run = (args: string[]) => spawnSync(SCRIPT, args, { encoding: 'utf8', env: { ...process.env, PI_SUPERAGENT_STATE: state, ...env } })
    const ok = run(['abandon-pull', 'TK-1', 'o/r#14', 'the fork is archived'])
    expect(ok.status, ok.stderr).toBe(0)
    const logged = readFileSync(calls, 'utf8')
    expect(logged).toContain('-X POST')
    expect(logged).toContain('api/tickets/TK-1/abandon')
    expect(logged).toContain('x-superagent-token: sekrit')
    expect(logged).toContain('o/r#14')
    expect(logged).toContain('the fork is archived')
    // A panel that refused is a lever that did not move: the shell says so with its exit code, not with prose alone.
    writeFileSync(join(bin, 'refuse'), '1')
    expect(run(['abandon-pull', 'TK-1', 'o/r#14', 'again']).status).toBe(1)
    rmSync(join(bin, 'refuse'))
    expect(run(['abandon-pull', 'TK-1']).status, 'a thread is not optional').toBe(2)
  })

  it('reads only PI_SUPERAGENT_* from config.env, and survives CRLF and stray spaces', () => {
    // config.env is a 0600 file the operator edits by hand: a foreign key must not reach the router's
    // environment, a file edited on Windows must not put \r in every value, and `KEY = value` must not
    // kill the start with a bad substitution (audit 2026-11-11).
    writeFileSync(join(state, 'config.env'), 'PI_SUPERAGENT_TICK_MS=44444\r\nNODE_OPTIONS=--require=/tmp/pwn\r\nPI_SUPERAGENT_MAX_WORKERS = 3\n')
    started()
    const routerEnv = routerTab()
    expect(routerEnv).toContain('PI_SUPERAGENT_TICK_MS=44444')
    expect(routerEnv).toContain('PI_SUPERAGENT_MAX_WORKERS=3')
    expect(routerEnv, 'a key that is not the router\'s is not exported').not.toContain('NODE_OPTIONS')
    expect(routerEnv).not.toMatch(/\r/)
  })
})
