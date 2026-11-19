# Adaptation ledger

If you follow a request from GitHub into the code, you’ll cross a boundary at `src/core/`.
DeepSeek’s dsh-superagent-prototype supplies the rules for opening a ticket, assigning a worker
and recording the outcome. This project supplies the pieces that talk to GitHub, run pi and keep
the worker’s terminal open in herdr.

That split gives maintainers a place to start. For a question about what a *ready* report means,
look in the engine. For a question about how that report becomes a GitHub comment, look in
`src/pi/`. The tables below identify the upstream files and the local code on either side.

## The baseline

The files below were imported from upstream commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` and matched it
byte for byte at the import (`ebdd633`). They do not any more: the Deviations table lists every local change
since, and a diff against upstream reports exactly those. The pinned revision is recorded in
`vendor/dsh-superagent/UPSTREAM_SHA`.

| Here | Upstream |
| --- | --- |
| `src/core/` | `src/core/` |
| `test/core-engine.spec.ts` | `tests/core-engine.spec.ts` |
| `vendor/dsh-superagent/docs/` | `docs/` |
| `vendor/dsh-superagent/LICENSE` | `LICENSE` |

Run these comparisons from the repository root. Each `diff` exits successfully only when the files are
identical; today it reports the deviations below.

```sh
git clone https://github.com/deepseek-ai/dsh-superagent-prototype /tmp/upstream
git -C /tmp/upstream checkout "$(cat vendor/dsh-superagent/UPSTREAM_SHA)"
diff -r /tmp/upstream/src/core src/core
diff /tmp/upstream/tests/core-engine.spec.ts test/core-engine.spec.ts
diff -r /tmp/upstream/docs vendor/dsh-superagent/docs
diff /tmp/upstream/LICENSE vendor/dsh-superagent/LICENSE
```

## Deviations

All of them. Taking an upstream change now means copying the baseline files AND re-applying this table; the
formal models already carry the semantics, so the models — not the ledger — were the running record of the
fork until this table existed.

| File | Deviation from upstream `8c32a9dc` | Introduced by | Reason |
| --- | --- | --- | --- |
| `src/core/engine.ts` | adds `release` and `wake` entry points; `stopTicket` gains a `kind` parameter | f4236a4, 5ef2c88 | free a worker that waits on a person; record whose act stopped a ticket |
| `src/core/tickets.ts` | `Tickets.release` (ends a running assignment as `released`, retags an ended one); `wake` accepts a live released ticket; `stop`/`end` carry `TicketStopKind`, and `stop` ends `by: 'human'` for an operator, `by: 'router'` for the router's own kinds; `stop` throws `ticketEnded` on an ended ticket; `release` requeues delivered-but-unread input; `attachable` reads the door predicate | f4236a4, 351cb7f, 5ef2c88, 2026-11-11 audit (#105, #108) | slots freed for questioning and reviewing workers; the answer starts the next worker; a stop that records nothing is a lie the panel told; `by` records whose act it was |
| `src/core/model.ts` | `TicketStopKind`; `ended.kind`; `TicketEndBy` gains `'router'`; `mandateWithdrawn`, the one door predicate (replaced the interim `resumableBySpeech`) | 5ef2c88, 92772cd, 2026-11-11 (#108) | `by` records whose act it was; one predicate reads whether the mandate stands |
| `src/core/intake.ts` | resume rule reads `mandateWithdrawn` | 5ef2c88, 2026-11-11 (#108) | the door above |
| `src/core/evals.ts`, `src/core/errors.ts` | `decide` refuses an unknown outcome kind instead of falling through to accept | 2026-11-11 audit | a malformed judge answer must not open a ticket |
| `test/core-engine.spec.ts` | conversation-door tests; release-requeue, stop-refusal and attach-door cases | 5ef2c88, 2026-11-11 audit | pin the doors above |
| `formal/Ticket.tla` | extended in lockstep: `released` variable, `Release`, `Resurrect`, `StopByRouter`, invariants R1–R3 and R5 | with each code deviation | the models are the proof the deviations keep the guarantees |

Record any future change here with the affected file, the commit and the reason. Maintainers will need that
history when they apply the next upstream fix — copying the baseline files alone now silently reverts every
row above, and `src/pi/extension.ts` calls `release`, `wake` and stop kinds upstream does not have.

## Local adapters

The engine is synchronous and does no I/O of its own. The interfaces in `src/core/ports.ts` connect it to storage, processes and
models. Their implementations live in `src/pi/`.

| Port | Bound in | How |
| --- | --- | --- |
| `Repositories` | `store.ts` | synchronous `node:sqlite` in WAL mode with `synchronous=FULL`, one transaction per engine command |
| `Policy` | `router.ts` (`policyOf`) | admits a trigger only from a person who is not on the bot list |
| `SourceScope` | `router.ts` (`scopeOf`) | filters incoming authors by GitHub association or the configured login list |
| `Assessor` | `assessor.ts`, `judge.ts` | candidates go one at a time to a headless pi judge, which answers with `ticket_decide` |
| `Executor` | `executor.ts`, `herdr-workers.ts` | one pi session per assignment, in its own herdr tab, reached through files that outlive the router |
| `Outbox` | `outbox.ts` | GitHub comments, queued once per id and marked sent only once GitHub accepts them |

The engine accepts triggers directly. `source-github.ts` converts issues, comments and reviews
into triggers and saves its read positions in the engine’s SQLite database. Upstream also ships a
Feishu source, an executor, a panel and a store. This project supplies its own GitHub integration,
herdr workers, panel (`server.ts`) and storage adapter (`store.ts`).

Only the engine writes a ticket — with one deliberate exception: the store's `pruneClosedTickets`, which at
startup deletes ended rows older than 90 days from behind the engine's back, and never a row still holding
undelivered input. The worker submits its assignment outcome through
`ticket_report`. A *blocked* report carries the question that the router posts for the requester.

## Tests

`test/core-engine.spec.ts` is the upstream engine suite. `test/sqlite-engine.spec.ts` runs the
same 113 cases against the local SQLite adapter, exercising the same transitions with persistent storage.

## Taking an upstream change

Copy the files listed in the baseline table to their corresponding local paths and update
`vendor/dsh-superagent/UPSTREAM_SHA`. If a ticket transition changed, update `formal/Ticket.tla`.
Run `npm run check` and `scripts/check-formal` against the new baseline.
