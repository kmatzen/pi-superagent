import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openLog } from '../src/pi/log.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'log-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('the engine log', () => {
  it('writes one readable line per event, with the fields a stall is diagnosed from', () => {
    const dir = tmp()
    const log = openLog(dir)
    log.line('info', 'eval.deliver', { eval: 'abc', bytes: 812, target: 'judge' })
    log.line('warn', 'tick', { n: 4, inflight: 2, capped: true, ms: 12 })
    const lines = readFileSync(log.path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO  eval\.deliver eval=abc bytes=812 target=judge$/)
    expect(lines[1]).toMatch(/WARN  tick n=4 inflight=2 capped=true ms=12$/)
  })

  it('quotes a value with spaces so one event is still one field per key', () => {
    const log = openLog(tmp())
    log.line('error', 'uncaught', { error: 'boom at line 3' })
    expect(readFileSync(log.path, 'utf8')).toContain('error="boom at line 3"')
  })

  it('rotates instead of growing without bound', () => {
    const dir = tmp()
    const log = openLog(dir)
    writeFileSync(log.path, 'x'.repeat(6 * 1024 * 1024))
    log.line('info', 'tick', { n: 1 })
    expect(readFileSync(`${log.path}.1`, 'utf8').length).toBeGreaterThan(1_000_000)
    expect(readFileSync(log.path, 'utf8')).toMatch(/ INFO  tick n=1$/m)
  })

  it('a log it cannot write never takes the engine down', () => {
    const log = openLog('/proc/definitely-not-writable')
    expect(() => log.line('info', 'tick', { n: 1 })).not.toThrow()
  })
})
