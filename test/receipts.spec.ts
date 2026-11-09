import { describe, expect, it } from 'vitest'
import { pullEndText, receiptText } from '../src/pi/receipts.ts'
import { evidenceOf } from './pull-read.ts'

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

  it('an ending quotes the read it acted on, so a person can check it against the API', () => {
    const text = pullEndText('#235', [{
      url: 'https://github.com/matzen_adobe/fleet-board/pull/74', outcome: 'closed',
      evidence: evidenceOf({ repo: 'matzen_adobe/fleet-board', number: 74, status: 0, state: 'closed',
        closedAt: '2026-11-09T06:00:01Z', mergedAt: null, headRefOid: '9a0e7ea1234567890abcdef1234567890abcdef1' }),
    }])
    expect(text).toMatch(/closed without merging/)
    // Every field the ticket asks a receipt to carry: PR number, raw state, closed_at, merged_at, head, exit status.
    expect(text).toContain('#74 in matzen_adobe/fleet-board')
    expect(text).toContain('gh exit 0')
    expect(text).toContain('state=closed')
    expect(text).toContain('closed_at=2026-11-09T06:00:01Z')
    expect(text).toContain('merged_at=null')
    expect(text).toContain('head=9a0e7ea123')
  })

  it('a pull request GitHub has no number for is named as that, not as a reviewer closing the work', () => {
    const text = pullEndText('#400', [{ url: 'https://github.com/o/r/pull/9', outcome: 'closed', evidence: evidenceOf({ number: 9, status: 1, reason: 'no-such-pull-request' }) }])
    expect(text).toMatch(/no longer exists on GitHub.*nothing merged/)
    expect(text).not.toMatch(/closed without merging/)
    expect(text).toContain('read=no-such-pull-request')
  })
})
