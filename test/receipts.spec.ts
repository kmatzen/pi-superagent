import { describe, expect, it } from 'vitest'
import { pullEndText, receiptText } from '../src/pi/receipts.ts'

describe('what the thread reads when a run ends', () => {
  it('a run that left something going says when the next look is', () => {
    const text = receiptText('#145', 'worker', { state: 'waiting', summary: 'run 31 trains', wakeAt: '2026-11-12T20:15:00.000Z' })
    expect(text).toBe('#145 waiting: run 31 trains\n\nNext check: a fresh worker looks at it at 20:15 UTC.')
    expect(receiptText('#145', 'worker', { state: 'blocked', summary: 'pod idle', question: 'Stop it?', wakeAt: '2026-11-12T20:15:00.000Z' }))
      .toMatch(/\*\*Question:\*\* Stop it\?[\s\S]*Next check: a fresh worker looks at it at 20:15 UTC\./)
  })

  it('a ticket whose CI the router can watch is woken by the checks, so the timer is only the backstop', () => {
    const waiting = { state: 'waiting', summary: 'pushed, waiting on CI', wakeAt: '2026-11-12T20:15:00.000Z' }
    const text = receiptText('#145', 'worker', waiting, false, undefined, true)
    expect(text).toBe('#145 waiting: pushed, waiting on CI\n\nNext check: a fresh worker the moment its pull-request '
      + 'checks finish; a timed backstop looks at it at 20:15 UTC if nothing fires.')
    expect(text).not.toMatch(/Next check: a fresh worker looks at it at/)
  })

  it('a result is one line: the thread, the state, the summary, and the end of the ticket', () => {
    const text = receiptText('#400', 'worker', { state: 'ready', summary: 'merged and deployed' })
    expect(text.startsWith('#400 ready: merged and deployed'), text).toBe(true)
    // A finished report with nothing to wait on says so: the ticket that only got its summary stayed open and
    // labelled on GitHub, where intake hears it again (issue #309).
    expect(text).toMatch(/ends with the report[\s\S]*nothing runs it now[\s\S]*A comment on the closed issue/)
  })

  it('a question is asked on the thread, with an invitation to answer there', () => {
    const text = receiptText('#400', 'worker', { state: 'blocked', summary: 'needs the merge window', question: 'Ship tonight?' })
    expect(text).toContain('#400 blocked: needs the merge window')
    expect(text).toContain('**Question:** Ship tonight?')
    expect(text).toContain('Reply here')
  })

  it('each way a run can fail says what the person can do about it', () => {
    expect(receiptText('#400', 'worker', { state: 'failed', summary: 'tests red' })).toContain('reply here to steer it')
    expect(receiptText('#400', 'silent', { state: 'failed', summary: 'x' })).toMatch(/stopped without reporting a result[\s\S]*reply here/)
    expect(receiptText('#400', 'crash', { state: 'failed', summary: 'the worker crashed: its pi left' })).toContain('superagent restart')
    expect(receiptText('#400', 'crash', { state: 'failed', summary: 'the worker crashed: its pi left' }, true))
      .toMatch(/started a fresh worker[\s\S]*If that one crashes too/)
    expect(receiptText('#400', 'launch', { state: 'failed', summary: 'could not start a worker: no pi' })).toContain('tries again on every poll')
  })

  it('a result with a pull request links it and says the ticket now waits for it', () => {
    const text = receiptText('#400', 'worker', { state: 'ready', summary: 'renamed the button', pullRequests: ['https://github.com/o/r/pull/9'] })
    expect(text).toContain('**Pull request:** https://github.com/o/r/pull/9')
    expect(text).toContain('stays open until the pull request is merged or closed')
    expect(receiptText('#400', 'worker', { state: 'blocked', summary: 'x', question: 'Rebase?', pullRequests: ['https://github.com/o/r/pull/9'] }))
      .toMatch(/Pull request:\*\* https:\/\/github.com\/o\/r\/pull\/9[\s\S]*Question:\*\* Rebase\?/)
    expect(receiptText('#400', 'worker', { state: 'ready', summary: 'answered' }), 'no pull request, so the ticket ends here')
      .toMatch(/ends with the report[\s\S]*no pull request is open/)
  })

  it('several pull requests are numbered in merge order, point at their live status, and say they all hold the ticket', () => {
    const run = { state: 'ready', summary: 'kit and app', pullRequests: ['https://github.com/o/kit/pull/5', 'https://github.com/o/app/pull/9'] }
    const text = receiptText('#400', 'worker', run, false, 'https://github.com/o/r/issues/400#issuecomment-77')
    expect(text).toContain('**Pull requests, in merge order:**\n1. https://github.com/o/kit/pull/5\n2. https://github.com/o/app/pull/9')
    expect(text).toContain("Each one's state, kept current: https://github.com/o/r/issues/400#issuecomment-77")
    expect(text).toContain('until its pull requests are merged or closed; comments, reviews and each merge go to the worker')
    expect(text, 'never the singular for two').not.toContain('until the pull request is merged')
    expect(receiptText('#400', 'worker', run), 'before the status comment exists, no link').not.toContain('kept current')
  })

  it('the end of a pull request is said on the issue: done when merged, how to start again when closed', () => {
    const pr = (n: number, outcome: 'merged' | 'closed') => ({ url: `https://github.com/o/r/pull/${n}`, outcome })
    expect(pullEndText('#400', [pr(9, 'merged')])).toBe('#400 merged: https://github.com/o/r/pull/9. This ticket is done.')
    expect(pullEndText('#400', [pr(9, 'closed')])).toMatch(/closed without merging[\s\S]*A comment here starts the work again/)
    // A ticket opens as many pull requests as the work needs; the engine ends it on the last close, and that
    // one outcome must not be said about the pull request that merged.
    const mixed = pullEndText('#400', [pr(9, 'merged'), pr(12, 'closed')])
    expect(mixed).toMatch(/pull\/9 merged and https:\/\/github.com\/o\/r\/pull\/12 closed without merging/)
    expect(mixed).toMatch(/ends with the work that landed/)
  })

  it('the end of a pull request quotes the question nobody answered, because the ticket keeps none', () => {
    const pr = (n: number, outcome: 'merged' | 'closed') => ({ url: `https://github.com/o/r/pull/${n}`, outcome })
    expect(pullEndText('#400', [pr(9, 'closed')], undefined, 'Leave it closed, yes or no?'))
      .toMatch(/\*\*The question that was open when it ended:\*\* Leave it closed, yes or no\?$/)
    expect(pullEndText('#400', [pr(9, 'merged')], undefined)).toBe('#400 merged: https://github.com/o/r/pull/9. This ticket is done.')
  })

  it('a pull request end that leaves a check owed says the check still happens and the issue stays open', () => {
    const pr = (n: number, outcome: 'merged' | 'closed') => ({ url: `https://github.com/o/r/pull/${n}`, outcome })
    expect(pullEndText('#387', [pr(9, 'merged')], '2026-11-13T03:56:17.558Z')).toBe('#387: https://github.com/o/r/pull/9 merged. '
      + 'A fresh worker still makes the check the last one asked for at 03:56 UTC, and this issue stays open until it reports.')
    expect(pullEndText('#387', [pr(9, 'merged'), pr(12, 'closed')], '2026-11-13T03:56:17.558Z'))
      .toMatch(/^#387: https:\/\/github.com\/o\/r\/pull\/9 merged and https:\/\/github.com\/o\/r\/pull\/12 closed without merging\. A fresh worker/)
  })
})
