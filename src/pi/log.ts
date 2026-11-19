/** A stall must be readable from a file: the wedged thing is often the TUI you would otherwise read it from. */
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

export interface EngineLog {
  line(level: LogLevel, event: string, fields?: Record<string, unknown>): void
  readonly path: string
}

const MAX_BYTES = 5 * 1024 * 1024

const field = (key: string, value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return /\s/.test(text) ? ` ${key}=${JSON.stringify(text)}` : ` ${key}=${text}`
}

export function openLog(dir: string, name = 'engine.log'): EngineLog {
  const path = join(dir, name)
  return {
    path,
    line(level, event, fields = {}) {
      const at = new Date().toISOString()
      const rest = Object.entries(fields).map(([k, v]) => field(k, v)).join('')
      try {
        // Rotate on the boundary, before the write, so the newest event is always in the live file.
        if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(path, `${path}.1`)
        appendFileSync(path, `${at} ${level.toUpperCase().padEnd(5)} ${event}${rest}\n`)
      } catch {
        // A log that cannot write must never take the engine down with it.
      }
    },
  }
}
