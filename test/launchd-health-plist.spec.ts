import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const plist = readFileSync(join(import.meta.dirname, '..', 'launchd', 'com.example.superagent-health.plist'), 'utf8')

describe('launchd/com.example.superagent-health.plist', () => {
  it('asks the script for the remedy, instead of guessing one from a failing status', () => {
    expect(plist).toMatch(/superagent --respect-stop remedy/)
    // The mapping (1 start · 2 restart · 0, 3, 4 nothing) lives in scripts/superagent, where a test can run
    // it. A job that shells `status || start` cannot express "restart a router that is up and not beating",
    // and `start` refuses a running router: the stall was a loud no-op every five minutes.
    expect(plist).not.toMatch(/--respect-stop (status|start|restart)\b/)
  })

  it('runs the installed superagent command, not a script in one particular checkout', () => {
    // The job installed on the box this was written on (2026-11-09) runs `cd $HOME/git/pi-superagent` and then
    // ./scripts/superagent, which checks and heals whatever repository that path names today, and predates
    // the remedy mapping. This test is what says so; the fix is to re-render this file and reload the job.
    expect(plist).not.toMatch(/scripts\/superagent<|cd "/)
    expect(plist).toMatch(/<string>superagent --respect-stop remedy/)
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

  it('dates every line it logs, because launchd does not, and a repeating remedy must read as one', () => {
    expect(plist).toMatch(/date -u \+%FT%TZ/)
  })

  it('is XML a plist parser accepts: the double hyphen is forbidden inside a comment', () => {
    for (const comment of plist.match(/<!--[\s\S]*?-->/g) ?? []) {
      expect(comment.slice(4, -3), comment.slice(0, 60)).not.toContain('--')
    }
  })
})
