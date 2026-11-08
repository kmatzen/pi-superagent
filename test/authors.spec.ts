import { describe, expect, it } from 'vitest'
import { isListed } from '../src/pi/authors.ts'
import { ghAccounts, policyOf, scopeOf } from '../src/pi/router.ts'

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

describe('which account each GitHub client acts as', () => {
  it('every client acts as the token file it was given, and no client defaults to the gh login', () => {
    // The operator's rule 2026-11-08. The gh login made a second account real in practice: it was the one
    // that read pull requests, and when reads fell back the other way, a 404 ended a live ticket.
    const accounts = ghAccounts({ ghBin: '/bin/gh', githubTokenFile: '/s/github-token' } as never)
    expect(accounts.watched).toEqual({ bin: '/bin/gh', tokenFile: '/s/github-token' })
    expect(accounts.pulls).toEqual({ bin: '/bin/gh', tokenFile: '/s/github-token' })
    expect(ghAccounts({} as never)).toEqual({ watched: {}, pulls: {} })
  })
})

describe('who the router hears', () => {
  const github = (association: string | undefined, author = 'octocat') =>
    ({ source: 'github', meta: { ...association === undefined ? {} : { association }, author } })

  it('people with write access are heard; everyone else stops at the scope, before the judge or a worker', () => {
    const scope = scopeOf({ bots: new Set() } as never)
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(scope.scope(github(association)), association).toEqual({ listened: true, observed: false })
    }
    for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', undefined]) {
      expect(scope.scope(github(association)), String(association)).toEqual({ listened: false, reason: 'senderNotMember' })
    }
  })

  it('a list of logins replaces the write-access rule: an owner off the list is not heard, a listed stranger is', () => {
    const scope = scopeOf({ bots: new Set(), allowed: new Set(['alice', 'team-*']) } as never)
    expect(scope.scope(github('NONE', 'alice')).listened).toBe(true)
    expect(scope.scope(github('NONE', 'team-bob')).listened).toBe(true)
    expect(scope.scope(github('OWNER', 'octocat')).listened).toBe(false)
  })

  it('a source with no notion of repository access is heard as before', () => {
    expect(scopeOf({ bots: new Set() } as never).scope({ source: 'board', meta: {} }).listened).toBe(true)
  })
})
