import { describe, expect, it } from 'vitest'
import { isListed } from '../src/pi/authors.ts'
import { policyOf } from '../src/pi/router.ts'

describe('bot patterns', () => {
  it('the gate rechecks the author, so a trigger stored with the old human flag cannot open a ticket', () => {
    const policy = policyOf({ bots: new Set(['pi-*', 'fleet-*']) } as never)
    const trigger = (id: string) => ({ human: true, actor: { source: 'github', id } }) as never
    expect(policy.gate(trigger('pi-a1b2c3d4'), {} as never, [])).toMatchObject({ admissible: false })
    expect(policy.gate(trigger('octocat'), {} as never, [])).toMatchObject({ admissible: true })
  })

  it('an agent matches its pattern, a person does not', () => {
    const bots = new Set(['pi-*', 'fleet-*', 'release-bot'])
    expect(isListed('pi-a1b2c3d4', bots)).toBe(true)
    expect(isListed('fleet-answer-loop', bots)).toBe(true)
    expect(isListed('release-bot', bots)).toBe(true)
    expect(isListed('octocat', bots)).toBe(false)
    expect(isListed('pilot', bots), 'a pattern is anchored: pi-* is not pi*').toBe(false)
    expect(isListed('xzy', new Set(['x.y'])), 'regex characters are literal').toBe(false)
  })

  it("an agent's comment is not a person asking: that is how an approval request became a job", () => {
    const bots = new Set(['pi-*', 'fleet-*'])
    expect(isListed('pi-a1b2c3d4', bots)).toBe(true)
    expect(isListed('octocat', bots)).toBe(false)
  })
})
