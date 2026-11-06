/** Who the router speaks as on GitHub: asked of GitHub, because config can name an account the
 *  credential does not own, and every receipt then signs itself with the operator's login. */
import { statSync } from 'node:fs'
import { isBotLogin } from './authors.ts'
import type { GithubApi } from './source-github.ts'

export type IdentityMode = 'configured' | 'mismatch' | 'adopted' | 'shared' | 'unknown'

export interface IdentityProblem { code: string; place: string; detail: string }

export interface IdentityRecord {
  login: string
  self: string
  mode: IdentityMode
  repo: string
  /** Where the credential came from: a token file, or gh's own sign-in. */
  credential: string
  at: string
}

export interface Identity {
  login: string
  self: string
  mode: IdentityMode
  problems: IdentityProblem[]
}

const modeOf = (file: string): number | null => {
  try { return statSync(file).mode & 0o777 } catch { return null }
}

/** The credential decides `self`, config only declares it: a name that disagrees is a finding, and the
 *  real login is what intake must filter, or the agent reads its own receipts as requests. */
export async function checkGithubIdentity(input: {
  api: GithubApi
  repo: string
  bots: ReadonlySet<string>
  configuredSelf?: string
  tokenFile?: string
  now: () => string
}): Promise<Identity> {
  const problems: IdentityProblem[] = []
  const credential = input.tokenFile ?? "gh's own sign-in"
  if (input.tokenFile) {
    const mode = modeOf(input.tokenFile)
    if (mode === null) {
      problems.push({ code: 'github-token-missing', place: 'GitHub',
        detail: `PI_SUPERAGENT_GITHUB_TOKEN_FILE names ${input.tokenFile}, which cannot be read: nothing can be posted to GitHub until it exists` })
    } else if (mode & 0o077) {
      problems.push({ code: 'github-token-readable', place: 'GitHub',
        detail: `${input.tokenFile} is readable by group or world (mode ${mode.toString(8)}): it is a GitHub credential, so chmod 600 it` })
    }
  }
  if (!input.api.whoami) return { login: '', self: input.configuredSelf ?? '', mode: 'unknown', problems }
  let login = ''
  try {
    login = await input.api.whoami()
  } catch (error) {
    problems.push({ code: 'github-identity-unknown', place: 'GitHub',
      detail: `cannot ask GitHub who the credential belongs to (${credential}): ${String(error).slice(0, 160)}` })
    return { login: '', self: input.configuredSelf ?? '', mode: 'unknown', problems }
  }
  const configured = input.configuredSelf
  if (configured && configured.toLowerCase() !== login.toLowerCase()) {
    problems.push({ code: 'github-identity', place: 'GitHub',
      detail: `the credential speaks as ${login}, but PI_SUPERAGENT_GITHUB_SELF says the agent is ${configured}: fix the config, the token file, or gh's sign-in, or every receipt is posted by the wrong account` })
    return { login, self: login, mode: 'mismatch', problems }
  }
  if (configured) return { login, self: login, mode: 'configured', problems }
  // A login no person writes from is safe to adopt; the operator's own is not, because filtering it would
  // discard every comment the operator writes, which is the trap the reply marker exists for.
  if (isBotLogin(login, input.bots)) return { login, self: login, mode: 'adopted', problems }
  return { login, self: '', mode: 'shared', problems }
}
