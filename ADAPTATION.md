# Adaptation ledger

The ticket engine comes from DeepSeek’s dsh-superagent-prototype. Use this ledger to verify the
upstream files and find the local code that connects them to pi, herdr and GitHub.

## The baseline

The files below match upstream commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` byte for byte.
The pinned revision is recorded in `vendor/dsh-superagent/UPSTREAM_SHA`.

| Here | Upstream |
| --- | --- |
| `src/core/` | `src/core/` |
| `test/core-engine.spec.ts` | `tests/core-engine.spec.ts` |
| `vendor/dsh-superagent/docs/` | `docs/` |
| `vendor/dsh-superagent/LICENSE` | `LICENSE` |

Run these comparisons from the repository root. Each `diff` exits successfully for an exact match.

```sh
git clone https://github.com/deepseek-ai/dsh-superagent-prototype /tmp/upstream
git -C /tmp/upstream checkout "$(cat vendor/dsh-superagent/UPSTREAM_SHA)"
diff -r /tmp/upstream/src/core src/core
diff /tmp/upstream/tests/core-engine.spec.ts test/core-engine.spec.ts
diff -r /tmp/upstream/docs vendor/dsh-superagent/docs
diff /tmp/upstream/LICENSE vendor/dsh-superagent/LICENSE
```

## Deviations

There are currently no local deviations. Record any future change here with the affected file, upstream
revision and reason. Maintainers will need that history when they apply the next upstream fix.

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

Only the engine writes a ticket. The worker submits its assignment outcome through
`ticket_report`. A *blocked* report carries the question that the router posts for the requester.

## Tests

`test/core-engine.spec.ts` is the upstream engine suite. `test/sqlite-engine.spec.ts` runs the
same 113 cases against the local SQLite adapter, exercising the same transitions with persistent storage.

## Taking an upstream change

Copy the files listed in the baseline table to their corresponding local paths and update
`vendor/dsh-superagent/UPSTREAM_SHA`. If a ticket transition changed, update `formal/Ticket.tla`.
Run `npm run check` and `scripts/check-formal` against the new baseline.
