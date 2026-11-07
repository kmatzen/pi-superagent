/** GitHub through the `gh` CLI, as the account it is signed in as or as the one a token file names. */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { REPLY_MARKER, type GithubApi, type IssueComment, type IssueState, type PrReview } from './source-github.ts'
import type { PullApi } from './pulls.ts'

export interface GhOptions {
  bin?: string
  /** A file holding the token of the account to act as; unset, gh acts as the account it is signed in as. */
  tokenFile?: string
}

export interface GithubApiOptions extends GhOptions {
  repo: string
  /**
   * The pull requests whose reviews matter. Reviews have no repository-wide feed, so a read costs one call
   * per pull request: asking for every open one made the tick grow with the repository (50 open pull requests
   * was 51 round trips per poll), while the tickets only ever wait on the ones they follow.
   */
  followed: () => Array<{ repo: string; number: number }>
  /**
   * Read reviews as another account, the one that opens the pull requests. A router watches one repository and
   * opens its pull requests in others, and an organization repository is invisible to an account outside the
   * org: measured live 2026-11-07, six followed pull requests answered 404 to the watched token, and the
   * account that opened them read a review request in one call. The pulls account usually has no token file —
   * it is the account `gh` is signed in as — so this is an account, not a second token.
   */
  reviewsAccount?: GhOptions
  /**
   * Called when a followed pull request's reviews go unreadable (a string) or readable again (null). A 404
   * is permanent — the pull is deleted, moved, or private to this account — and a ticket that follows it
   * waits for a review nobody will ever read. Silence is the defect: measured 2026-11-07 with a ghost pull
   * that stalled a ticket with no reason a person could see.
   */
  onPullUnreadable?: (ref: string, problem: string | null) => void
}

// A pull request's conversation comments arrive with an /issues/N url too (a pull request is issue N);
// a row with no number is skipped, never filed under #0.
const issueOf = (url: string): number => Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? 0)
// An absent association reads as no access: the scope then drops the author instead of trusting them.
const associationOf = (row: { author_association?: string }): string => row.author_association ?? 'NONE'

// Asynchronous on purpose: execFileSync held the router's event loop for every round trip (1.5-4 s a
// pass), and the panel and the judge froze with it.
const ghCall = ({ bin = 'gh', tokenFile }: GhOptions) => (args: string[], stdin?: string): Promise<string> => new Promise((resolve, reject) => {
  let env = process.env
  if (tokenFile) {
    // Read on every call, so a rotated token takes effect without a restart; only gh's environment holds it.
    let token = ''
    try { token = readFileSync(tokenFile, 'utf8').trim() } catch (error) {
      reject(new Error(`cannot read the GitHub token file ${tokenFile}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`))
      return
    }
    if (!token) { reject(new Error(`the GitHub token file ${tokenFile} is empty`)); return }
    env = { ...process.env, GH_TOKEN: token }
  }
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk })
  child.on('error', reject)
  child.on('close', code => code === 0
    ? resolve(out)
    : reject(new Error(`gh ${args.slice(0, 2).join(' ')} exited ${code}: ${err.trim().slice(0, 300)}`)))
  // gh may exit before reading stdin (for example, on an auth failure). Its exit reports the cause.
  child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error) })
  child.stdin.end(stdin)
})

type ReviewRow = { id: number; user?: { login: string } | null; author_association?: string; state: string; submitted_at?: string; body?: string }
type CommentRow = { user?: { login: string }; author_association?: string; created_at: string; body: string }

