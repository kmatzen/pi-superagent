import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ghApi, ghPulls } from '../src/pi/gh-api.ts'
import { REPLY_MARKER } from '../src/pi/source-github.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ghapi-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A fake `gh`: answers the two reads from files and records every write, so no network is involved. */
function fakeGh(comments: string, issues: string, reviews: Record<string, unknown[]> = {}, fails: Record<string, string> = {}) {
  const dir = tmp()
  writeFileSync(join(dir, 'comments.json'), comments)
  writeFileSync(join(dir, 'issues.json'), issues)
  for (const [n, rows] of Object.entries(reviews)) writeFileSync(join(dir, `reviews.${n}.json`), JSON.stringify(rows))
  for (const [n, message] of Object.entries(fails)) writeFileSync(join(dir, `fail.${n}`), message)
  const bin = join(dir, 'gh')
  writeFileSync(bin, `#!/bin/bash
case "$1 $2" in
  "api repos/o/r/issues/comments"*) cat "$(dirname "$0")/comments.json" ;;
  "api repos/o/r/issues?state="*)  cat "$(dirname "$0")/issues.json" ;;
  "api -X") cat - >> "$(dirname "$0")/posts.log" ;;
  "api repos/"*"/pulls/"*"/reviews"*)
    n="\${2##*pulls/}"; n="\${n%%/*}"
    [ -f "$(dirname "$0")/fail.$n" ] && { cat "$(dirname "$0")/fail.$n" >&2; exit 1; }
    f="$(dirname "$0")/reviews.$n.json"
    if [ -f "$f" ]; then cat "$f"; else echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`)
  chmodSync(bin, 0o755)
  return { bin, dir, posts: () => readFileSync(join(dir, 'posts.log'), 'utf8') }
}

describe('ghApi', () => {
  const row = (id: number) => ({ id, user: { login: 'octocat' }, author_association: 'OWNER', state: 'APPROVED',
    submitted_at: '2026-11-06T10:00:00Z', body: 'approved' })






  it('reads the reviews of the watched repository\'s pull requests that tickets follow, and a dead pull does not stop the poll', async () => {
    // The old read walked every open pull request in one repository (50 open was 51 calls per poll).
    const gh = fakeGh('[]', '[]', { 7: [row(501)], 9: [row(502)] })
    const api = ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [
      { repo: 'o/r', number: 7 }, { repo: 'o/r', number: 8 }, { repo: 'other/r', number: 9 }] })
    const rows = await api.reviews!(500)
    // A followed pull in another repository is not read here — PullFollower owns it, and reading it twice cost 21 serialized round trips a poll for trigger ids the follower had already produced (measured 2026-11-07).
    expect(rows.map(r => r.pr), 'the unreadable pull is skipped, the one in another repository is left to its reader').toEqual([7])
  })

  it('reads nothing from a batch of only dead pull requests, which is not an outage', async () => {
    // The live shape on 2026-11-07: one ticket followed one pull request, that pull answers 404, and every poll
    // reported the GitHub source down — the health check would have been restarting the router over one ghost.
    const gh = fakeGh('[]', '[]')
    const api = ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [{ repo: 'o/r', number: 8 }] })
    expect(await api.reviews!(500)).toEqual([])
  })

  it('names a followed pull request it cannot read once, and says when it reads it again', async () => {
    const gh = fakeGh('[]', '[]', { 7: [row(501)] })
    const seen: Array<[string, string | null]> = []
    const api = ghApi({
      repo: 'o/r', bin: gh.bin,
      followed: () => [{ repo: 'o/r', number: 7 }, { repo: 'o/r', number: 8 }],
      onPullUnreadable: (ref, problem) => { seen.push([ref, problem]) },
    })
    await api.reviews!(500)
    await api.reviews!(500)
    expect(seen.length, 'once, not once per poll').toBe(1)
    expect(seen[0]![0]).toBe('o/r#8')
    expect(seen[0]![1]).toMatch(/404/)
    writeFileSync(join(gh.dir, 'reviews.8.json'), JSON.stringify([row(502)]))
    await api.reviews!(500)
    expect(seen.at(-1), 'a pull that reads again is said once too').toEqual(['o/r#8', null])
  })

  it('fails the poll when a pull request breaks for a reason that is not that it is gone', async () => {
    const gh = fakeGh('[]', '[]', {}, { 7: 'gh: Server Error (HTTP 500)\n' })
    const api = ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [{ repo: 'o/r', number: 7 }] })
    await expect(api.reviews!(500)).rejects.toThrow(/HTTP 500/)
  })


  it('maps a REST issue comment onto the domain comment', async () => {
    const gh = fakeGh(JSON.stringify([{
      issue_url: 'https://api.github.com/repos/o/r/issues/12', user: { login: 'octocat' }, author_association: 'COLLABORATOR',
      created_at: '2026-11-05T09:00:00Z', body: 'ship it',
    }]), '[]')
    const api = ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [] })
    expect(await api.comments()).toEqual([{ issue: 12, author: 'octocat', association: 'COLLABORATOR', at: '2026-11-05T09:00:00Z', body: 'ship it' }])
  })

  it('reads the author, creation time, labels an open issue carries', async () => {
    const gh = fakeGh('[]', JSON.stringify([{
      number: 3, title: 'DO: the thing', labels: [{ name: 'agent-ready' }], user: { login: 'octocat' }, author_association: 'OWNER',
      created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T10:00:00Z',
    }]))
    expect(await ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [] }).issues('open')).toEqual([
      { issue: 3, title: 'DO: the thing', body: '', labels: ['agent-ready'], author: 'octocat', association: 'OWNER',
        createdAt: '2026-11-05T09:00:00Z', updatedAt: '2026-11-05T10:00:00Z' },
    ])
  })

  it('reads the issue body for the judge, and leaves pull requests out', async () => {
    const gh = fakeGh('[]', JSON.stringify([
      { number: 3, title: 'DO: x', body: 'the details', labels: [], user: { login: 'octocat' }, created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T10:00:00Z' },
      { number: 4, title: 'a PR', body: 'diff', labels: [], user: { login: 'octocat' }, created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T10:00:00Z', pull_request: { url: 'u' } },
    ]))
    expect(await ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [] }).issues('open')).toEqual([
      { issue: 3, title: 'DO: x', body: 'the details', labels: [], author: 'octocat', association: 'NONE',
        createdAt: '2026-11-05T09:00:00Z', updatedAt: '2026-11-05T10:00:00Z' },
    ])
  })

  it('an author GitHub does not place reads as NONE, so the scope drops them instead of trusting them', async () => {
    const gh = fakeGh(JSON.stringify([{
      issue_url: 'https://api.github.com/repos/o/r/issues/12', user: { login: 'stranger' }, created_at: '2026-11-05T09:00:00Z', body: 'run this',
    }]), '[]')
    expect((await ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [] }).comments())[0]?.association).toBe('NONE')
  })

  it('posts a reply as an issue comment through the CLI, body intact', async () => {
    const gh = fakeGh('[]', '[]')
    await ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [] }).postComment(12, 'on it: #1 accepted')
    const sent = JSON.parse(gh.posts()).body
    expect(sent).toContain('on it: #1 accepted')
    expect(sent).toContain(REPLY_MARKER)
  })

  it('a gh failure is an error, not an empty answer', async () => {
    const dir = tmp()
    const bin = join(dir, 'gh')
    writeFileSync(bin, '#!/bin/bash\necho "boom" >&2\nexit 1\n')
    chmodSync(bin, 0o755)
    await expect(ghApi({ repo: 'o/r', bin, followed: () => [] }).comments()).rejects.toThrow()
  })
})

