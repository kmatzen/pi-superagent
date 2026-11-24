// The ready sweep: a free worker slot asks the judge about a ready issue nobody is on. Intake is
// activity-driven, so an issue quiet past the poll's cursor produces no trigger: measured 2026-11-24, six
// agent-ready issues idled 62 to 84 hours against five free slots. These are the rules that keep that ask a
// last resort — and the pin that it never speaks as a person.
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, runningAssignment } from '../src/core/index.ts'
import type { Assessor, Candidate, EngineOptions, Executor, Outcome, OutboundMessage, Policy, SweepCandidate, SweepPass, Ticket, Trigger } from '../src/core/index.ts'

const OWNER = { source: 'github', id: 'octocat' }
const DAY = '2026-11-24'
/** A minute on the sweep's day: the pass's gates are `updatedAt` compared to a cursor, so every fixture shares a day. */
const at = (minute: number) => `${DAY}T12:${String(minute).padStart(2, '0')}:00Z`
const thread = (id: string) => ({ source: 'github', id: `#${id}` })

/** A board row, in the shape `GithubSource.sweepBoard` produces: the poll's listing, not a fresh GitHub read. */
function issue(id: string, minute: number, extra: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    thread: thread(id), updatedAt: at(minute), priority: false, waitingOnHuman: false,
    actor: OWNER, text: `Issue ${id}: rotate the keys`,
    channel: { source: 'github', thread: `#${id}`, address: { issue: id } },
    meta: { association: 'OWNER', author: 'octocat' }, ...extra,
  }
}

function pass(board: SweepCandidate[], over: Partial<SweepPass> = {}): SweepPass {
  return { slots: 1, cursor: at(0), day: DAY, cooled: () => false, spend: () => {}, board, ...over }
}

function harness(options: { policy?: Partial<Policy>, slots?: number, listen?: (source: string) => boolean } = {}) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const launches: Ticket[] = []
  const outbox: OutboundMessage[] = []
  const assessor: Assessor = { request: vi.fn((candidate: Candidate) => void requests.push(candidate)), release: vi.fn() }
  const executor: Executor = { start: vi.fn((ticket: Ticket) => void launches.push(ticket)), deliver: vi.fn(), stop: vi.fn() }
  const full: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: trigger => trigger.meta.sweep === true
      ? { admissible: true, strength: 'inferred', basis: { via: 'sweep', observation: { mode: 'auto' } } }
      : trigger.human ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'not human' },
    revalidate: () => true, admitsInferred: rules => rules.length > 0, ...options.policy,
  }
  const scope: EngineOptions['scope'] = { scope: t => (options.listen?.(t.source) ?? true) ? { listened: true, observed: false } : { listened: false, reason: 'not listened to' } }
  const queued: EngineOptions['outbox'] = { send: (m: OutboundMessage) => void outbox.push(m), status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo, scope, policy: () => full, assessor, executor, outbox: queued, now: () => `${DAY}T12:45:00Z` })
  const sweep = (board: SweepCandidate[], over: Partial<SweepPass> = {}) => {
    const out = engine.sweepReady(pass(board, { slots: options.slots ?? 1, ...over }))
    engine.evaluateDue()
    return out
  }
  const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  // An Eval the judge never answers is a queue that never empties, and every gate behind it reads that queue.
  let answered = 0
  const settle = (outcome: Outcome = { kind: 'ignore', reason: 'chatter' }) => {
    for (const candidate of requests.slice(answered)) decide(candidate, outcome)
    answered = requests.length
  }
  const ask = (id: string) => {
    engine.receive({ id: `human:#${id}`, source: 'github', threads: [thread(id)], actor: OWNER, human: true, at: at(1),
      text: 'ship it tonight', channel: { source: 'github', thread: `#${id}`, address: { issue: id } }, meta: { association: 'OWNER' } } as Trigger)
    engine.evaluateDue()
  }
  const openTicket = (id: string) => {
    ask(id)
    decide(requests.at(-1)!, { kind: 'accept', title: 'Rotate the keys', scope: 'the staging keys', reason: 'a concrete ask' })
    return repo.tickets.list()[0]!
  }
  /** A worker's final report: the ticket ends answered, which is not the same thing as stopped. */
  const finish = (ticketId: string) => {
    const assignment = runningAssignment(repo.tickets.get(ticketId)!)
    if (assignment) engine.assignmentStarted(ticketId, assignment.id)
    return engine.report(ticketId, { state: 'ready', summary: 'the keys are rotated' })
  }
  return { engine, repo, requests, launches, sweep, decide, settle, ask, openTicket, finish, tickets: () => repo.tickets.list() }
}

