import { describe, expect, it } from 'vitest'
import { reportTool, type ReportOutcome, type Reporter } from '../src/pi/report-tool.ts'

/** What the worker's tool call answers, for a reporter whose verdict is `outcome`. */
const answer = (outcome: ReportOutcome | void): string => {
  const reporter: Reporter = () => outcome
  return reportTool(reporter).execute('r1', { state: 'ready', summary: 'the merge landed' }).content[0]!.text
}

describe('ticket_report', () => {
  it('a waiting report needs a wake-up in range, a ready one cannot carry it, and the wake-up reaches the reporter', () => {
    // Operator, 2026-11-12: someone always watches what a worker leaves running.
    const calls: Array<number | undefined> = []
    const tool = reportTool((_s, _m, _q, _o, _p, wake) => { calls.push(wake) })
    const said = (args: Record<string, unknown>) => tool.execute('r', { summary: 'run 31 trains', ...args })
    expect(said({ state: 'waiting' }).isError, 'waiting without a wake-up').toBe(true)
    expect(said({ state: 'waiting', wakeInMinutes: 2 }).isError, 'too soon').toBe(true)
    expect(said({ state: 'waiting', wakeInMinutes: 1000 }).isError, 'too late: nobody looks for 16 hours').toBe(true)
    expect(said({ state: 'ready', wakeInMinutes: 60 }).isError, 'ready is finished work').toBe(true)
    expect(calls, 'none of those reached the router').toEqual([])
    expect(said({ state: 'waiting', wakeInMinutes: 60 }).isError).toBeUndefined()
    expect(said({ state: 'blocked', question: 'Stop the idle pod?', wakeInMinutes: 30 }).isError, 'a question can keep a watch too').toBeUndefined()
    expect(calls).toEqual([60, 30])
  })

  it('refuses a summary that fails the plain-language check in the worker\'s own turn, says what to fix, and reports nothing', () => {
    const calls: string[] = []
    const tool = reportTool((_s, summary) => { calls.push(summary) })
    const wall = `Fixed \`launcher.py\` token precedence in app/ci/launcher.py; CI run mid-flight, check back in 50 min to confirm the pod clone.`
    const refused = tool.execute('r', { state: 'ready', summary: wall })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(/^Not reported: the summary is posted on the issue for the person who asked/)
    expect(refused.content[0]!.text).toMatch(/line 1 contains a file path/)
    expect(refused.content[0]!.text, 'and where the detail belongs').toMatch(/what to check next go in notes/)
    expect(calls, 'nothing reached the router').toEqual([])
  })

  it('hands private notes to the reporter beside a summary that reads plainly', () => {
    const calls: Array<[string, string | undefined]> = []
    const tool = reportTool((_s, summary, _q, _o, _p, _w, notes) => { calls.push([summary, notes]) })
    expect(tool.execute('r', { state: 'ready', summary: 'The upload fix is in review.', notes: '  check app/ci/launcher.py first  ' }).isError).toBeUndefined()
    expect(tool.execute('r', { state: 'ready', summary: 'The upload fix is in review.', notes: '   ' }).isError).toBeUndefined()
    expect(calls).toEqual([['The upload fix is in review.', 'check app/ci/launcher.py first'], ['The upload fix is in review.', undefined]])
  })

  it('says the work is reported when the router took the report', () => {
    expect(answer('recorded')).toBe('reported')
  })

  it('a report that reached no worker is answered as that, because "reported" is a lie the next run believes', () => {
    // Measured 2026-11-09 on the operator's board spike #255: a report the router had already ended
    // answered `reported`, posted nothing, and the ticket's next three runs started from that receipt.
    const said = answer('dropped')
    expect(said).toMatch(/not recorded/)
    expect(said).toMatch(/no reply was posted/)
    expect(said, 'it names the door that works').toMatch(/A comment on the issue starts the work again/)
  })

  it('a reporter that cannot see the verdict (the worker pane appending its report file) says the plain thing', () => {
    expect(answer(undefined)).toBe('reported')
  })

  it('refuses a ready result that carries a question, in the worker\'s own turn, and reports nothing', () => {
    // The engine refuses this combination; from the router the refusal reached no one (2026-11-12).
    const calls: string[] = []
    const tool = reportTool(state => { calls.push(state); return 'recorded' })
    const res = tool.execute('r1', { state: 'ready', summary: 'PR is up', question: 'approve it?' })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('report blocked with the question')
    expect(calls, 'nothing reached the router').toEqual([])
    expect(tool.execute('r2', { state: 'blocked', summary: 'PR is up', question: 'approve it?' }).isError).toBeUndefined()
    expect(calls).toEqual(['blocked'])
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
    const bad = 'https://github.comExample-Corp/widget/pull/1994'
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
      pullRequests: ['https://github.com/o/r/pull/9', 'https://git.example-corp.com/widget/widget/pull/1574'],
    })
    expect(verdict.isError, 'an enterprise URL tracks nothing, so the report says so instead of dropping it').toBe(true)
    expect(verdict.content[0]!.text).toContain('git.example-corp.com/widget/widget/pull/1574')
    expect(verdict.content[0]!.text).not.toContain('o/r/pull/9')
    expect(seen, 'a mixed report is refused whole, so the worker re-reports both').toEqual([])
  })

  it('refuses every URL parsePull refuses, and accepts every URL it accepts', () => {
    const seen: Array<readonly string[] | undefined> = []
    const tool = reportTool((_s, _su, _q, _o, pulls) => { seen.push(pulls); return 'recorded' })
    // The guard is the router's parser and nothing more: no new strictness, no widened host.
    for (const bad of ['https://github.com.example-corp/widget/pull/1', '#77', 'o/r#77', 'https://github.com/o/r/issues/9']) {
      expect(tool.execute('r1', { state: 'ready', summary: 's', pullRequests: [bad] }).isError, bad).toBe(true)
    }
    const valid = ['https://github.com/o/r/pull/9', 'https://github.com/o/r/pull/10/', 'https://github.com/o/r/pull/11?files=1', 'http://github.com/o/r/pull/12#issuecomment-1']
    expect(tool.execute('r2', { state: 'ready', summary: 's', pullRequests: valid }).isError, 'a trailing slash, a query and a fragment stay valid').toBeUndefined()
    expect(tool.execute('r3', { state: 'ready', summary: 's', pullRequests: [] }).isError, 'a ready report with no pull request is legal').toBeUndefined()
    expect(seen).toEqual([valid, undefined])
  })
})
