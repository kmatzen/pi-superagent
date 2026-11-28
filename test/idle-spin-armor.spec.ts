import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRouterExtension, type PiLike, type RegisteredTool } from '../src/pi/extension.ts'
import type { RouterConfig, SdkSurface } from '../src/pi/router.ts'
import type { GithubApi, IssueComment, IssueState } from '../src/pi/source-github.ts'

// agent-inbox#1085: idle slot reclamation, the swamp guard, and the router edge of the control-token armor.

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pi-1085-')); dirs.push(d); return d }
const live: Array<{ stop(): void }> = []
afterEach(() => { for (const r of live.splice(0)) r.stop() })
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 15))
const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 25))
}

interface FakePi extends PiLike { tools: Map<string, RegisteredTool>; sent: string[]; handlers: Map<string, Array<(p?: unknown) => void>> }
function fakePi(): FakePi {
  const tools = new Map<string, RegisteredTool>()
  const handlers = new Map<string, Array<(p?: unknown) => void>>()
  const sent: string[] = []
  return {
    tools, sent, handlers,
    registerTool: t => { tools.set(t.name, t) },
    sendUserMessage: text => { sent.push(String(text)) },
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {} },
  }
}

interface Spy { prompts: string[]; report: ((args: Record<string, unknown>) => unknown) | undefined; disposed: boolean;
  events: Array<(event: { type: string; effects?: boolean; reasoning?: string }) => void> }

function fixture(options: { maxConcurrent?: number; workerIdleParkMinutes?: number; workerSpinTurns?: number } = {}) {
  const dir = tmp()
  const feed: { issues: IssueState[]; comments: IssueComment[]; posts: Array<{ issue: number; body: string }> } =
    { issues: [], comments: [], posts: [] }
  const api: GithubApi = {
    issues: async () => [...feed.issues],
    issueState: async () => 'open',
    comments: async () => [...feed.comments],
    postComment: async (issue, body) => { feed.posts.push({ issue, body }) },
    closeIssue: async () => {},
    createIssue: async () => 999,
  }
  const addComment = (n: string, author: string, body: string, at = '2026-11-28T09:00:00Z') => {
    if (!feed.issues.some(i => String(i.issue) === n)) feed.issues.push({
      issue: Number(n), title: 'DO: the thing', author: 'pi-superagent', association: 'OWNER',
      createdAt: '2026-11-27T09:00:00Z', updatedAt: at })
    feed.comments.push({ issue: Number(n), author, association: 'OWNER', at, body })
  }
  const config: RouterConfig = {
    dataDir: dir, worktreeRoot: join(dir, 'work'), self: 'pi-superagent', githubRepo: 'o/r', prepare: 'true',
    bots: new Set(), tickMs: 5,
    // Off: the 20 GB default floor pauses launches, and this box runs under it — the disk rule is not what these tests prove.
    minFreeGb: 0,
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    ...(options.workerIdleParkMinutes === undefined ? {} : { workerIdleParkMinutes: options.workerIdleParkMinutes }),
    ...(options.workerSpinTurns === undefined ? {} : { workerSpinTurns: options.workerSpinTurns }),
  }
  const workers: Spy[] = []
  const judge: Spy = { prompts: [], report: undefined, disposed: false, events: [] }
  const sdk: SdkSurface = {
    createAgentSession: async (options) => {
      const tool = (options.customTools as RegisteredTool[])[0]!
      if (tool.name === 'ticket_decide') {
        judge.report = args => tool.execute('judge-1', args as never)
        return { session: { sessionId: 'judge', prompt: async (t: string) => { judge.prompts.push(t) }, subscribe: () => () => {}, abort: () => {}, dispose: () => {} } }
      }
      const spy: Spy = { prompts: [], report: args => tool.execute('call-1', args as never), disposed: false, events: [] }
      workers.push(spy)
      return { session: { sessionId: `w${workers.length}`, prompt: async (t: string) => { spy.prompts.push(t) },
        subscribe: (l: (event: { type: string; effects?: boolean; reasoning?: string }) => void) => { spy.events.push(l); return () => {} },
        abort: () => {}, dispose: () => { spy.disposed = true } } }
    },
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    getAgentDir: () => dir,
  }
  const pi = fakePi()
  const running = createRouterExtension(pi, { config, sdk, githubApi: api, now: () => new Date().toISOString(),
    scopesWork: () => false, capWorkerGroup: () => true })
  live.push(running)
  const accept = () => {
    const evalId = /Assess eval (\S+)/.exec(judge.prompts.at(-1) ?? '')?.[1]
    if (!evalId) return false
    judge.report!({ evalId, kind: 'accept', reason: 'the operator asked', title: 'Ship it', scope: 'the named change', acknowledgement: 'on it' })
    return true
  }
  const receipts = (n: string) => feed.posts.filter(p => String(p.issue) === n).map(p => p.body).join('\n')
  const events = (i = 0) => workers[i]!.events
  const emit = (i: number, event: { type: string; effects?: boolean; reasoning?: string }) => { for (const l of workers[i]!.events) l(event) }
  const trail = () => readFileSync(join(dir, 'engine.log'), 'utf8')
  return { dir, feed, addComment, running, workers, judge, accept, receipts, events, emit, trail, sdk, pi }
}

const RAW = '<' + '|im_start|' + '>'
const ESCAPED = '<' + '|~im_start|' + '>'

