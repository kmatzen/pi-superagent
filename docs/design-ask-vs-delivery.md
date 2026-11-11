# Ask and Delivery: one object each, two lifecycles

Status: proposed (2026-11-10). Owner: the router's operator. Affects `src/core` (vendored, edited under
the operator's standing authorisation), `src/pi`, `formal/`, and the panel.

## The problem

An issue asks for something and a person closes it. A pull request delivers something and a person merges
it. Those are two lifecycles with two different deciders. The engine stores both inside one ticket — the
ask as the ticket's `channels`, the delivery as the ticket's `follows` — and its rules read one object and
act on the other.

The live database (2026-11-10, 240 tickets) shows how much of the engine services that crossing:

| Measured | Count | Share |
| --- | --- | --- |
| Tickets carrying a `follows` entry (a delivery bound into the ask) | 126 | 52% |
| Tickets owning a pull request that is still open | 53 | 22% |
| Tickets ended `merged` or `closed` — ended by what happened to a pull request | 73 | 30% |
| Tickets ended `completed` — ended by finishing the ask | 44 | 18% |
| Tickets open, reporting `ready`, waiting on an unmerged pull request | 2 | — |

A delivery decides the fate of the ask more often (73) than the ask's own completion does (44). Nothing in
the model says so, so every rule that touches it re-derives the relationship from scratch.

## The crossing, rule by rule

Seven rules carry the crossing. Each is a place where a decision about one object is taken from the state
of the other.