describe('the ready sweep asks about the oldest ready issue, and only it', () => {
  it('takes the oldest of three ready issues', () => {
    const h = harness()
    const out = h.sweep([issue('12', 20), issue('9', 5), issue('20', 10)])
    expect(out.skipped, 'a free slot and an empty queue: nothing skips the pass').toBeUndefined()
    expect(out.swept).toBe('github:#9')
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.triggers[0]!.threads[0]).toEqual(thread('9'))
  })

  it('asks about a `priority:high` issue ahead of an older ordinary one', () => {
    const h = harness()
    expect(h.sweep([issue('9', 1), issue('12', 5, { priority: true })]).swept).toBe('github:#12')
  })

  it('asks the judge, not a worker: nothing launches until the accept', () => {
    const h = harness()
    h.sweep([issue('9', 1)])
    expect(h.launches, 'a sweep trigger is a request for a judgement').toHaveLength(0)
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'nothing to do' })
    expect(h.tickets(), 'the judge said no, so no ticket').toHaveLength(0)
  })

  it('accepts on the matched rules, opens the ticket, and leaves it alone after', () => {
    const h = harness()
    h.sweep([issue('9', 1)])
    h.decide(h.requests[0]!, { kind: 'accept', title: 'Rotate the keys', scope: 'the staging keys', reason: 'a concrete ask', rules: ['ready-issue'] })
    expect(h.tickets()).toHaveLength(1)
    const out = h.sweep([issue('9', 1)], { cursor: at(50) })
    expect(out.swept, 'a thread with a ticket on it is not idle work').toBeUndefined()
    expect(out.passed).toEqual([{ thread: 'github:#9', reason: 'liveTicket' }])
  })

  it('refuses an inferred accept that names no rule', () => {
    const h = harness()
    h.sweep([issue('9', 1)])
    expect(() => h.decide(h.requests[0]!, { kind: 'accept', title: 'Rotate the keys', scope: 'the staging keys', reason: 'a concrete ask' }))
      .toThrow()
    expect(h.tickets()).toHaveLength(0)
  })
})

describe('the sweep trigger is the router speaking for itself, never a person', () => {
  it('carries human: false and the sweep marker', () => {
    const h = harness()
    const out = h.sweep([issue('9', 1)])
    const trigger = h.requests[0]!.triggers[0]!
    expect(out.swept).toBe('github:#9')
    expect(trigger.human).toBe(false)
    expect(trigger.meta.sweep).toBe(true)
    expect(trigger.meta.via).toBe('sweep')
    expect(h.requests[0]!.strength, 'the judge weighs it as the router asking, not as an operator instructing').toBe('inferred')
  })

  it('refuses a sweep trigger that claims to be a person’s message, on any path', () => {
    const h = harness()
    const forged = { id: 'forged:1', source: 'github', threads: [thread('9')], actor: OWNER, human: true, at: at(2),
      text: 'wake the ticket a person stopped', meta: { via: 'sweep', sweep: true } }
    expect(() => h.engine.receive(forged as Trigger)).toThrow(UserError)
    try {
      h.engine.receive({ ...forged, id: 'forged:2' } as Trigger)
      expect.unreachable('intake took a sweep trigger that claimed a person spoke')
    } catch (error) {
      expect((error as UserError).code).toBe('sweepNotHuman')
    }
  })

  it('will not resume a ticket a person stopped, whatever the sweep decides about its issue', () => {
    const h = harness()
    const ticket = h.openTicket('9')
    h.engine.stopTicket(ticket.id, 'the operator said stop', 'operator')
    h.sweep([issue('9', 40)], { cursor: at(50) })
    expect(h.requests.length, 'the stopped thread is not the sweep’s to re-open').toBe(1)
    expect(h.repo.tickets.get(ticket.id)!.ended, 'and the stop stands').toBeDefined()
  })
})

