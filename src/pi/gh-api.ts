/** GitHub through the `gh` CLI: the credentials stay in the operator's keyring, out of this process. */
import { spawn } from 'node:child_process'
import { REPLY_MARKER, type GithubApi, type IssueComment, type IssueState, type PrReview } from './source-github.ts'

export interface GithubApiOptions {
  repo: string
  bin?: string
}

// The comments endpoint answers for pull requests too, and a pull URL carries no issue number:
// taking 0 from it produced junk tickets whose replies could never post.
const issueOf = (url: string): number => Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? 0)

export function ghApi(options: GithubApiOptions): GithubApi {
  const bin = options.bin ?? 'gh'
  const openPulls = async (): Promise<Array<{ number: number }>> => {
    const open: Array<{ number: number }> = []
    for (let page = 1; ; page += 1) {
      const got = JSON.parse((await call(['api', `repos/${options.repo}/pulls?state=open&per_page=100&page=${page}`])) || '[]')
      open.push(...got)
      if (got.length < 100) break
    }
    return open
  }
  // Asynchronous on purpose: execFileSync held the router's event loop for every round trip (1.5-4 s a
  // pass), and the panel and the judge froze with it.
  const call = (args: string[], stdin?: string): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve(out)
      : reject(new Error(`gh ${args.slice(0, 2).join(' ')} exited ${code}: ${err.trim().slice(0, 300)}`)))
    child.stdin.end(stdin ?? '')
  })

  return {
    async comments(since) {
      const query = `repos/${options.repo}/issues/comments?per_page=100&sort=created&direction=asc${since ? `&since=${encodeURIComponent(since)}` : ''}`
      const rows = JSON.parse((await call(['api', query])) || '[]') as Array<Record<string, never | string>>
      return (rows as unknown as Array<{ issue_url: string; user?: { login: string }; created_at: string; body: string }>)
        .filter(r => /\/issues\/\d+/.test(r.issue_url))
        .map(r => ({ issue: issueOf(r.issue_url), author: r.user?.login ?? 'anonymous', at: r.created_at, body: r.body }))
    },

    async issues(state) {
      // GitHub pages at 100; an unpaginated read hides every issue past the newest page, forever.
      const rows: Array<{ number: number; title: string; body?: string | null; labels?: Array<{ name: string }>; user?: { login: string }; created_at: string; updated_at: string; pull_request?: unknown }> = []
      for (let page = 1; ; page += 1) {
        const got = JSON.parse((await call(['api', `repos/${options.repo}/issues?state=${state}&per_page=100&page=${page}`])) || '[]')
        rows.push(...got)
        if (got.length < 100) break
      }
      // The issues endpoint returns pull requests too; a PR is not a request on the board.
      return rows.filter(r => !r.pull_request).map(r => ({
        issue: r.number, title: r.title, body: r.body ?? '', labels: (r.labels ?? []).map(l => l.name),
        author: r.user?.login ?? 'anonymous', createdAt: r.created_at, updatedAt: r.updated_at,
      }))
    },

    async postComment(issue, body) {
      await call(['api', '-X', 'POST', `repos/${options.repo}/issues/${issue}/comments`, '--input', '-'],
                 JSON.stringify({ body: `${body}\n\n${REPLY_MARKER}` }))
    },

    async pullsOpen() {
      return (await openPulls()).map(pr => pr.number)
    },

    async reviews(sinceId) {
      // Reviews have no repo-level feed: read the open PRs and pull each one's reviews above the cursor.
      const open = await openPulls()
      const out: PrReview[] = []
      for (const pr of open) {
        const rows = JSON.parse((await call(['api', `repos/${options.repo}/pulls/${pr.number}/reviews?per_page=100`])) || '[]') as
          Array<{ id: number; user?: { login: string } | null; state: string; submitted_at?: string; body?: string }>
        for (const r of rows) if (r.id > sinceId && r.submitted_at) {
          out.push({ pr: pr.number, id: r.id, author: r.user?.login ?? 'anonymous', state: r.state, at: r.submitted_at, body: r.body ?? '' })
        }
      }
      return out.sort((a, b) => a.id - b.id)
    },

    async commentsFor(issue) {
      const rows = JSON.parse((await call(['api', `repos/${options.repo}/issues/${issue}/comments?per_page=100&sort=created&direction=desc`])) || '[]') as
        Array<{ user?: { login: string }; created_at: string; body: string }>
      return rows.map(r => ({ issue, author: r.user?.login ?? 'anonymous', at: r.created_at, body: r.body }))
    },
  }
}

export type { IssueComment, IssueState }
