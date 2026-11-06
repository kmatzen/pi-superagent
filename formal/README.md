# formal/ — the dangerous parts, machine-checked

Three specs, checked to exhaustion by `./scripts/check-formal` (~5 min total,
exit 0 only when every proof completes):

| Spec | Models | States | Proves |
| --- | --- | --- | --- |
| `Ticket.tla` | core ticket lifecycle | 12.3M | stop-absorbing, done-from-ready, one-running, no-second-ticket, outbox-once, delivery liveness |
| `Intake.tla` | GitHub intake source | 566K | seed silence, reopen-once, crash-safe cursor (deferred commit), no double-accept, bot gate, no-loss |
| `Workers.tla` | worker records, tabs, agents | 347 | one live worker, sweep never closes a live agent's tab, no record resurrection, zombie tabs cleaned |

Claims, method, and scope: [docs/formal-verification.md](../docs/formal-verification.md).

`Ticket.tla` is a TLA+ model of what `src/core` does to a ticket: intake fans a
message to live subscribers and queues it for Eval only when no worker decides it;
accept creates one ticket with one pending assignment; only a `ready` report ends a
ticket completed; a person's stop absorbs; an outbox key sends once. Every action
carries a comment naming the core function it mirrors. `scripts/check-formal` runs
TLC to exhaustion (about 1.4M states, ~5 min on a laptop).

What is proved (all reachable states, plus the fairness-based liveness claim):

| Claim | Meaning |
| --- | --- |
| `I1_StopAbsorbing` | a ticket a person stopped is never live again — `wake`, `attach` and intake all guard on `ended.by === 'human'`, and no other door exists |
| `I2_DoneFromReady` | `done` implies the worker reported `ready` — silent success is unrepresentable in the model |
| `I3_OneRunning` | at most one running Assignment per ticket, the contract `runningAssignment` assumes |
| `I4_NoSecondTicket` | no ticket is ever created for a thread a live ticket follows, under every interleaving — including a follow-up that arrives mid-Evaluation |
| `I5_OutboxOnce` | an acknowledgement is queued at most once and sent at most once (keyed by trigger id) |
| `I6_SentMonotonic` | sent messages are never re-queued or forgotten |
| `LT_Delivered` | with minimal fairness, every emitted message is eventually delivered — the queue has no stalls |

Honesty rules for edits here: the model's guarantees bind only as far as its
abstractions. Each removed feature (context threads, follows/PR closes, eval expiry,
policy revalidation, attention) only removes transitions that could end or resume a
ticket — never adds soundness. A change to `src/core` ticket transitions must be
mirrored here, and the check re-run; TLC found two model bugs during development
(a dropped eval batch, a resurrected stopped ticket), which is the point of running it.
