import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isListed } from '../src/pi/authors.ts'
import { policyOf } from '../src/pi/router.ts'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const card = (id: string, comments: Array<{ author: string; at: string; body: string }>) => `---
id: TASK-${id}
status: To Do
---

# DO: the thing

<!-- COMMENTS:BEGIN -->
${comments.map((c, i) => `${i ? '\n---\n' : ''}\nauthor: ${c.author}\ncreated: ${c.at}\n\n---\n\n${c.body}\n`).join('')}
<!-- COMMENTS:END -->
`

describe('bot patterns', () => {
  it('the gate rechecks the author, so a trigger stored with the old human flag cannot open a ticket', () => {
    const policy = policyOf({ bots: new Set(['pi-*', 'fleet-*']) } as never)
    const trigger = (id: string) => ({ human: true, actor: { source: 'board', id } }) as never
    expect(policy.gate(trigger('pi-f11a9262'), {} as never, [])).toMatchObject({ admissible: false })
    expect(policy.gate(trigger('octocat'), {} as never, [])).toMatchObject({ admissible: true })
  })

  it('a fleet agent matches its pattern, a person does not', () => {
    const bots = new Set(['pi-*', 'fleet-*', 'board-bot'])
    expect(isListed('pi-f11a9262', bots)).toBe(true)
    expect(isListed('fleet-answer-loop', bots)).toBe(true)
    expect(isListed('board-bot', bots)).toBe(true)
    expect(isListed('octocat', bots)).toBe(false)
    expect(isListed('pilot', bots), 'a pattern is anchored: pi-* is not pi*').toBe(false)
    expect(isListed('xzy', new Set(['x.y'])), 'regex characters are literal').toBe(false)
  })

  it("a fleet agent's comment is not a person asking: that is how an approval request became a job", () => {
    const bots = new Set(['pi-*', 'fleet-*'])
    expect(isListed('pi-f11a9262', bots)).toBe(true)
    expect(isListed('octocat', bots)).toBe(false)
  })
})
