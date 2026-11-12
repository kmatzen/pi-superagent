/** Per-worker resource limits: each worker's pi and its children run in their own systemd user scope, so one
 *  runaway is killed at its cap instead of starving the host (2026-11-11: an 8.5 GB leak test took it down). */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WorkerLimits {
  memoryMaxBytes: number
  cpuPercent: number
  tasksMax: number
}

export interface WorkerLimitSettings {
  off?: boolean
  memoryGb?: number
  cpus?: number
  tasks?: number
}

export const SCOPE_SLICE = 'pi-superagent.slice'
const GiB = 1024 ** 3

/** Workers share 3/4 of memory (the rest is the router's, herdr's and the host's); each gets 1.5x its CPU share. */
export function defaultLimits(totalBytes: number, cores: number, maxWorkers: number): WorkerLimits {
  const workers = Math.max(1, Math.floor(maxWorkers))
  return {
    memoryMaxBytes: Math.floor((totalBytes * 0.75) / workers),
    cpuPercent: Math.max(100, Math.round((cores / workers) * 150)),
    tasksMax: 2048,
  }
}

export function limitsFor(settings: WorkerLimitSettings, totalBytes: number, cores: number, maxWorkers: number): WorkerLimits | null {
  if (settings.off) return null
  const base = defaultLimits(totalBytes, cores, maxWorkers)
  return {
    memoryMaxBytes: settings.memoryGb ? Math.floor(settings.memoryGb * GiB) : base.memoryMaxBytes,
    cpuPercent: settings.cpus ? Math.round(settings.cpus * 100) : base.cpuPercent,
    tasksMax: settings.tasks ? Math.floor(settings.tasks) : base.tasksMax,
  }
}

/** herdr starts `pi` by name, so a PATH entry ahead of the real pi is the only seam; `--scope` keeps the pid, so
 *  herdr still sees pi in the pane. XDG_RUNTIME_DIR is for systemd-run only: herdr's socket path assumes none. */
// No MemoryHigh: with no swap it stalls a runaway at the threshold instead of killing it (measured on the fleet
// box: a hog sat throttled for 120 s), and the brief promises a kill the agent can see.
export function shimScript(limits: WorkerLimits): string {
  return [
    '#!/bin/sh',
    'self=$(cd "$(dirname "$0")" && pwd)',
    'real=$(PATH=$(printf %s "$PATH" | tr ":" "\\n" | grep -vxF "$self" | paste -sd: -) command -v pi) \\',
    '  || { echo "pi-superagent: no pi on PATH outside $self" >&2; exit 127; }',
    'unit="pi-superagent-worker-$(basename "${PI_SUPERAGENT_WORKER_DIR:-$$}")"',
    `exec env XDG_RUNTIME_DIR="/run/user/$(id -u)" systemd-run --user --scope --quiet --collect --slice=${SCOPE_SLICE} --unit="$unit" \\`,
    `  -p MemoryMax=${limits.memoryMaxBytes} -p MemorySwapMax=0 \\`,
    `  -p TasksMax=${limits.tasksMax} -p CPUQuota=${limits.cpuPercent}% \\`,
    '  -- env -u XDG_RUNTIME_DIR "$real" "$@"',
    '',
  ].join('\n')
}

/** Linux with a systemd user manager that delegates memory, cpu and pids; elsewhere workers run unconfined. */
export function scopesWork(run: typeof execFileSync = execFileSync): boolean {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return false
  try {
    run('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--slice=${SCOPE_SLICE}`,
      '-p', 'MemoryMax=67108864', '-p', 'TasksMax=16', '-p', 'CPUQuota=50%', 'true'], {
      env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` }, stdio: 'ignore', timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}

export function installShim(stateDir: string, limits: WorkerLimits): string {
  const bin = join(stateDir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'pi'), shimScript(limits))
  chmodSync(join(bin, 'pi'), 0o755)
  return bin
}

/** One line for the worker's brief, so a killed process reads as its cap and not as a mystery. */
export function limitsBrief(limits: WorkerLimits): string {
  const gb = (limits.memoryMaxBytes / GiB).toFixed(1)
  const cores = (limits.cpuPercent / 100).toFixed(1)
  return `Hard limits: your processes share ${gb} GB of memory (a process past it is killed), ${cores} CPU cores, `
    + `and ${limits.tasksMax} processes. Cap memory-hungry runs (node --max-old-space-size, smaller inputs) and keep `
    + 'scratch files in your workspace: /tmp is a small RAM disk shared with the whole machine.'
}
