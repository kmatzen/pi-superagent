/** The package entry point: the router in the session the start script launches, the worker role inside a
 *  worker, and inert everywhere else. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const runGit = promisify(execFile)
import { join, resolve } from 'node:path'
import { Engine, type AssessmentOutcome, type Assessor, type Candidate, type OutboundMessage, type Policy, type Ticket, type TicketInput, type Trigger } from '../core/index.ts'
import { SqliteRepositories } from './store.ts'
import {GithubSource, REPLY_MARKER, type GithubApi, type IssueState, QUEUE_LABEL, REQUEST_LABEL} from './source-github.ts'
import { ghApi, ghPulls } from './gh-api.ts'
import { redactCredentials } from './git-credentials.ts'
import { followedPulls, parsePull, parseThread, pullUrl, PullFollower, threadOfPull, type PullApi, type ReconcileReport } from './pulls.ts'
import { CommentOutbox } from './outbox.ts'
import { PiExecutor } from './executor.ts'
import { renderCandidateFor, SessionAssessor, type SessionPilot } from './assessor.ts'
import { openJudge, type Judge } from './judge.ts'
import { openLog } from './log.ts'
import { openWorkerView } from './worker-view.ts'
import { herdrCli, type Herdr } from './herdr.ts'
import { HerdrWorkers } from './herdr-workers.ts'
import { reportTool, type ReportOrigin } from './report-tool.ts'
import { pullEndText, receiptText, type ReportedRun } from './receipts.ts'
import { isListed } from './authors.ts'
import { workerRole } from './worker-role.ts'
import { createPanelServer } from './server.ts'
import { checkoutRepository, guardExtension, prepareWorkspace, setupProblems } from './workspace.ts'
import { briefFor, ghAccounts, loadSdk, policyOf, pullBrief, scopeOf, type RouterConfig, type SdkSurface } from './router.ts'

export interface PiLike {
  registerTool(tool: RegisteredTool): void
  // pi reads only these two and steers mid-turn on any other value (agent-session.js:1640), which is how 'text' injected unchosen.
  sendUserMessage(text: string, options?: { deliverAs?: 'steer' | 'followUp' }): void
  on(event: string, handler: (payload?: unknown) => void): () => void
}

export interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  // pi calls `definition.execute(toolCallId, params, signal, onUpdate, ctx)`. A tool registered with any
  // other key name registers cleanly, shows up in the model's tool list, and fails every call with
  // `definition.execute is not a function` — which is how the router judged nothing for 188 evals.
  execute(id: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }> | { content: Array<{ type: 'text'; text: string }> }
}

export const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    evalId: { type: 'string' },
    kind: { type: 'string', enum: ['accept', 'ignore', 'stop', 'unavailable'] },
    title: { type: 'string' }, scope: { type: 'string' }, reason: { type: 'string' },
    acknowledgement: { type: 'string' }, rules: { type: 'array', items: { type: 'string' } },
    name: { type: 'string' }, note: { type: 'string' }, ticketId: { type: 'string' },
  },
  required: ['evalId', 'kind', 'reason'],
}

const STR = { type: 'object', properties: {}, additionalProperties: false }

export interface ExtensionDeps {
  config: RouterConfig
  sdk?: SdkSurface
  herdr?: Herdr
  now?: () => string
  githubApi?: GithubApi
  pullApi?: PullApi
  /** Tests read worker files and check worker liveness in milliseconds, not seconds. */
  workerTiming?: { pollMs?: number; livenessMs?: number }
}

