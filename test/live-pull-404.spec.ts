import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ghPulls } from '../src/pi/gh-api.ts'
import { PullFollower, UNREADABLE_PULLS, type UnreadablePulls } from '../src/pi/pulls.ts'
import type { Ticket } from '../src/core/index.ts'

/**
 * The live proof, against GitHub itself, of the fact the fakes can only imitate: a 404 is GitHub's answer for
 * a pull request that is gone AND for one the token cannot see, and the two are told apart by asking the
 * repository with the same token. Measured 2026-11-09 with the deployment's own tokens:
 *
 *   account matzenbot_adobe (the router's)  GET repos/kmatzen/pi-superagent      404
 *                                         GET .../pulls/29                      404   (open, merged=false, clean)
 *   account kmatzen (the owner's)           GET .../pulls/29                    200   open
 *
 * and `src/pi` read that 404 as "closed, as of now": board ticket #303 ended "closed without merging" three
 * times, at 07:30:17Z, 09:26:17Z and 11:34:18Z, while its pull request sat open with no review.
 *
 * Skipped unless SUPERAGENT_LIVE=1, so the suite stays offline, and read-only: every call here is a GET.
 * Point PI_SUPERAGENT_PROOF_TOKENS at a `router-token,owner-token` pair to run it against another deployment.
 */
const live = process.env.SUPERAGENT_LIVE === '1'
const state = process.env.PI_SUPERAGENT_STATE ?? join(homedir(), '.pi/superagent')
const tokens = (process.env.PI_SUPERAGENT_PROOF_TOKENS ?? '').split(',')
const routerToken = tokens[0] || join(state, 'github-token')
const ownerToken = tokens[1] || join(state, 'deploy-git-token')
const repo = process.env.PI_SUPERAGENT_PROOF_REPO ?? 'kmatzen/pi-superagent'
const openPull = Number(process.env.PI_SUPERAGENT_PROOF_PULL ?? 29)

describe.skipIf(!live)('a pull request the token cannot see reads as unreadable, not as closed (live GitHub)', () => {
  it('the router token gets 404, and the read reports itself instead of ending a ticket', async () => {
    expect(existsSync(routerToken), `the router's token file: ${routerToken}`).toBe(true)
    const api = ghPulls({ tokenFile: routerToken })
    const read = await api.pull(repo, openPull)
    expect(read, '404 on the pull AND 404 on the repository: invisible, so the read says so and ends nothing')
      .toMatchObject({ read: 'unreadable', reason: expect.stringContaining('repo-invisible') })
    expect(JSON.stringify(read)).toContain('http-404')
  })

  it('the owner token reads the same pull request open, with its own body', async () => {
    expect(existsSync(ownerToken), `the owner's token file: ${ownerToken}`).toBe(true)
    const read = await ghPulls({ tokenFile: ownerToken }).pull(repo, openPull)
    expect(read, 'the pull request the router could not see is open on GitHub').toMatchObject({ read: 'found', pull: { open: true } })
  })

  it('a number the repository really has none of is absence, and only in a repository the token can read', async () => {
    expect(existsSync(ownerToken), `the owner's token file: ${ownerToken}`).toBe(true)
    const read = await ghPulls({ tokenFile: ownerToken }).pull(repo, 9_999_999)
    expect(read, 'repository readable, pull absent: this is the 404 that is a fact about the pull request').toEqual({ read: 'absent' })
  })

  it('the watched repository answers the router token, so its pull requests are read, not reported blind', async () => {
    expect(existsSync(routerToken), `the router's token file: ${routerToken}`).toBe(true)
    const watched = process.env.PI_SUPERAGENT_PROOF_WATCHED ?? 'matzen_adobe/superagent-board-spike'
    const read = await ghPulls({ tokenFile: routerToken }).pull(watched, 1)
    expect(['found', 'absent'], `${watched} is readable to the router's token, so a 404 there is absence`).toContain(read.read)
  })

  it('the 11:34:18Z first pass, replayed: the follows the router ended are read, and none of them closes', async () => {
    // Every thread in the ticket's block, the router's own token, the real follower, GitHub answering live.
    // Before the fix this pass logged `pull.closed outcome=closed` for all of them and ended board ticket #303
    // for the third time; all of these pull requests are open.
    const threads = ['matzen_adobe/fleet-board#70', 'matzen_adobe/fleet-board#69', 'matzen_adobe/pi-superagent#1',
      'kmatzen/pi-superagent#29', 'kmatzen/pi-superagent#31', 'kmatzen/pi-superagent#30']
    const closed: string[] = []
    const warned: string[] = []
    const kv = new Map<string, unknown>()
    const follower = new PullFollower({
      home: 'matzen_adobe/superagent-board-spike', api: ghPulls({ tokenFile: routerToken }),
      openThreads: () => new Set<string>(),
      positions: { get: <T,>(k: string) => kv.get(k) as T | undefined, set: (k, v) => { kv.set(k, v) } },
      self: 'matzenbot_adobe', everyMs: 0,
      closed: thread => { closed.push(thread.id) },
      receive: () => { throw new Error('an unreadable pull must not produce triggers either') },
      warn: (event, fields) => { warned.push(`${event} ${fields.thread} ${fields.reason ?? ''}`) },
    })
    const tickets = [{ follows: threads.map(t => ({ thread: `github:${t}`, own: true })) }] as unknown as Ticket[]
    await follower.reconcile(tickets)
    expect(closed, 'a read that GitHub cannot answer ends no ticket: no close, no invented closedAt').toEqual([])
    const blind = warned.filter(w => w.startsWith('pull.unreadable'))
    expect(blind, 'one line per pull request, naming it and the reason').toHaveLength(threads.length)
    expect(blind.join('\n')).toContain('repo-invisible:http-404')
    const listed = (kv.get(UNREADABLE_PULLS) ?? {}) as UnreadablePulls
    expect(Object.keys(listed), 'and all of them counted, which is what health.json publishes')
      .toEqual(expect.arrayContaining(threads))
  }, 180_000)
})

/** The same facts, printed for the human who is asked to believe them. */
describe.skipIf(!live)('the live reads, printed', () => {
  it('prints what each token was told', async () => {
    for (const [label, file] of [['router', routerToken], ['owner', ownerToken]] as const) {
      if (!existsSync(file)) continue
      const read = await ghPulls({ tokenFile: file }).pull(repo, openPull)
      console.log(`  ${label.padEnd(7)} ${repo}#${openPull} -> ${JSON.stringify(read)}`)
    }
  })
})
