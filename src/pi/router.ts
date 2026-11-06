/** The router's shared surface: config, the SDK seam, the worker brief, and the admissibility policy. */
import { isListed } from './authors.ts'
import type { Policy, SourceScope, Ticket } from '../core/index.ts'

export interface RouterConfig {
  herdrWorkspace?: string
  dataDir: string
  self: string
  bots: ReadonlySet<string>
  worktreeRoot: string
  sdkPath?: string
  maxConcurrent?: number
  workerQuietMinutes?: number
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

export async function loadSdk(config: RouterConfig): Promise<SdkSurface> {
  const spec = config.sdkPath ?? '@earendil-works/pi-coding-agent'
  return await import(spec) as unknown as SdkSurface
}

export const briefFor = (ticket: Ticket, worktree: string): string => [
  `You are a worker on ${ticket.channels[0]?.thread ?? ticket.id}: ${ticket.title}.`,
  `Mandate: ${ticket.mandate ?? '(the ticket text)'}`,
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

export function policyOf(config: RouterConfig): Policy {
  return {
    version: 'v1',
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
