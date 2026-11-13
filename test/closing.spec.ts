import { describe, expect, it } from 'vitest'
import { closesBoardIssue } from '../src/pi/closing.ts'

const HOME = 'acme/board'

describe('closing keywords for board issues', () => {
  it('finds every form GitHub honours for an issue of the board', () => {
    expect(closesBoardIssue('## Summary\n\nCloses acme/board#340', HOME)).toBe('Closes acme/board#340')
    expect(closesBoardIssue('fixes: acme/board#12', HOME)).toBe('fixes: acme/board#12')
    expect(closesBoardIssue('Resolved https://github.com/acme/board/issues/7', HOME)).toBeTruthy()
    expect(closesBoardIssue('CLOSE Acme/Board#5', HOME), 'GitHub reads names in any case').toBeTruthy()
  })

  it('leaves alone a plain reference, another repository, and prose', () => {
    expect(closesBoardIssue('Part of acme/board#340', HOME)).toBeUndefined()
    expect(closesBoardIssue('Closes #1234', HOME), 'an issue of the repository the pull request is in').toBeUndefined()
    expect(closesBoardIssue('Closes acme/models#1234', HOME)).toBeUndefined()
    expect(closesBoardIssue('This closes the loop on acme/board board work.', HOME)).toBeUndefined()
    expect(closesBoardIssue('Closes acme/board#340', ''), 'no board, nothing to protect').toBeUndefined()
  })
})
