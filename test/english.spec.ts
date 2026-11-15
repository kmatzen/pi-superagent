import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nonEnglish, publishedText } from '../src/pi/english.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'english-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

// The opening of one of the four bodies that went out on 2026-11-12.
const CHINESE = '## 这个 PR 是什么\n\n把注意力脚手架拆成五个按层的 PR，按顺序合并。'

describe('english', () => {
  it('flags a paragraph in another language, and lets a short quote through', () => {
    expect(nonEnglish(CHINESE)).toBe(true)
    expect(nonEnglish('## What this PR is\n\nSplits the attention scaffolding into five stacked PRs.')).toBe(false)
    expect(nonEnglish('The dataset label "中文标签" is misspelled; fixed it.'), 'a four-character quote is fine').toBe(false)
  })

  it('reads what a command publishes, files included, and nothing from commands that publish nothing', () => {
    const ws = tmp()
    mkdirSync(join(ws, 'app'))
    writeFileSync(join(ws, 'app', 'body.md'), CHINESE)
    writeFileSync(join(ws, 'msg.txt'), 'fix: 修复了注意力层的权重加载顺序问题')
    writeFileSync(join(ws, 'comment.md'), CHINESE)
    expect(publishedText(`gh pr create --title "Split" --body "${CHINESE}"`, ws)).toContain('这个')
    expect(publishedText('cd app && gh pr edit 2031 --body-file body.md', ws), 'a body file next to a cd').toContain('这个')
    expect(publishedText('git commit -F msg.txt', ws)).toContain('修复')
    expect(publishedText('gh api repos/o/r/issues/1/comments -f body=@comment.md', ws)).toContain('这个')
    expect(publishedText(`gh pr comment 7 --body-file ${join(ws, 'comment.md')}`, '/elsewhere'), 'an absolute path').toContain('这个')
    expect(publishedText('grep -rn "中文标签" data/', ws), 'reading is not publishing').toBeUndefined()
    expect(publishedText('gh pr view 2031 --json body', ws), 'neither is viewing').toBeUndefined()
  })
})
