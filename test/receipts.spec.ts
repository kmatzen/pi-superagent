import { describe, expect, it } from 'vitest'
import { pullEndText, receiptText } from '../src/pi/receipts.ts'

describe('what the thread reads when a run ends', () => {
  it('a result is one line: the thread, the state, the summary', () => {
    expect(receiptText('#400', 'worker', { state: 'ready', summary: 'merged and deployed' })).toBe('#400 ready: merged and deployed')
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
    expect(receiptText('#400', 'worker', { state: 'ready', summary: 'answered' }), 'no pull request, no wait').toBe('#400 ready: answered')
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

  it('names the pull request the router could not read, on the receipt that ends the ticket', () => {
    // Measured 2026-11-09: board ticket #303 read "closed without merging" three times for a pull request the
    // router's token gets 404 on. An ending is a claim about GitHub, so the receipt says which part it read.
    const pr = (n: number, outcome: 'merged' | 'closed') => ({ url: `https://github.com/o/r/pull/${n}`, outcome })
    const blind = [{ url: 'https://github.com/kmatzen/pi-superagent/pull/29', reason: 'repo-invisible:http-404' }]
    const text = pullEndText('#303', [pr(9, 'closed')], blind)
    expect(text).toMatch(/closed without merging/)
    expect(text).toMatch(/could NOT read https:\/\/github\.com\/kmatzen\/pi-superagent\/pull\/29 \(repo-invisible:http-404\)/)
    expect(text).toMatch(/nothing above is verified against that pull request: it may be open/)
    expect(pullEndText('#303', [pr(9, 'merged')], blind), 'a merge is not verified by a pull request it could not read either')
      .toMatch(/This ticket is done\.[\s\S]*could NOT read/)
    expect(pullEndText('#303', [pr(9, 'merged')]), 'nothing added when every follow was readable')
      .toBe('#303 merged: https://github.com/o/r/pull/9. This ticket is done.')
  })

  it('says a deleted pull request as a deleted pull request, never as unreadable', () => {
    // `absent` is GitHub answering for a repository the router CAN read and having no such number. "The router
    // could not read it" would be its own false statement, and this receipt is where an operator reads it.
    const pr = (n: number, outcome: 'merged' | 'closed') => ({ url: `https://github.com/o/r/pull/${n}`, outcome })
    const text = pullEndText('#410', [pr(9, 'merged')],
      [{ url: 'https://github.com/o/r/pull/12', reason: 'github-has-no-such-pull' }])
    expect(text).toMatch(/GitHub has no pull request at https:\/\/github\.com\/o\/r\/pull\/12/)
    expect(text).toMatch(/the router can read that repository/)
    expect(text).toMatch(/ended this ticket on the signal above, not on that pull request/)
    expect(text, 'it is not reported as a read the router could not make')
      .not.toMatch(/could NOT read/)
    const both = pullEndText('#410', [pr(9, 'merged')],
      [{ url: 'https://github.com/o/r/pull/12', reason: 'github-has-no-such-pull' },
        { url: 'https://github.com/secret/lib/pull/3', reason: 'repo-invisible:http-404' }])
    expect(both).toMatch(/could NOT read https:\/\/github\.com\/secret\/lib\/pull\/3/)
    expect(both).toMatch(/GitHub has no pull request at https:\/\/github\.com\/o\/r\/pull\/12/)
  })
})
