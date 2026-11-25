/** The Assessor port: renders each Candidate and sends it to the judge, one at a time; the judge's
 *  `ticket_decide` call brings the answer back. */
import { UserError, type Assessor, type AssessmentOutcome, type Candidate, type Engine } from '../core/index.ts'
import { ACK_FORMAT } from './firstpost.ts'
import { threadUrl } from './pulls.ts'

export interface SessionPilot {
  // Must not block the engine's loop: request() runs inside an engine command.
  deliver(text: string, meta: { evalId: string }): void
}

export interface AssessorOptions {
  /** Optional override; the default prompt states the facts and the four answers. */
  render?(candidate: Candidate): string
  /**
   * Answers recorded for trigger sets judged before. Measured 2026-11-11: the engine re-asked a thread's
   * Eval every pass, the judge gave the same ignore each time, and the fleet burned ~39,000 judge calls a
   * day re-asking "get green" against the ticket that already owned it. A seen set for answers, not a cache
   * of truth: a new trigger id on the thread is a new question and goes to the judge.
   */
  memo?: { get(key: string): string | undefined; set(key: string, reason: string): void }
}

/** What a judge sees is the trigger set and the strength; that is what an answer belongs to. */
export const memoKey = (c: Candidate): string => `${[...c.triggers].map(t => t.id).sort().join('|')}|${c.strength}`

export const renderCandidate = (c: Candidate): string => [
  `Assess eval ${c.evalId} (policy ${c.policyVersion}, ${c.strength}).`,
  `Thread ${c.thread.key}`,
  ...c.triggers.map(t => `[${t.actor.id}${t.human ? '' : ' (not human)'} ${t.at}] ${t.text}`),
  ...(c.triggers.some(t => t.meta?.sweep === true)
    // The judge must know nobody spoke: "a person wants this" is the reason it accepts most GitHub candidates.
    ? ['The ready sweep sent this, not a person: a worker slot is free and no ticket is on this thread. '
      + 'accept is the answer when the issue is work an agent can take now; ignore when it needs a person first, '
      + 'when its work is done, or when it is chatter. Name the rules you matched, e.g. rules: ["swept-ready-ask"].']
    : []),
  c.tickets.length ? `Tickets already on this thread:\n${c.tickets.map(t => `- ${t.id} ${t.title}${t.ended ? ' (ended)' : ' (open)'}`).join('\n')}` : 'No tickets on this thread yet.',
  'Answer with ticket_decide: accept (title, scope, reason, acknowledgement for the asker, rules you matched, '
  + 'name, note for the worker), ignore (reason), stop (ticketId, reason), or unavailable (reason). '
  + 'Ignore is the answer for chatter, and for a request someone else already owns.\n'
  + `The acknowledgement is the first post on the asker's issue, and an accept is refused without it rendering in blocks: ${ACK_FORMAT}`,
].join('\n')

/** GitHub threads carry only `#<issue>`; the judge should see the URL it describes and what counts as a request. */
export const renderCandidateFor = (repo?: string) => (c: Candidate): string => {
  const base = renderCandidate(c)
  const url = c.thread.key.startsWith('github:') ? threadUrl(c.thread.key.slice('github:'.length), repo ?? '') : undefined
  if (!url) return base
  return `${base.replace(`Thread ${c.thread.key}`, `Thread ${c.thread.key} (${url})`)}
`
    + 'This is GitHub: a person writing to the agent. accept is the answer for a concrete action '
    + 'the person asks the agent to take, including a request that calls itself a test. '
    + 'An artifact on its own — an alert, a sentry or monitoring link, a log, a screenshot, an issue or pull '
    + 'request number — IS the request: the person wants it diagnosed and resolved, so answer accept with that '
    + 'as the scope, name the rules you inferred (rules: ["artifact-implies-request"]) so the policy admits an '
    + 'inferred accept, and title the ticket after the thing to fix. '
    + 'ignore is the answer for '
    + 'chatter, for messages addressed to a person, and for a request whose ticket is already open.'
}

export class SessionAssessor implements Assessor {
  private readonly pending = new Map<string, Candidate>()
  // One candidate in the conversation at a time. The engine hands over every due eval in one command, and
  // a burst of 41 (measured) once arrived as 41 messages in a running turn: pi steered them all into it,
  // the model answered out of order, and the tail expired. Queued, each costs ~15 s and gets its own turn.
  private readonly queue: string[] = []
  private inFlight: string | null = null

  constructor(private readonly engine: () => Engine, private readonly pilot: SessionPilot,
              private readonly options: AssessorOptions = {}) {}

  // Idempotent per evalId: the engine re-runs a command after a crash, and a judged-twice candidate is a
  // double acknowledgement the operator reads.
  request(candidate: Candidate): void {
    if (this.pending.has(candidate.evalId)) return
    const memo = this.options.memo
    const key = memo && memoKey(candidate)
    const seen = key ? memo!.get(key) : undefined
    if (memo && key && seen !== undefined) {
      // Answer it as the judge answered last time, outside this engine command: the engine re-asks the same
      // set in a loop, and a loop must cost no model turn.
      this.engine().candidateDelivered(candidate.evalId)
      const trigger = candidate.triggers[0]
      if (trigger) queueMicrotask(() => { try { this.engine().decide(trigger.id, { kind: 'ignore', reason: seen, evalId: candidate.evalId }) } catch { /* the engine moved on; its next ask stands */ } })
      return
    }
    this.pending.set(candidate.evalId, candidate)
    if (this.inFlight === null) this.send(candidate)
    else this.queue.push(candidate.evalId)
  }

  private send(candidate: Candidate): void {
    this.inFlight = candidate.evalId
    this.pilot.deliver(this.options.render?.(candidate) ?? renderCandidate(candidate), { evalId: candidate.evalId })
    this.engine().candidateDelivered(candidate.evalId)
  }

  /** The next question goes out only after the current one is answered, so a turn carries one eval. */
  private drain(): void {
    if (this.inFlight !== null) return
    while (this.queue.length) {
      const id = this.queue.shift()!
      const next = this.pending.get(id)
      if (next) return this.send(next)
    }
  }

  get inFlightEval(): string | null { return this.inFlight }

  threadOf(evalId: string): string | undefined { return this.pending.get(evalId)?.thread.key }

  release(evalId: string): void {
    this.pending.delete(evalId)
    if (this.inFlight === evalId) { this.inFlight = null; this.drain() }
  }

  // The ticket_decide tool lands here; only the engine decides whether an answer still counts.
  decide(evalId: string, outcome: AssessmentOutcome): void {
    const candidate = this.pending.get(evalId)
    if (!candidate) throw new UserError('evalFinished', { eval: evalId })
    const trigger = candidate.triggers[0]
    if (!trigger) throw new UserError('notAdmissible', { reason: 'this eval carries no trigger' })
    if (this.options.memo && outcome.kind === 'ignore') this.options.memo.set(memoKey(candidate), typeof outcome.reason === 'string' ? outcome.reason : 'the same triggers were ignored before')
    this.engine().decide(trigger.id, { ...outcome, evalId })
    if (this.inFlight === evalId) { this.inFlight = null; this.drain() }
  }

  /** The panel's waiting list: who has not answered, and how big the ask is. */
  waiting(): Array<{ evalId: string; triggers: number; thread: string }> {
    return [...this.pending.values()].map(c => ({ evalId: c.evalId, triggers: c.triggers.length, thread: c.thread.key }))
  }
}
