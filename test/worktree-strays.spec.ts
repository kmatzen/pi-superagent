import { describe, expect, it } from 'vitest'
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneRootScratch, STRAY_MAX_AGE_MS, sweepWorktrees } from '../src/pi/extension.ts'

// agent-inbox#887: four scratch files sat in the work root and warned `worktree.strays strays=4` on every router start,
// 14 warns in 24 h, because the sweep counted non-directories and never removed one.
const DAY = 86_400_000
function root(files: Record<string, { ageDays: number }>, dirs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'work-root-'))
  for (const name of dirs) mkdirSync(join(dir, name), { recursive: true })
  for (const [name, { ageDays }] of Object.entries(files)) {
    const path = join(dir, name)
    writeFileSync(path, 'scratch\n')
    const at = (Date.now() - ageDays * DAY) / 1000
    utimesSync(path, at, at)
  }
  return dir
}

const swept = (dir: string, open: ReadonlySet<string> = new Set()) =>
  sweepWorktrees(dir, open, 20, Infinity)

describe('work-root scratch prune (agent-inbox#887)', () => {
  it('deletes the idle scratch, so a dirty root no longer counts as strays', async () => {
    const dir = root({ 'uv-sync-wt.log': { ageDays: 4 }, 'clone.log': { ageDays: 5 }, 'msg_orig.txt': { ageDays: 3 } })
    const report = await swept(dir)
    expect(report.straysRemoved.sort()).toEqual(['clone.log', 'msg_orig.txt', 'uv-sync-wt.log'])
    expect(report.strays).toBe(0)
    expect(existsSync(join(dir, 'clone.log'))).toBe(false)
  })

  it('warns again the next sweep, because the count is zero: the recurrence is what ends', async () => {
    const dir = root({ 'precommit-all.log': { ageDays: 3 } })
    expect((await swept(dir)).strays).toBe(0)
    expect((await swept(dir)).straysRemoved).toEqual([])
  })

  it('keeps scratch a running worker wrote today, and says so in the count', async () => {
    const dir = root({ 'in-flight.log': { ageDays: 0.1 } })
    expect((await swept(dir)).strays).toBe(1)
    expect(existsSync(join(dir, 'in-flight.log'))).toBe(true)
  })

  it('never deletes a symlink, so a root that warns after a prune holds something a person should see', async () => {
    const dir = root({}, ['outside'])
    const target = join(dir, 'outside', 'secret')
    writeFileSync(target, 'do not delete me via the work root\n')
    const link = join(dir, 'link.log')
    symlinkSync(target, link)
    const at = (Date.now() - 9 * DAY) / 1000
    lutimesSync(link, at, at)
    expect((await swept(dir)).strays).toBe(1)
    expect(existsSync(target)).toBe(true)
  })

  it('leaves the open ticket workspace standing while it clears the root', async () => {
    const dir = root({ 'clone.log': { ageDays: 3 } }, ['ticket-open-1'])
    const report = await swept(dir, new Set(['ticket-open-1']))
    expect(report.straysRemoved).toEqual(['clone.log'])
    expect(existsSync(join(dir, 'ticket-open-1'))).toBe(true)
  })

  it('prunes on its own, and an unreadable root answers without throwing', async () => {
    const dir = root({ 'old.log': { ageDays: 2 } })
    expect(await pruneRootScratch(dir, Date.now(), STRAY_MAX_AGE_MS)).toEqual({ removed: ['old.log'], kept: 0 })
    expect(await pruneRootScratch(join(dir, 'no-such-root'))).toEqual({ removed: [], kept: 0 })
  })
})
