import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkGithubIdentity } from '../src/pi/identity.ts'
import { GithubSource, type GithubApi } from '../src/pi/source-github.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sa-id-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const BOTS = new Set(['pi-*', 'fleet-*'])
const api = (login: string | (() => Promise<string>)): GithubApi => ({
  comments: async () => [], issues: async () => [], postComment: async () => {},
  whoami: async () => (typeof login === 'string' ? login : login()),
})
const check = (over: Partial<Parameters<typeof checkGithubIdentity>[0]> = {}) => checkGithubIdentity({
  api: api('agent-bot'), repo: 'o/r', bots: BOTS, now: () => '2026-11-06T12:00:00.000Z', ...over,
})

const codes = (got: Awaited<ReturnType<typeof checkGithubIdentity>>) => got.problems.map(p => p.code)

describe('checkGithubIdentity', () => {
  it('confirms the account config named', async () => {
    expect(await check({ configuredSelf: 'agent-bot' })).toMatchObject({ login: 'agent-bot', self: 'agent-bot', mode: 'configured', problems: [] })
  })

  it('names both accounts when the credential is not the one config claims', async () => {
    const got = await check({ api: api('matzen_adobe'), configuredSelf: 'agent-bot' })
    expect(got.mode).toBe('mismatch')
    expect(codes(got)).toEqual(['github-identity'])
    expect(got.problems[0]!.detail).toContain('speaks as matzen_adobe')
    expect(got.problems[0]!.detail).toContain('agent-bot')
  })

  it('trusts the credential over the config for self, so its own receipts are never requests', async () => {
    expect((await check({ api: api('someone-else'), configuredSelf: 'agent-bot' })).self).toBe('someone-else')
  })

  it('adopts a login no person writes from, with no setting at all', async () => {
    expect(await check({ api: api('superagent[bot]') })).toMatchObject({ self: 'superagent[bot]', mode: 'adopted' })
    expect(await check({ api: api('pi-superagent') })).toMatchObject({ self: 'pi-superagent', mode: 'adopted' })
  })

  it("never adopts the operator's own login: filtering it would drop every comment they write", async () => {
    const got = await check({ api: api('matzen_adobe') })
    expect(got).toMatchObject({ self: '', mode: 'shared', problems: [] })
  })

  it('a login whose case differs from config is the same account', async () => {
    expect((await check({ api: api('Agent-Bot'), configuredSelf: 'agent-bot' })).problems).toEqual([])
  })

  it('reports a token file that is not there, where a health check will show it', async () => {
    const got = await check({ tokenFile: join(tmp(), 'absent') })
    expect(codes(got)).toEqual(['github-token-missing'])
    expect(got.problems[0]!.place).toBe('GitHub')
  })

  it('reports a token file the group can read: it is a credential, not a config file', async () => {
    const dir = tmp()
    const file = join(dir, 'github.token')
    writeFileSync(file, 'ghp_x')
    chmodSync(file, 0o644)
    expect(codes(await check({ tokenFile: file }))).toEqual(['github-token-readable'])
    chmodSync(file, 0o600)
    expect(codes(await check({ tokenFile: file }))).toEqual([])
  })

  it('says so when GitHub will not answer, instead of reporting an identity it does not have', async () => {
    const got = await check({ api: api(async () => { throw new Error('gh api user exited 4: Bad credentials') }) })
    expect(got.mode).toBe('unknown')
    expect(codes(got)).toEqual(['github-identity-unknown'])
    expect(got.problems[0]!.detail).toContain('Bad credentials')
  })

  it('has nothing to say about a source that never asks GitHub (a fake, a test)', async () => {
    const got = await checkGithubIdentity({ api: { comments: async () => [], issues: async () => [], postComment: async () => {} },
      repo: 'o/r', bots: BOTS, now: () => '2026-11-06T12:00:00.000Z' })
    expect(got).toMatchObject({ login: '', mode: 'unknown', problems: [] })
  })
})

/** The part of the identity that changes behaviour: which author intake reads as a request. */
describe('the source and its own login', () => {
  const dir = tmp()
  mkdirSync(join(dir, 'state'), { recursive: true })
  const store = new Map<string, unknown>()
  const positions = { get: <T,>(k: string) => store.get(k) as T | undefined, set: (k: string, v: unknown) => { store.set(k, v) } }

  const source = (api: GithubApi, self: string) => new GithubSource(api, { repo: 'o/r', self, bots: BOTS }, positions)
  const comment = (author: string, body: string): GithubApi => ({
    comments: async () => [{ issue: 1, author, at: '2026-11-06T12:00:00Z', body }],
    issues: async () => [], postComment: async () => {},
  })

  it('reads a comment from a login it has adopted as itself as nothing', async () => {
    const github = source(comment('agent-bot', 'the worker reported ready'), 'pi-superagent')
    github.setSelf('agent-bot')
    expect(await github.poll()).toEqual([])
  })

  it('reads a comment from the operator as a request, in the same pass', async () => {
    const github = source(comment('matzen_adobe', 'fix the build'), 'pi-superagent')
    github.setSelf('agent-bot')
    expect((await github.poll()).map(t => t.actor.id)).toEqual(['matzen_adobe'])
  })
})