describe('idle slot reclamation (agent-inbox#1085)', () => {
  it('parks a quiet parked worker within one tick, frees its slot to the queue, and says so on the ticket', async () => {
    const f = fixture({ maxConcurrent: 1, workerIdleParkMinutes: 0.02 })
    f.addComment('101', 'octocat', 'first ask')
    f.addComment('102', 'octocat', 'second ask', '2026-11-28T09:01:00Z')
    await f.running.tick(); await settle(); expect(f.accept()).toBe(true)
    await f.running.tick(); await settle(); expect(f.accept()).toBe(true)
    await until(() => f.workers.length === 1)
    expect(f.running.load().running, 'the cap is one, so the first worker fills it').toBe(1)
    f.emit(0, { type: 'agent_settled' }) // the session parks: busy false, the quiet clock starts
    expect(f.running.load().running, 'a parked worker is not running, whatever its tab shows').toBe(0)
    // Measured 2026-11-28: `busy: false, quietSeconds: 3485` with the fleet at `running: 8` of 8 and 20
    // asks starved; a person's stop-ticket freed two launches in 40 s. Past the threshold the rule must
    // land within one tick of the beat (tickMs=5 here), not after a human types.
    await new Promise(resolve => setTimeout(resolve, 1600))
    await until(() => f.workers.length === 2)
    expect(f.workers[1]!.prompts[0], 'the freed slot goes to the queued ask').toContain('#102')
    expect(f.running.load().running).toBe(1)
    expect(f.receipts('101'), 'the parked ticket is told its worker ran dry').toContain('ran dry')
    expect(f.trail()).toMatch(/worker\.idle_parked/)
    expect(f.trail(), 'parking ends the assignment `released`: the state a thread comment wakes').toMatch(/worker\.released/)
  }, 20000)
})

describe('the swamp guard (agent-inbox#1085)', () => {
  it('stops a worker after N effectless turns exactly once, quoting its last reasoning block', async () => {
    const f = fixture({ workerSpinTurns: 3 })
    f.addComment('201', 'octocat', 'build the thing')
    await f.running.tick(); await settle(); expect(f.accept()).toBe(true)
    await f.running.tick()
    await until(() => f.workers.length === 1)
    const spin = (reasoning: string) => f.emit(0, { type: 'turn', effects: false, reasoning })
    spin('thinking about the trailer merging')
    spin('thinking about per-token divergence at token 0')
    f.emit(0, { type: 'turn', effects: true }) // writing, testing, committing: the streak resets
    spin('thinking about agreed=0 refusal paths')
    spin('thinking about FakeTokenizer subclasses again')
    await f.running.tick()
    expect(f.workers[0]!.disposed, 'two in a row is under the limit of three').toBe(false)
    expect(f.receipts('201')).not.toContain('Stopped the worker')
    spin('thinking about tokenizer fixtures, the mandate never asked for this')
    await until(() => f.workers[0]!.disposed)
    // The stop frees the slot. The standing-ask lane may later re-grant the ticket (capped per day): that
    // is the queue's lane, not a second stop, and the quote posted here is what the next worker reads.
    const said = f.receipts('201')
    expect(said).toContain('Stopped the worker')
    expect(said, 'the stop quotes what it was reasoning about, as a blockquote').toContain('> thinking about tokenizer fixtures')
    expect(said).toContain('3 turns in a row')
    expect(f.trail()).toMatch(/worker\.spinning/)
    // Exactly once: the release removed the live worker, later turns are deaf, and the outbox id is keyed
    // to the assignment, so a replayed event cannot post a second verdict.
    f.emit(0, { type: 'turn', effects: false, reasoning: 'still thinking' })
    await f.running.tick()
    expect(f.feed.posts.filter(p => p.body.includes('Stopped the worker'))).toHaveLength(1)
  }, 20000)
})

describe('ChatML control-token armor at the router boundary (agent-inbox#1085)', () => {
  it('delivers the ticket text escaped and posts the receipt unescaped, worker prose untouched', async () => {
    const f = fixture()
    f.addComment('301', 'octocat', `the template needs ${RAW}system and its pair`)
    await f.running.tick(); await settle(); expect(f.accept()).toBe(true)
    await f.running.tick()
    await until(() => f.workers.length === 1)
    const brief = f.workers[0]!.prompts.join('\n')
    expect(brief, 'the person\'s words reach the worker with the control token escaped').toContain(ESCAPED)
    expect(brief, 'and the raw token never crosses the boundary').not.toContain(RAW)
    // A later comment delivers through renderInput, the second ingress door.
    f.addComment('301', 'octocat', `again: ${RAW}user`, '2026-11-28T09:30:00Z')
    await f.running.tick()
    await until(() => f.workers[0]!.prompts.length >= 2)
    const delivery = f.workers[0]!.prompts.at(-1)!
    expect(delivery).toContain(ESCAPED)
    expect(delivery).not.toContain(RAW)
    // Egress: quoting the escaped form returns the raw form on the issue; plain words pass through.
    f.workers[0]!.report!({ state: 'ready', summary: `fixed the trailer merge around ${ESCAPED} — shipped clean` })
    await f.running.tick()
    const posted = f.receipts('301')
    expect(posted, 'the human-facing issue reads what the author wrote').toContain(RAW)
    expect(posted).toContain('fixed the trailer merge around')
    expect(posted).toContain('— shipped clean')
  }, 20000)
})
