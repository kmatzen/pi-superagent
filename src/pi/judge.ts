/** The judge: a headless pi session that answers each candidate with `ticket_decide`. Judging once ran in
 *  the operator's own pane, which froze for every model turn. */
import type { SdkSurface } from './router.ts'
import type { EngineLog } from './log.ts'

export interface Judge {
  readonly sessionId: string
  /** True once a delivered prompt produced a run; the readiness probe's whole verdict. */
  readonly ready: boolean
  /** The probe gave up: feed this session nothing more, and reap it. */
  readonly wedged: boolean
  prompt(text: string): void
  dispose(): void
}

export interface JudgeOptions {
  cwd: string
  tools: unknown[]
  thinking?: string
  log: EngineLog
  /** pi will not continue on its own: any judgement still unanswered will not be answered by this turn. */
  onSettled?: () => void
  /** The bound on opening and on the first run: 47 min of prompts accepted with no run (agent-inbox#1022). */
  readyTimeoutMs?: number
  /** The probe failed: a prompt, and no run within `readyTimeoutMs`. */
  onUnready?: (reason: string) => void
  onActivity?: (what: 'prompt' | 'run_end' | 'settled') => void
}

/** One bounded await: a promise that answers nothing must not own the judge's life. */
const within = <T>(what: string, ms: number, work: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms)
    timer.unref?.()
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })

export async function openJudge(sdk: SdkSurface, options: JudgeOptions): Promise<Judge> {
  const started = Date.now()
  const limit = options.readyTimeoutMs ?? 120_000
  // The candidate is the whole input; discovered extensions would load this package into the judge again.
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: options.cwd, agentDir: sdk.getAgentDir(),
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
  })
  await within('the judge resource loader', limit, resourceLoader.reload())
  const { session } = await within('createAgentSession', limit, sdk.createAgentSession({
    cwd: options.cwd,
    sessionManager: sdk.SessionManager.inMemory(options.cwd),
    resourceLoader,
    customTools: options.tools,
    tools: ['ticket_decide'],
    thinkingLevel: (options.thinking ?? 'low') as never,
  }))
  options.log.line('info', 'judge.opened', { session: session.sessionId, ms: Date.now() - started })
  let run: number | null = null
  let ready = false
  let wedged = false
  let prompts = 0
  let probe: NodeJS.Timeout | undefined
  const stopProbe = (): void => { if (probe) { clearTimeout(probe); probe = undefined } }
  // The first run is the only readiness a headless session proves without spending a turn on a dummy prompt.
  const armProbe = (): void => {
    if (ready || wedged || probe) return
    probe = setTimeout(() => {
      probe = undefined
      if (ready || wedged) return
      wedged = true
      options.log.line('error', 'judge.unready', { session: session.sessionId, ms: limit, prompts })
      options.onUnready?.(`no run within ${limit} ms of its first prompt (${prompts} prompt(s) delivered)`)
    }, limit)
    probe.unref?.()
  }
  session.subscribe(event => {
    if (event.type === 'agent_start') {
      run = Date.now()
      if (!ready) {
        ready = true
        stopProbe()
        options.log.line('info', 'judge.ready', { session: session.sessionId, ms: Date.now() - started })
      }
    }
    if (event.type === 'agent_end') {
      options.log.line('info', 'judge.run_end', { ms: run ? Date.now() - run : -1 })
      run = null
      options.onActivity?.('run_end')
    }
    if (event.type === 'agent_settled') {
      options.log.line('info', 'judge.settled')
      options.onActivity?.('settled')
      options.onSettled?.()
    }
  })
  return {
    sessionId: session.sessionId,
    get ready() { return ready },
    get wedged() { return wedged },
    prompt: body => {
      // The session failed its probe: the eval it was for goes back to the engine, not into a wedged queue.
      if (wedged) {
        options.log.line('warn', 'judge.prompt_refused', { session: session.sessionId, bytes: body.length })
        return
      }
      options.log.line('info', 'judge.prompt', { bytes: body.length })
      prompts += 1
      options.onActivity?.('prompt')
      armProbe()
      // The next candidate is sent from inside the previous answer's tool call, mid-turn, so it must queue.
      session.prompt(body, { streamingBehavior: 'followUp' })
        .catch((error: unknown) => options.log.line('error', 'judge.prompt_failed', { error: String(error).slice(0, 200) }))
    },
    dispose: () => { stopProbe(); session.dispose() },
  }
}