export function ghApi(options: GithubApiOptions): GithubApi {
  const call = ghCall(options)
  const reviewCall = options.reviewsAccount ? ghCall(options.reviewsAccount) : call
  const deadPulls = new Set<string>()
  const openPulls = async (): Promise<Array<{ number: number }>> => {
    const open: Array<{ number: number }> = []
    for (let page = 1; ; page += 1) {
      const got = JSON.parse((await call(['api', `repos/${options.repo}/pulls?state=open&per_page=100&page=${page}`])) || '[]')
      open.push(...got)
      if (got.length < 100) break
    }
    return open
  }
  return {
    async comments(since) {
      const query = `repos/${options.repo}/issues/comments?per_page=100&sort=created&direction=asc${since ? `&since=${encodeURIComponent(since)}` : ''}`
      const rows = JSON.parse((await call(['api', query])) || '[]') as Array<Record<string, never | string>>
      return (rows as unknown as Array<{ issue_url: string; user?: { login: string }; author_association?: string; created_at: string; body: string }>)
        .filter(r => /\/issues\/\d+/.test(r.issue_url))
        .map(r => ({ issue: issueOf(r.issue_url), author: r.user?.login ?? 'anonymous', association: associationOf(r), at: r.created_at, body: r.body }))
    },

    async issues(state) {
      // GitHub pages at 100; an unpaginated read hides every issue past the newest page, forever.
      const rows: Array<{ number: number; title: string; body?: string | null; labels?: Array<{ name: string }>; user?: { login: string }; author_association?: string; created_at: string; updated_at: string; pull_request?: unknown }> = []
      for (let page = 1; ; page += 1) {
        const got = JSON.parse((await call(['api', `repos/${options.repo}/issues?state=${state}&per_page=100&page=${page}`])) || '[]')
        rows.push(...got)
        if (got.length < 100) break
      }
      // The issues endpoint lists pull requests too; opening a pull request is a delivery, not a request.
      return rows.filter(r => !r.pull_request).map(r => ({
        issue: r.number, title: r.title, body: r.body ?? '', labels: (r.labels ?? []).map(l => l.name),
        author: r.user?.login ?? 'anonymous', association: associationOf(r), createdAt: r.created_at, updatedAt: r.updated_at,
      }))
    },

    async postComment(issue, body, repo) {
      await call(['api', '-X', 'POST', `repos/${repo ?? options.repo}/issues/${issue}/comments`, '--input', '-'],
                 JSON.stringify({ body: `${body}\n\n${REPLY_MARKER}` }))
    },

    async pullsOpen() {
      return (await openPulls()).map(pr => pr.number)
    },

    async reviews(sinceId) {
      // Reported once per pull, not once per poll: 2880 polls a day is not a log.
      const targets = options.followed()
      const out: PrReview[] = []
      for (const pr of targets) {
        let rows: ReviewRow[]
        try {
          rows = JSON.parse((await reviewCall(['api', `repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`])) || '[]') as ReviewRow[]
        } catch (error) {
          // GitHub answers 404 for a pull request that is gone, moved, or private to this account, and that is
          // a fact about one pull, not an outage. Measured live 2026-11-07: a followed pull answering 404 threw
          // out of the whole read, so no review reached any ticket, and once it was the only pull in the batch
          // every poll reported the source down. Skipping it loses nothing — the cursor is per source, so a
          // pull that becomes readable again is read from where it left off.
          const problem = String(error)
          if (!/HTTP 404/.test(problem)) throw error
          const ref = `${pr.repo}#${pr.number}`
          if (!deadPulls.has(ref)) {
            deadPulls.add(ref)
            options.onPullUnreadable?.(ref, problem.slice(0, 200))
          }
          continue
        }
        if (deadPulls.delete(`${pr.repo}#${pr.number}`)) options.onPullUnreadable?.(`${pr.repo}#${pr.number}`, null)
        for (const r of rows) if (r.id > sinceId && r.submitted_at) {
          out.push({ pr: pr.number, repo: pr.repo, id: r.id, author: r.user?.login ?? 'anonymous', association: associationOf(r), state: r.state, at: r.submitted_at, body: r.body ?? '' })
        }
      }
      return out.sort((a, b) => a.id - b.id)
    },

    async commentsFor(issue, repo) {
      const rows = JSON.parse((await call(['api', `repos/${repo ?? options.repo}/issues/${issue}/comments?per_page=100&sort=created&direction=desc`])) || '[]') as CommentRow[]
      return rows.map(r => ({ issue, author: r.user?.login ?? 'anonymous', association: associationOf(r), at: r.created_at, body: r.body }))
    },
  }
}

/** Pull requests in any repository the operator's gh can read, by number: the ones tickets follow. */
export function ghPulls(options: GhOptions = {}): PullApi {
  const call = ghCall(options)
  return {
    async pull(repo, number) {
      try {
        const r = JSON.parse(await call(['api', `repos/${repo}/pulls/${number}`])) as
          { state: string; merged_at?: string | null; closed_at?: string | null; created_at: string }
        const closedAt = r.merged_at ?? r.closed_at
        return { open: r.state === 'open', merged: Boolean(r.merged_at), createdAt: r.created_at, ...(closedAt ? { closedAt } : {}) }
      } catch (error) {
        if (/HTTP 404|Not Found/i.test(String(error))) return undefined
        throw error
      }
    },
    async comments(repo, number, since) {
      const query = `repos/${repo}/issues/${number}/comments?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ''}`
      const rows = JSON.parse((await call(['api', query])) || '[]') as CommentRow[]
      return rows.map(r => ({ issue: number, author: r.user?.login ?? 'anonymous', association: associationOf(r), at: r.created_at, body: r.body }))
    },
    async reviews(repo, number) {
      const rows = JSON.parse((await call(['api', `repos/${repo}/pulls/${number}/reviews?per_page=100`])) || '[]') as ReviewRow[]
      return rows.filter(r => r.submitted_at).map(r => ({
        pr: number, repo, id: r.id, author: r.user?.login ?? 'anonymous', association: associationOf(r), state: r.state, at: r.submitted_at!, body: r.body ?? '',
      }))
    },
  }
}

export type { IssueComment, IssueState }
