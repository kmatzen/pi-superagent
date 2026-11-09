/**
 * The credential guard: a remote URL that carries `user:token@` is a live secret written into a file git
 * creates 0644, so every user and every process on the box can read it, and every `git remote -v`,
 * `git config --list`, failed push or verbose `ls-remote` an agent prints publishes it into a transcript.
 * Measured on the deployment box (issue #314): the watched checkout's `.git/config` held a 40-character
 * `ghp_` classic token with `repo` scope — read/write on every repository the account reaches — in a
 * `-rw-r--r--` file, with ~20 worker sessions per router run able to print it.
 *
 * Nothing here deletes the credential: it finds it, says where it is with the secret masked, and hands over
 * the fix. A finding is only ever carried as a masked string, so the guard cannot become the leak it detects.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** One credential found in one git config file. */
export interface CredentialFinding {
  /** The config file that holds it, so the operator edits the right one. */
  file: string
  /** The config key that holds it, e.g. `remote.origin.url`. */
  key: string
  /** The value with the secret replaced: safe to log, safe to put in an issue body. */
  masked: string
  /** Octal mode of that file: `644` is the finding, `600` is the shape that is acceptable. */
  mode: string
  /** True when any user on the box can read the file — the reason this is urgent, not cosmetic. */
  worldReadable: boolean
}

/** `scheme://user:secret@host`. A bare `user@host` names an account; only the password half is a secret. */
const USERINFO = /([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/\s@"]*):([^/\s@"]*)@/
/**
 * GitHub's own token shapes: a `credential.helper` line can carry one with no URL around it. Deliberately
 * not global: `.test()` on a global regex advances `lastIndex`, and the next call resumes there, so a value
 * whose token sits before the previous match ends scans clean. Measured with two token-bearing remotes in
 * one file — origin reported, backup dropped, deploy allowed. The guard does not get to miss the second one.
 */
const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/
/** The same shapes, global, for masking *every* occurrence inside one value. */
const TOKENS = new RegExp(TOKEN.source, 'g')

/** True when a config value carries a credential: userinfo in a URL, or a GitHub token in plain text. */
export const holdsCredential = (value: string): boolean => USERINFO.test(value) || TOKEN.test(value)

/** Replace the secret with `***`, keeping the scheme, the account name and the host so the finding is locatable. */
export const maskSecret = (value: string): string => value
  .replace(USERINFO, (_all, scheme: string, user: string) => `${scheme}://${user}:***@`)
  .replace(TOKENS, (token: string) => `${token.slice(0, 4)}***`)
  .trim()
  .slice(0, 140)

/** Git's value syntax, reduced to what the scan needs: quotes, and a comment outside them. */
const unquote = (raw: string): string => {
  const value = raw.trim()
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"')
    return end > 0 ? value.slice(1, end) : value.slice(1)
  }
  const comment = value.search(/\s#/)
  return comment === -1 ? value : value.slice(0, comment).trim()
}

/** Every `key = value` in one git config file whose value carries a credential. */
export function scanGitConfig(file: string): Array<{ key: string; masked: string }> {
  const found: Array<{ key: string; masked: string }> = []
  let section = ''
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      section = header[1]!.trim().replace(/\s+/g, ' ')
      continue
    }
    const entry = /^([A-Za-z0-9._-]+)\s*=\s*(.*)$/.exec(line)
    if (!entry) continue
    const value = unquote(entry[2]!)
    if (!holdsCredential(value)) continue
    found.push({ key: section ? `${section}.${entry[1]}` : entry[1]!, masked: maskSecret(value) })
  }
  return found
}

/**
 * The config files that name this checkout's remotes. A linked worktree keeps only its own settings in
 * `gitdir/`, and its remotes live in the common dir's config, so both are read; a `.git` file (submodule,
 * linked worktree) points at the real git dir.
 */
