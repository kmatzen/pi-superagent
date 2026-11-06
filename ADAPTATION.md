# Adaptation ledger

The engine in `src/core/` is DeepSeek's, copied from upstream without a single change. This file is the
record that keeps that true: the commit it was copied from, how to prove the copy is exact, and where
everything that is *not* upstream plugs in.

## The baseline

Upstream commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`, also recorded in
`vendor/dsh-superagent/UPSTREAM_SHA`. At that commit these are byte-identical:

| Here | Upstream |
| --- | --- |
| `src/core/` | `src/core/` |
| `test/core-engine.spec.ts` | `tests/core-engine.spec.ts` |
| `vendor/dsh-superagent/docs/` | `docs/` |
| `vendor/dsh-superagent/LICENSE` | `LICENSE` |

To prove it, compare against a fresh clone. Every `diff` should print nothing:

```sh
git clone https://github.com/deepseek-ai/dsh-superagent-prototype /tmp/upstream
git -C /tmp/upstream checkout "$(cat vendor/dsh-superagent/UPSTREAM_SHA)"
diff -r /tmp/upstream/src/core src/core
diff /tmp/upstream/tests/core-engine.spec.ts test/core-engine.spec.ts
diff -r /tmp/upstream/docs vendor/dsh-superagent/docs
```

## Deviations

None. If one is ever unavoidable, list it here with the file, the upstream commit it was measured
against, what changed and why, so that the next upstream fix can still be merged by hand.

## Where this repository plugs in

The engine is synchronous and does no I/O of its own. Everything that touches a process, the network or
a model reaches it through an interface in `src/core/ports.ts`, and every binding of those interfaces
lives in `src/pi/`:

| Port | Bound in | How |
| --- | --- | --- |
| `Repositories` | `store.ts` | synchronous `node:sqlite` in WAL mode with `synchronous=FULL`, one transaction per engine command |
| `Policy` | `router.ts` (`policyOf`) | admits a trigger only from a person who is not on the bot list |
| `SourceScope` | `extension.ts` | every thread is listened to |
| `Assessor` | `assessor.ts`, `judge.ts` | candidates go one at a time to a headless pi judge, which answers with `ticket_decide` |
| `Executor` | `executor.ts`, `herdr-workers.ts` | one pi session per assignment, in its own herdr tab, reached through files that outlive the router |
| `Outbox` | `outbox.ts` | GitHub comments, queued once per id and marked sent only once GitHub accepts them |

Sources are not a port upstream; the engine simply receives Triggers. `source-github.ts` produces them
from issues, comments and reviews, with read positions kept in the same SQLite file as the engine's state.

Upstream ships its own executor, Feishu and GitHub sources, panel and SQLite store. None of them are
vendored: this repository replaces them with pi sessions in herdr, the GitHub source above, the panel in
`server.ts`, and the store in `store.ts`.

Two of upstream's rules carry through every binding:

- **A report is a tool call, not prose.** A worker's `ticket_report` call sets the state of its
  assignment; a question in a *blocked* report becomes the ticket's request for a person.
- **Only the engine writes a ticket.** A worker that could edit its own ticket could mark its own work
  done.

## Tests

`test/core-engine.spec.ts` is upstream's engine suite, unchanged. `test/sqlite-engine.spec.ts` runs the
same 113 cases against the SQLite store, with one line changed, because durability can only be tested
against a store that survives the process.

## Taking an upstream change

Copy upstream's `src/core/`, `tests/core-engine.spec.ts` and `docs/` over their counterparts here, update
`UPSTREAM_SHA`, and run `npm run check` and `scripts/check-formal`. If a ticket transition changed,
change `formal/Ticket.tla` to match before trusting the result.
