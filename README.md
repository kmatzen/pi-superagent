# pi-superagent

A supervisor-and-workers engine for coding agents, vendored from DeepSeek's
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) (`src/core`, unmodified)
and bound to [pi](https://github.com/badlogic/pi-mono) sessions. MIT, see `NOTICE` and `ADAPTATION.md`.

**The front door is GitHub issues.** Open an issue that asks the agent for something; a judge assesses it,
opens a ticket, a worker (a real pi session in a herdr tab) does the work, and the result is posted back as
a reply on your issue. No labels, no board, no ceremony.

## Docs

| Read | For |
| --- | --- |
| [docs/operator-guide.md](docs/operator-guide.md) | running it day to day: start, watch, recover, config |
| [docs/architecture.md](docs/architecture.md) | the map: components, the path of one request, where each guarantee lives |
| [docs/design-decisions.md](docs/design-decisions.md) | why the rules are shaped this way, each with the incident behind it |
| [docs/formal-verification.md](docs/formal-verification.md) | the three TLA+ specs, what they prove, what they don't |
| [formal/README.md](formal/README.md) | the specs themselves — `./scripts/check-formal` (~5 min) |

## How a request travels

1. **Trigger** — your issue (title + body) or a comment on one. Existing issues at first start are seeded
   silent; a new issue, a reopened one, or a new comment fires.
2. **Judgement** — a headless pi session reads the request with its URL and answers `accept`, `ignore`
   (chatter, questions to a person, requests that already own a ticket) or `stop`.
3. **Ticket + worker** — accept opens a ticket; the executor starts a herdr tab named for the issue, running
   a real pi session in a per-ticket workspace.
4. **Report** — the worker answers with a tool call, never prose. A run that ends without reporting is
   `failed`. The result (and the acknowledgement) is posted to the issue.

The domain model is the upstream core: Trigger → Policy → Ticket/Mandate → Assignment → Executor → Report.
The state machine answers "did anyone work on this, and what did they say?" without guessing from logs.

## Why this exists

This fleet ran a board where agents polled markdown cards, prompts were fired at terminal panes, and a
classifier guessed from prose whether a human had answered. Every one of those is the same defect wearing a
different hat: **state recorded as text, transitions guessed by readers.** So:

- A worker reports with a **tool call**, never with prose. Silent success is treated as the defect class it is.
- **Only the engine writes a ticket.** A worker that can edit its own ticket can mark its own work Done.
- **A restart replays nothing.** Read positions and outbox statuses commit in the same SQLite transaction
  as the effects they describe.

## Watching it

Everything lives in the herdr workspace `superagent`:

| Tab | What you see |
| --- | --- |
| `engine log` | the engine's live log: every judgement, dispatch and receipt (`tail -F ~/.pi/superagent/engine.log`) |
| one per ticket | the worker's own pi session, live — labelled `#141 · <issue title>` |
| `engine` | the router session: a control panel, quiet by design (its work runs as background services inside it) |

The panel at `http://127.0.0.1:8788/` answers: does anything need me, what is running, what did the judge
decide and why. Ticket rows link to their GitHub issues.

## Run it

```sh
scripts/superagent start                      # the router: a pi session in herdr (needs the herdr server)
scripts/superagent status                     # 0 healthy, 1 down, 2 running with a failing part, 3 waiting for setup
scripts/superagent stop                       # asks pi to exit, closes the router tab; workers survive
```

Deployment settings live in `~/.pi/superagent/config.env` — start from [`config.example.env`](config.example.env); `PI_SUPERAGENT_GITHUB_REPO` is the one that
matters. State lives in `PI_SUPERAGENT_STATE`: `tickets.db`, `engine.log`, `workers/<session>/`,
`work/<ticket>/`.

## Layout

| Path | What it is |
| --- | --- |
| `src/core/` | the vendored engine — byte-identical to the upstream commit named in `ADAPTATION.md`. |
| `src/pi/source-github.ts` | issues and comments → Triggers, with the durable read position. |
| `src/pi/gh-api.ts` | GitHub through the `gh` CLI: credentials stay in the operator's keyring. |
| `src/pi/herdr.ts`, `herdr-workers.ts` | the herdr CLI client and worker lifecycle (tabs, records, sweeps). |
| `src/pi/executor.ts`, `worker-role.ts` | Assignments → pi sessions; the worker guard that refuses delegation. |
| `src/pi/assessor.ts`, `judge.ts` | what the judge sees, and the headless session that answers. |
| `src/pi/server.ts` | panel + management API over the engine's own store. |
| `test/` | the real engine, store, sources, outbox and executor against fixtures: no model spend, no network. |

`npx vitest run` and `npx tsc --noEmit`. The suite scrubs `PI_SUPERAGENT_*` from the environment
(`test/setup.ts`) so tests can never talk to a live engine.

`scripts/check-formal` model-checks the ticket lifecycle (`formal/`): TLC exhausts ~1.4M reachable
states of the core's transition system and proves the lifecycle claims — stop is absorbing, done
requires a ready report, one ticket per thread, outbox sends once — in every interleaving.