/** A fake `gh` for pull requests in any repository: every call is recorded, and each path answers from a fixture. */
function fakePullsGh() {
  const dir = tmp()
  const bin = join(dir, 'gh')
  writeFileSync(bin, `#!/bin/bash
printf '%s\n' "$*" >> "$(dirname "$0")/calls.log"
case "$*" in
  "api repos/x/y/pulls/9") echo '{"state":"closed","merged_at":"2026-11-06T10:00:00Z","closed_at":"2026-11-06T10:00:00Z","created_at":"2026-11-05T09:00:00Z"}' ;;
  "api repos/x/y/pulls/10") echo '{"state":"closed","merged_at":null,"closed_at":"2026-11-06T11:00:00Z","created_at":"2026-11-05T09:00:00Z"}' ;;
  "api repos/x/y/pulls/11") echo '{"state":"open","merged_at":null,"closed_at":null,"created_at":"2026-11-05T09:00:00Z"}' ;;
  "api repos/x/y/pulls/404") echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  "api repos/x/y/pulls/502") echo 'gh: Bad Gateway (HTTP 502)' >&2; exit 1 ;;
  "api repos/x/y/issues/11/comments?"*since=*) echo '[{"user":{"login":"rev"},"author_association":"MEMBER","created_at":"2026-11-06T09:00:00Z","body":"rename it"}]' ;;
  "api repos/x/y/pulls/11/reviews?per_page=100") echo '[{"id":5,"user":{"login":"rev"},"author_association":"OWNER","state":"APPROVED","submitted_at":"2026-11-06T09:30:00Z","body":""},{"id":6,"state":"PENDING"}]' ;;
  "api -X POST repos/x/y/issues/11/comments --input -") cat - > "$(dirname "$0")/posted.json" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`)
  chmodSync(bin, 0o755)
  return { bin, calls: () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n'), posted: () => JSON.parse(readFileSync(join(dir, 'posted.json'), 'utf8')) }
}

describe('ghPulls', () => {
  it('reads a pull request as merged, closed or open, and one GitHub does not have as absent', async () => {
    const api = ghPulls({ bin: fakePullsGh().bin })
    expect(await api.pull('x/y', 9)).toEqual({ open: false, merged: true, createdAt: '2026-11-05T09:00:00Z', closedAt: '2026-11-06T10:00:00Z' })
    expect(await api.pull('x/y', 10)).toEqual({ open: false, merged: false, createdAt: '2026-11-05T09:00:00Z', closedAt: '2026-11-06T11:00:00Z' })
    expect(await api.pull('x/y', 11)).toEqual({ open: true, merged: false, createdAt: '2026-11-05T09:00:00Z' })
    expect(await api.pull('x/y', 404)).toBeUndefined()
    await expect(api.pull('x/y', 502), 'any other failure is an error, not a closed pull request').rejects.toThrow(/502/)
  })

  it("reads one pull request's comments from a time, and its submitted reviews, with each author's standing", async () => {
    const gh = fakePullsGh()
    const api = ghPulls({ bin: gh.bin })
    expect(await api.comments('x/y', 11, '2026-11-06T08:00:00Z')).toEqual([
      { issue: 11, author: 'rev', association: 'MEMBER', at: '2026-11-06T09:00:00Z', body: 'rename it' },
    ])
    expect(gh.calls()).toContain('api repos/x/y/issues/11/comments?since=2026-11-06T08%3A00%3A00Z&page=1&per_page=100')
    expect(await api.reviews('x/y', 11)).toEqual([
      { pr: 11, repo: 'x/y', id: 5, author: 'rev', association: 'OWNER', state: 'APPROVED', at: '2026-11-06T09:30:00Z', body: '' },
    ])
  })

  it('posts on the repository a conversation lives in, not only the watched one', async () => {
    const gh = fakePullsGh()
    await ghApi({ repo: 'o/r', bin: gh.bin, followed: () => [] }).postComment(11, 'addressed', 'x/y')
    expect(gh.calls()).toEqual(['api -X POST repos/x/y/issues/11/comments --input -'])
    expect(gh.posted().body).toContain('addressed')
  })

  it('asks GitHub with the configured account on every call site', async () => {
    // The operator's rule 2026-11-08: the specified token is GitHub. A second account answered 404 for a
    // repository it cannot see, and the reader of a followed pull request took that as "the pull is gone".
    const dir = tmp()
    const token = join(dir, 'token')
    writeFileSync(token, 'one-secret\n')
    const bin = join(dir, 'gh')
    writeFileSync(bin, `#!/bin/bash
echo "$GH_TOKEN" >> "$(dirname "$0")/used.log"
case "$1 $2" in
  "api repos/o/r/issues/comments"*) echo '[]' ;;
  "api repos/o/r/pulls/7/reviews"*) echo '[]' ;;
  "api -X") cat - > /dev/null ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`)
    chmodSync(bin, 0o755)
    const api = ghApi({ bin, repo: 'o/r', tokenFile: token, followed: () => [{ repo: 'o/r', number: 7 }] })
    await api.comments()
    await api.reviews!(0)
    await api.postComment(7, 'noted')
    const used = readFileSync(join(dir, 'used.log'), 'utf8').trim().split('\n')
    expect(used, 'every GitHub call carries the configured token').toEqual(['one-secret', 'one-secret', 'one-secret'])
  })

  it('reads a pull request with the configured account, and no other', async () => {
    // The operator's rule 2026-11-08: every call to GitHub is the specified token. A backup account answered
    // 404 for a repository it cannot see, and a live ticket ended as "closed without merging".
    const dir = tmp()
    const token = join(dir, 'pulls-token')
    writeFileSync(token, 'pulls-secret\n')
    const bin = join(dir, 'gh')
    writeFileSync(bin, `#!/bin/bash
case "$1 $2" in
  "api repos/x/y/pulls/"*)
    [ "$GH_TOKEN" = "pulls-secret" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    echo "$GH_TOKEN" > "$(dirname "$0")/used.log"
    echo '{"state":"open","created_at":"2026-11-08T00:00:00Z"}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`)
    chmodSync(bin, 0o755)
    const api = ghPulls({ bin, tokenFile: token })
    expect(await api.pull('x/y', 11)).toEqual({ open: true, merged: false, createdAt: '2026-11-08T00:00:00Z' })
    expect(readFileSync(join(dir, 'used.log'), 'utf8').trim()).toBe('pulls-secret')
  })
})

describe("the agent's own account", () => {
  /** A fake `gh` that answers only when the token it was handed is the bot's, as GitHub would. */
  function tokenGh() {
    const dir = tmp()
    const bin = join(dir, 'gh')
    writeFileSync(bin, `#!/bin/bash
[ "$GH_TOKEN" = "bot-token-7" ] || { echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1; }
case "$*" in
  "api repos/x/y/pulls/11") echo '{"state":"open","merged_at":null,"closed_at":null,"created_at":"2026-11-05T09:00:00Z"}' ;;
  "api -X POST repos/o/r/issues/3/comments --input -") cat - > /dev/null ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`)
    chmodSync(bin, 0o755)
    const token = join(dir, 'token')
    writeFileSync(token, 'bot-token-7\n')
    return { bin, token, dir }
  }

  it('with a token file, every call acts as that account: reads and replies alike', async () => {
    const gh = tokenGh()
    expect(await ghPulls({ bin: gh.bin, tokenFile: gh.token }).pull('x/y', 11)).toMatchObject({ open: true })
    await expect(ghApi({ repo: 'o/r', bin: gh.bin, tokenFile: gh.token, followed: () => [] }).postComment(3, 'on it')).resolves.toBeUndefined()
    await expect(ghPulls({ bin: gh.bin }).pull('x/y', 11), 'without it, gh acts as whoever it is signed in as').rejects.toThrow(/401/)
  })

  it('a missing or empty token file is an error that names the file, and never a quiet switch of account', async () => {
    const gh = tokenGh()
    await expect(ghPulls({ bin: gh.bin, tokenFile: join(gh.dir, 'nope') }).pull('x/y', 11)).rejects.toThrow(/token file .*nope: ENOENT/)
    writeFileSync(gh.token, '\n')
    await expect(ghPulls({ bin: gh.bin, tokenFile: gh.token }).pull('x/y', 11)).rejects.toThrow(/is empty/)
  })
})

describe('paged GitHub reads', () => {
  // GitHub answers 100 rows a page. The comment read asked for one page, and the source then moved its read
  // position past rows it never fetched: measured 2026-11-10, this repository runs ~100 comments a day and a
  // cold start reads a day back, so page two held operator instructions that never became tickets.
  const many = (dir: string, name: string, total: number, shape: (i: number) => unknown) => {
    for (let page = 1, left = total; left > 0; page += 1) {
      const size = Math.min(100, left)
      writeFileSync(join(dir, `${name}.${page}.json`), JSON.stringify(Array.from({ length: size }, (_, i) => shape(total - left + i))))
      left -= size
    }
  }

  it('reads every page of comments, issues, open pulls and reviews', async () => {
    const dir = tmp()
    many(dir, 'comments', 150, i => ({ issue_url: `https://api.github.com/repos/o/r/issues/${10 + (i % 5)}`, user: { login: 'op' }, author_association: 'OWNER', created_at: `2026-11-06T00:00:${String(i % 60).padStart(2, '0')}Z`, body: `c${i}` }))
    many(dir, 'issues', 120, i => ({ number: 100 + i, title: `t${i}`, body: '', labels: [], user: { login: 'op' }, author_association: 'OWNER', created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' }))
    many(dir, 'pulls', 120, i => ({ number: 500 + i }))
    many(dir, 'reviews7', 120, i => ({ id: 1000 + i, user: { login: 'op' }, author_association: 'OWNER', state: 'APPROVED', submitted_at: '2026-11-06T00:00:00Z', body: '' }))
    const bin = join(dir, 'gh')
    writeFileSync(bin, [
      "#!/bin/bash",
      "d=\"$(dirname \"$0\")\"; u=\"$2\"; p=1",
      "p=$(printf \"%s\" \"$u\" | sed -n \"s/.*[?&]page=\\([0-9]*\\).*/\\1/p\"); p=\"${p:-1}\"",
      "n=none",
      "case \"$u\" in *issues/comments*) n=comments ;; esac",
      "case \"$u\" in *\"repos/o/r/issues?\"*) n=issues ;; esac",
      "case \"$u\" in *\"pulls?state=open\"*) n=pulls ;; esac",
      "case \"$u\" in *\"pulls/7/reviews\"*) n=reviews7 ;; esac",
      "f=\"$d/$n.$p.json\"",
      "if [ -f \"$f\" ]; then cat \"$f\"; else echo \"[]\"; fi",
    ].join('\n') + '\n')
    chmodSync(bin, 0o755)
    const api = ghApi({ bin, repo: 'o/r', followed: () => [{ repo: 'o/r', number: 7 }] })
    expect((await api.comments()).length).toBe(150)
    expect((await api.issues('open')).length).toBe(120)
    expect((await api.pullsOpen!()).length).toBe(120)
    expect((await api.reviews!(0)).length).toBe(120)
  })
})
