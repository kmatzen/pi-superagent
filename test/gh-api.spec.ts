import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ghApi } from '../src/pi/gh-api.ts'
import { REPLY_MARKER } from '../src/pi/source-github.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ghapi-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A fake `gh`: answers the two reads from files and records every write, so no network is involved. */
function fakeGh(comments: string, issues: string) {
  const dir = tmp()
  writeFileSync(join(dir, 'comments.json'), comments)
  writeFileSync(join(dir, 'issues.json'), issues)
  const bin = join(dir, 'gh')
  writeFileSync(bin, `#!/bin/bash
case "$1 $2" in
  "api repos/o/r/issues/comments"*) cat "$(dirname "$0")/comments.json" ;;
  "api repos/o/r/issues?state="*)  cat "$(dirname "$0")/issues.json" ;;
  "api -X") cat - >> "$(dirname "$0")/posts.log" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`)
  chmodSync(bin, 0o755)
  return { bin, posts: () => readFileSync(join(dir, 'posts.log'), 'utf8') }
}

describe('ghApi', () => {
  it('maps a REST issue comment onto the domain comment', async () => {
    const gh = fakeGh(JSON.stringify([{
      issue_url: 'https://api.github.com/repos/o/r/issues/12', user: { login: 'octocat' },
      created_at: '2026-11-05T09:00:00Z', body: 'ship it',
    }]), '[]')
    const api = ghApi({ repo: 'o/r', bin: gh.bin })
    expect(await api.comments()).toEqual([{ issue: 12, author: 'octocat', at: '2026-11-05T09:00:00Z', body: 'ship it' }])
  })

  it('reads the author, creation time, labels an open issue carries', async () => {
    const gh = fakeGh('[]', JSON.stringify([{
      number: 3, title: 'DO: the thing', labels: [{ name: 'agent-ready' }], user: { login: 'octocat' },
      created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T10:00:00Z',
    }]))
    expect(await ghApi({ repo: 'o/r', bin: gh.bin }).issues('open')).toEqual([
      { issue: 3, title: 'DO: the thing', body: '', labels: ['agent-ready'], author: 'octocat',
        createdAt: '2026-11-05T09:00:00Z', updatedAt: '2026-11-05T10:00:00Z' },
    ])
  })

  it('reads the issue body for the judge, and leaves pull requests out', async () => {
    const gh = fakeGh('[]', JSON.stringify([
      { number: 3, title: 'DO: x', body: 'the details', labels: [], user: { login: 'octocat' }, created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T10:00:00Z' },
      { number: 4, title: 'a PR', body: 'diff', labels: [], user: { login: 'octocat' }, created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T10:00:00Z', pull_request: { url: 'u' } },
    ]))
    expect(await ghApi({ repo: 'o/r', bin: gh.bin }).issues('open')).toEqual([
      { issue: 3, title: 'DO: x', body: 'the details', labels: [], author: 'octocat',
        createdAt: '2026-11-05T09:00:00Z', updatedAt: '2026-11-05T10:00:00Z' },
    ])
  })

  it('posts a reply as an issue comment through the CLI, body intact', async () => {
    const gh = fakeGh('[]', '[]')
    await ghApi({ repo: 'o/r', bin: gh.bin }).postComment(12, 'on it: #1 accepted')
    const sent = JSON.parse(gh.posts()).body
    expect(sent).toContain('on it: #1 accepted')
    expect(sent).toContain(REPLY_MARKER)
  })

  it('a gh failure is an error, not an empty answer', async () => {
    const dir = tmp()
    const bin = join(dir, 'gh')
    writeFileSync(bin, '#!/bin/bash\necho "boom" >&2\nexit 1\n')
    chmodSync(bin, 0o755)
    await expect(ghApi({ repo: 'o/r', bin }).comments()).rejects.toThrow()
  })

  it('asks GitHub who the credential belongs to', async () => {
    const dir = tmp()
    const bin = join(dir, 'gh')
    writeFileSync(bin, '#!/bin/bash\n[ "$2" = user ] && echo agent-bot\n')
    chmodSync(bin, 0o755)
    expect(await ghApi({ repo: 'o/r', bin }).whoami!()).toBe('agent-bot')
  })

  it('an account of the agent\'s own authenticates the calls, and the token reaches only the child', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'token'), 'ghp_bot\n')
    const bin = join(dir, 'gh')
    // The child reports its own credential and command line: the two places a token must not appear.
    writeFileSync(bin, '#!/bin/bash\nprintf \'%s\\n%s\\n\' "${GH_TOKEN:-none}" "$*" > "$(dirname "$0")/seen.log"\necho agent-bot\n')
    chmodSync(bin, 0o755)
    const api = ghApi({ repo: 'o/r', bin, tokenFile: join(dir, 'token') })
    expect(await api.whoami!()).toBe('agent-bot')
    const [seen, args] = readFileSync(join(dir, 'seen.log'), 'utf8').split('\n')
    expect(seen, 'the token file is what authenticates the call').toBe('ghp_bot')
    expect(args, 'the token is never part of the command line every ps can read').not.toContain('ghp_bot')
    expect(process.env.GH_TOKEN, 'and never part of this process').not.toBe('ghp_bot')
  })

  it('an empty token file is an error, not an anonymous call', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'token'), '\n')
    const bin = join(dir, 'gh')
    writeFileSync(bin, '#!/bin/bash\necho should-not-run\n')
    chmodSync(bin, 0o755)
    await expect(ghApi({ repo: 'o/r', bin, tokenFile: join(dir, 'token') }).whoami!()).rejects.toThrow(/empty/)
  })

  it('reads the token file every call, so rotating a token needs no restart', async () => {
    const dir = tmp()
    const file = join(dir, 'token')
    writeFileSync(file, 'ghp_first')
    const bin = join(dir, 'gh')
    writeFileSync(bin, '#!/bin/bash\necho "${GH_TOKEN:-none}"\n')
    chmodSync(bin, 0o755)
    const api = ghApi({ repo: 'o/r', bin, tokenFile: file })
    expect(await api.whoami!()).toBe('ghp_first')
    writeFileSync(file, 'ghp_second')
    expect(await api.whoami!()).toBe('ghp_second')
  })
})