| # | Rule | Where | What it mixes | What it cost |
| --- | --- | --- | --- | --- |
| 1 | A `ready` report ends the ask only once the delivery closed | `src/core/tickets.ts:84-95` (`followsDone`), `:399` (`unfinished`) | the ask's completion gated on a pull request's merge | the 2 tickets in the table above sit in that limbo, and the panel calls them ready |
| 2 | A `ready` report frees the worker | `src/pi/extension.ts:314` with `awaitsAHuman` at `:295` | a worker's lifetime keyed on a pull request being open | pull request #37 (2026-11-09) |
| 3 | The silence sweep frees the worker | `src/pi/extension.ts:~805` | the same fact, a second copy, because the sweep files its report through the domain | 6 tickets held finished workers until the copy existed (#40) |
| 4 | A person's reply resurrects the ask only when its own pull request closed | `src/pi/extension.ts:456-457` | a person's ability to reopen work gated on the delivery | "nobody is answering my comment" (2026-11-10, issue #350) |
| 5 | Absence from the open set stops the ask | `src/pi/extension.ts:754-761`, `openThreads` | open issues and open pull requests in one set, and absence read as closed | #350's ticket stopped at 00:12:11 while its issue sat open; the reply at 00:21:59 reached a stopped ticket, which takes no comment by design |
| 6 | A closed pull request ends the ask | `src/pi/pulls.ts:241` → `closed()` → the core's end | the delivery ending the ask, outcome `merged`/`closed` | 73 tickets, and `follows.own`/`follows.closed` existing at all |
| 7 | A pull request cannot be an ask | `src/pi/extension.ts:413` (`trigger.source === 'pull'`) | review speech on a delivery cannot create work | a reviewer must open a second issue to ask for a change |

The identity is shared too: `threadKey` (`src/core/model.ts:12`) is `github:#350` for an issue and
`github:#351` for a pull request, in one numbering space, and the panel prints `#350` with no type. A human
reading the board, and a rule reading a set, cannot tell the ask from the delivery.

## Target model

Two objects, one link, and no shared fields to read through.

```
Ask        mandate + one issue binding + inputs + reports + attention   (was: Ticket)
Delivery   worktree + branch + one pull-request binding + reviews       (new, 0..1 per Ask)
Assignment a worker, bound to the Delivery when there is one, else to the Ask (unchanged)
Link       Delivery.ask = Ask.id, set once at creation, one way
```

`Delivery` is optional by construction: a question answered in prose has no delivery, and that is a normal
state, not an error.

Every rule reads one object, and the objects talk by event, not by field:

| Question | Asked of | Object |
| --- | --- | --- |
| Is work wanted here? | the issue's state and people's speech on it | Ask |
| Is the ask over? | a person closed the issue, or accepted the answer | Ask |
| Is work in flight? | an Assignment is running | Assignment |
| Should the worker be free? | the Delivery awaits a human — review, merge, an answer | Delivery |
| Is the work delivered? | the pull request merged | Delivery |
| Should the ask close? | a `delivery-merged` event, accepted by the ask's own rules | Ask, informed by an event |

The mechanism that replaces `follows`: a Delivery publishes typed inputs into its Ask's stream —
`{ kind: 'delivery', event: 'opened' | 'changes-requested' | 'approved' | 'merged' | 'closed', at }` —
exactly as a person's comment is an input today. The Ask never reads a Delivery's fields; the Delivery never
reads the Ask's. `followsDone` and `unfinished` become one rule over an event, and rules 2, 3, 4, 5 and 6
above lose their second object.

## Invariants to prove

`formal/` keeps its job; the claims get sharper, they do not get softer.

- **A1** An Ask stops only when GitHub answers `closed` for its issue. No inference from a list.
- **A2** An Ask has at most one open Delivery.
- **A3** A Delivery's merge ends its Ask within one tick; closing an Ask never merges a Delivery, it detaches.
- **A4** A person's message on the Ask's issue reaches a running Assignment, a released worker, or resumes
  a released one — with no condition on the Delivery.
- **A5** No worker stays assigned to an Ask whose Delivery awaits a human.

A1 is today's #350. A4 is today's rule 4. A5 is #37, #40 and the 6 stuck tickets.

## Migration, staged

Each stage ships alone, is gated alone, and reverses alone.

| Stage | Change | Deletions | Rollback |
| --- | --- | --- | --- |
| **S0** | Land the two deletions already coded: one release rule shared by every reporter, and closure asked of GitHub per issue instead of inferred from a set. | the second copy of the release rule; the absence inference | revert the commit |
| **S1** | Type the identities: `kind: 'issue' \| 'pull'` on the thread reference, backfilled once per distinct thread and cached. | the `startsWith('#')` parsing at `extension.ts:759`; the `pull_request` filter duplicated by callers | additive field; ignore it |
| **S2** | Extract `Delivery` as a store, mirror `follows` from it, and have the merge scan write Delivery events. Purely additive: nothing reads the new source of truth yet. | none yet | drop the store, the mirror stops |
| **S3** | Move the rules onto the new sources, one rule per release: the release rule reads the Delivery; the wake rule reads the Ask (deleting the delivery gate at `:456-457`); the end rule reads delivery events (deleting `followsDone`, `unfinished`, `Follow.own`, `Follow.closed`); intake accepts a pull-request comment as an event on the linked Ask (deleting `:413`). | rule 1, 4, 6's machinery, and 7 | one flag per rule, effective next tick |
| **S4** | The board and every notice name the object: `ask #350 → pull #351 (open)`, "reopen the issue", "merge the pull request". | the ambiguous `#N` renderings, and the notice that told a person to "reopen it" | render the old form |
| **S5** | Re-model: `Ticket.tla` → `Ask.tla`, a small `Delivery.tla`, and a cross model proving A1–A5. | the follows machinery in the model | keep the old model as a regression |

S0 is in flight. S1 and S2 are additive, so a bad one is invisible. S3 is where behaviour changes, and it is
deliberately split one rule per release: today's incidents were all single rules.

## Non-goals

- **Multiple pull requests per ask.** One delivery per ask. A second pull request is a second ask, with its
  own identity. Today's `Follow[]` array is the generalisation nobody uses: 126 tickets have follows and the
  rules only ever ask "is any of my own still open".
- **Other forges.** The Ask's binding stays an abstract thread reference with a `kind`; nothing in `src/core`
  learns what GitHub is.
- **A queue, priorities, and the panel rewrite.** Separate designs.

## Risks

- **A question with no delivery.** Handled by construction (0..1) and by A5, which keys the free-the-worker
  rule on the thing that is awaited.
- **240 live tickets.** S2 backfills a Delivery for the 126 tickets with follows; the 2 in the ready limbo
  resolve on their next merge; the 20 open tickets are the migration's test set.
- **`src/core` is vendored.** `followsDone` and `unfinished` live there, so S2 and S3 are core edits under
  the authorisation the operator gave for `release` and `resurrect`, with `formal/` updated in the same PR.
- **Migration under live traffic.** S2 is a mirror, not a switch: no ticket is ever between two sources of
  truth, and no stage in the table needs the engine stopped for more than the restart it already does.
- **Cost.** S1 and S2 together are about the size of #37 and #40 combined; S3 is one small PR per rule. No
  new dependencies, no new processes, no new infrastructure.

## What stays

The Mandate, the accept-and-eval intake, the Assignment and its reports, the durable store and restart
recovery, the panel, the worker pool, and the proofs. This design removes one confusion, not a capability:
after S3 the engine has the same powers, two objects, and no rule that has to guess which object a `#350`
refers to.

## Re-measuring

Every number above comes from the live deployment, and these commands reproduce it (read-only):

```bash
python3 - <<'PY'   # outcomes, follows, open deliveries, the ready limbo
import json, sqlite3, collections
oc, fol, own, limbo, tot = collections.Counter(), 0, 0, 0, 0
for (v,) in sqlite3.connect('tickets.db').execute('select value from ticket'):
    t = json.loads(v); tot += 1
    oc[(t.get('ended') or {}).get('outcome') or 'open'] += 1
    f = t.get('follows') or []
    fol += bool(f); own += any(x.get('own') and not x.get('closed') for x in f)
    r = (t.get('assignments') or [{}])[-1].get('report') or {}
    limbo += not t.get('ended') and r.get('state') == 'ready' and any(x.get('own') and not x.get('closed') for x in f)
print(tot, 'tickets |', fol, 'with follows |', own, 'own an open pull |', limbo, 'ready, pull unmerged |', dict(oc))
PY
gh api "repos/<owner>/<board>/issues/350" --jq '{state, labels: (.labels|map(.name))}'
gh api "repos/<owner>/<board>/issues/350/events" --jq '.[] | select(.event=="closed" or .event=="reopened") | "\(.created_at) \(.event) by \(.actor.login)"'
grep -a "ticket.conversation_closed" ~/.pi/superagent/engine.log | wc -l
```
