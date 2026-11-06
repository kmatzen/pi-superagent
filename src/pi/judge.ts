/** Judging used to run in the operator's own pane, so the pane looked wedged for every model turn; this is the headless judge instead. */
import type { SdkSurface } from './router.ts'
import type { EngineLog } from './log.ts'

export interface Judge {
  readonly sessionId: string
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
}

export async function openJudge(sdk: SdkSurface, options: JudgeOptions): Promise<Judge> {
  const started = Date.now()
  // The candidate is the whole input; discovered extensions would load this package into the judge again.
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: options.cwd, agentDir: sdk.getAgentDir(),
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
  })
  await resourceLoader.reload()
  const { session } = await sdk.createAgentSession({
    cwd: options.cwd,
    sessionManager: sdk.SessionManager.inMemory(options.cwd),
    resourceLoader,
    customTools: options.tools,
    tools: ['ticket_decide'],
    thinkingLevel: (options.thinking ?? 'low') as never,
  })
  options.log.line('info', 'judge.opened', { session: session.sessionId, ms: Date.now() - started })
  let run: number | null = null
  session.subscribe(event => {
    if (event.type === 'agent_start') run = Date.now()
    if (event.type === 'agent_end') {
      options.log.line('info', 'judge.run_end', { ms: run ? Date.now() - run : -1 })
      run = null
    }
    if (event.type === 'agent_settled') {
      options.log.line('info', 'judge.settled')
      options.onSettled?.()
    }
  })
  return {
    sessionId: session.sessionId,
    prompt: body => {
      options.log.line('info', 'judge.prompt', { bytes: body.length })
      // The next candidate is sent from inside the previous answer's tool call, mid-turn, so it must queue.
      session.prompt(body, { streamingBehavior: 'followUp' })
        .catch((error: unknown) => options.log.line('error', 'judge.prompt_failed', { error: String(error).slice(0, 200) }))
    },
    dispose: () => session.dispose(),
  }
}
