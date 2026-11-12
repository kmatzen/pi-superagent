import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLimits, installShim, limitsBrief, limitsFor, scopesWork } from '../src/pi/worker-limits.ts'

const GiB = 1024 ** 3
const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wlim-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('worker limits', () => {
  it('derives each worker\'s share from the machine: the fleet box (15 GiB, 4 cores, 3 workers)', () => {
    expect(defaultLimits(15 * GiB, 4, 3)).toEqual({ memoryMaxBytes: Math.floor(3.75 * GiB), cpuPercent: 200, tasksMax: 2048 })
    expect(defaultLimits(8 * GiB, 1, 4).cpuPercent, 'never under one core').toBe(100)
  })

  it('takes the operator\'s overrides, and off means unconfined', () => {
    expect(limitsFor({ memoryGb: 2, cpus: 1.5, tasks: 512 }, 15 * GiB, 4, 3)).toEqual({ memoryMaxBytes: 2 * GiB, cpuPercent: 150, tasksMax: 512 })
    expect(limitsFor({ off: true }, 15 * GiB, 4, 3)).toBeNull()
  })

  it('the shim runs the real pi, not itself, inside a scope with exactly these limits', () => {
    // A fake systemd-run records what it was asked and then runs the command after `--`, as --scope does.
    const root = tmp()
    const fake = join(root, 'fake')
    mkdirSync(fake)
    writeFileSync(join(fake, 'systemd-run'), '#!/bin/sh\necho "SR XDG=$XDG_RUNTIME_DIR $*"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n')
    writeFileSync(join(fake, 'pi'), '#!/bin/sh\necho "REAL PI xdg=${XDG_RUNTIME_DIR:-unset} $*"\n')
    chmodSync(join(fake, 'systemd-run'), 0o755)
    chmodSync(join(fake, 'pi'), 0o755)
    const bin = installShim(join(root, 'state'), { memoryMaxBytes: 2 * GiB, cpuPercent: 150, tasksMax: 512 })
    const out = execFileSync(join(bin, 'pi'), ['--session-id', 'S1'], {
      env: { PATH: `${bin}:${fake}:/usr/bin:/bin`, PI_SUPERAGENT_WORKER_DIR: '/state/workers/abc-123' }, encoding: 'utf8',
    })
    const [sr, real] = out.trim().split('\n')
    expect(sr).toMatch(/^SR XDG=\/run\/user\/\d+ --user --scope --quiet --collect --slice=pi-superagent\.slice --unit=pi-superagent-worker-abc-123 /)
    expect(sr).toContain(`-p MemoryMax=${2 * GiB} -p MemoryHigh=${Math.floor(1.8 * GiB)} -p MemorySwapMax=0`)
    expect(sr).toContain('-p TasksMax=512 -p CPUQuota=150%')
    expect(sr).toContain(`-- env -u XDG_RUNTIME_DIR ${join(fake, 'pi')} --session-id S1`)
    expect(real, 'the real pi got its arguments, and herdr\'s socket path still assumes no XDG_RUNTIME_DIR').toBe('REAL PI xdg=unset --session-id S1')
  })

  it('says no where the host cannot scope, without running anything', () => {
    let ran = false
    const run = (() => { ran = true; throw new Error('no systemd') }) as never
    expect(scopesWork(run)).toBe(false)
    if (process.platform !== 'linux') expect(ran, 'off Linux it does not even try').toBe(false)
  })

  it('tells the worker its limits in numbers it can act on', () => {
    expect(limitsBrief({ memoryMaxBytes: Math.floor(3.75 * GiB), cpuPercent: 200, tasksMax: 2048 }))
      .toMatch(/share 3\.8 GB of memory \(a process past it is killed\), 2\.0 CPU cores, and 2048 processes/)
  })
})
