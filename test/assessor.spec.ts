import { describe, expect, it } from 'vitest'
import { Engine, MemoryRepositories, type Candidate, type OutboundMessage, type Policy } from '../src/core/index.ts'
import { SessionAssessor, renderCandidate, renderCandidateFor, type SessionPilot } from '../src/pi/assessor.ts'
import type { Trigger } from '../src/core/index.ts'

function fixture(evalTimeoutMs = 60_000) {
  const repo = new MemoryRepositories()
  const delivered: Array<{ text: string; evalId: string }> = []
  const pilot: SessionPilot = { deliver: (text, meta) => { delivered.push({ text, evalId: meta.evalId }) } }
  let engine!: Engine
  const assessor = new SessionAssessor(() => engine, pilot)
  const outbox: OutboundMessage[] = []
  let clock = 0
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs,
    gate: t => (t.human ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'not human' }),
    revalidate: () => true,
    admitsInferred: rules => rules.length > 0,
  }
  engine = new Engine({
    repo,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => policy,
    assessor,
    executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: m => { if (!outbox.some(o => o.id === m.id)) outbox.push(m) }, status: id => (outbox.some(o => o.id === id) ? 'pending' : undefined), withdraw: () => {} },
    now: () => new Date(Date.UTC(2026, 10, 5, 0, 0, clock)).toISOString(),
  })
  const ask = (text = 'merge the green build tonight'): Trigger => {
    const t: Trigger = {
      id: 'github:#1:abc', source: 'github', threads: [{ source: 'github', id: '#1' }],
      actor: { source: 'github', id: 'octocat' }, human: true, at: '2026-11-05T09:00:00Z', text,
      channel: { source: 'github', thread: '#1', address: { issue: '1' } }, meta: {},
    }
    engine.receive(t)
    engine.evaluateDue()
    return t
  }
  const tick = (seconds: number) => { clock += seconds; engine.evaluateDue() }
  return { repo, engine, assessor, delivered, outbox, ask, tick }
}

describe('SessionAssessor', () => {
  it('delivers the candidate to the session, once per eval', () => {
    const f = fixture()
    f.ask()
    expect(f.delivered).toHaveLength(1)
    expect(f.delivered[0]!.text).toContain('merge the green build tonight')
    expect(f.delivered[0]!.text).toContain('ticket_decide')
    f.engine.evaluateDue()
    expect(f.delivered).toHaveLength(1)
  })

  it('an accept from the session becomes a ticket, and the acknowledgement reaches the thread', () => {
    const f = fixture()
    f.ask()
    const evalId = f.delivered[0]!.evalId
    f.assessor.decide(evalId, { kind: 'accept', title: 'Ship tonight', scope: 'the green build', reason: 'the operator asked', acknowledgement: 'on it, tonight' })
    expect(f.repo.tickets.open()).toHaveLength(1)
    expect(f.outbox.map(o => o.text)).toContain('on it, tonight')
    expect(f.assessor.waiting()).toHaveLength(0)
  })

  it('an ignore is a decision, not a hang: no ticket, no reply, nothing waiting', () => {
    const f = fixture()
    f.ask('saw the screenshot, funny')
    f.assessor.decide(f.delivered[0]!.evalId, { kind: 'ignore', reason: 'chatter, no request' })
    expect(f.repo.tickets.open()).toHaveLength(0)
    expect(f.outbox).toHaveLength(0)
    expect(f.assessor.waiting()).toHaveLength(0)
  })

  it('a timed-out eval is asked again, and a late answer for the dead one creates nothing', () => {
    const f = fixture(30_000)
    f.ask()
    const dead = f.delivered[0]!.evalId
    f.tick(60)
    // REQUEUES: a busy assessor does not lose the request, so a fresh eval is delivered.
    expect(f.delivered.map(d => d.evalId)).toHaveLength(2)
    expect(f.assessor.waiting().map(w => w.evalId)).toEqual([f.delivered[1]!.evalId])
    f.assessor.decide(dead, { kind: 'accept', title: 'Late', scope: 's', reason: 'r' })
    expect(f.repo.tickets.open()).toHaveLength(0)
    // Two more expiries and the engine records it unavailable: the panel must show nobody waiting.
    f.tick(60)
    f.tick(60)
    expect(f.assessor.waiting()).toHaveLength(0)
  })

  it('waiting() names the eval the panel should put in front of a person', () => {
    const f = fixture()
    f.ask()
    expect(f.assessor.waiting()).toEqual([{ evalId: f.delivered[0]!.evalId, triggers: 1, thread: 'github:#1' }])
  })

  it('one question at a time: a burst of candidates does not steer every message into one turn', () => {
    const f = fixture()
    f.ask()
    for (const n of ['2', '3']) {
      f.engine.receive({
        id: `github:#${n}:abc`, source: 'github', threads: [{ source: 'github', id: `#${n}` }],
        actor: { source: 'github', id: 'octocat' }, human: true, at: '2026-11-05T09:00:00Z', text: `work ${n}`,
        channel: { source: 'github', thread: `#${n}`, address: { issue: n } }, meta: {},
      } as never)
    }
    f.engine.evaluateDue()
    expect(f.delivered).toHaveLength(1)
    expect(f.assessor.waiting()).toHaveLength(3)
    f.assessor.decide(f.delivered[0]!.evalId, { kind: 'ignore', reason: 'queued' })
    expect(f.delivered).toHaveLength(2)
    f.assessor.decide(f.delivered[1]!.evalId, { kind: 'ignore', reason: 'queued' })
    expect(f.delivered).toHaveLength(3)
  })

  it('the prompt shows the asker, the thread, and the tickets it must not duplicate', () => {
    const candidate = {
      evalId: 'e1', key: 'github:#2', id: '#2', strength: 'explicit', policyVersion: 'v1',
      thread: { key: 'github:#2' } as never,
      triggers: [{ id: 't1', actor: { source: 'github', id: 'ci-bot' }, human: false, at: '2026-11-05T09:00:00Z', text: 'build red' } as never],
      tickets: [{ id: 'TK1', title: 'Fix the build', ended: undefined } as never],
    } as unknown as Candidate
    const text = renderCandidate(candidate)
    expect(text).toContain('ci-bot (not human)')
    expect(text).toContain('github:#2')
    expect(text).toContain('Fix the build (open)')
  })

  it('a bare artifact reaches the judge as the request itself, not as chatter', () => {
    const candidate = {
      evalId: 'e1', key: 'github:#191', id: '#191', strength: 'explicit', policyVersion: 'v1',
      thread: { key: 'github:#191' } as never,
      triggers: [{
        id: 't1', actor: { source: 'github', id: 'kblackburn' }, human: true, at: '2026-11-07T01:09:00Z',
        text: 'https://example.sentry.io/issues/7829822666/?project=4511909839699968',
      } as never],
      tickets: [],
    } as unknown as Candidate
    const text = renderCandidateFor('o/r')(candidate)
    expect(text, 'an alert link is the ask; the judge must not file it as chatter')
      .toMatch(/An artifact on its own[\s\S]*IS the request/)
    expect(text, 'an inferred accept needs named rules, or the policy refuses it')
      .toContain('artifact-implies-request')
  })
})