export function gitConfigFiles(dir: string): string[] {
  const dirs: string[] = []
  const gitref = join(dir, '.git')
  if (existsSync(gitref) && statSync(gitref).isDirectory()) dirs.push(gitref)
  else if (existsSync(gitref)) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitref, 'utf8'))
    if (pointer) dirs.push(isAbsolute(pointer[1]!) ? pointer[1]! : resolve(dir, pointer[1]!.trim()))
  }
  // A path that is itself a git dir (a bare repo, a `.git` handed over directly).
  else if (existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects'))) dirs.push(dir)

  const files = new Set<string>()
  for (const gitdir of dirs) {
    for (const candidate of [join(gitdir, 'config'), ...commonDir(gitdir).map(common => join(common, 'config'))]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) files.add(candidate)
    }
  }
  return [...files]
}

const commonDir = (gitdir: string): string[] => {
  const file = join(gitdir, 'commondir')
  if (!existsSync(file)) return []
  const value = readFileSync(file, 'utf8').trim()
  return value ? [isAbsolute(value) ? value : resolve(gitdir, value)] : []
}

/** The credential findings for one checkout: every config file that names its remotes, mode included. */
export function findEmbeddedGitCredentials(dir: string): CredentialFinding[] {
  const findings: CredentialFinding[] = []
  for (const file of gitConfigFiles(dir)) {
    let mode = '????'
    let worldReadable = false
    try {
      const stat = lstatSync(file)
      mode = (stat.mode & 0o777).toString(8)
      worldReadable = (stat.mode & 0o077) !== 0
    } catch { /* the file vanished between the listing and the stat: nothing to report */ }
    for (const hit of scanGitConfig(file)) {
      findings.push({ file, ...hit, mode, worldReadable })
    }
  }
  return findings
}

/** The directories under a worktree root, bounded: a live root held 84 ticket directories, and this runs at startup. */
export function childDirs(root: string, limit = 300): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .slice(0, limit)
      .map(entry => join(root, entry.name))
  } catch {
    return []
  }
}

/** A directory holding a checkout: `.git` as a directory, or as the file a linked worktree or submodule leaves. */
const isCheckout = (dir: string): boolean => existsSync(join(dir, '.git'))

/**
 * The checkouts under a worktree root, one level past the ticket directory.
 *
 * `prepareWorkspace` makes `<root>/<ticket>/` and the product's own clone lands there. A worker told "clone the
 * repository into your workspace" lands in `<root>/<ticket>/repo/` — measured on the deployment box: 26 of the
 * 29 live ticket checkouts are that shape, and the one holding the exposed `repo`-scoped token was one of them.
 * A scan that stops at the ticket directory reports a leaking deployment clean, so it goes one level down and
 * stops: only a directory that is itself a checkout counts, which keeps a `node_modules` full of nested `.git`
 * directories out of the walk.
 */
export function checkoutDirs(root: string, limit = 300): string[] {
  const dirs: string[] = []
  for (const dir of childDirs(root, limit)) {
    dirs.push(dir)
    if (isCheckout(dir)) continue
    for (const sub of childDirs(dir, 40)) if (isCheckout(sub)) dirs.push(sub)
  }
  return dirs
}

/** The one-line fix, with no secret in it: the URL stops being the credential store. */
export const credentialFix = (dir: string): string =>
  `git -C ${dir} remote set-url origin <the same URL with the user:token@ part removed>, then supply the `
  + 'password from a 0600 file with a repo-local credential helper (docs/operator-guide.md, "Keep the git credential out of .git/config")'

/** What the guard says about one checkout, ready for a problem detail, a log line or a start refusal. */
export const describeCredentials = (dir: string, findings: CredentialFinding[]): string =>
  findings
    .map(f => `${f.file} keeps a credential in ${f.key} = ${f.masked}${f.worldReadable ? ` (mode ${f.mode}: readable by every user on this box)` : ''}`)
    .join('; ')
    + ` — ${credentialFix(dir)}`

/** A checkout whose git config carries a credential, in the shape `setupProblems` carries. */
export function credentialProblem(dir: string, place: string): { code: string; place: string; detail: string } | undefined {
  const findings = findEmbeddedGitCredentials(dir)
  return findings.length
    ? { code: 'git-credential-in-url', place, detail: describeCredentials(dir, findings) }
    : undefined
}
