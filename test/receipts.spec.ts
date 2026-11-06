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
    expect(pullEndText('#400', 'merged', ['https://github.com/o/r/pull/9'])).toBe('#400 merged: https://github.com/o/r/pull/9. This ticket is done.')
    expect(pullEndText('#400', 'closed', ['https://github.com/o/r/pull/9'])).toMatch(/closed without merging[\s\S]*A comment here starts the work again/)
  })
})
