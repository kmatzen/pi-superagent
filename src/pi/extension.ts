/** The package entry point: the router in the session the start script launches, the worker role inside a
 *  worker, and inert everywhere else. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Engine, type AssessmentOutcome, type Assessor, type Candidate, type OutboundMessage, type Policy, type Ticket, type Trigger } from '../core/index.ts'
import { SqliteRepositories } from './store.ts'
import { SessionInbox } from './sink-session-inbox.ts'
import { GithubSource, REPLY_MARKER, type GithubApi } from './source-github.ts'
import { ghApi, ghPulls } from './gh-api.ts'
import { parsePull, parseThread, pullUrl, PullFollower, threadOfPull, type PullApi } from './pulls.ts'
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
import { workerRole } from './worker-role.ts'
import { createPanelServer } from './server.ts'
import { checkoutRepository, guardExtension, prepareWorkspace, setupProblems } from './workspace.ts'
import { briefFor, ghAccounts, loadSdk, policyOf, pullBrief, scopeOf, type RouterConfig, type SdkSurface } from './router.ts'

export interface PiLike {
  registerTool(tool: RegisteredTool): void
  sendUserMessage(text: string, options?: { deliverAs?: 'text' | 'prompt' }): void
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
  load(): { running: number; parked: number; queued: number; maxWorkers: number }
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

/** `superagent status` greps health.json for "state": "error"; the router rewrites it as the GitHub source
 *  fails and recovers. */
function writeHealth(dir: string, source: { state: string; detail?: string } | null): void {
  writeFileSync(`${dir}/health.json`, JSON.stringify({
    runtime: { state: 'ready', at: new Date().toISOString() },
    ...(source ? { source } : {}),
  }, null, 2))
}