describe('the sweep leaves alone every thread that is not idle work', () => {
  it('skips a stopped ticket as terminal, not merely ticketless', () => {
    const h = harness()
    const ticket = h.openTicket('9')
    h.engine.stopTicket(ticket.id, 'the operator said stop', 'operator')
    const out = h.sweep([issue('9', 40)], { cursor: at(50) })
    expect(out.swept).toBeUndefined()
    expect(out.passed).toEqual([{ thread: 'github:#9', reason: 'ticketStopped' }])
  })

  it('skips a ticket that finished, because its person has been answered', () => {
    const h = harness()
    const ticket = h.openTicket('9')
    h.finish(ticket.id)
    expect(h.sweep([issue('9', 40)], { cursor: at(50) }).passed).toEqual([{ thread: 'github:#9', reason: 'ticketEnded' }])
  })

  it('leaves a thread with activity past its cursor to the comment path', () => {
    const h = harness()
    h.ask('9')
    h.settle()
    const out = h.sweep([issue('9', 40)])
    expect(out.swept).toBeUndefined()
    expect(out.passed).toEqual([{ thread: 'github:#9', reason: 'liveActivity' }])
  })

  it('leaves an issue the board parked under waiting-on-human', () => {
    const h = harness()
    expect(h.sweep([issue('9', 1, { waitingOnHuman: true })]).passed).toEqual([{ thread: 'github:#9', reason: 'waitingOnHuman' }])
  })

  it('asks about nobody outside the repos it listens to, and spends no day on them', () => {
    const spent: string[] = []
    const h = harness({ listen: source => source === 'github' })
    const out = h.sweep([issue('9', 1, { thread: { source: 'chat', id: '9' } })], { spend: t => spent.push(t) })
    expect(out.swept).toBeUndefined()
    expect(out.passed).toEqual([{ thread: 'chat:9', reason: 'outOfScope' }])
    expect(spent, 'the day is not spent on a thread that cannot pass').toEqual([])
  })
})

describe('the sweep asks about an issue once a day, and no more', () => {
  it('refuses the second ask in a day, then grants the next day', () => {
    const h = harness()
    const days = new Map<string, string>()
    const cooled = (t: string, day: string) => days.get(t) === day
    const spend = (t: string, day: string) => void days.set(t, day)
    const board = [issue('9', 1)]
    // The pass's own trigger stamps the thread, so a later pass reads from past it: that is the extension advancing
    // its sweep cursor to the tick's time after it reads the board.
    const later = { cooled, spend, cursor: at(50) }
    expect(h.sweep(board, later).swept).toBe('github:#9')
    h.settle()
    const second = h.sweep(board, later)
    expect(second.swept).toBeUndefined()
    expect(second.passed).toEqual([{ thread: 'github:#9', reason: 'sweptToday' }])
    h.settle()
    expect(h.sweep(board, { ...later, day: '2026-11-25' }).swept, 'tomorrow the rules decide again').toBe('github:#9')
  })

  it('emits one trigger per pass, and reports what it passed over', () => {
    const h = harness()
    const out = h.sweep([issue('9', 1, { waitingOnHuman: true }), issue('10', 2)])
    expect(out.swept).toBe('github:#10')
    expect(out.passed).toEqual([{ thread: 'github:#9', reason: 'waitingOnHuman' }])
    expect(h.requests).toHaveLength(1)
  })
})

describe('the sweep never takes capacity the router does not have', () => {
  it('does not run when every slot is busy', () => {
    const h = harness({ slots: 0 })
    expect(h.sweep([issue('9', 1)]).skipped).toBe('no-slots')
    expect(h.requests).toHaveLength(0)
  })

  it('does not run while the judge has work on the board', () => {
    const h = harness()
    h.ask('7')
    const out = h.sweep([issue('9', 1)])
    expect(out.skipped, 'a trigger queued for Eval is the judge’s work in flight').toBe('eval-busy')
    expect(h.requests.map(r => r.triggers[0]!.threads[0]!.id), 'the person’s ask is judged first').toEqual(['#7'])
  })

  it('spends no cooldown when the board offers nothing it may ask about', () => {
    const spent: string[] = []
    const h = harness()
    expect(h.sweep([], { spend: t => spent.push(t) })).toEqual({ skipped: 'no-eligible-issue', passed: [] })
    h.sweep([issue('9', 1, { waitingOnHuman: true })], { spend: t => spent.push(t) })
    expect(spent).toEqual([])
  })
})