export interface RunningRouter {
  tick(): Promise<void>
  stop(): void
  workers(): ReturnType<PiExecutor['workers']>
  tools: RegisteredTool[]
  engine: Engine
  assessor: SessionAssessor
  setPaused(v: boolean): void
  isPaused(): boolean
  /** Workers on a run (against the cap), parked between runs, and queued: the panel's load line. */
  load(): { running: number; parked: number; queued: number; maxWorkers: number; starved: number; oldestStarvedH: number; unanswered: number }
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

/** Why a pass is not moving, in the one file that is readable when the router's own pane is not. */
export interface TickHealth {
  /** The contract `superagent status` counts: a stalled tick is an error, and it fails the health check. */
  state: 'ok' | 'error'
  /** The stall, in the words `superagent status` prints: the file is read by a human over a wall. */
  detail?: string
  at: string
  n: number
  ms: number
  intervalMs: number
  /** Milliseconds since the last finished pass, read against `intervalMs`: this is the stall as a number. */
  sinceLastMs: number
  stage?: string
  stageMs?: number
  launchPending?: number
}

/** `superagent status` reads this file and splits it by block: a tick block in error, or a file nobody
 *  rewrote, is the beat stopped (exit 2, the health check restarts the router); any other block in error is a
 *  part (exit 4, the check reports and does not restart). It prints the file's first 200 characters, so the
 *  tick block goes second, before the source block, and its `detail` field is short enough to survive the cut.
 *  A healthy tick writes `"state": "ok"`, which fails nothing. */
function writeHealth(dir: string, source: { state: string; detail?: string } | null, tick?: TickHealth): void {
  writeFileSync(`${dir}/health.json`, JSON.stringify({
    runtime: { state: 'ready', at: new Date().toISOString() },
    ...(tick ? { tick } : {}),
    ...(source ? { source } : {}),
  }, null, 1))
}

export function createRouterExtension(pi: PiLike, deps: ExtensionDeps): RunningRouter {
  const cfg = deps.config
  const repos = new SqliteRepositories(`${cfg.dataDir}/tickets.db`)
  const log = openLog(cfg.dataDir)
  // The router owns health.json from its first moment: a router that has not polled yet is ready, and the
  // health check must find a file, not an absence.
  writeHealth(cfg.dataDir, null)
  // The worker cap and the beat are logged here because a stall line reports `running` and `cap` and nothing
  // else in the trail carries the configured cap; a reader should not have to open config.env to read a log.
  log.line('info', 'router.start', {
    dataDir: cfg.dataDir, panelPort: cfg.panelPort ?? 0,
    sdkPath: cfg.sdkPath ?? 'package-name', githubRepo: cfg.githubRepo ?? '',
    githubAs: cfg.githubTokenFile ? 'token file' : 'gh login',
    maxWorkers: cfg.maxConcurrent ?? 4, tickMs: cfg.tickMs ?? 30_000,
  })
  const issueOf = (m: OutboundMessage): string | undefined =>
    m.channel.source === 'github' ? (m.channel.address as { issue?: string } | undefined)?.issue : undefined
  const repoOf = (m: OutboundMessage): string | undefined => (m.channel.address as { repo?: string } | undefined)?.repo
  const outbox = new CommentOutbox({
    accepts: m => m.channel.source === 'github' && Boolean(githubApi && issueOf(m)),
    post: async (m, body, retry) => {
      const issue = Number(issueOf(m))
      const repo = repoOf(m)
      if (!issue || !githubApi) return
      try {
        // GitHub may have taken the last attempt before the process died: on a retry, look first. The
        // comparison is against the body as it will be posted — credentials masked — because the masked text is
        // what GitHub has, and comparing the unmasked original would post a duplicate on every retry.
        const seen = retry && githubApi.commentsFor ? await githubApi.commentsFor(issue, repo) : []
        const posted = `${redactCredentials(body)}\n\n${REPLY_MARKER}`
        if (seen.some(c => c.body.trimEnd() === posted)) return
        await githubApi.postComment(issue, body, repo)
      } catch (error) {
        log.line('warn', 'outbox.github_failed', { issue, repo, error: String(error).slice(0, 200) })
        throw error
      }
    },
  }, repos.kv, () => Date.now(), 12,
     (m, tries, error) => log.line('error', 'outbox.given_up', { thread: m.channel.thread, tries, error }))
  // Every `gh` process this pass spawns, counted: the fan-out is the tick's cost, and until #303 nothing had
  // ever counted it. Reset per pass and reported on the tick line.
  let ghCalls = 0
  const accounts = ghAccounts(cfg, () => { ghCalls += 1 })
  const githubApi = deps.githubApi ?? (cfg.githubRepo ? ghApi({
    // Reviews are read as the account that opens the pull requests: the watched account is not in the
    // organization that hosts them, and a pull request it cannot see is a review the ticket never gets.
    repo: cfg.githubRepo, ...accounts.watched,
    // The reviews a ticket waits on are the ones on the pull requests it follows.
    onPullUnreadable: (ref, problem) => log.line('warn', 'pull.reviews_readability', { ref, problem: problem ?? 'readable again' }),
    // A worker's report that quotes `git remote -v` carries the checkout's credential, and this is the write
    // that publishes it to GitHub. It is masked on the way out; the log says that it happened, never what.
    onCredentialRedacted: (count, where) => log.line('warn', 'github.credential_redacted', { where, count }),
    followed: () => followedPulls(repos.tickets.open(), cfg.githubRepo ?? ''),
  }) : undefined)
  // Labelled work with no live ticket: the queue `running=8 cap=8` hides. Measured 2026-11-10: four asks sat
  // unstarted, the oldest 45 hours, while every published number read healthy. The source owns the labels, so it
  // hands the board over on every poll rather than the metric making a second API call.
  let openBoard: readonly IssueState[] = []
  const starvation = (): { starved: number; oldestStarvedH: number; unanswered: number } => {
    // Two questions, two numbers, because one number answered both silently and disagreed with an audit twice.
    // `starved` = labelled asks nobody has ever been put on (what a free slot unblocks). `unanswered` = labelled
    // asks with no worker on them now. Definitions: docs/design-capacity-liveness.md.
    const threads = (t: Ticket) => t.channels.map(c => c.thread)
    const open = repos.tickets.open()
    const claimed = new Set(open.filter(t => { const a = t.assignments.at(-1); return a && a.state !== 'pending' }).flatMap(threads))
    const onIt = new Set(open.filter(t => ['running', 'pending', 'ready', 'blocked'].includes(t.assignments.at(-1)?.state ?? '')).flatMap(threads))
    const labelled = openBoard.filter(i => i.labels.includes(QUEUE_LABEL))
    const waiting = labelled.filter(i => !claimed.has(`#${i.issue}`))
    const hours = (iso: string) => (Date.now() - Date.parse(iso)) / 3.6e6
    const oldest = waiting.reduce((m, i) => Math.max(m, hours(i.updatedAt)), 0)
    return {
      starved: waiting.length,
      oldestStarvedH: Math.round(oldest * 10) / 10,
      unanswered: labelled.filter(i => !onIt.has(`#${i.issue}`)).length,
    }
  }
  const github = githubApi
    ? new GithubSource(githubApi, {
        repo: cfg.githubRepo ?? '', self: cfg.githubSelf ?? cfg.self, bots: cfg.bots, requestLabel: REQUEST_LABEL,
        onWarn: (event, fields) => log.line('warn', event, fields),
        onOpen: (open) => { openBoard = open },
      }, repos.kv)
    : undefined
  github?.bootstrap()
  let paused = false

  // Judgement prompts go to a headless session. Sending them into this session is what made the operator's
  // pane look wedged: one model turn per candidate, every keystroke queued behind it.
  let judge: Judge | undefined
  let judgeFailed = false
  const judgeQueue: string[] = []
  // Opening a session takes 20-45 seconds measured, and every eval that arrives in that window used to
  // start its own: the log showed eight judges open at once and the panel unable to answer a request.
  let judgeOpening: Promise<void> | undefined
  const openTheJudge = (): Promise<void> => judgeOpening ??= doOpenJudge()
  const doOpenJudge = async (): Promise<void> => {
    if (judge) return
    try {
      const sdk = deps.sdk ?? await loadSdk(cfg)
      judge = await openJudge(sdk, {
        cwd: cfg.dataDir, tools: [decideTool], ...(cfg.judgeThinking ? { thinking: cfg.judgeThinking } : {}), log,
        // A turn that ended without ticket_decide holds the one in-flight slot until the eval's deadline;
        // free it now, and the engine's expiry requeues the eval.
        onSettled: () => {
          const unanswered = assessor.inFlightEval
          if (!unanswered) return
          log.line('warn', 'judge.settled_without_decision', { eval: unanswered })
          assessor.release(unanswered)
        },
      })
      for (const body of judgeQueue.splice(0)) judge.prompt(body)
    } catch (error) {
      judgeFailed = true
      log.line('error', 'judge.open_failed', { error: String(error).slice(0, 220), queued: judgeQueue.length })
      // One turn each: steered into the running turn, a burst is answered out of order and the tail expires.
      for (const body of judgeQueue.splice(0)) pi.sendUserMessage(body, { deliverAs: 'followUp' })
    }
  }
  const pilot: SessionPilot = {
    deliver: body => {
      const evalId = /Assess eval (\S+)/.exec(body)?.[1] ?? ''
      if (judge) {
        log.line('info', 'eval.deliver', { eval: evalId, bytes: body.length, target: 'judge' })
        judge.prompt(body)
        return
      }
      // Never park a judgement in the operator's pane while the judge is merely starting: it is answered
      // twice, and the pane is the thing that must stay usable. The pane is the fallback only when the
      // judge cannot open at all.
      judgeQueue.push(body)
      if (judgeFailed) {
        log.line('warn', 'eval.deliver', { eval: evalId, bytes: body.length, target: 'pane-fallback' })
        pi.sendUserMessage(body, { deliverAs: 'followUp' })
        return
      }
      log.line('info', 'eval.deliver', { eval: evalId, bytes: body.length, target: 'judge-starting' })
      void openTheJudge()
    },
  }
  let engine!: Engine
  let executorRef: PiExecutor | undefined
  const assessor: SessionAssessor = new SessionAssessor(() => engine, pilot, { render: renderCandidateFor(cfg.githubRepo) })
  // The engine calls its executor from inside its commands. Each call runs once the command has committed,
  // so a worker never acts on a write that could still roll back.
  const afterCommit = (what: string, run: () => void): void => {
    setImmediate(() => {
      try { run() } catch (error) { log.line('error', 'executor.port_failed', { what, error: String(error).slice(0, 200) }) }
    })
  }
  const policy = (): Policy => ({ ...policyOf(cfg), ...(paused ? { paused: true } : {}) })

  engine = new Engine({
    repo: repos,
    scope: scopeOf(cfg),
    policy,
    assessor,
    executor: {
      start: (ticket, assignment) => afterCommit('start', () => {
        // A poll can launch the assignment before this callback, and a crash can already have replaced it.
        const fresh = repos.tickets.get(ticket.id)
        const latest = fresh?.assignments.at(-1)
        if (fresh && !fresh.ended && latest?.id === assignment.id && latest.state === 'pending') executorRef?.start(fresh, latest)
      }),
      deliver: (ticket, assignment) => afterCommit('deliver', () => {
        const fresh = repos.tickets.get(ticket.id)
        if (!fresh) return
        // Say it out loud: a delivery that the worker's model never read is the difference between a worker
        // that ignored a review and one that was never told, and only the trail can tell them apart later.
        log.line('info', 'input.delivered', { ticket: ticket.id, thread: fresh.channels[0]?.thread ?? ticket.id, waiting: fresh.undelivered.length })
        executorRef?.deliver(fresh, assignment)
      }),
      stop: (ticket, assignment, reason) => afterCommit('stop', () => executorRef?.stop(ticket, assignment, reason)),
    },
    outbox,
    now: deps.now ?? (() => new Date().toISOString()),
  })

  const renderInput = (input: TicketInput): string | undefined => input.kind === 'trigger'
    ? (repos.triggers.get(input.triggerId) ? `${repos.triggers.get(input.triggerId)!.actor.id}: ${repos.triggers.get(input.triggerId)!.text}` : undefined)
    // A text Input is the operator's own words: rendering it as `[text]` would deliver the literal
    // string to the worker and mark the answer read.
    : input.kind === 'text' ? input.text : `[${input.kind}]`

  // The release rule, in one place: a settled report frees the agent, whoever filed it. It lived twice — in
  // this callback and in the silence sweep, which files through the domain and so never reached this code —
  // and the second copy is what freed the 6 tickets that the first one could not see (measured 2026-11-09).
  const releaseIfWaiting = (ticketId: string, assignmentId: string, state: string): void => {
    const ticket = repos.tickets.get(ticketId)
    if (!ticket || ticket.ended) return
    engine.release(ticketId, assignmentId)
    executorRef?.release(ticket)
    log.line('info', 'worker.released', { ticket: ticketId, assignment: assignmentId, state })
  }

  // One message per assignment, ending and text; a failed launch drops the text, since it retries every poll.
  const announce = (ticket: Ticket, assignmentId: string, origin: ReportOrigin, run: ReportedRun, relaunched: boolean): void => {
    const channel = ticket.channels[0]
    if (!channel) return
    const said = origin === 'launch' ? ''
      : createHash('sha1').update(JSON.stringify([run.state, run.summary, run.question ?? null, run.pullRequests ?? []])).digest('hex').slice(0, 12)
    outbox.send({ id: `report:${assignmentId}:${origin}:${said}`, channel, kind: 'reply', ticketId: ticket.id,
      text: receiptText(channel.thread, origin, run, relaunched) })
  }
  // One fresh worker per crash, per ticket per process; the engine's retry requeues comments the dead one never read.
  const relaunched = new Set<string>()
  // A worker that has asked and waits for a person is not work in progress: 5 of them held tabs and slots for
  // hours while 13 tickets queued (measured 2026-11-08). Free the agent when it posts the question; a reply starts
  // a fresh one, and the issue is its memory. `ready` is excluded: that report ends the ticket, and ending it
  // needs the worker's own turn-end bookkeeping (measured: releasing on ready left the ticket unended).
  const awaitsAHuman = (state: string): boolean => state === 'blocked' || state === 'waiting'

  const reported = (ticket: Ticket, assignmentId: string, origin: ReportOrigin, run: ReportedRun): void => {
    let fresh = false
    // A crash of a worker that had already reported `ready`, `blocked`, or `waiting` is not unfinished work: the
    // delivery exists, or a person is the only blocker. Relaunching those re-ran shipped changes (measured
    // 2026-11-10: after four panes closed, all four tickets relaunched, two of them already merged-ready PRs).
    const saidItsPiece = run.state === 'ready' || awaitsAHuman(run.state)
    if (origin === 'crash' && !relaunched.has(ticket.id) && !saidItsPiece) {
      relaunched.add(ticket.id)
      try {
        engine.retryTicket(ticket.id)
        fresh = true
        log.line('info', 'worker.relaunched', { ticket: ticket.id, after: assignmentId })
      } catch (error) {
        log.line('warn', 'worker.relaunch_failed', { ticket: ticket.id, error: String(error).slice(0, 200) })
      }
    }
    if (origin === 'crash' && saidItsPiece) {
      log.line('info', 'worker.relaunch_skipped', { ticket: ticket.id, assignment: assignmentId, state: run.state })
      releaseIfWaiting(ticket.id, assignmentId, run.state)
    }
    announce(ticket, assignmentId, origin, run, fresh)
    // The operator's rule 2026-11-08 and its 2026-11-09 extension: a worker gives up its agent, tab and slot
    // whenever a person is the only thing it can be waiting for — it asked, it needs an answer, or it finished
    // its turn and its own pull request waits for a human merge. A ticket the report ENDED needs none of this:
    // ending disposes the worker through `stop`. formal/Ticket.tla R1/R3/R5 are the claims.
    if (origin === 'worker' && (awaitsAHuman(run.state) || run.state === 'ready')) {
      releaseIfWaiting(ticket.id, assignmentId, run.state)
    }
    pullEnded(ticket.id)
    // The report the person reads has gone out; these two bound what a finished ticket can do next.
    if (origin === 'worker') capRepeats(repos.tickets.get(ticket.id) ?? ticket, run)
    finishIssue(ticket.id)
  }
  const home = cfg.githubRepo ?? ''
  const pullApi = deps.pullApi ?? ghPulls(accounts.pulls)

  /**
   * The terminal end of a ticket that finished with nothing to wait on: its issue closes with it. A `ready`
   * report that opens no pull request ends the ticket inside the engine and left the issue open and labelled,
   * which is a request intake can hear forever — measured 2026-11-09, #255 was dispatched a fourth time nine
   * hours after its merge landed. A closed issue is not in intake's hearing; a comment on it, or a reopen, is
   * a person saying go again, and both doors stay open.
   */
  const closedKey = 'closed-issues'
  const closedHere = (): Record<string, string> => repos.kv.get<Record<string, string>>(closedKey) ?? {}
  const closing: string[] = []
  const finishIssue = (ticketId: string): void => {
    if (cfg.keepIssuesOpen) return
    const ticket = repos.tickets.get(ticketId)
    const channel = ticket?.channels[0]
    if (!ticket?.ended || ticket.ended.by !== 'executor' || !channel || channel.source !== 'github') return
    // Work still owed: a pull request that has not landed is the ticket waiting on a person, not finished.
    if ((ticket.follows ?? []).some(f => !f.closed)) return
    const address = channel.address as { issue?: string; repo?: string }
    // Only the watched repository's issues: an issue in another repository belongs to that repository's board.
    if (!address.issue || address.repo) return
    if (closedHere()[ticket.id]) return
    closing.push(ticket.id)
  }
  const flushCloses = async (): Promise<void> => {
    if (!closing.length) return
    // The words first, then the door: the receipt is posted (and awaited) before the issue closes, so the
    // thread reads as an answer that ended, not as a request that vanished.
    outbox.flush()
    await outbox.drained()
    for (const ticketId of closing.splice(0)) {
      const ticket = repos.tickets.get(ticketId)
      const issue = Number((ticket?.channels[0]?.address as { issue?: string } | undefined)?.issue)
      if (!issue || !githubApi) continue
      try {
        // `#7` names an issue and a pull request in the same repository, and PATCH state=closed on the pull
        // number closes the pull request: only a number GitHub does not know as a pull is safe to close here.
        if (await pullApi.pull(home, issue)) {
          log.line('info', 'issue.close_skipped', { ticket: ticketId, issue: `#${issue}`, why: 'the thread is a pull request' })
          continue
        }
        await githubApi.closeIssue?.(issue)
        repos.kv.set(closedKey, { ...closedHere(), [ticketId]: deps.now?.() ?? new Date().toISOString() })
        log.line('info', 'issue.closed', { ticket: ticketId, issue: `#${issue}`, outcome: ticket?.ended?.outcome })
      } catch (error) {
        // The ticket is ended and its grant is spent, so a failed close costs tidiness, not quiet.
        log.line('warn', 'issue.close_failed', { ticket: ticketId, issue: `#${issue}`, error: String(error).slice(0, 200) })
      }
    }
  }

  /**
   * The blast-radius bound: a ticket that keeps reporting with nothing new to act on must stop recruiting.
   * On 2026-11-09 #227 reported the same sentence 93 times in 20 hours, and #255 reported five times in nine
   * hours — each time in new words, and flipping from `ready` to `blocked`: "Nothing to merge: this pull
   * request landed…", "The mandate is already satisfied…", "Close this ticket: its pull request merged…".
   * Wording is not the signature. The signature is a report that landed with **no new inbound speech on the
   * thread since the previous report**: the worker was recruited by speech the router wrote itself, so it can
   * only re-prove what it proved last time. N of those (`PI_SUPERAGENT_REPORT_CAP`, default 3) and the ticket
   * says so on itself and stops recruiting sessions.
   *
   * Two things make the streak, and both must hold: the same report state, and quiet on the thread. A report
   * that changed state, or a person's comment, restarts the count — three in a row is the loop, three spread
   * across real progress is a worker that kept working. The count is the router's journal, not the ticket's
   * assignments: an Assignment keeps its LAST report, so the 93 receipts of one worker session are one report
   * in the ticket. Only a worker's own report counts: a launch that fails on every poll is the router retrying,
   * and its contract is to keep trying and say so once, not to give up on a ticket a person asked for.
   */
  const capKey = 'report-conclusions'
  type CapRow = { state: string; times: number; at: string }
  const capRows = (): Record<string, CapRow> => repos.kv.get<Record<string, CapRow>>(capKey) ?? {}
  // GitHub's clock and the router's are not the same clock, and a comment that arrived a moment before a
  // report is speech the worker acted on. Generous by two minutes: this window only ever resets the count.
  const SPEECH_GRACE_MS = 120_000
  /**
   * Did a person say anything on this ticket's thread after `after`? The router's own writing is not speech
   * (it is the receipt the worker is answering again), the intake label is not speech (it is a grant), and a
   * pull request's edge is not speech either: #205 sat 2h13m waiting on CI and reported 48 times because
   * every check that finished, every recompute of `mergeable`, fired a pull Trigger that woke the worker.
   * Words from a person on the thread are the only thing that restarts the count.
   */
  const inboundSpeech = (ticket: Ticket, after: string): boolean =>
    (ticket.inputs ?? []).some(input => {
      if (input.kind !== 'trigger' || !input.human) return false
      if (Date.parse(input.at) <= Date.parse(after) - SPEECH_GRACE_MS) return false
      const trigger = repos.triggers.get(input.triggerId)
      if (!trigger || trigger.source === 'pull') return false
      const author = String(trigger.meta?.author ?? trigger.actor?.id ?? '')
      if (author && isListed(author, new Set([cfg.githubSelf ?? cfg.self, ...(cfg.bots ?? [])]))) return false
      return (trigger.meta?.via ?? 'comment') !== 'label'
    })
  const capRepeats = (ticket: Ticket, run: ReportedRun): void => {
    const cap = cfg.reportCap ?? 3
    if (run.state === 'progress' || run.state === 'waiting') return
    const at = deps.now?.() ?? new Date().toISOString()
    const rows = capRows()
    const prior = rows[ticket.id]
    const times = prior && prior.state === run.state && !inboundSpeech(ticket, prior.at) ? prior.times + 1 : 1
    repos.kv.set(capKey, Object.fromEntries(Object.entries({ ...rows, [ticket.id]: { state: run.state, times, at } as CapRow })
      .filter(([, row]) => Date.parse(row.at) > Date.parse(at) - 30 * 86_400_000)))
    if (times < cap) return
    const channel = ticket.channels[0]
    if (!channel) return
    const said = `${run.state}: ${run.summary}`.slice(0, 160)
    outbox.send({
      id: `repeat:${ticket.id}:${createHash('sha1').update(said).digest('hex').slice(0, 12)}`,
      channel, kind: 'notice', ticketId: ticket.id,
      text: `${channel.thread}: the same result has been reported ${times} times — ${run.summary}. Nothing new arrived on this thread `
        + 'between the reports, so no further session runs this ticket. It is stopped, not waiting: a comment here will not wake it, and a person un-stops it.',
    })
    if (!ticket.ended) {
      // A stop by the router on a repeating loop, and it is deliberately the strong kind: `wake` refuses to
      // resume a stopped ticket, so neither the router's receipt, a label trigger, nor a pull request's CI
      // churn can put a session back on it. Re-asking is then a deliberate act — `superagent intake #NNN`,
      // which relabels — which is what "new inbound speech" is allowed to look like.
      try {
        engine.stopTicket(ticket.id, `the same result was reported ${times} times, so the ticket stops here`, 'loop')
        log.line('info', 'ticket.repeat_stopped', { ticket: ticket.id, times, state: run.state })
      } catch { /* it ended by its own report, which is the same quiet */ }
    }
    // A finished conclusion that repeated closes the issue too: closing is what makes the quiet last.
    finishIssue(ticket.id)
  }

  // The engine ends a ticket with its pull request but posts nothing, so the issue hears it here, once per ticket.
  const pullEnded = (ticketId: string): void => {
    const ticket = repos.tickets.get(ticketId)
    const outcome = ticket?.ended?.outcome
    const channel = ticket?.channels[0]
    if (!ticket || !channel || ticket.ended?.by !== 'executor' || (outcome !== 'merged' && outcome !== 'closed')) return
    const pulls = (ticket.follows ?? []).filter(f => f.own && f.closed)
      .flatMap(f => { const pull = parseThread(f.thread.replace(/^github:/, ''), home)
        return pull ? [{ url: pullUrl(pull), outcome: f.closed!.outcome }] : [] })
    outbox.send({ id: `pull-end:${ticket.id}`, channel, kind: 'notice', ticketId: ticket.id, text: pullEndText(channel.thread, pulls) })
    // The merge was the work landing: with the pull request done, the ticket has nothing left to wait on.
    finishIssue(ticket.id)
  }
  const follower = new PullFollower({
    home, api: pullApi,
    openThreads: () => github?.openThreads(), positions: repos.kv,
    self: cfg.githubSelf ?? cfg.self, bots: cfg.bots, now: () => Date.now(),
    // The fan-out is bounded per pass, not left to the 120 s budget, which binds only while the loop keeps its
    // cadence (measured 2026-11-09: 41 follows due at once, 12.1 s per pass).
    ...(cfg.pullReadsPerTick === undefined ? {} : { maxReads: cfg.pullReadsPerTick }),
    ...(cfg.pullReadBudgetMs === undefined ? {} : { budgetMs: cfg.pullReadBudgetMs }),
    receive: trigger => { engine.receive(trigger) },
    warn: (event, fields) => log.line('warn', event, fields),
    closed: (thread, pull, outcome, at) => {
      const key = `github:${thread.id}`
      const waiting = repos.tickets.open().filter(t => t.follows?.some(f => f.thread === key && !f.closed)).map(t => t.id)
      engine.threadClosed(thread, outcome, at)
      log.line('info', 'pull.closed', { thread: thread.id, outcome, url: pullUrl(pull), tickets: waiting.length })
      for (const id of waiting) pullEnded(id)
    },
    // The other half of `closed`: a close written down by a read that failed (GitHub answers 404 for a private
    // repository the account cannot see) leaves a live ticket holding a closed follow on a pull request that is
    // open, with nothing left to follow. Re-binding the thread clears the recorded close, so the ticket is waited
    // on, ended by, and hears review on its pull request again. Live tickets only: an ended ticket's terminal end is
    // the operator's to undo, and reopening 39 of them in one start would recruit 39 sessions unasked (#309 ask 3).
    reopened: (thread, pull) => {
      const key = `github:${thread.id}`
      const holding = repos.tickets.open().filter(t => t.follows?.some(f => f.thread === key && f.closed?.outcome === 'closed'))
      for (const t of holding) {
        try { engine.bindThread(t.id, thread, true) }
        catch (error) { log.line('warn', 'pull.reopen_failed', { ticket: t.id, thread: thread.id, url: pullUrl(pull), error: String(error).slice(0, 200) }) }
      }
      return holding.length
    },
  })
  // Bound before the engine reads the report: a ready report completes a ticket that follows no open pull request.
  const follow = (ticket: Ticket, urls: readonly string[]): readonly string[] => {
    const followed: string[] = []
    for (const url of urls) {
      const pull = parsePull(url)
      if (!pull) { log.line('warn', 'pull.unreadable', { ticket: ticket.id, ref: url.slice(0, 200) }); continue }
      try {
        engine.bindThread(ticket.id, threadOfPull(pull, home), true)
        followed.push(pullUrl(pull))
        log.line('info', 'pull.followed', { ticket: ticket.id, url: pullUrl(pull) })
      } catch (error) {
        log.line('warn', 'pull.follow_failed', { ticket: ticket.id, url: pullUrl(pull), error: String(error).slice(0, 200) })
      }
    }
    return followed
  }
  const herdrWorkers = cfg.workers === 'herdr'
    ? new HerdrWorkers({ herdr: deps.herdr ?? herdrCli(cfg.herdrBin), stateDir: cfg.dataDir, log,
      ...(cfg.herdrWorkspace ? { workspaceLabel: cfg.herdrWorkspace } : {}), ...deps.workerTiming })
    : undefined

  const executor = new PiExecutor(engine, {
    launch: async ({ ticket, report }) => {
      const channel = ticket.channels[0]
      // A ticket with no workspace is the ticket's failure, with the command's own output as the summary.
      const token = cfg.workerTokenFile ? workerToken(cfg.workerTokenFile, (event, fields) => log.line('warn', event, fields)) : undefined
      const workspace = prepareWorkspace({
        root: cfg.worktreeRoot, ticketId: ticket.id, stateDir: cfg.dataDir,
        ...(cfg.prepare ? { prepare: cfg.prepare } : {}),
        ...(cfg.blockedCommands ? { blockedCommands: cfg.blockedCommands } : {}),
        ...(token ? { workerToken: token } : {}),
        ...(cfg.githubSelf ? { identity: { name: cfg.githubSelf, email: `${cfg.githubSelf}@users.noreply.github.com` } } : {}),
      })
      // In asks-only mode the watched repository is the ask board: cloning it put a checkout with no code in
      // it in front of every worker, and a ticket naming no repository then ran for a day in an empty directory.
      if (cfg.githubRepo && !cfg.prepare && !cfg.watchRepoIsAsks) await checkoutRepository(workspace, cfg.githubRepo, ticket.id)
      if (herdrWorkers) {
        return herdrWorkers.launch({
          ticket, thread: channel?.thread ?? ticket.id, workspace: workspace.dir, report,
          env: {
            ...(cfg.blockedCommands?.length ? { PI_SUPERAGENT_BLOCKED: cfg.blockedCommands.join(',') } : {}),
            ...(cfg.allowDelegation ? { PI_SUPERAGENT_ALLOW_DELEGATION: '1' } : {}),
          },
        })
      }
      // In-process workers: only tests come this way, since configFrom always chooses herdr.
      const sdk = deps.sdk ?? await loadSdk(cfg)
      // The guard rides in as an inline extension because pi enforces policy at its tool_call hook; the
      // `toolGuard` option this used to pass does not exist, so pi ignored it and workers had every tool.
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: workspace.dir, agentDir: sdk.getAgentDir(),
        extensionFactories: [guardExtension({
          blocked: cfg.blockedCommands ?? [], workspace: workspace.dir, allowDelegation: cfg.allowDelegation ?? false,
        })],
      })
      await resourceLoader.reload()
      const { session } = await sdk.createAgentSession({
        cwd: workspace.dir,
        sessionManager: sdk.SessionManager.inMemory(workspace.dir),
        customTools: [reportTool(report)],
        resourceLoader,
      })
      const view = openWorkerView({ dir: join(cfg.dataDir, 'workers'), log }, {
        ticketId: ticket.id, thread: channel?.thread ?? ticket.id, title: ticket.title, sessionId: session.sessionId, workspace: workspace.dir,
      })
      const unwatch = session.subscribe(event => view.event(event as { type: string } & Record<string, unknown>))
      log.line('info', 'worker.opened', { ticket: ticket.id, session: session.sessionId, workspace: workspace.dir, watch: view.path })
      return {
        sessionId: session.sessionId,
        workspace: workspace.dir,
        watch: view.path,
        // pi refuses a prompt mid-turn unless it is told to steer or queue it.
        prompt: (body: string, mode: 'steer' | 'followUp') => {
          session.prompt(body, { streamingBehavior: mode }).catch((error: unknown) =>
            log.line('error', 'worker.prompt_failed', { ticket: ticket.id, mode, error: String(error).slice(0, 200) }))
        },
        subscribe: (listener) => session.subscribe(event => {
          if (event.type === 'agent_start') listener({ type: 'turnStarted' })
          else if (event.type === 'agent_settled') listener({ type: 'settled' })
          else listener({ type: 'activity' })
        }),
        abort: () => session.abort(),
        dispose: () => { unwatch(); view.close('stopped'); session.dispose() },
      }
    },
  }, {
    worktreeFor: ticket => `${cfg.worktreeRoot}/${ticket.id}`,
    briefFor: ticket => {
      // A worker started after a failed attempt shares that attempt's workspace, and must look before redoing it.
      const before = ticket.assignments.filter(a => a.report?.state === 'failed').at(-1)?.report
      const brief = briefFor(ticket, `${cfg.worktreeRoot}/${ticket.id}`) + (before
        ? `\nA previous worker on this ticket stopped (${before.summary}); anything it changed is still in the workspace, so check it before starting over.`
        : '')
      const address = ticket.channels[0]?.source === 'github' ? ticket.channels[0].address as { issue?: string; repo?: string } : undefined
      const issue = address?.issue
      const repo = address?.repo ?? cfg.githubRepo
      // Without gh the worker cannot open a pull request, so it is not asked to. Without a token of its own it
      // cannot push either, and the old brief sent it to try: measured, gh answers "please run gh auth login".
      const pulls = cfg.blockedCommands?.includes('gh') ? ''
        : `\n${cfg.workerTokenFile
          ? pullBrief(issue && repo ? `${repo}#${issue}` : undefined)
          : pullBrief(undefined, false)}`
      if (!issue || !repo) return brief + pulls
      // A comment the worker posts itself carries no reply footer, so the router would read it as the
      // operator asking again on this thread.
      const clone = cfg.watchRepoIsAsks
        ? 'Your workspace holds no checkout of code: the watched repository carries asks, not the repository this '
          + 'request changes. Clone the repository the request names into your workspace before you change anything, '
          + 'and if it names none, report blocked and say what you need. '
        : ''
      return `${brief}\nThe request is GitHub issue ${repo}#${issue}: read it with \`gh issue view ${issue} --repo ${repo} --comments\`. `
        + clone + 'Do not comment on the issue yourself; ticket_report is how your result reaches it.' + pulls
    },
    renderInput,
    reported,
    follow,
    reportDropped: fields => log.line('warn', 'worker.report_dropped', fields),
    ...(cfg.maxConcurrent ? { maxConcurrent: cfg.maxConcurrent } : {}),
  })
  executorRef = executor

  const decideTool: RegisteredTool = {
    name: 'ticket_decide', label: 'Judge a candidate',
    description: 'Answer one eval the engine delivered: accept (title, scope, reason, acknowledgement), ignore, stop (ticketId), or unavailable.',
    parameters: DECIDE_SCHEMA,
    execute: (_id, args) => {
      const a = args as unknown as { evalId: string; kind: AssessmentOutcome['kind'] } & Record<string, string>
      // One open ticket per thread: its messages belong to its worker. The judge once accepted a second
      // ticket on a thread whose first ticket was right there in its prompt.
      const thread = assessor.threadOf(a.evalId)
      const owner = a.kind === 'accept' && thread
        ? repos.tickets.open().find(t => t.channels.some(c => `${c.source}:${c.thread}` === thread))
        : undefined
      if (owner) {
        log.line('warn', 'eval.accept_overruled', { eval: a.evalId, thread, ticket: owner.id })
        a.kind = 'ignore' as AssessmentOutcome['kind']
        a.reason = `${thread} already has open ticket ${owner.id}; its worker gets this thread's messages`
      }
      log.line('info', 'eval.decided', { eval: a.evalId, kind: a.kind, reason: (a.reason ?? '').slice(0, 300) })
      assessor.decide(a.evalId, a as unknown as AssessmentOutcome)
      return text(`decided ${a.kind}`)
    },
  }
  void openTheJudge()

  // Core asks the assessor only when an eval starts, and never expires one whose candidate was not
  // delivered: an eval in flight when the last process died waits forever unless this one asks again.
  const now = new Date().toISOString()
  let reasked = 0
  for (const thread of repos.threads.active()) {
    const evaluation = thread.evaluating
    if (!evaluation || (evaluation.delivered && evaluation.deadline <= now)) continue
    const candidate = engine.candidate(evaluation.primary ?? evaluation.triggerIds[0] ?? '')
    if (candidate) { assessor.request(candidate); reasked += 1 }
  }
  log.line('info', 'evals.reasked', { count: reasked })

  const tools: RegisteredTool[] = [
    decideTool,
    {
      name: 'tickets_open', label: 'List open tickets',
      description: 'Every open ticket with its state and what it waits for.',
      parameters: STR,
      execute: () => text(repos.tickets.open().map(t => ({
        id: t.id, title: t.title, thread: t.channels[0]?.thread,
        assignment: t.assignments.at(-1)?.state ?? 'queued',
        waiting: t.attention ? (t.attention as { question?: string }).question ?? 'a person' : null,
      }))),
    },
    {
      name: 'ticket_show', label: 'Show one ticket',
      description: 'One ticket as history: its triggers, decision, assignments and reports.',
      parameters: { type: 'object', properties: { ticketId: { type: 'string' } }, required: ['ticketId'] },
      execute: (_id, args) => {
        const t = repos.tickets.get((args as unknown as { ticketId: string }).ticketId)
        return text(t ?? 'no such ticket')
      },
    },
    {
      name: 'engine_tick', label: 'Run one pass now',
      description: 'Poll GitHub, judge what is due, start queued work, and post receipts.',
      parameters: STR,
      execute: async () => { await tickNow(); return text(paused ? 'paused: tick skipped' : 'tick done') },
    },
    {
      name: 'engine_pause', label: 'Pause or resume processing',
      description: 'Pause stops new work; running workers keep going. Resume with false.',
      parameters: { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] },
      execute: (_id, args) => { paused = Boolean((args as unknown as { paused: boolean }).paused); return text(`paused=${paused}`) },
    },
  ]
  for (const tool of tools) pi.registerTool(tool)

  let sweeps = 0
  process.on('uncaughtException', (error: unknown) => log.line('error', 'uncaught', { error: String(error).slice(0, 300) }))
  process.on('unhandledRejection', (error: unknown) => log.line('error', 'unhandled_rejection', { error: String(error).slice(0, 300) }))

  /**
   * One pass of the loop. `mine` is the generation that owns the cadence guard: a pass the beat abandoned keeps
   * running, and a pass that no longer owns the guard must not describe the loop (see the closing block).
   */
  async function tick(mine: number): Promise<void> {
    if (paused) return
    const started = Date.now()
    const gapMs = started - lastTickEnd
    // Only the pass holding the guard names the stage the loop is parked in; a superseded pass reaching its next
    // await would move the label out from under the stall report that is describing it.
    const enter = (name: string): void => { if (mine === generation) enterStage(name) }
    const callsAtStart = ghCalls
    let pollMs = 0
    let reconcileMs = 0
    let evaluateMs = 0
    let drainMs = 0
    let drain = { settled: true, pending: 0 }
    let pulls: ReconcileReport = { due: 0, read: 0, deferred: 0, atOnce: 0 }
    // The startup sweep, the takeover of surviving workers, and the orphan retire all live behind this one
    // await, and every pass waits on it: named as a stage so a router that never gets past it says so (#303).
    enter('recovery')
    await recovered
    // A ticket that finished closes its issue at the top of a pass, after the pass that queued the close has
    // flushed its receipt: the person reads the words on the issue before the door closes (see flushCloses).
    // It posts to GitHub, so it is a named stage: a pass parked here says so instead of looking idle (#303).
    enter('closes')
    await flushCloses()
    let triggers: Trigger[] = []
    if (github) {
      const pollAt = Date.now()
      enter('poll')
      // A failing poll is not a quiet tick: a router that cannot hear GitHub looks healthy forever, so three
      // failures in a row go into health.json, where `superagent status` turns them into exit code 4: an alarm
      // for a person, not a restart, because restarting the router does not bring the source back.
      try {
        triggers = await github.poll()
      } catch (error) {
        pollFailures += 1
        log.line('error', 'github.poll_failed', { error: String(error).slice(0, 200), failures: pollFailures, ms: Date.now() - pollAt, gh: ghCalls - callsAtStart })
        if (pollFailures >= 3) {
          sourceHealth = { state: 'error', detail: `github polls failing (${pollFailures}): ${String(error).slice(0, 160)}` }
          publishHealth(tickHealth('error', { detail: sourceHealth.detail }))
        }
        return
      }
      if (pollFailures) { pollFailures = 0; sourceHealth = null; publishHealth() }
      pollMs = Date.now() - pollAt
    }
    for (const trigger of triggers) engine.receive(trigger)
    // One worker per thread: the sweep runs after intake so it sees the ticket the poll just opened, and it
    // stops the younger duplicate, which releases its agent, its tab and its slot like any other stop.
    for (const id of duplicateLiveTickets(repos.tickets.open(), executor.workers())) {
      log.line('warn', 'ticket.duplicate_swept', { ticket: id })
      try { engine.stopTicket(id, 'duplicate live ticket on the same thread; the older ticket keeps the job') } catch {
        // A ticket that refuses to stop (already ended between the scan and here) is the outcome we wanted.
      }
    }
    const reconcileAt = Date.now()
    enter('reconcile')
    try {
      pulls = await follower.reconcile(repos.tickets.open())
    } catch (error) {
      // The rest of the pass still runs: judgements, launches and replies must not wait on one pull request.
      log.line('error', 'pull.reconcile_failed', { error: String(error).slice(0, 200) })
    }
    reconcileMs = Date.now() - reconcileAt
    // The conversation a ticket lives in can end on GitHub: a merge closes the issue it names, and
    // closing without merging is a person saying no. Either way the ticket stops and says so, unless it
    // follows its own pull request, whose close ends it (above).
    const openThreads = github?.openThreads()
    enter('conversations')
    if (openThreads) {
      for (const ticket of repos.tickets.open()) {
        const channel = ticket.channels[0]
        if (!channel || channel.source !== 'github' || !channel.thread.startsWith('#') || openThreads.has(channel.thread)) continue
        // A merge closes the issue it names: the ticket ends with its pull request once the work finishes, not as a stop.
        if (ticket.follows?.some(f => f.own && f.closed)) continue
        // Absence from the open list is the hint; GitHub's answer on this issue is the fact. Measured
        // 2026-11-09: a thread missing from the list stopped a live ticket whose issue was open all along, and
        // the stopped ticket then took no comment, so a person's reply reached nothing.
        const state = github?.issueState ? await github.issueState(Number(channel.thread.slice(1))) : 'closed'
        if (state !== 'closed') {
          if (state === 'unknown') log.line('warn', 'conversation.state_unknown', { ticket: ticket.id, thread: channel.thread })
          continue
        }
        try {
          engine.stopTicket(ticket.id, 'the conversation closed on GitHub', 'conversation')
          outbox.send({
            id: `closed:${ticket.id}`,
            channel,
            kind: 'notice', ticketId: ticket.id,
            text: 'Stopped: this conversation closed on GitHub. Reopen it, or comment on it, and the work resumes.',
          })
          log.line('info', 'ticket.conversation_closed', { ticket: ticket.id, thread: channel.thread })
        } catch {
          // A stop raced with this poll; the ticket is already ended, which is the same outcome.
        }
      }
    }
    // evaluateDue runs on every pass: it is the only thing that expires a stuck eval, and gating it once left
    // 54 stale judgements in flight forever. The judge's load is bounded by the assessor, one question at a time.
    sweeps += 1
    enter('evaluate')
    const evaluateAt = Date.now()
    engine.evaluateDue()
    evaluateMs = Date.now() - evaluateAt
    enter('launch')
    for (const ticket of repos.tickets.open()) {
      const assignment = ticket.assignments.at(-1)
      if (assignment && assignment.state === 'pending') executor.start(ticket, assignment)
      // The answer to a released worker is the request that starts the next one (formal/Ticket.tla R2): wake
      // appends the fresh Assignment and the resumed marker, and the next poll launches it.
      else if (assignment && assignment.state === 'ended' && assignment.endedReason === 'released'
        && ticket.undelivered.length && !executor.workers().some(w => w.ticketId === ticket.id)) engine.wake(ticket.id)
    }
    // The other half of the conversation door. Intake attaches a person's message to a ticket the router stopped
    // because its conversation closed, and `wake` starts a worker on it — but the loop above visits open tickets
    // only, so the attachment had no partner: measured 2026-11-10, #350's reply at 00:21:59 became an Input on a
    // ticket that nothing visited, and the ask died there with the label that spent it. `wake` holds the guard.
    for (const stopped of repos.tickets.active()) {
      if (stopped.ended?.kind !== 'conversation' || !stopped.undelivered.length) continue
      if (executor.workers().some(w => w.ticketId === stopped.id)) continue
      engine.wake(stopped.id)
    }
    // A worker quiet for 15 minutes gets a question on the panel, not the issue: a long build is not news.
    for (const quiet of executor.quiet(cfg.workerQuietMinutes ?? 15)) {
      engine.report(quiet.ticketId, {
        state: 'blocked',
        summary: `the worker sent no event for ${Math.round(quiet.quietSeconds / 60)} minutes in ${quiet.workspace}`,
        question: 'steer it, stop it, or accept the work it has done',
      } as never)
      // The silence became a question, and a question is what frees an agent (the operator's rule 2026-11-08): a
      // worker that has said nothing for 15 minutes is a tab, an agent and a slot waiting on a person. Measured
      // 2026-11-09, minutes after the release rule shipped: 6 tickets still held finished workers whose only
      // report predated the deploy, because this sweep — the one report they were going to file — went straight
      // to the ticket and left the Session in place. The report goes first: it belongs to the running Assignment
      // that the release then ends.
      const running = repos.tickets.get(quiet.ticketId)?.assignments.at(-1)
      if (running?.state === 'running') releaseIfWaiting(quiet.ticketId, running.id, 'quiet')
    }
    // The operator's deadline, not the router's: report and let a person decide. A worker mid-legitimate
    // work must never be terminated by a clock the router owns, so this speaks and does not kill.
    for (const late of executor.overdue(cfg.workerDeadlineHours ?? 6)) {
      engine.report(late.ticketId, {
        state: 'blocked',
        summary: `the worker has run ${Math.round(late.ageSeconds / 3600)} hours in ${late.workspace} without finishing`,
        question: 'accept the work, steer it, or stop it on the panel',
      } as never)
    }
    // Replies go out before anything that waits: with every slot busy, an acknowledgement must not queue behind
    // the fleet, which is what held nine replies for ten minutes on 2026-11-08.
    outbox.flush()
    // The launches this pass queued get a bounded start, and no more. `executor.idle()` is the launch queue's
    // tail and that queue is gated on a free worker slot, so awaiting it made the loop enterable only when the
    // fleet went quiet — hourly, at 20 workers against a cap of 8. That is the stall #303 was filed for.
    enter('drain')
    const drainAt = Date.now()
    drain = await executor.drain(launchDrainMs)
    drainMs = Date.now() - drainAt
    outbox.flush()
    // The liveness line, and the only place the cadence is visible: `gapMs` is the beat, and the stages are
    // where a slow pass spent itself. One `ms=` field carried all of it, which is why the 6 h stall took six
    // hours to see and the 15 s pass took a board to notice (measured 2026-11-09).
    const finished = Date.now()
    // Superseded: the beat gave this pass up and a newer one owns the guard. Its numbers are true of itself and
    // false of the loop, so publishing them would be the silent-success shape all over again — a loop that has
    // finished nothing, logging a finished pass and writing `"state": "ok"` over its own alarm. The record that
    // it landed at all is `tick.late_finish`, in `startTick`.
    if (mine !== generation) return
    lastTickEnd = finished
    log.line('info', 'tick', {
      n: sweeps, inflight: repos.threads.active().filter(t => t.evaluating).length,
      running: executor.running, parked: executor.parked, cap: executor.capacity,
      open: repos.tickets.open().length, ms: finished - started,
      ...starvation(),
      gapMs, pollMs, reconcileMs, evaluateMs, drainMs,
      gh: ghCalls - callsAtStart, ghTotal: ghCalls,
      pullsDue: pulls.due, pullsRead: pulls.read, pullsDeferred: pulls.deferred, readsAtOnce: pulls.atOnce,
      launchPending: drain.pending, drained: drain.settled,
    })
    publishHealth(tickHealth('ok', { ms: finished - started }))
  }

  // An assignment marked running with no session in this process is a ghost: the worker died with the
  // previous router, and 'running' would block the queue forever.
  const recover = async (ticket: ReturnType<typeof repos.tickets.open>[number]): Promise<void> => {
    const assignment = ticket.assignments.at(-1)
    if (assignment?.state !== 'running') return
    try {
      // A herdr worker runs in its own process and outlives the router: take it over instead of starting another.
      const survivor = herdrWorkers ? await herdrWorkers.find(ticket.id) : undefined
      if (survivor && herdrWorkers) {
        executor.adopt(ticket, assignment, send => herdrWorkers.attach(survivor, send, { adopted: true }))
        log.line('info', 'worker.adopted', { ticket: ticket.id, agent: survivor.agent, tab: survivor.tabId })
        return
      }
      engine.assignmentInterrupted(ticket.id, assignment.id)
      // The engine keeps an assignment whose last report is settled, assuming a live session holds it;
      // after a restart nothing holds it, so the router says so on the ticket instead of pretending.
      const kept = repos.tickets.open().find(item => item.id === ticket.id)?.assignments.at(-1)
      if (kept?.state === 'running' && !executor.workers().some(w => w.ticketId === ticket.id)) {
        engine.report(ticket.id, {
          state: 'failed', summary: 'the worker did not survive the router restart; nothing is running', question: null,
        } as never)
        // Once per process, from the record: the mandate stands, so the work gets a fresh worker. A relaunch
        // loop is bounded by this loop running only at startup.
        executor.start(repos.tickets.get(ticket.id) ?? ticket, kept)
      }
    } catch (error) {
      log.line('error', 'recover.failed', { ticket: ticket.id, error: String(error).slice(0, 200) })
      console.error('superagent: recovery of', ticket.id, 'failed:', String(error).slice(0, 180))
    }
  }
  const recovered = (async () => {
    for (const ticket of repos.tickets.open()) await recover(ticket)
    const openIds = new Set(repos.tickets.open().map(t => t.id))
    const beganSweep = Date.now()
    // Ninety days: the ticket row is the engine's working set, and the issue on GitHub is the record.
    const pruned = repos.pruneClosedTickets(new Date(Date.now() - 90 * 86_400_000).toISOString())
    if (pruned) log.line('info', 'tickets.pruned', { removed: pruned, olderThanDays: 90 })
    const swept = await sweepWorktrees(cfg.worktreeRoot, openIds, cfg.keepWorktrees ?? 20)
    const homes = sweepHomes(join(cfg.dataDir, 'worker-homes'), openIds)
    if (swept.removed || swept.keptWork || homes) {
      log.line('info', 'worktree.swept', {
        ...swept, keptWorkIds: swept.keptWorkIds.slice(0, 8), seconds: Math.round((Date.now() - beganSweep) / 1000),
        kept: cfg.keepWorktrees ?? 20, homes,
        note: swept.keptWork ? 'settled checkouts with commits on no remote are never deleted' : undefined })
    }
    if (!herdrWorkers) return
    const adopted = new Set(executor.workers().map(w => w.sessionId))
    // Every tick waits on this: a herdr hiccup during the sweep must not wedge the router for its whole life.
    try {
      for (const r of await herdrWorkers.retireOrphans(adopted)) log.line('info', 'worker.retired', { ticket: r.ticketId, agent: r.agent, tab: r.tabId })
      for (const tab of await herdrWorkers.closeStaleTabs(cfg.herdrWorkspace ?? 'superagent')) log.line('info', 'worker.stale_tab_closed', { tab })
    } catch (error) {
      log.line('error', 'recover.sweep_failed', { error: String(error).slice(0, 200) })
    }
  })()

  let pollFailures = 0
  /** The GitHub source's own state, published into health.json next to the tick's. */
  let sourceHealth: { state: string; detail: string } | null = null

  // ── Tick cadence ─────────────────────────────────────────────────────────
  // Measured on the live router 2026-11-09: a 30 s timer entered 7 ticks in 6.6 h. `runTick` fired on every
  // beat, saw `ticking === true`, and folded the demand into `again` — silently, for hours, because nothing
  // logged that a pass had not finished. The pass was parked in its last await, `executor.idle()`, which is the
  // launch queue's tail, and that queue waits for a free worker slot: with 20 workers busy against a cap of 8
  // (survivors adopted at startup ignore the cap) it drains only when the fleet goes quiet, which is the hourly
  // beat. The cadence and the cost are one fault: at an hourly beat the 120 s per-pull budget is always
  // expired, so every pass paid the full 41-pull fan-out — the 6.6 s → 15.4 s climb the board tracked.
  // Three changes, each of them loud: the pass never awaits worker capacity; a pass that stops moving names the
  // stage it is parked in, in the log and in health.json, where `superagent status` fails on it; and a pass
  // that never finishes is abandoned, so a wedged `gh` call cannot own the cadence for the life of the process.
  const tickMs = cfg.tickMs ?? 30_000
  /** How long a pass may start launches. Never a wait on capacity: see above. */
  const launchDrainMs = cfg.launchDrainMs ?? Math.min(5_000, Math.max(250, Math.round(tickMs / 6)))
  const stallMs = cfg.tickStallMs ?? Math.max(2 * tickMs, 60_000)
  const stallReportMs = cfg.tickStallReportMs ?? Math.max(60_000, tickMs)
  const abandonMs = cfg.tickAbandonMs ?? Math.max(10 * tickMs, 300_000)

  /** Where the in-flight pass is, and when it got there. */
  let stage = 'idle'
  let stageAt = 0
  /** When the in-flight pass began, and when the last one finished (from process start, until it has one). */
  let tickBegan = 0
  let lastTickEnd = Date.now()
  let lastStallReport = 0
  let lastAbandonReport = 0
  const enterStage = (name: string): void => { stage = name; stageAt = Date.now() }
  // One decimal, because a stall reported as "0s" reads as nothing having happened.
  const secs = (ms: number): string => `${Math.round(ms / 100) / 10}s`

  const tickHealth = (state: 'ok' | 'error', fields: { ms?: number; detail?: string } = {}): TickHealth => {
    const at = Date.now()
    // The cause, whenever the loop can see it. Measured on the live router (2026-11-09, #303): the one run that
    // lost its beat queued a median of 12 launches a pass against a fleet of 18 workers on a cap of 8, and its
    // beat was 2,780 s; 35 runs that queued <=1 kept 30.0 s, 17 of them with the fleet over the cap. So a stall
    // is only actionable when the reader sees the backlog and the cap, and health.json is the one line a person
    // reads over a wall — `superagent status` prints it.
    const backlog = executor.pendingLaunches > 0 && executor.running >= executor.capacity
      ? `${executor.pendingLaunches} launch${executor.pendingLaunches === 1 ? '' : 'es'} queued, `
        + `${executor.running} busy against the cap of ${executor.capacity}`
      : undefined
    const base = fields.detail
      ?? (state === 'error' ? `tick stalled in ${stage} for ${secs(at - stageAt)} (pass ${secs(at - tickBegan)})` : undefined)
    const detail = base && state === 'error' && backlog ? `${base}: ${backlog}` : base
    return {
      state,
      ...(detail ? { detail: detail.slice(0, 160) } : {}),
      at: new Date(at).toISOString(),
      n: sweeps,
      ms: fields.ms ?? 0,
      intervalMs: tickMs,
      sinceLastMs: at - lastTickEnd,
      stage,
      ...(state === 'error' ? { stageMs: at - stageAt, launchPending: executor.pendingLaunches } : {}),
    }
  }
  const publishHealth = (tick?: TickHealth): void => writeHealth(cfg.dataDir, sourceHealth, tick)

  // Ticks cost 1-5 s and every settled agent asks for one: five workers settling at once used to start
  // five full GitHub polls. One runs, and the demand to run again after it is remembered.
  let ticking = false
  let again = false
  /** Which pass owns the guard. An abandoned pass that later settles must not clear the guard of the pass that
   *  replaced it, and must not report that it is the live one. */
  let generation = 0
  /**
   * Passes started and not finished. Abandoning a pass gives up its place in the guard, it does not stop the
   * pass: its awaits stay open, and a `gh` process has no timeout of its own, so a wedge that never clears — a
   * hung socket, a herdr that stopped answering — would collect one live pass, and its child processes, every
   * `abandonMs` for the life of the process. The ceiling is the point where the alarm is the whole product.
   */
  let inFlight = 0
  const maxPassesInFlight = 3
  const startTick = (): void => {
    const mine = ++generation
    const beganAt = Date.now()
    tickBegan = beganAt
    ticking = true
    inFlight += 1
    void tick(mine).finally(() => {
      inFlight -= 1
      if (mine !== generation) {
        // The pass gave up its place long ago, and the live stage belongs to whoever holds it now: report only
        // what this one knows, which is how long it took to land.
        log.line('warn', 'tick.late_finish', { runningMs: Date.now() - beganAt, supersededBy: generation, launchPending: executor.pendingLaunches })
        return
      }
      ticking = false
      if (again) { again = false; runTick() }
    })
  }
  const runTick = (): void => {
    // Measured 2026-11-08: a tick parked on worker capacity held nine replies for ten minutes, and the guard returned before this line.
    outbox.flush()
    // A router paused on purpose keeps its beat in health.json: that file is what a scheduled check reads, and a
    // loop that stops writing it is indistinguishable from a dead one (`stale_health` in scripts/superagent).
    if (paused) { publishHealth(tickHealth('ok', { detail: 'paused: the beat is running, the pass is skipped' })); return }
    if (!ticking) { startTick(); return }
    again = true
    // The timer fires while a pass is parked, which makes it the one thing that can see the stall. Before this
    // line the coalescing was invisible, and that is why six hours of a dead loop looked like a quiet board.
    const at = Date.now()
    const running = at - tickBegan
    if (running < stallMs) return
    if (running < abandonMs) {
      // One voice per phase: past the abandon deadline the wedge line below owns health.json, so the two never
      // take turns overwriting each other on consecutive beats.
      if (at - lastStallReport >= stallReportMs) {
        lastStallReport = at
        log.line('warn', 'tick.stalled', {
          stage, stageMs: at - stageAt, runningMs: running, intervalMs: tickMs, stallMs, n: sweeps,
          sinceLastMs: at - lastTickEnd, launchPending: executor.pendingLaunches, ghCalls,
          running: executor.running, cap: executor.capacity,
        })
        publishHealth(tickHealth('error'))
      }
      return
    }
    if (inFlight >= maxPassesInFlight) {
      // The passes this loop replaced are wedged in the same place, so replacing them buys nothing. Keep the
      // alarm and stop stacking work on a box shared with the workers: `superagent status` exits 2 on this and
      // says the loop is not beating, which is the fact the operator needs.
      if (at - lastAbandonReport >= stallReportMs) {
        lastAbandonReport = at
        log.line('error', 'tick.abandon_skipped', {
          stage, stageMs: at - stageAt, runningMs: running, abandonMs, passesInFlight: inFlight,
          intervalMs: tickMs, n: sweeps, launchPending: executor.pendingLaunches, ghCalls,
          running: executor.running, cap: executor.capacity,
        })
        publishHealth(tickHealth('error', { detail: `tick wedged in ${stage} for ${secs(at - stageAt)}: ${inFlight} passes in flight, the loop is not beating` }))
      }
      return
    }
    // Give the pass up and keep the beat. Awaits here are GitHub, herdr and the launch queue, and none of them
    // is allowed to own the cadence for the life of the process; the pass keeps running and reports where it
    // landed. Repeating a pass is safe by construction: trigger ids dedup, the outbox is idempotent by id, and
    // the engine's commands are the only writes.
    lastAbandonReport = at
    log.line('error', 'tick.abandoned', { stage, runningMs: running, abandonMs, passesInFlight: inFlight, n: sweeps, launchPending: executor.pendingLaunches, running: executor.running, cap: executor.capacity })
    again = false
    startTick()
  }
  /** A pass on demand: the panel, the `engine_tick` tool, a test. It takes the guard from no one. While a pass
   *  owns the guard it also runs as a superseded one, because a tick asked for by hand over a stalled loop must
   *  not move that loop's stage label, log a liveness line for a loop that has finished nothing, or write
   *  `"state": "ok"` over the alarm — the panel button is exactly what an operator reaches for in that moment. */
  const tickNow = (): Promise<void> => tick(ticking ? -1 : generation)
  const timer = setInterval(runTick, tickMs)
  const off = pi.on('agent_settled', runTick)

  // Made at startup, not at the first write: the operator reads this file to pause the fleet by hand.
  if (cfg.panelPort) panelToken(cfg.dataDir)

  const panel = cfg.panelPort
    ? createPanelServer({
      repos, engine, assessor, config: cfg,
      load: () => panelLoad(), isPaused: () => paused, workers: () => executor.workers(),
      health: () => { try { return JSON.parse(readFileSync(`${cfg.dataDir}/health.json`, 'utf8')) as Record<string, unknown> } catch { return {} } },
      log: (level, event, fields) => log.line(level, event, fields), setPaused: (v: boolean) => { paused = v },
      token: () => panelToken(cfg.dataDir),
      now: deps.now ?? (() => new Date().toISOString()),
    })
    : undefined
  // A panel that cannot bind must not take the router down: pi treats any uncaught exception as fatal
  // (`pi exiting due to uncaughtException: listen EADDRINUSE ... :8788`), so the page that shows the
  // engine's health was killing the engine. Bind the requested port, fall back to an ephemeral one, and
  // record which.
  if (panel) {
    let fallback = false
    panel.server.on('error', (error: Error) => {
      writeFileSync(join(cfg.dataDir, 'panel-error.txt'), `${new Date().toISOString()} ${error.message}\n`)
      log.line('error', 'panel.error', { port: (panel.server.address() as { port?: number } | null)?.port ?? cfg.panelPort, error: error.message })
      if (fallback) return
      fallback = true
      panel.server.listen(0, '127.0.0.1')
    })
    panel.server.on('listening', () => {
      // The pid that bound the panel, recorded for the start script: before it kills a port owner it proves the
      // owner is ours, and a router rewrites its process title, so macOS `ps` prints no command line and no
      // environment for this process. Measured 2026-11-09: `ps eww` on the live router carried no PI_SUPERAGENT
      // variable at all, so the environment test read every running router as a squatter and `restart` could not
      // start. A pid is the proof that survives a rewritten title.
      try {
        writeFileSync(join(cfg.dataDir, 'panel.pid'), `${process.pid}\n`)
        // The port a zero-config panel bound to, on the record: `superagent stop-ticket` must reach the panel,
        // and a pid and a token are useless to a caller that cannot find the door.
        writeFileSync(join(cfg.dataDir, 'panel.port'), `${(panel.server.address() as { port?: number } | null)?.port ?? cfg.panelPort}\n`)
      } catch { /* a panel that cannot record its pid still serves; `start` then falls back to its old refusal */ }
      log.line('info', 'panel.bound', { port: (panel.server.address() as { port?: number } | null)?.port ?? cfg.panelPort })
    })
    panel.server.listen(cfg.panelPort, '127.0.0.1')
  }

  const panelLoad = () => {
    const open = repos.tickets.open()
    return {
      // A session in this process is the only thing that can be running; an assignment left 'running' by a
      // dead router is not work, and counting it is how the panel hides a stall.
      running: executor.running,
      parked: executor.parked,
      queued: open.filter(t => { const a = t.assignments.at(-1); return !a || a.state === 'pending' }).length,
      maxWorkers: cfg.maxConcurrent ?? 4,
      ...starvation(),
    }
  }

  return {
    tick: tickNow, tools, engine, assessor, workers: () => executor.workers(),
    setPaused: (v: boolean) => { paused = v },
    isPaused: () => paused,
    load: panelLoad,
    stop: () => { clearInterval(timer); off(); panel?.server.close(); executor.detach() },
  }
}