export function createRouterExtension(pi: PiLike, deps: ExtensionDeps): RunningRouter {
  const cfg = deps.config
  const repos = new SqliteRepositories(`${cfg.dataDir}/tickets.db`)
  const log = openLog(cfg.dataDir)
  // The router owns health.json from its first moment: a router that has not polled yet is ready, and the
  // health check must find a file, not an absence.
  writeHealth(cfg.dataDir, null)
  log.line('info', 'router.start', {
    dataDir: cfg.dataDir, panelPort: cfg.panelPort ?? 0,
    sdkPath: cfg.sdkPath ?? 'package-name', githubRepo: cfg.githubRepo ?? '',
    githubAs: cfg.githubTokenFile ? 'token file' : 'gh login',
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
        // GitHub may have taken the last attempt before the process died: on a retry, look first.
        const seen = retry && githubApi.commentsFor ? await githubApi.commentsFor(issue, repo) : []
        if (seen.some(c => c.body.trimEnd() === `${body}\n\n${REPLY_MARKER}`)) return
        await githubApi.postComment(issue, body, repo)
      } catch (error) {
        log.line('warn', 'outbox.github_failed', { issue, repo, error: String(error).slice(0, 200) })
        throw error
      }
    },
  }, repos.kv, () => Date.now(), 12,
     (m, tries, error) => log.line('error', 'outbox.given_up', { thread: m.channel.thread, tries, error }))
  const accounts = ghAccounts(cfg)
  const githubApi = deps.githubApi ?? (cfg.githubRepo ? ghApi({ repo: cfg.githubRepo, ...accounts.watched }) : undefined)
  const github = githubApi
    ? new GithubSource(githubApi, { repo: cfg.githubRepo ?? '', self: cfg.githubSelf ?? cfg.self, bots: cfg.bots }, repos.kv)
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
      for (const body of judgeQueue.splice(0)) pi.sendUserMessage(body, { deliverAs: 'text' })
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
        pi.sendUserMessage(body, { deliverAs: 'text' })
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
  const reported = (ticket: Ticket, assignmentId: string, origin: ReportOrigin, run: ReportedRun): void => {
    let fresh = false
    if (origin === 'crash' && !relaunched.has(ticket.id)) {
      relaunched.add(ticket.id)
      try {
        engine.retryTicket(ticket.id)
        fresh = true
        log.line('info', 'worker.relaunched', { ticket: ticket.id, after: assignmentId })
      } catch (error) {
        log.line('warn', 'worker.relaunch_failed', { ticket: ticket.id, error: String(error).slice(0, 200) })
      }
    }
    announce(ticket, assignmentId, origin, run, fresh)
    pullEnded(ticket.id)
  }
  const home = cfg.githubRepo ?? ''
  // The engine ends a ticket with its pull request but posts nothing, so the issue hears it here, once per ticket.
  const pullEnded = (ticketId: string): void => {
    const ticket = repos.tickets.get(ticketId)
    const outcome = ticket?.ended?.outcome
    const channel = ticket?.channels[0]
    if (!ticket || !channel || ticket.ended?.by !== 'executor' || (outcome !== 'merged' && outcome !== 'closed')) return
    const pulls = (ticket.follows ?? []).filter(f => f.own && f.closed)
      .flatMap(f => { const pull = parseThread(f.thread.replace(/^github:/, ''), home); return pull ? [pullUrl(pull)] : [] })
    outbox.send({ id: `pull-end:${ticket.id}`, channel, kind: 'notice', ticketId: ticket.id, text: pullEndText(channel.thread, outcome, pulls) })
  }
  const follower = new PullFollower({
    home, api: deps.pullApi ?? ghPulls(accounts.pulls), openThreads: () => github?.openThreads(), positions: repos.kv,
    self: cfg.githubSelf ?? cfg.self, bots: cfg.bots, now: () => Date.now(),
    receive: trigger => { engine.receive(trigger) },
    warn: (event, fields) => log.line('warn', event, fields),
    closed: (thread, pull, outcome, at) => {
      const key = `github:${thread.id}`
      const waiting = repos.tickets.open().filter(t => t.follows?.some(f => f.thread === key && !f.closed)).map(t => t.id)
      engine.threadClosed(thread, outcome, at)
      log.line('info', 'pull.closed', { thread: thread.id, outcome, url: pullUrl(pull), tickets: waiting.length })
      for (const id of waiting) pullEnded(id)
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
      const workspace = prepareWorkspace({
        root: cfg.worktreeRoot, ticketId: ticket.id, stateDir: cfg.dataDir,
        ...(cfg.prepare ? { prepare: cfg.prepare } : {}),
        ...(cfg.blockedCommands ? { blockedCommands: cfg.blockedCommands } : {}),
      })
      if (cfg.githubRepo && !cfg.prepare) await checkoutRepository(workspace, cfg.githubRepo, ticket.id)
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
      // Without gh the worker cannot open a pull request, so it is not asked to.
      const pulls = cfg.blockedCommands?.includes('gh') ? '' : `\n${pullBrief(issue && repo ? `${repo}#${issue}` : undefined)}`
      if (!issue || !repo) return brief + pulls
      // A comment the worker posts itself carries no reply footer, so the router would read it as the
      // operator asking again on this thread.
      return `${brief}\nThe request is GitHub issue ${repo}#${issue}: read it with \`gh issue view ${issue} --repo ${repo} --comments\`. `
        + 'Do not comment on the issue yourself; ticket_report is how your result reaches it.' + pulls
    },
    renderInput: input => input.kind === 'trigger'
      ? (repos.triggers.get(input.triggerId) ? `${repos.triggers.get(input.triggerId)!.actor.id}: ${repos.triggers.get(input.triggerId)!.text}` : undefined)
      // A text Input is the operator's own words: rendering it as `[text]` would deliver the literal
      // string to the worker and mark the answer read.
      : input.kind === 'text' ? input.text : `[${input.kind}]`,
    inbox: new SessionInbox(`${cfg.dataDir}/inbox`),
    reported,
    follow,
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
      execute: async () => { await tick(); return text(paused ? 'paused: tick skipped' : 'tick done') },
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

  async function tick(): Promise<void> {
    if (paused) return
    await recovered
    const started = Date.now()
    let triggers: Trigger[] = []
    if (github) {
      // A failing poll is not a quiet tick: a router that cannot hear GitHub looks healthy forever, so three
      // failures in a row go into health.json, where `superagent status` turns them into exit code 2.
      try {
        triggers = await github.poll()
      } catch (error) {
        pollFailures += 1
        log.line('error', 'github.poll_failed', { error: String(error).slice(0, 200), failures: pollFailures })
        if (pollFailures >= 3) writeHealth(cfg.dataDir, { state: 'error', detail: `github polls failing (${pollFailures}): ${String(error).slice(0, 160)}` })
        return
      }
      if (pollFailures) { pollFailures = 0; writeHealth(cfg.dataDir, null) }
    }
    for (const trigger of triggers) engine.receive(trigger)
    try {
      await follower.reconcile(repos.tickets.open())
    } catch (error) {
      // The rest of the pass still runs: judgements, launches and replies must not wait on one pull request.
      log.line('error', 'pull.reconcile_failed', { error: String(error).slice(0, 200) })
    }
    // The conversation a ticket lives in can end on GitHub: a merge closes the issue it names, and
    // closing without merging is a person saying no. Either way the ticket stops and says so, unless it
    // follows its own pull request, whose close ends it (above).
    const openThreads = github?.openThreads()
    if (openThreads) {
      for (const ticket of repos.tickets.open()) {
        const channel = ticket.channels[0]
        if (!channel || channel.source !== 'github' || !channel.thread.startsWith('#') || openThreads.has(channel.thread)) continue
        // A merge closes the issue it names: the ticket ends with its pull request once the work finishes, not as a stop.
        if (ticket.follows?.some(f => f.own && f.closed)) continue
        try {
          engine.stopTicket(ticket.id, 'the conversation closed on GitHub')
          outbox.send({
            id: `closed:${ticket.id}`,
            channel,
            kind: 'notice', ticketId: ticket.id,
            text: 'Stopped: this conversation closed on GitHub. Reopen it to run the request again.',
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
    engine.evaluateDue()
    log.line('info', 'tick', {
      n: sweeps, inflight: repos.threads.active().filter(t => t.evaluating).length,
      running: executor.running, parked: executor.parked, open: repos.tickets.open().length, ms: Date.now() - started,
    })
    for (const ticket of repos.tickets.open()) {
      const assignment = ticket.assignments.at(-1)
      if (assignment && assignment.state === 'pending') executor.start(ticket, assignment)
    }
    // A worker quiet for 15 minutes gets a question on the panel, not the issue: a long build is not news.
    for (const quiet of executor.quiet(cfg.workerQuietMinutes ?? 15)) {
      engine.report(quiet.ticketId, {
        state: 'blocked',
        summary: `the worker sent no event for ${Math.round(quiet.quietSeconds / 60)} minutes in ${quiet.workspace}`,
        question: 'steer it, stop it, or accept the work it has done',
      } as never)
    }
    // Replies go out before the wait on worker capacity: with every slot busy, idle() resolves only when a
    // worker ends, and an acknowledgement must not wait an hour behind it.
    outbox.flush()
    await executor.idle()
    outbox.flush()
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
  const timer = setInterval(() => { void tick() }, cfg.tickMs ?? 30_000)
  const off = pi.on('agent_settled', () => { void tick() })

  const panel = cfg.panelPort
    ? createPanelServer({
      repos, engine, assessor, config: cfg,
      load: () => panelLoad(), isPaused: () => paused, workers: () => executor.workers(),
      log: (level, event, fields) => log.line(level, event, fields), setPaused: (v: boolean) => { paused = v },
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
    panel.server.on('listening', () => log.line('info', 'panel.bound', { port: (panel.server.address() as { port?: number } | null)?.port ?? cfg.panelPort }))
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
    }
  }

  return {
    tick, tools, engine, assessor, workers: () => executor.workers(),
    setPaused: (v: boolean) => { paused = v },
    isPaused: () => paused,
    load: panelLoad,
    stop: () => { clearInterval(timer); off(); panel?.server.close(); executor.detach() },
  }
}


/** A session is the router only when the start script says so; for every other session this is null. */
export function configFrom(env: NodeJS.ProcessEnv): RouterConfig | null {
  if (env.PI_SUPERAGENT_ROLE !== 'router') return null
  const dataDir = env.PI_SUPERAGENT_STATE
  if (!dataDir) throw new Error('PI_SUPERAGENT_STATE is required for role=router')
  return {
    dataDir, worktreeRoot: env.PI_SUPERAGENT_WORKTREES ?? `${dataDir}/work`,
    self: env.PI_SUPERAGENT_SELF ?? 'pi-superagent',
    bots: new Set((env.PI_SUPERAGENT_BOTS ?? 'pi-*,fleet-*').split(',').map(s => s.trim()).filter(Boolean)),
    ...(env.PI_SUPERAGENT_MAX_WORKERS ? { maxConcurrent: Number(env.PI_SUPERAGENT_MAX_WORKERS) } : {}),
    ...(env.PI_SUPERAGENT_TICK_MS ? { tickMs: Number(env.PI_SUPERAGENT_TICK_MS) } : {}),
    ...(env.PI_SUPERAGENT_PANEL_PORT ? { panelPort: Number(env.PI_SUPERAGENT_PANEL_PORT) } : {}),
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
  const problems = setupProblems({ root: config.worktreeRoot, stateDir: config.dataDir })
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
