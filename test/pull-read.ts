/**
 * The pull-state reads a test hands a `PullFollower`, in the shapes `ghPulls` answers with. A test that wants to
 * prove "a failed read ends nothing" has to say which failure it means — a non-zero exit, an empty body, a body
 * with no state, a rate limit, an invisible repository — and this is the one place that spells them out.
 */
import type { PullEvidence, PullRead, PullState } from '../src/pi/pulls.ts'

const OID = '9a0e7ea1234567890abcdef1234567890abcdef1'
const HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString()

export const evidenceOf = (over: Partial<PullEvidence> = {}): PullEvidence =>
  ({ repo: 'o/r', number: 5, status: 0, state: '', closedAt: null, mergedAt: null, headRefOid: OID, ...over })

/** The body a test is describing: GitHub's fields, plus the repository and number the read was for. */
export type PullReadShape = Partial<PullEvidence> & { createdAt?: string }

/** A read GitHub answered: `state`, and the times it names, exactly as the API's body carries them. */
function found(state: Omit<Partial<PullState>, 'rawState' | 'headRefOid' | 'createdAt'>, evidence: PullEvidence, createdAt = HOUR_AGO()): PullRead {
  return {
    read: 'found', evidence,
    state: {
      open: state.open ?? false, merged: state.merged ?? false,
      createdAt,
      rawState: evidence.state, headRefOid: evidence.headRefOid,
      ...(state.closedAt ? { closedAt: state.closedAt } : {}),
      ...(state.mergedAt ? { mergedAt: state.mergedAt } : {}),
    },
  }
}

export const openRead = (over: PullReadShape = {}): PullRead => {
  const { createdAt, ...fields } = over
  return found({ open: true }, evidenceOf({ state: 'open', ...fields }), createdAt)
}

/** CLOSED with `merged_at: null`: the one read, besides a merge, that ends a ticket. */
export const closedRead = (closedAt: string, over: PullReadShape = {}): PullRead => {
  const { createdAt, ...fields } = over
  return found({ closedAt }, evidenceOf({ state: 'closed', closedAt, ...fields }), createdAt)
}

/** GitHub answers a merge as a closed pull request that carries `merged_at`. */
export const mergedRead = (mergedAt: string, over: PullReadShape = {}): PullRead => {
  const { createdAt, ...fields } = over
  return found({ merged: true, mergedAt, closedAt: mergedAt }, evidenceOf({ state: 'closed', mergedAt, closedAt: mergedAt, ...fields }), createdAt)
}

/** A read that decided nothing: the ticket keeps its follow and the next pass asks again. */
export const unknownRead = (reason: string, over: PullReadShape = {}): PullRead => {
  const { createdAt: _createdAt, ...fields } = over
  return { read: 'unknown', reason, evidence: evidenceOf({ reason, ...fields }) }
}

/** GitHub has no such number in a repository this token read: the pull request is gone, so nothing can merge. */
export const absentRead = (over: PullReadShape = {}): PullRead => {
  const { createdAt: _createdAt, ...fields } = over
  return { read: 'absent', evidence: evidenceOf({ reason: 'no-such-pull-request', ...fields }) }
}
