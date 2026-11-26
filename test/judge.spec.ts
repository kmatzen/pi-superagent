import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openJudge } from '../src/pi/judge.ts'
import { openLog } from '../src/pi/log.ts'
import type { SdkSurface } from '../src/pi/router.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pi-judge-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

interface FakeSession {
  sessionId: string
  prompts: string[]
  disposed: boolean
  emit: (type: string) => void
  [key: string]: unknown
}

/** A judge session that answers what it is told to: `starts` decides whether a prompt ever becomes a run. */
function fakeSdk(over: { starts?: boolean; hangs?: boolean } = {}) {
  const sessions: FakeSession[] = []
  const sdk = {
    createAgentSession: async () => {
      if (over.hangs) return new Promise<{ session: never }>(() => {})
      const listeners: Array<(event: { type: string }) => void> = []
      const session: FakeSession = {
        sessionId: `judge-${sessions.length + 1}`, prompts: [], disposed: false,
        prompt: async (text: string) => {
          session.prompts.push(text)
          if (over.starts) for (const l of listeners) l({ type: 'agent_start' })
        },
        subscribe: (l: (event: { type: string }) => void) => { listeners.push(l); return () => {} },
        abort: () => {},
        dispose: () => { session.disposed = true },
        emit: (type: string) => { for (const l of listeners) l({ type }) },
      }
      sessions.push(session)
      return { session: session as never }
    },
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    getAgentDir: () => '/tmp',
  } as unknown as SdkSurface
  return { sdk, sessions }
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20))
const until = async (ok: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5))
}
const logOf = (dir: string) => readFileSync(join(dir, 'engine.log'), 'utf8')

describe('the judge readiness probe', () => {
  it('a session that takes a prompt and starts no run fails the probe and is fed nothing more', async () => {
    // The wedge of 2026-11-25 (agent-inbox#1022): 182 prompts, 80 runs. The prompts were accepted, the runs
    // were not coming, and the engine kept feeding the session for 47 minutes because nothing could tell.
    const dir = tmp()
    const { sdk, sessions } = fakeSdk({ starts: false })
    const unready: string[] = []
    const judge = await openJudge(sdk, { cwd: dir, tools: [], log: openLog(dir), readyTimeoutMs: 30, onUnready: r => unready.push(r) })
    judge.prompt('Assess eval e1')
    await until(() => unready.length > 0)
    expect(unready, 'no run within the probe window names the reason').toHaveLength(1)
    expect(judge.wedged).toBe(true)
    expect(judge.ready).toBe(false)
    judge.prompt('Assess eval e2')
    judge.prompt('Assess eval e3')
    expect(sessions[0]!.prompts, 'a wedged session is fed nothing more').toEqual(['Assess eval e1'])
    expect(logOf(dir)).toMatch(/judge\.unready session=judge-1 ms=30 prompts=1/)
    expect(logOf(dir)).toMatch(/judge\.prompt_refused session=judge-1/)
  })

  it('a session that starts a run passes the probe, and a slow first turn is not a wedge', async () => {
    const dir = tmp()
    const { sdk, sessions } = fakeSdk({ starts: true })
    const unready: string[] = []
    const judge = await openJudge(sdk, { cwd: dir, tools: [], log: openLog(dir), readyTimeoutMs: 50, onUnready: r => unready.push(r) })
    judge.prompt('Assess eval e1')
    await settle()
    judge.prompt('Assess eval e2')
    await settle()
    expect(unready, 'a run answers the probe, so the window never fires').toEqual([])
    expect(judge.ready).toBe(true)
    expect(sessions[0]!.prompts).toEqual(['Assess eval e1', 'Assess eval e2'])
    expect(logOf(dir)).toMatch(/judge\.ready session=judge-1/)
  })

  it('an open that never answers is a failed open, not a judge that owns the process for its life', async () => {
    // `createAgentSession` is an await on the engine's own startup path: unbounded, one hung open parked every
    // eval in a queue nothing drained, which is the shape of the 47-minute stall.
    const dir = tmp()
    const { sdk } = fakeSdk({ hangs: true })
    await expect(openJudge(sdk, { cwd: dir, tools: [], log: openLog(dir), readyTimeoutMs: 25 }))
      .rejects.toThrow(/createAgentSession did not answer in 25 ms/)
  })

  it('dispose ends the probe, so a reaped session cannot report itself wedged afterwards', async () => {
    const dir = tmp()
    const { sdk, sessions } = fakeSdk({ starts: false })
    const unready: string[] = []
    const judge = await openJudge(sdk, { cwd: dir, tools: [], log: openLog(dir), readyTimeoutMs: 25, onUnready: r => unready.push(r) })
    judge.prompt('Assess eval e1')
    judge.dispose()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(sessions[0]!.disposed).toBe(true)
    expect(unready, 'the probe died with the session it was watching').toEqual([])
  })
})
