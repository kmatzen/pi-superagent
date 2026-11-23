import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

// pi-superagent#11: a router resumed at 90-100 % context booted pi and no engine, and no report said so.
const dirs: string[] = []
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'superagent')
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-herdr')
chmodSync(FAKE, 0o755)

let state: string, herdrDir: string

const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(SCRIPT, args, {
  encoding: 'utf8',
  env: {
    ...process.env,
    PI_SUPERAGENT_STATE: state,
    PI_SUPERAGENT_HERDR: FAKE,
    PI_SUPERAGENT_GRACE: '1',
    // 1 s, not the production 60: every spec here reads the report after the wait, not the wait.
    PI_SUPERAGENT_READY_WAIT: '1',
    PI_SUPERAGENT_PANEL_PORT: '8799',
    // start refuses a dirty checkout, and the checkout under test carries the changes under test.
    PI_SUPERAGENT_ALLOW_DIRTY: '1',
    // A started router needs an engine process: `status` counts engines by process, not by tab.
    FAKE_HERDR_ENGINE: join(state, 'bin', 'pi'),
    FAKE_HERDR_DIR: herdrDir,
    ...extra,
  },
})

const startRouter = (extra: Record<string, string> = {}) =>
  run(['start'], { FAKE_HERDR_READY: join(state, 'ready'), ...extra })

const sessionIdFile = () => join(state, 'session-id')
const sessionId = () => readFileSync(sessionIdFile(), 'utf8').trim()
const resumedId = () =>
  /-- --session-id (\S+)/.exec(readFileSync(join(herdrDir, 'start.superagent.args'), 'utf8'))?.[1]

/** Backdate health.json so `status` reads the beat as stopped (code 2), the fault `remedy` restarts on. */
const stopTheBeat = (hours = 3) => {
  writeFileSync(join(state, 'health.json'), JSON.stringify({ runtime: { state: 'ready' }, tick: { state: 'ok' } }))
  const old = (Date.now() - hours * 3_600_000) / 1000
  utimesSync(join(state, 'health.json'), old, old)
}

/** One engine.log line, in the format src/pi/log.ts writes, stamp included: the matcher reads the stamp. */
const logRouterStart = (atMs: number) => appendFileSyncLine(
  join(state, 'engine.log'),
  `${new Date(atMs).toISOString()} INFO  router.start dataDir=${state} panelPort=8799\n`,
)
function appendFileSyncLine(file: string, line: string) {
  writeFileSync(file, readIfExists(file) + line)
}
const readIfExists = (file: string) => {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** engine.log.1: rotation moves a long boot's `router.start` out of the live file. */
const logRouterStartRotated = (atMs: number) => appendFileSyncLine(
  join(state, 'engine.log.1'),
  `${new Date(atMs).toISOString()} INFO  router.start dataDir=${state} panelPort=8799\n`,
)

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sa-dead-engine-')); dirs.push(root)
  state = join(root, 'state'); herdrDir = join(root, 'herdr')
  mkdirSync(state, { recursive: true }); mkdirSync(herdrDir, { recursive: true })
  mkdirSync(join(state, 'bin'), { recursive: true })
  copyFileSync('/bin/sleep', join(state, 'bin', 'pi'))
  chmodSync(join(state, 'bin', 'pi'), 0o755)
})
afterAll(() => {
  for (const d of dirs) {
    // The fixture spawns the tab's engine detached; only the file it writes names it.
    try { process.kill(Number(readFileSync(join(d, 'herdr', 'engine.pid'), 'utf8')), 'SIGKILL') } catch { /* never started */ }
    rmSync(d, { recursive: true, force: true })
  }
})

