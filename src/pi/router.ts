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
  /** GB cap for the work root; settled checkouts over it are swept oldest-first. Default 200. */
  workBudgetGb?: number
  /** Per-worker scope limits (PI_SUPERAGENT_WORKER_LIMITS/MEMORY_GB/CPUS/TASKS); unset means machine-derived. */
  workerLimits?: import('./worker-limits.ts').WorkerLimitSettings
  /**
   * A file holding a scoped GitHub token to hand a worker, so it can push a branch and open a pull request as
   * that token instead of as the operator. Unset, the brief tells the worker it cannot push.
   */
  workerTokenFile?: string
  /** Milliseconds a worker session gets to reach its prompt (PI_SUPERAGENT_WORKER_START_MS); the default is 2 minutes. */
  workerStartMs?: number
  /** How long a close that waits on an open pull request waits before GitHub is asked again; default 10 min. */
  closeRecheckMs?: number
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
  /**
   * How long a tick may wait on the launch queue. It never waits on worker capacity: the queue is gated on a free
   * worker slot, and a tick that awaits that is re-entered only when the fleet goes quiet (measured 2026-11-09:
   * 7 ticks in 6.6 h against a 30 s timer, #303).
   */
  launchDrainMs?: number
  /** A tick that has not finished in this long is stalled: name the stage in the log and fail `superagent status`. */
  tickStallMs?: number
  /** How often one stall is repeated into the log and health.json: a wedged await is one fact, not 2880 lines a day. */
  tickStallReportMs?: number
  /** A tick that has not finished in this long is given up on and a fresh one started, so the cadence survives it. */
  tickAbandonMs?: number
  /** Most followed pull requests one tick reads, and the wall clock it spends starting them (#303). */
  pullReadsPerTick?: number
  pullReadBudgetMs?: number
  policyVersion?: string
  /** Serve the panel and the management API on 127.0.0.1:port; unset means no panel. */
  panelPort?: number
  prepare?: string
  githubRepo?: string
  githubSelf?: string
  /** The agent's own GitHub account, by a file holding its token: the router reads and posts on the watched repository as it. */
  githubTokenFile?: string
  /**
   * Checkouts this deployment reads besides the ticket clones — the watched board's checkout, the checkout the
   * router runs from. Each one is scanned for a credential baked into its remote URL (see git-credentials.ts).
   */
  watchedCheckouts?: readonly string[]
  /** The gh binary; tests put a stand-in here. */
  ghBin?: string
  blockedCommands?: readonly string[]
  /** Off by default: a worker that delegates escapes its mandate, workspace and report. */
  allowDelegation?: boolean
  /** Login patterns the router hears; set, the list replaces the write-access rule (see scopeOf). */
  allowed?: ReadonlySet<string>
  /**
   * Leave the watched repository's issue open when its ticket finishes with nothing to wait on. Off by default:
   * an open, labelled issue is a request intake hears again, which is how a finished ticket kept recruiting
   * workers (issue #309). `PI_SUPERAGENT_KEEP_ISSUES_OPEN=1` restores it.
   */
  keepIssuesOpen?: boolean
  /**
   * Times the same conclusion may be reported on one ticket before it stops recruiting sessions and says so on
   * itself. Default 3. `PI_SUPERAGENT_REPORT_CAP`.
   */
  reportCap?: number
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
export const ghAccounts = (config: RouterConfig, onCall?: (args: readonly string[]) => void): { watched: GhOptions; pulls: GhOptions } => {
  const bin = config.ghBin ? { bin: config.ghBin } : {}
  const token = config.githubTokenFile ? { tokenFile: config.githubTokenFile } : {}
  const counted = onCall ? { onCall } : {}
  // One account for every call (the operator's rule 2026-11-08): the token file is GitHub, not the gh login.
  return { watched: { ...bin, ...token, ...counted }, pulls: { ...bin, ...token, ...counted } }
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
  'A ready or blocked report is your last act: it hands the ticket to a person and frees this session, so finish every',
  'change first, then report, then end your turn. Tools stop working after it until a new message arrives, and nothing',
  'you do on your own afterwards is read.',
  'Do not edit the ticket and do not post reply comments: the router writes receipts, you report.',
  'Write in English: every pull request title and body, issue comment, commit message, code comment and ticket_report,',
  'whatever language you think in. Text in another language is refused before it is sent.',
  'This machine is shared: budget CPU and memory. Run builds and tests sequentially, cap parallel jobs',
  '(make -j4, pytest -n4, not an unbounded fan-out), avoid pulling huge caches, and stop every process',
  'you started before you report.',
  'Waiting on CI: poll it one step per command (`gh pr checks`, then `sleep 60` at most, and again), never one long',
  'wait: a person\'s review reaches you only between commands, and the guard refuses longer waits.',
].join('\n')

/** How work reaches a repository: a pull request the ticket then waits on. Work that changes no repository ends as before. */
export const pullBrief = (closes?: string, canPush = true): string => canPush ? [
  'If the request changes code or files in a GitHub repository, work in a git checkout inside your workspace on a new branch,',
  'push it, and open a pull request with `gh pr create`, ready for review rather than a draft. Its body says what changed and',
  `why${closes ? `, and ends with \`Closes ${closes}\` when merging it completes the request` : ''}. Report ready with pullRequests`,
  'set to its URL: the ticket then waits for the pull request, comments and reviews on it come to you, and the ticket ends when',
  'it is merged or closed. Do not comment on the pull request yourself. A request that changes no repository, such as a',
  'question, an investigation or an operation, reports ready without one. When the work needs several pull requests,',
  'in one repository or across several, list every one in pullRequests in the order a person should merge them: the issue',
  'shows that order with each one\'s state, and when one merges you hear about it to make the follow-on change the rest need.',
  'A review reaches you with its comments on the code numbered: answer every number, by changing the code or by saying',
  'why not, and in ticket_report list each number with what you did. A comment left unanswered is the review not done.',
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
      // Host-authored, not speech: the pull follower's merge-conflict notice is the router telling its own
      // ticket a fact about its own pull request. Its actor is the router and its association is None, so
      // the write-access rule below would filter the notice before the ticket that waits on the pull
      // request ever hears it (it did, on every deployment, from the day the notice shipped).
      // A merge of one of the ticket's pull requests is the same kind of fact, and only someone with write access merges.
      if (meta.via === 'conflict' || meta.via === 'merge') return { listened: true, observed: false }
      const heard = config.allowed
        ? isListed(typeof meta.author === 'string' ? meta.author : '', config.allowed)
        : WRITERS.has(String(meta.association))
      return heard ? { listened: true, observed: false } : { listened: false, reason: 'senderNotMember' }
    },
  }
}
