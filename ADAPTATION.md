# Adaptation ledger

The rule for this file: **`src/core/**` is upstream, and every line that is not upstream is listed
here.** Vendoring without a ledger turns an upstream fix into a merge conflict you cannot resolve, and
"we changed a little" into "nobody knows what runs". Each entry names the file, the upstream SHA it was
measured against, what changed, and why the change is ours to make.

Baseline: `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` — `src/core/**` and `test/core-engine.spec.ts` are
byte-identical to upstream at that commit. Verify with:

```sh
git show $(cat vendor/dsh-superagent/UPSTREAM_SHA)  # upstream commit recorded in this repo
diff -r src/core <upstream-clone>/src/core          # expected: no differences
```

## Deviations

| file | upstream SHA | change | why it is ours |
| --- | --- | --- | --- |
| — none yet — | | | |

## Ports we write, not vendor

`src/core/ports.ts` is the seam: the engine is pure and synchronous, and everything that touches a
process, a network, or a model arrives through one of these interfaces.

| port | upstream binding | our binding | why |
| --- | --- | --- | --- |
| `Executor` | a DeepSeek Harness session per ticket | a **pi session** per ticket, in its own git worktree, briefed with the ticket's mandate | pi owns sessions, tools, skills, context, and the subagent/workflow layers; reimplementing that would be the worst part of the deal |
| `Assessor` | a Harness model call | a **pi model call** on a cheap model, with the candidate rendered from our sources | the eval's judgement is a model call; the gate in front of it is code, and the gate is the part that must stay deterministic |
| `Repositories` | their store | **SQLite** (`node:sqlite`), synchronous, one file, wrapped in `atomic()` | their interface demands synchronous repositories so a unit of work is one atomic call; `node:sqlite` is the only thing in our stack that gives that without a daemon |
| `Outbox` | Feishu topic replies, GitHub comments | **fleet-board card comments** first, GitHub pull-request comments second | the card is where the operator already answers; a new place to read is a new way to miss a request |
| `Source` | Feishu, GitHub | **board card comments** (replaces our `fleet-card-poll` extension), then GitHub events | the durable read position per source is the property our daemons lack: a restart must not replay events, and accepting a trigger twice must create one ticket |

## What we keep from our own system

- **the TLA+ model.** Their state machine is written in prose and in TypeScript. Ours is
  `FleetManager.tla` with 104 model cells, and it is what caught the double-dispatch and the
  answered-ask-label defects. The model gets ported to ticket/assignment/mandate states, not deleted.
- **the board as the auditable surface.** Their panel is a good UI; the card is a durable artifact an
  operator can grep, comment on from a phone, and hand to a lawyer.
- **the gates.** Every retired daemon must be covered by a rule plus a gate before it is deleted.

## Retirement list, with the proof each one needs

| daemon today | replaced by | proof required before deletion |
| --- | --- | --- |
| `fleet-card-poll` | the board `Source` with a read position | a replay test: restart mid-stream, no re-delivery, no double ticket |
| `fleet-dispatch` | `Eval` accept → `Assignment` → `Executor` | the label rule becomes a policy rule; a fixture run dispatches once per accepted trigger |
| `fleet-answer-loop` | `Subscription` fan-out + typed `Report` | the escalation cases in `test-answer-verdicts` pass against the engine, then the gate is deleted with the daemon |
| `audit-stuck`, `audit-answers`, and the other 11 audits | eval rules + one report | each audit's finding becomes a named rule with a case; nothing is deleted on a hunch |
| the ack classifier (`is_closing_ack`) | a structured `Attention` field | their design says it plainly: never infer "waiting on a person" from a report's free text. We guessed with a regex; the guess gets deleted when the worker reports a field |

## Port bindings (mine; upstream ships none of these)

Upstream's four ports are interfaces with in-memory fakes in `test/`. These are the pi bindings, and each
one exists because a fleet daemon does its job badly today.

| Port | File | Bound to | The defect it retires |
| --- | --- | --- | --- |
| `Repositories` | `src/pi/store.ts` | `node:sqlite` (`DatabaseSync`), WAL, `synchronous=FULL`, `foreign_keys=ON`, one transaction per command | The board's JSONL/append files, where "the write happened" and "the reader saw it" are different days. |
| `Source` | `src/pi/source-card-comments.ts`, `src/pi/source-card-state.ts` | card comments *and* card state (the `agent-ready` label, mid-flight adoption), with a content-hashed read position in the same store | `fleet-card-poll`: no read position, so a restart re-delivers, and the bot's own comments come back as requests. |
| `Outbox` | `src/pi/outbox.ts` | Card comments, idempotent by message id, statuses persisted | Messages that "sent" into an exception; the operator's answer posted twice after a restart. |
| `Executor` | `src/pi/executor.ts` | pi sessions through a 5-method `WorkerSession` interface (launch/prompt/subscribe/abort/dispose) | `fleet-dispatch`: a prompt fired at a pane with no receipt, no delivery state, and no answer to "did anyone work on this?". |
| `Assessor` | `src/pi/assessor.ts` | the router session: the engine delivers a Candidate, the session answers with `ticket_decide` | The ack classifier guessing intent from prose, and a classifier that hangs when nobody answers: the engine owns the deadline and re-asks. |

Two rules that survive the binding, both from this fleet's own defect history:

- **A report is a tool call, not prose.** The worker gets `ticket_report`; `state` becomes the ticket's
  state and `question` becomes the operator's queue item. A session that settles without calling it is
  `failed`, with a sentence saying it never reported — the "exit 0, printed nothing" class.
- **Only the engine writes a ticket.** A worker with shell access to its ticket file can mark its own work
  Done, which is how a board starts lying.

`EngineForExecutor` is `Pick<Engine, …>` from upstream: the adapter can only advance the domain, never
rewrite it. The SDK import lives behind `WorkerSession`, so `test/executor.spec.ts` and `test/bridge.spec.ts`
run the real engine, the real store, the real Source and the real Outbox with a fake session and a fixture
board: 241 tests, no model spend, no network.
