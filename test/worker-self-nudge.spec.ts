import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_SELF_NUDGES, SILENT_NUDGE_FILE, workerRole, type WorkerPi } from '../src/pi/worker-role.ts'

/**
 * agent-inbox#886, live shape: 16 `worker repeated selfNudge` in 24 h from 5 workers, 366 nudges from 305 of
 * 1830 workers in a week. Every worker that nudged more than once had already filed a hand-over report — the
 * wake that ended its run was a background task of its own (a `tail -F` of a build log, a pluto-run finishing),
 * and the router had stopped reading the session. Each spec drives that same event order: a report, a settle,
 * then wakes that end in silence.
 */
const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wsn-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const lines = (file: string) => existsSync(file)
  ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
  : []
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10))
}

function fakePi() {
  const handlers = new Map<string, Array<(event?: unknown) => unknown>>()
  const tools: Array<{ name: string; execute: (id: string, args: Record<string, unknown>) => unknown }> = []
  const sent: string[] = []
  const pi: WorkerPi = {
    registerTool: tool => { tools.push(tool) },
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    sendUserMessage: text => { sent.push(String(text)) },
  }
  const emit = (event: string, payload?: unknown) => (handlers.get(event) ?? []).map(h => h(payload))
  /** One run of the model: what pi emits around any turn, wake or not. */
  const turn = () => { f.emit('agent_start'); f.emit('agent_settled') }
  const f = {
    pi, tools, sent, emit, turn,
    report: (args: Record<string, unknown>) => { f.emit('agent_start'); f.tools.find(t => t.name === 'ticket_report')!.execute('c1', args); f.emit('agent_settled') },
    // `turn` (agent-inbox#1085) is the swamp guard's witness; these specs pin nudge/file bookkeeping only.
    types: () => lines(join(dir, 'events.jsonl')).filter(e => e.type !== 'turn').map(e => e.type),
    reports: () => lines(join(dir, 'reports.jsonl')),
    nudged: () => existsSync(join(dir, 'inbox', SILENT_NUDGE_FILE)),
  }
  let dir = tmp()
  const start = (env: Record<string, string> = {}, pollMs = 1000) => workerRole(f.pi, { PI_SUPERAGENT_ROLE: 'worker', PI_SUPERAGENT_WORKER_DIR: dir, ...env }, pollMs)
  return { f, dir: () => dir, start }
}

describe('the worker self-nudge watchdog (agent-inbox#886)', () => {
  it('does not nudge a freed session that its own background task woke up', () => {
    const w = fakePi()
    w.start()
    w.f.report({ state: 'waiting', summary: 'the sweep still runs, check it in 30 minutes', wakeInMinutes: 30 })
    expect(w.f.types()).toEqual(['turnStarted', 'settled'])

    // The live loop: the log tail emits a line every few minutes, and the run it starts ends in silence,
    // because a hand-over session is refused every tool. Three of these filled one worker's linger window.
    w.f.turn()
    w.f.turn()
    w.f.turn()
    const wake = ['turnStarted', 'silentAfterHandover', 'settled']
    expect(w.f.types()).toEqual(['turnStarted', 'settled', ...wake, ...wake, ...wake])
    expect(w.f.nudged(), 'a nudge here is answered by a report nobody reads').toBe(false)
    expect(w.f.reports(), 'the real report stands, unmasked').toMatchObject([{ state: 'waiting' }])
  })

  it('nudges the forgotten call once, files the failure once, and never files it twice', () => {
    const w = fakePi()
    w.start()
    w.f.turn() // ended its turn with no ticket_report: the case the watchdog exists for
    expect(w.f.types()).toEqual(['turnStarted', 'selfNudge', 'settled'])
    expect(w.f.nudged()).toBe(true)
    w.f.turn() // woken, and silent again: the outcome is a person's case now
    expect(w.f.reports()).toMatchObject([{ state: 'failed', origin: 'silent' }])
    w.f.turn()
    w.f.turn()
    expect(w.f.reports()).toHaveLength(1)
    expect(w.f.types().filter(t => t === 'selfNudge')).toHaveLength(1)
  })

  it('stops nudging a worker that answers every nudge and goes silent again, and says so', () => {
    const w = fakePi()
    w.start()
    // The live shape of the 15 workers that burned their whole linger window on this: nudge, answer, go silent,
    // nudge. A `failed` report frees nobody, so this worker stays live and the streak keeps restarting.
    for (let i = 0; i < MAX_SELF_NUDGES; i++) {
      w.f.turn()
      w.f.report({ state: 'failed', summary: 'the build broke on a missing dependency' })
    }
    expect(w.f.types().filter(t => t === 'selfNudge')).toHaveLength(MAX_SELF_NUDGES)
    w.f.turn()
    expect(w.f.types()).toContain('selfNudgeExhausted')
    expect(w.f.types().filter(t => t === 'selfNudge')).toHaveLength(MAX_SELF_NUDGES)
    w.f.turn()
    expect(w.f.reports().filter(r => r.origin === 'silent')).toMatchObject([{ state: 'failed', origin: 'silent' }])
    w.f.turn()
    expect(w.f.reports().filter(r => r.origin === 'silent')).toHaveLength(1)
  })

  it('arms the watchdog again when the router sends the worker new work', async () => {
    const w = fakePi()
    w.start({}, 10)
    w.f.report({ state: 'blocked', summary: 'which port should it bind?', question: 'which port should it bind?' })
    w.f.turn()
    expect(w.f.types()).toContain('silentAfterHandover')

    // The person answers on the issue, the router writes it into the inbox: this session is live work again.
    writeFileSync(join(w.dir(), 'inbox', '1795269481918-0000.json'), JSON.stringify({ text: 'bind 8080', mode: 'followUp' }))
    w.f.emit('session_start')
    await until(() => w.f.sent.length === 1)
    w.f.turn()
    expect(w.f.types()).toContain('selfNudge')
    w.f.emit('session_shutdown')
  })
})
