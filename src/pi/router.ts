/** The router's shared surface: config, the SDK seam, the worker brief, and the admissibility policy. */
import { isListed } from './authors.ts'
import type { Policy, SourceScope, Ticket } from '../core/index.ts'
import type { GhOptions } from './gh-api.ts'

export interface RouterConfig {
  herdrWorkspace?: string
  dataDir: string
  self: string
  bots: ReadonlySet<string>
  worktreeRoot: string
  sdkPath?: string
  maxConcurrent?: number
  workerQuietMinutes?: number
  /** Settled checkouts to keep at startup, newest first. Measured: each one is about 570 MB. */
  keepWorktrees?: number
  /**
   * A file holding a scoped GitHub token to hand a worker, so it can push a branch and open a pull request as
   * that token instead of as the operator. Unset, the brief tells the worker it cannot push.
   */
  workerTokenFile?: string
  /** Report a worker that has run this long without finishing. Reports; never kills. */
  workerDeadlineHours?: number
  /**
   * The watched repository carries asks, not code: don't hand a worker a checkout of the ask board, and tell it
   * to clone the repository the request names. Off by default, since a single-repository deployment works code
   * out of the repository it watches.
   */
  watchRepoIsAsks?: boolean
  judgeThinking?: string
  /** 'herdr': each worker is its own pi session in a herdr tab. Unset, workers run in-process (tests only). */
  workers?: 'herdr'
  herdrBin?: string
  evalTimeoutMs?: number
  /** How often the loop polls without being nudged; the panel's freshness is this number. */
  tickMs?: number
  policyVersion?: string
  /** Serve the panel and the management API on 127.0.0.1:port; unset means no panel. */
  panelPort?: number
  prepare?: string
  githubRepo?: string
  githubSelf?: string
  /** The agent's own GitHub account, by a file holding its token: the router reads and posts on the watched repository as it. */
  githubTokenFile?: string
  /** The gh binary; tests put a stand-in here. */
  ghBin?: string
  blockedCommands?: readonly string[]
  /** Off by default: a worker that delegates escapes its mandate, workspace and report. */
  allowDelegation?: boolean
  /** Login patterns the router hears; set, the list replaces the write-access rule (see scopeOf). */
  allowed?: ReadonlySet<string>
}

export interface SdkSurface {
  createAgentSession(options: Record<string, unknown>): Promise<{
    session: {
      sessionId: string
      prompt(text: string, options?: { streamingBehavior?: string }): Promise<void>
      subscribe(listener: (event: { type: string }) => void): () => void
      abort(): void
      dispose(): void
    }
  }>
  SessionManager: { inMemory(cwd: string): unknown }
  /** pi's documented way to add an inline extension to a session or leave discovered resources out. */
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> }
  getAgentDir(): string
}

/** Pull requests are read as gh's own login: workers open them as that account, and a reader that cannot see
 *  one would take it for closed and end its ticket. */
export const ghAccounts = (config: RouterConfig): { watched: GhOptions; pulls: GhOptions } => {
  const bin = config.ghBin ? { bin: config.ghBin } : {}
  return { watched: { ...bin, ...(config.githubTokenFile ? { tokenFile: config.githubTokenFile } : {}) }, pulls: bin }
}

export async function loadSdk(config: RouterConfig): Promise<SdkSurface> {
  const spec = config.sdkPath ?? '@earendil-works/pi-coding-agent'
  return await import(spec) as unknown as SdkSurface
}

export const briefFor = (ticket: Ticket, worktree: string): string => [
  `You are a worker on ${ticket.channels[0]?.thread ?? ticket.id}: ${ticket.title}.`,
  `Mandate: ${ticket.mandate?.scope ?? '(the ticket text)'}`,
  `Worktree: ${worktree}. Work there; do not touch the primary checkout.`,
  `Finish with the ticket_report tool: state one of ready, blocked, failed, cancelled; summary = what a`,
  `reviewer needs; question = the single yes/no the operator must answer, and only for state=blocked.`,
  'End every run with ticket_report, including a run that answers a follow-up: a run that ends without it is',
  'posted on the issue as stopped without a result, and your prose answer stays in this tab, unread.',
  'Do not edit the ticket and do not post reply comments: the router writes receipts, you report.',
  'This machine is shared: budget CPU and memory. Run builds and tests sequentially, cap parallel jobs',
  '(make -j4, pytest -n4, not an unbounded fan-out), avoid pulling huge caches, and stop every process',
  'you started before you report.',
].join('\n')

/** How work reaches a repository: a pull request the ticket then waits on. Work that changes no repository ends as before. */
export const pullBrief = (closes?: string, canPush = true): string => canPush ? [
  'If the request changes code or files in a GitHub repository, work in a git checkout inside your workspace on a new branch,',
  'push it, and open a pull request with `gh pr create`, ready for review rather than a draft. Its body says what changed and',
  `why${closes ? `, and ends with \`Closes ${closes}\` when merging it completes the request` : ''}. Report ready with pullRequests`,
  'set to its URL: the ticket then waits for the pull request, comments and reviews on it come to you, and the ticket ends when',
  'it is merged or closed. Do not comment on the pull request yourself. A request that changes no repository, such as a',
  'question, an investigation or an operation, reports ready without one.',
].join('\n') : [
  'If the request changes code or files, work in the git checkout inside your workspace on a new branch and commit it',
  'there. This worker has no GitHub access, so do not try to push or open a pull request: report ready with `branch` set',
  'to the branch name, and say in the summary that the commits are in the ticket workspace. A request that changes no',
  'repository, such as a question, an investigation or an operation, reports ready as it is.',
].join('\n')

export function policyOf(config: RouterConfig): Policy {
  return {
    // v2 marks the judge brief that treats a bare artifact link as the request it implies.
    version: 'v2',
    paused: false,
    // Longer than the router needs to answer one eval under load: a deadline it cannot meet turns every
    // pending judgement into a requeue, and the requeues are what pin the session at full CPU.
    evalTimeoutMs: config.evalTimeoutMs ?? 300_000,
    // Admission is policy, not a model call: a person, explicitly, on a thread the router listens to. The
    // author is checked again here because a trigger stored before bot names were matched as patterns still
    // says human, and one such trigger (an agent asking the operator to approve a test) became a ticket to run it.
    gate: trigger => (trigger.human && !isListed(trigger.actor.id, config.bots)
      ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: false, reason: 'not human' }),
    revalidate: () => true,
    admitsInferred: rules => rules.length > 0,
  }
}

/** GitHub's author associations that come with write access; MEMBER is any member of the owning organization. */
const WRITERS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** Who the router hears at all. On a public repository anyone can open an issue, and an issue starts a worker
 *  with a shell on this machine, so a stranger's issue, comment or review stops here: before the judge spends
 *  a turn on it, and before it reaches a worker as input. */
export function scopeOf(config: RouterConfig): SourceScope {
  return {
    scope: ({ source, meta }) => {
      if (source !== 'github') return { listened: true, observed: false }
      const heard = config.allowed
        ? isListed(typeof meta.author === 'string' ? meta.author : '', config.allowed)
        : WRITERS.has(String(meta.association))
      return heard ? { listened: true, observed: false } : { listened: false, reason: 'senderNotMember' }
    },
  }
}
