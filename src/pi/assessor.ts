/** Assessor bound to the router session: it reads the Candidate and answers with `ticket_decide`. */
import type { Assessor, AssessmentOutcome, Candidate, Engine } from '../core/index.ts'

export interface SessionPilot {
  // Must not block the engine's loop: request() runs inside an engine command.
  deliver(text: string, meta: { evalId: string }): void
}

export interface AssessorOptions {
  /** Optional override; the default prompt states the facts and the four answers. */
  render?(candidate: Candidate): string
}

export const renderCandidate = (c: Candidate): string => [
  `Assess eval ${c.evalId} (policy ${c.policyVersion}, ${c.strength}).`,
  `Thread ${c.thread.key}`,
  ...c.triggers.map(t => `[${t.actor.id}${t.human ? '' : ' (not human)'} ${t.at}] ${t.text}`),
  c.tickets.length ? `Tickets already on this thread:\n${c.tickets.map(t => `- ${t.id} ${t.title}${t.ended ? ' (ended)' : ' (open)'}`).join('\n')}` : 'No tickets on this thread yet.',
  'Answer with ticket_decide: accept (title, scope, reason, acknowledgement for the asker, rules you matched, '
  + 'name, note for the worker), ignore (reason), stop (ticketId, reason), or unavailable (reason). '
  + 'Ignore is the answer for chatter, and for a request someone else already owns.',
].join('\n')

/** GitHub threads carry only `#<issue>`; the judge should see the URL it describes and what counts as a request. */
export const renderCandidateFor = (repo?: string) => (c: Candidate): string => {
  const base = renderCandidate(c)
  if (!repo || !c.thread.key.startsWith('github:')) return base
  const issue = c.thread.key.slice('github:'.length).replace('#', '')
  return `${base.replace(`Thread ${c.thread.key}`, `Thread ${c.thread.key} (https://github.com/${repo}/issues/${issue})`)}
`
    + 'This is GitHub: a person writing to the agent that runs your fleet. accept is the answer for a concrete action '
    + 'the person asks the agent to take, including a request that calls itself a test. ignore is the answer for '
    + 'chatter, for messages addressed to a person, and for a request whose ticket is already open.'
}

export class SessionAssessor implements Assessor {
  private readonly pending = new Map<string, Candidate>()
  // One candidate in the conversation at a time. The engine hands over every due eval in one command, and
  // a replay of the open board (41 cards, measured) delivered 41 user messages into a running turn: pi
  // steers them all into the same turn, the model answers them out of order, and the tail expires.
  // Queuing them costs ~15 s each and every one gets its own turn.
  private readonly queue: string[] = []
  private inFlight: string | null = null

  constructor(private readonly engine: () => Engine, private readonly pilot: SessionPilot,
              private readonly options: AssessorOptions = {}) {}

  // Idempotent per evalId: the engine re-runs a command after a crash, and a judged-twice candidate is a
  // double acknowledgement the operator reads.
  request(candidate: Candidate): void {
    if (this.pending.has(candidate.evalId)) return
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
    if (!candidate) return
    const trigger = candidate.triggers[0]
    if (!trigger) return
    this.engine().decide(trigger.id, { ...outcome, evalId })
    if (this.inFlight === evalId) { this.inFlight = null; this.drain() }
  }

  /** The panel's waiting list: who has not answered, and how big the ask is. */
  waiting(): Array<{ evalId: string; triggers: number; thread: string }> {
    return [...this.pending.values()].map(c => ({ evalId: c.evalId, triggers: c.triggers.length, thread: c.thread.key }))
  }
}
