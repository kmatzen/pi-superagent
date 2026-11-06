import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const plist = readFileSync(join(import.meta.dirname, '..', 'launchd', 'com.example.superagent-health.plist'), 'utf8')

describe('launchd/com.example.superagent-health.plist', () => {
  it('reads the health contract instead of guessing whether the router is alive', () => {
    expect(plist).toMatch(/superagent --respect-stop status/)
    expect(plist).toMatch(/superagent --respect-stop start/)
  })

  it('keeps a deliberate stop deliberate, and never runs as a KeepAlive pair with the router', () => {
    expect(plist).toContain('--respect-stop')
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>/)
    expect(plist).toMatch(/<key>StartInterval<\/key><integer>\d+<\/integer>/)
  })

  it('names herdr, node and pi on the job PATH, because launchd hands a job an empty one', () => {
    const path = plist.match(/<key>PATH<\/key><string>([^<]+)<\/string>/)?.[1] ?? ''
    expect(path).toContain('/opt/homebrew/bin')
    expect(path).toContain('/.npm-global/bin')
    expect(plist).toMatch(/<key>HOME<\/key><string>[^<]+<\/string>/)
  })

  it('writes its own log, so a silent restart loop is at least visible somewhere', () => {
    expect(plist).toMatch(/StandardOutPath[\s\S]*superagent-health\.log/)
    expect(plist).toMatch(/StandardErrorPath[\s\S]*superagent-health\.log/)
  })
})
