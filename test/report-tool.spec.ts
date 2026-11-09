import { describe, expect, it } from 'vitest'
import { reportTool, type ReportOutcome, type Reporter } from '../src/pi/report-tool.ts'

/** What the worker's tool call answers, for a reporter whose verdict is `outcome`. */
const answer = (outcome: ReportOutcome | void): string => {
  const reporter: Reporter = () => outcome
  return reportTool(reporter).execute('r1', { state: 'ready', summary: 'the merge landed' }).content[0]!.text
}

describe('ticket_report', () => {
  it('says the work is reported when the router took the report', () => {
    expect(answer('recorded')).toBe('reported')
  })

  it('a report that reached no worker is answered as that, because "reported" is a lie the next run believes', () => {
    // Measured 2026-11-09 on matzen_adobe/superagent-board-spike#255: a report the router had already ended
    // answered `reported`, posted nothing, and the ticket's next three runs started from that receipt.
    const said = answer('dropped')
    expect(said).toMatch(/not recorded/)
    expect(said).toMatch(/no reply was posted/)
    expect(said, 'it names the door that works').toMatch(/A comment on the issue starts the work again/)
  })

  it('a reporter that cannot see the verdict (the worker pane appending its report file) says the plain thing', () => {
    expect(answer(undefined)).toBe('reported')
  })

  it('keeps the pull requests a worker names, and drops the ones that are not strings', () => {
    const seen: Array<readonly string[] | undefined> = []
    const tool = reportTool((_s, _su, _q, _o, pulls) => { seen.push(pulls); return 'recorded' })
    tool.execute('r1', { state: 'ready', summary: 's', pullRequests: ['https://x/1', 7, null] })
    tool.execute('r2', { state: 'ready', summary: 's', pullRequests: [] })
    expect(seen).toEqual([['https://x/1'], undefined])
  })
})
