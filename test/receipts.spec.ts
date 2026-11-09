import { describe, expect, it } from 'vitest'
import { pullEndText, receiptText } from '../src/pi/receipts.ts'

describe('what the thread reads when a run ends', () => {
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

  it('an outcome the router cannot see is never stated as one', () => {
    // Measured 2026-11-09 on board #309: the router's account cannot read the repository its own pull requests
    // live in, so the close it held for `kmatzen/pi-superagent#31` came from a read that failed. The board was
    // told "pull/31 closed without merging, so this ticket ends" about a pull request that merged, and the issue
    // was closed on that sentence. A fact nobody observed is said as a fact, and a person acts on it.
    const blind = { url: 'https://github.com/o/r/pull/9', outcome: 'closed' as const, confirmed: false }
    const text = pullEndText('#400', [blind])
    expect(text).not.toMatch(/closed without merging/)
    expect(text).toMatch(/I cannot read https:\/\/github.com\/o\/r\/pull\/9/)
    expect(text).toMatch(/say so here and I will record the merge/)
    expect(text).toMatch(/grant my account read/)
    // A ticket with one observed merge and one pull request it cannot see names the merge as a fact and the
    // other as unverified — the merged work must not be dragged into the blind one's uncertainty.
    const both = pullEndText('#400', [{ url: 'https://github.com/o/r/pull/9', outcome: 'merged' },
      { url: 'https://github.com/o/r/pull/12', outcome: 'closed', confirmed: false }])
    expect(both).toMatch(/merged: https:\/\/github\.com\/o\/r\/pull\/9\. This ticket is done\./)
    expect(both).toMatch(/I cannot read https:\/\/github.com\/o\/r\/pull\/12/)
    expect(both).not.toMatch(/pull\/12 closed without merging/)
  })
})