/** A session is the router only when the start script says so; for every other session this is null. */
/**
 * A number the operator set, or nothing when they set nothing. Garbage fails at startup: a NaN tick
 * interval becomes a 1ms loop, a NaN worker cap silences the fleet, and neither says why.
 */
export interface SweepReport {
  removed: number
  /** Settled checkouts kept because they hold commits that exist on no remote: deleting these deletes work. */
  keptWork: number
  checkouts: number
  /** Settled workspaces with files and no checkout, and empty ones: the 43 GB is not all code. */
  bare: number
  empty: number
  /** The settled checkouts kept because their work is on no remote: named, so the operator can push them. */
  keptWorkIds: string[]
}

/** A ticket's checkout is the ticket directory itself, or `repo` inside it: both layouts are live. */
const checkoutOf = (dir: string): string | undefined =>
  existsSync(join(dir, '.git')) ? dir : existsSync(join(dir, 'repo', '.git')) ? join(dir, 'repo') : undefined

/**
 * Commits on this checkout that exist on no remote. An unreadable checkout reads as unpushed and is kept:
 * the sweep frees disk, it never frees work it could not read. Asynchronous because the synchronous version
 * held the router's event loop for 47 s on a live start (47 checkouts, measured), and the first tick waited.
 */
async function unpushedCommits(dir: string): Promise<number> {
  try {
    // An unborn HEAD (a clone of an empty repository, a checkout mid-clone) reads as unpushed and is kept.
    await runGit('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], { timeout: 10_000 })
    const { stdout } = await runGit('git', ['-C', dir, 'rev-list', '--count', 'HEAD', '--not', '--remotes'], { timeout: 10_000 })
    return Number(stdout.trim())
  } catch { return 1 }
}

/**
 * Measured live: a ticket checkout is about 570 MB, 75 of them, 43 GB, and nothing ever deleted one. Keep
 * the newest settled ones for the audit trail; delete older ones only when the work inside is on a remote.
 */
export async function sweepWorktrees(root: string, open: ReadonlySet<string>, keep: number): Promise<SweepReport> {
  const report: SweepReport = { removed: 0, keptWork: 0, checkouts: 0, bare: 0, empty: 0, keptWorkIds: [] }
  let names: string[]
  try { names = readdirSync(root) } catch { return report }
  const settled = names
    .filter(name => !open.has(name))
    .map(name => { try { return { name, at: statSync(join(root, name)).mtimeMs } } catch { return null } })
    .filter((e): e is { name: string; at: number } => e !== null)
    .sort((a, b) => b.at - a.at)
  for (const [index, entry] of settled.entries()) {
    const dir = join(root, entry.name)
    const checkout = checkoutOf(dir)
    if (index < keep) { if (checkout) report.checkouts++; continue }
    if (!checkout) {
      if (readdirSync(dir).length === 0) report.empty++; else report.bare++
    }
    if (checkout && await unpushedCommits(checkout) > 0) { report.keptWork++; report.keptWorkIds.push(entry.name); continue }
    try { rmSync(dir, { recursive: true, force: true }); report.removed++ } catch { /* a busy checkout lives to the next start */ }
  }
  return report
}

/** Each worker gets a HOME under the state directory: configuration skeletons, a few KB, and one per ticket forever. */
export function sweepHomes(root: string, open: ReadonlySet<string>): number {
  let names: string[]
  try { names = readdirSync(root) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (open.has(name)) continue
    try { rmSync(join(root, name), { recursive: true, force: true }); removed++ } catch { /* in use: the next start tries again */ }
  }
  return removed
}

/** Read at every launch, so a rotated token lands on the next worker without a router restart. */
function workerToken(file: string, warn: (event: string, fields: Record<string, unknown>) => void): string | undefined {
  try {
    const token = readFileSync(file, 'utf8').trim()
    if (!token) throw new Error('empty')
    return token
  } catch (error) {
    warn('worker.token_unreadable', { file, error: String(error).slice(0, 120) })
    return undefined
  }
}

/** The panel's POST secret, made once per state directory: pause and stop are writes, and localhost is not a credential. */
/**
 * Tickets to retire because the thread already has an older ticket with a live worker.
 *
 * Measured 2026-11-10 on issue 145: ticket 7db2a21c's assignment ended at 08:35, a new trigger opened ticket
 * 69548839 at 08:36 (both correct), and at 16:44 a trigger re-dispatched the OLD ticket while the new one was
 * already running. Two open tickets, one issue, two agents in two work dirs, both publishing pull requests.
 *
 * An intake filter cannot fix this: a thread legitimately carries several open tickets over its life, and
 * triggers for a live thread are how a human's answer and follow-ups reach the running worker. Proven by
 * extension.spec.ts: refusing triggers killed both the answer-restart and the follow-up path.
 *
 * The invariant lives at dispatch: at most one ticket per thread may have a live worker. Earliest worker wins,
 * ties break on id, so the sweep does not move under a rerun.
 */
export function duplicateLiveTickets(
  open: readonly Ticket[],
  liveWorkers: readonly { ticketId?: string }[],
): string[] {
  const live = new Set(liveWorkers.map(w => w.ticketId).filter(Boolean) as string[])
  const started = (t: Ticket): string =>
    t.assignments[t.assignments.length - 1]?.startedAt ?? t.createdAt
  const byThread = new Map<string, Ticket[]>()
  for (const t of open) {
    if (!live.has(t.id)) continue
    for (const c of t.channels) {
      const list = byThread.get(c.thread) ?? []
      list.push(t)
      byThread.set(c.thread, list)
    }
  }
  const stop = new Set<string>()
  for (const list of byThread.values()) {
    if (list.length < 2) continue
    const keep = [...list].sort((a, b) => (started(a) < started(b) ? -1 : started(a) > started(b) ? 1 : a.id < b.id ? -1 : 1))[0]!
    for (const t of list) if (t.id !== keep.id) stop.add(t.id)
  }
  return [...stop]
}

export function panelToken(dataDir: string): string {
  const file = join(dataDir, 'panel-token')
  try { const seen = readFileSync(file, 'utf8').trim(); if (seen) return seen } catch { /* the first start makes it */ }
  const secret = createHash('sha256').update(`${randomUUID()}:${Date.now()}`).digest('hex').slice(0, 32)
  writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

function positiveNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`)
  return value
}

export function configFrom(env: NodeJS.ProcessEnv): RouterConfig | null {
  if (env.PI_SUPERAGENT_ROLE !== 'router') return null
  const dataDir = env.PI_SUPERAGENT_STATE
  if (!dataDir) throw new Error('PI_SUPERAGENT_STATE is required for role=router')
  const maxWorkers = positiveNumber('PI_SUPERAGENT_MAX_WORKERS', env.PI_SUPERAGENT_MAX_WORKERS)
  const tickMs = positiveNumber('PI_SUPERAGENT_TICK_MS', env.PI_SUPERAGENT_TICK_MS)
  const launchDrainMs = positiveNumber('PI_SUPERAGENT_LAUNCH_DRAIN_MS', env.PI_SUPERAGENT_LAUNCH_DRAIN_MS)
  const tickStallMs = positiveNumber('PI_SUPERAGENT_TICK_STALL_MS', env.PI_SUPERAGENT_TICK_STALL_MS)
  const tickStallReportMs = positiveNumber('PI_SUPERAGENT_TICK_STALL_REPORT_MS', env.PI_SUPERAGENT_TICK_STALL_REPORT_MS)
  const tickAbandonMs = positiveNumber('PI_SUPERAGENT_TICK_ABANDON_MS', env.PI_SUPERAGENT_TICK_ABANDON_MS)
  const pullReadsPerTick = positiveNumber('PI_SUPERAGENT_PULL_READS_PER_TICK', env.PI_SUPERAGENT_PULL_READS_PER_TICK)
  const pullReadBudgetMs = positiveNumber('PI_SUPERAGENT_PULL_READ_BUDGET_MS', env.PI_SUPERAGENT_PULL_READ_BUDGET_MS)
  const panelPort = positiveNumber('PI_SUPERAGENT_PANEL_PORT', env.PI_SUPERAGENT_PANEL_PORT)
  const keepWorktrees = positiveNumber('PI_SUPERAGENT_KEEP_WORKTREES', env.PI_SUPERAGENT_KEEP_WORKTREES)
  const workerTokenFile = env.PI_SUPERAGENT_WORKER_TOKEN_FILE?.trim()
  const workerQuietMinutes = positiveNumber('PI_SUPERAGENT_WORKER_QUIET_MINUTES', env.PI_SUPERAGENT_WORKER_QUIET_MINUTES)
  const deadlineHours = positiveNumber('PI_SUPERAGENT_WORKER_DEADLINE_HOURS', env.PI_SUPERAGENT_WORKER_DEADLINE_HOURS)
  const reportCap = positiveNumber('PI_SUPERAGENT_REPORT_CAP', env.PI_SUPERAGENT_REPORT_CAP)
  return {
    dataDir, worktreeRoot: env.PI_SUPERAGENT_WORKTREES ?? `${dataDir}/work`,
    self: env.PI_SUPERAGENT_SELF ?? 'pi-superagent',
    ...(maxWorkers === undefined ? {} : { maxConcurrent: maxWorkers }),
    ...(tickMs === undefined ? {} : { tickMs }),
    ...(launchDrainMs === undefined ? {} : { launchDrainMs }),
    ...(tickStallMs === undefined ? {} : { tickStallMs }),
    ...(tickStallReportMs === undefined ? {} : { tickStallReportMs }),
    ...(tickAbandonMs === undefined ? {} : { tickAbandonMs }),
    ...(pullReadsPerTick === undefined ? {} : { pullReadsPerTick: Math.floor(pullReadsPerTick) }),
    ...(pullReadBudgetMs === undefined ? {} : { pullReadBudgetMs }),
    ...(panelPort === undefined ? {} : { panelPort }),
    ...(keepWorktrees === undefined ? {} : { keepWorktrees: Math.floor(keepWorktrees) }),
    ...(workerTokenFile ? { workerTokenFile } : {}),
    ...(workerQuietMinutes === undefined ? {} : { workerQuietMinutes }),
    ...(deadlineHours === undefined ? {} : { workerDeadlineHours: deadlineHours }),
    ...(reportCap === undefined ? {} : { reportCap: Math.floor(reportCap) }),
    ...(env.PI_SUPERAGENT_KEEP_ISSUES_OPEN === '1' ? { keepIssuesOpen: true } : {}),
    ...(env.PI_SUPERAGENT_WATCH_REPO_ASKS === '1' ? { watchRepoIsAsks: true } : {}),
    bots: new Set((env.PI_SUPERAGENT_BOTS ?? 'pi-*,fleet-*').split(',').map(s => s.trim()).filter(Boolean)),
    ...(env.PI_SUPERAGENT_PREPARE ? { prepare: env.PI_SUPERAGENT_PREPARE } : {}),
    ...(env.PI_SUPERAGENT_BLOCKED ? { blockedCommands: env.PI_SUPERAGENT_BLOCKED.split(',').map(s => s.trim()).filter(Boolean) } : {}),
    ...(env.PI_SUPERAGENT_ALLOW_DELEGATION === '1' ? { allowDelegation: true } : {}),
    ...(env.PI_SUPERAGENT_SDK_PATH ? { sdkPath: env.PI_SUPERAGENT_SDK_PATH } : {}),
    // Workers always run in herdr tabs; the in-process path is for tests.
    workers: 'herdr',
    ...(env.PI_SUPERAGENT_HERDR_BIN ? { herdrBin: env.PI_SUPERAGENT_HERDR_BIN } : {}),
    ...(env.PI_SUPERAGENT_HERDR_WORKSPACE ? { herdrWorkspace: env.PI_SUPERAGENT_HERDR_WORKSPACE } : {}),
    ...(env.PI_SUPERAGENT_JUDGE_THINKING ? { judgeThinking: env.PI_SUPERAGENT_JUDGE_THINKING } : {}),
    // githubSelf has no default: when the operator and the agent share an account, the reply marker
    // identifies the agent, and naming the shared account here would drop every comment the operator writes.
    ...(env.PI_SUPERAGENT_GITHUB_REPO ? { githubRepo: env.PI_SUPERAGENT_GITHUB_REPO } : {}),
    ...(env.PI_SUPERAGENT_GITHUB_SELF ? { githubSelf: env.PI_SUPERAGENT_GITHUB_SELF } : {}),
    ...(env.PI_SUPERAGENT_GITHUB_TOKEN_FILE ? { githubTokenFile: env.PI_SUPERAGENT_GITHUB_TOKEN_FILE } : {}),
    // Checkouts outside the worktree root that this deployment reads: the board's checkout, the checkout the
    // router runs from. The credential guard scans them; ':' and ',' both separate, so config.env and a shell
    // prefix take the same value.
    ...(env.PI_SUPERAGENT_WATCHED_CHECKOUTS?.trim() ? { watchedCheckouts: env.PI_SUPERAGENT_WATCHED_CHECKOUTS.split(/[,:]/).map(s => s.trim()).filter(Boolean) } : {}),
    ...(env.PI_SUPERAGENT_ALLOWED?.trim() ? { allowed: new Set(env.PI_SUPERAGENT_ALLOWED.split(',').map(s => s.trim()).filter(Boolean)) } : {}),
  }
}

const ACTIVE = Symbol.for('pi-superagent.router')
type HostWithRouter = typeof globalThis & { [ACTIVE]?: boolean }

/** Why this load must not start a router, or null when it is the appointed one. */
export function activationRefusal(env: NodeJS.ProcessEnv, argv: readonly string[], routerActive: boolean): string | null {
  // The judge and every worker are sessions in this process: they load this extension and see this
  // environment, and each one used to boot another router that started more sessions.
  if (routerActive) return 'a router is already running in this process'
  // A pi that a worker runs from its shell inherits the environment, but not the start script's command line.
  const appointed = env.PI_SUPERAGENT_SESSION_ID
  if (appointed && !argv.includes(appointed)) return 'not the process the start script launched'
  return null
}

export default function superagent(pi: PiLike): void {
  if (workerRole(pi as never, process.env)) return
  const config = configFrom(process.env)
  if (!config) return
  const host = globalThis as HostWithRouter
  const refusal = activationRefusal(process.env, process.argv, host[ACTIVE] === true)
  if (refusal) {
    openLog(config.dataDir).line('info', 'router.inert', { reason: refusal, pid: process.pid })
    return
  }
  host[ACTIVE] = true
  let running: RunningRouter
  try {
    running = createRouterExtension(pi, { config })
  } catch (error) {
    host[ACTIVE] = false
    throw error
  }
  // The router's own checkout is a watched checkout too: its .git/config is one `git remote -v` away from a
  // worker transcript, and it is where a deploy-time credential gets baked when someone "just" fixes a push.
  const checkouts = [...(config.watchedCheckouts ?? []), resolve(import.meta.dirname, '..')]
  const problems = setupProblems({ root: config.worktreeRoot, stateDir: config.dataDir, checkouts })
  writeFileSync(`${config.dataDir}/setup.json`, JSON.stringify({ problem: problems[0] ?? null, problems, at: new Date().toISOString() }))
  writeHealth(config.dataDir, null)
  // `ready` is what `superagent start` waits for: a session that has booted is not yet a router that
  // listens, and the health check must not report 0 between the two.
  writeFileSync(`${config.dataDir}/ready`, JSON.stringify({ at: new Date().toISOString(), githubRepo: config.githubRepo ?? null }))
  // pi emits this before /reload loads the new copy, so the reloaded router may claim the process again.
  pi.on('session_shutdown', () => {
    running.stop()
    host[ACTIVE] = false
    rmSync(`${config.dataDir}/ready`, { force: true })
  })
}

export type { RouterConfig }
export { type SessionPilot, type Candidate, type SdkSurface }