describe('scripts/superagent: the tab is up and the engine is down', { timeout: 60_000 }, () => {
  it('names the resumed full session when start never reaches ready', () => {
    const r = run(['start'], { FAKE_HERDR_CONTEXT: '93%' })
    expect(r.status, 'a router that never reported ready is not healthy: code 1').toBe(1)
    const out = r.stdout + r.stderr
    expect(out).toMatch(/did not report ready/)
    expect(out).toMatch(/resumed a session at 93% context/)
    expect(out).toMatch(new RegExp(`clear it to boot fresh: rm -f ${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/session-id`))
  })

  it('still names the dead engine on a session with room left, without blaming its context', () => {
    const r = run(['start'], { FAKE_HERDR_CONTEXT: '5%' })
    expect(r.status).toBe(1)
    const out = r.stdout + r.stderr
    expect(out).toMatch(/no engine booted in it/)
    expect(out).not.toMatch(/at 5% context and booted no engine/)
  })

  it('says the case in status, where the operator reads only "running and not beating"', () => {
    expect(startRouter({ FAKE_HERDR_CONTEXT: '95%' }).status).toBe(0)
    stopTheBeat()
    const r = run(['status'], { FAKE_HERDR_CONTEXT: '95%' })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/resumed a session at 95% context and booted no engine/)
    expect(r.stderr).toMatch(/rm -f .*\/session-id/)
  })

  it('remedy clears the session id, and the restart resumes a fresh one', () => {
    expect(startRouter().status).toBe(0)
    const before = sessionId()
    expect(resumedId()).toBe(before)
    stopTheBeat()
    const r = run(['remedy'], { FAKE_HERDR_READY: join(state, 'ready'), FAKE_HERDR_CONTEXT: '97%' })
    const out = r.stdout + r.stderr
    expect(out).toMatch(/resumed a session at 97% context and booted no engine; cleared/)
    expect(sessionId(), 'a fresh id is minted for the session the restart opens').not.toBe(before)
    expect(resumedId()).not.toBe(before)
    expect(existsSync(join(state, 'watchdog-restart')), 'the restart is still on the clock').toBe(true)
  })

  it('remedy leaves the session id alone when this boot did reach its engine', () => {
    expect(startRouter().status).toBe(0)
    const before = sessionId()
    // A router.start stamped after this tab opened: a wedged loop, the fault a restart does fix.
    logRouterStart(Date.now())
    stopTheBeat()
    const r = run(['remedy'], { FAKE_HERDR_READY: join(state, 'ready'), FAKE_HERDR_CONTEXT: '97%' })
    expect(r.stdout + r.stderr).not.toMatch(/cleared .*session-id/)
    expect(sessionId()).toBe(before)
    expect(resumedId()).toBe(before)
  })

  it('counts a router.start that the log rotation left in engine.log.1', () => {
    expect(startRouter().status).toBe(0)
    const before = sessionId()
    // Measured on the live box: a 4-day boot rotates engine.log at 5 MB, so a healthy router's only
    // `router.start` sits here, and reading the live file alone deletes that router's session next pass.
    logRouterStartRotated(Date.now())
    stopTheBeat()
    const r = run(['remedy'], { FAKE_HERDR_READY: join(state, 'ready'), FAKE_HERDR_CONTEXT: '97%' })
    expect(r.stdout + r.stderr).not.toMatch(/cleared .*session-id/)
    expect(sessionId()).toBe(before)
    expect(resumedId()).toBe(before)
  })

  it('remedy leaves the session id alone when herdr reports the session with room left', () => {
    expect(startRouter().status).toBe(0)
    const before = sessionId()
    stopTheBeat()
    const r = run(['remedy'], { FAKE_HERDR_READY: join(state, 'ready'), FAKE_HERDR_CONTEXT: '40%' })
    expect(r.stdout + r.stderr).not.toMatch(/cleared .*session-id/)
    expect(sessionId()).toBe(before)
    expect(resumedId()).toBe(before)
  })

  it('remedy keeps its restart cooldown over the new path', () => {
    expect(startRouter().status).toBe(0)
    const before = sessionId()
    stopTheBeat()
    expect(run(['remedy'], { FAKE_HERDR_READY: join(state, 'ready'), FAKE_HERDR_CONTEXT: '99%' }).stdout)
      .toMatch(/restarting the router/)
    rmSync(join(state, 'ready'), { force: true })
    const second = run(['remedy'], { FAKE_HERDR_READY: join(state, 'ready'), FAKE_HERDR_CONTEXT: '99%' })
    expect(second.stdout).toMatch(/restart suppressed, the last one was \d+ min ago/)
    expect(second.stdout).not.toMatch(/cleared .*session-id/)
    expect(sessionId()).not.toBe(before)
  })
})
