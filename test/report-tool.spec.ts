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
    tool.execute('r1', { state: 'ready', summary: 's', pullRequests: ['https://github.com/o/r/pull/1', 7, null] })
    tool.execute('r2', { state: 'ready', summary: 's', pullRequests: [] })
    expect(seen).toEqual([['https://github.com/o/r/pull/1'], undefined])
  })

  // Five `pull.unreadable` warns in four days, three of them a model retyping its own URL and dropping the
  // `/`. The router skipped the entry and completed the ticket with its pull request untracked: exit 0, no
  // receipt, no signal. The refusal is the worker's own answer now — the router's warn is the backstop.
  it('refuses a report whose pull request URL the router cannot read, and names the entry', () => {
    const seen: Array<readonly string[] | undefined> = []
    const tool = reportTool((_s, _su, _q, _o, pulls) => { seen.push(pulls); return 'recorded' })
    const bad = 'https://github.comResearch-Adobe/caramel/pull/1994'
    const verdict = tool.execute('r1', { state: 'ready', summary: 's', pullRequests: [bad] })
    expect(verdict.isError, 'the worker sees a failure, not "reported"').toBe(true)
    expect(verdict.content[0]!.text).toContain(bad)
    expect(verdict.content[0]!.text, 'the fix is written on the page the worker has open').toMatch(/gh pr create/)
    expect(seen, 'the report reaches nobody, so the worker can fix it and re-report').toEqual([])
  })

  it('refuses a host the router cannot follow, naming only the entry that failed in a mixed report', () => {
    const seen: Array<readonly string[] | undefined> = []
    const tool = reportTool((_s, _su, _q, _o, pulls) => { seen.push(pulls); return 'recorded' })
    const verdict = tool.execute('r1', {
      state: 'ready', summary: 's',
      pullRequests: ['https://github.com/o/r/pull/9', 'https://git.corp.adobe.com/transmute/transmute/pull/1574'],
    })
    expect(verdict.isError, 'an enterprise URL tracks nothing, so the report says so instead of dropping it').toBe(true)
    expect(verdict.content[0]!.text).toContain('git.corp.adobe.com/transmute/transmute/pull/1574')
    expect(verdict.content[0]!.text).not.toContain('o/r/pull/9')
    expect(seen, 'a mixed report is refused whole, so the worker re-reports both').toEqual([])
  })

  it('refuses every URL parsePull refuses, and accepts every URL it accepts', () => {
    const seen: Array<readonly string[] | undefined> = []
    const tool = reportTool((_s, _su, _q, _o, pulls) => { seen.push(pulls); return 'recorded' })
    // The guard is the router's parser and nothing more: no new strictness, no widened host.
    for (const bad of ['https://github.com.matzen_adobe/pi-superagent/pull/1', '#77', 'o/r#77', 'https://github.com/o/r/issues/9']) {
      expect(tool.execute('r1', { state: 'ready', summary: 's', pullRequests: [bad] }).isError, bad).toBe(true)
    }
    const valid = ['https://github.com/o/r/pull/9', 'https://github.com/o/r/pull/10/', 'https://github.com/o/r/pull/11?files=1', 'http://github.com/o/r/pull/12#issuecomment-1']
    expect(tool.execute('r2', { state: 'ready', summary: 's', pullRequests: valid }).isError, 'a trailing slash, a query and a fragment stay valid').toBeUndefined()
    expect(tool.execute('r3', { state: 'ready', summary: 's', pullRequests: [] }).isError, 'a ready report with no pull request is legal').toBeUndefined()
    expect(seen).toEqual([valid, undefined])
  })
})
