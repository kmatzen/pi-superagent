import { describe, expect, it } from 'vitest'
import { PRIORITY_REGRANT_CAP, REGRANT_CAP, configFrom, regrantPlan, regrantUsed } from '../src/pi/extension.ts'

// pi-superagent#15: the cap lived in the source, so widening a starved lane meant editing the installed file.
const DAY = '2026-11-23'
const env = (over: Record<string, string> = {}) =>
  configFrom({ PI_SUPERAGENT_ROLE: 'router', PI_SUPERAGENT_STATE: '/state', ...over })

describe('the regrant cap is a setting', () => {
  it('keeps the constant as the default when config says nothing', () => {
    expect(REGRANT_CAP).toBe(2)
    expect(PRIORITY_REGRANT_CAP).toBe(6)
    expect(env()).not.toHaveProperty('regrantCap')
    expect(env()).not.toHaveProperty('priorityRegrantCap')
  })

  it('reads both lanes from the environment', () => {
    const cfg = env({ PI_SUPERAGENT_REGRANT_CAP: '8', PI_SUPERAGENT_PRIORITY_REGRANT_CAP: '12' })
    expect(cfg?.regrantCap).toBe(8)
    expect(cfg?.priorityRegrantCap).toBe(12)
  })

  it('refuses a cap that is not a count, at startup', () => {
    expect(() => env({ PI_SUPERAGENT_REGRANT_CAP: '0' })).toThrow(/PI_SUPERAGENT_REGRANT_CAP/)
    expect(() => env({ PI_SUPERAGENT_REGRANT_CAP: 'many' })).toThrow(/PI_SUPERAGENT_REGRANT_CAP/)
  })
})

describe('the counter behind the cap', () => {
  it('grants up to the cap and no further', () => {
    let c = regrantPlan(undefined, '#860', DAY, 2)
    expect(regrantUsed(c, '#860', DAY)).toBe(1)
    c = regrantPlan(c, '#860', DAY, 2)
    expect(regrantUsed(c, '#860', DAY)).toBe(2)
    expect(regrantPlan(c, '#860', DAY, 2)).toBeUndefined()
  })

  it('counts a day of its own, so the capped line reports the day it refused', () => {
    const yesterday = regrantPlan(undefined, '#860', '2026-11-22', 2)
    expect(regrantUsed(yesterday, '#860', DAY)).toBe(0)
    expect(regrantPlan(yesterday, '#860', DAY, 2)).toEqual({ day: DAY, perIssue: { '#860': 1 } })
  })

  it('keeps the other issues in the ledger when one is counted', () => {
    const c = regrantPlan({ day: DAY, perIssue: { '#891': 2 } }, '#860', DAY, 2)
    expect(c).toEqual({ day: DAY, perIssue: { '#891': 2, '#860': 1 } })
  })
})
