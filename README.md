# pi-superagent

**Open a GitHub issue. An agent does the work and answers you there.**

pi-superagent watches one GitHub repository. When someone opens an issue, comments on one, or reviews a
pull request, a judge reads it and decides whether a person has asked for something concrete. If one has,
a ticket opens and a worker starts: a full [pi](https://github.com/badlogic/pi-mono) session in its own
tab of herdr, a terminal multiplexer for coding agents, where you can watch it work, type into it, or take
over. The worker finishes by calling a report tool, and the result arrives on the issue as a reply.

There are no labels to learn and no board to tend. The issue is the request, a comment is a follow-up,
and closing the issue is the stop.

The ticket engine underneath is DeepSeek's
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), vendored
byte-for-byte. This repository binds it to pi, herdr and GitHub.

## How a request travels

1. **Trigger.** A new issue is a request; so is a comment on an issue or a pull request, and so is a
   submitted review. On its first look at a repository the router records what is already there and
   fires none of it.
2. **Judgement.** The judge, a headless pi session, reads the request with its link and answers through
   a tool: *accept*, *ignore* (chatter, a note to a colleague, a thread that already has a ticket) or
   *stop*.
3. **Work.** An accept opens a ticket and posts the judge's acknowledgement on the issue. A worker starts
   in a workspace of its own, briefed with the ticket's mandate. Every later comment a person writes on
   the thread goes straight to that worker.
4. **Report.** The worker ends every run by calling `ticket_report`, and the router posts the report on
   the issue. A *blocked* report asks you a question there, and your reply goes straight back to the
   worker. A run that ends without a report, a worker that crashes, and a launch that fails are posted
   too, each with what you can do next.

Closing the issue, or merging the pull request that closes it, stops the ticket and says so on the
thread. Reopening the issue starts the request again.

## Why it is built this way

pi-superagent grew out of a setup where agents polled markdown cards, prompts were typed into terminal
panes, and a classifier guessed from prose whether a person had answered. Every failure there was the
same defect in a different hat: **state recorded as text, transitions guessed by readers.** Three rules
answer it:

- **A worker reports through a tool call, never in prose.** "Done" in a chat message changes nothing.
- **Only the engine writes a ticket.** A worker that could edit its own ticket could mark its own work done.
- **A restart loses nothing and repeats nothing.** A read position commits only once the engine holds
  what it produced, every trigger carries an id the engine accepts once, and every outgoing message
  carries an id the outbox posts once.

The ticket lifecycle, the GitHub intake and the worker sweep are specified in TLA+ and checked
exhaustively, 1.5 million distinct states in all, by one command.

## Run it

You need Node 22.19 or later, pi, a running herdr, and the GitHub CLI signed in to the account the agent
should reply as. Install this repository as a pi package (`pi install ./pi-superagent`). The extension
does nothing in any pi session the start script did not launch, so loading it everywhere is safe.

```sh
mkdir -p ~/.pi/superagent
cp config.example.env ~/.pi/superagent/config.env   # then set PI_SUPERAGENT_GITHUB_REPO
scripts/superagent start     # the router: a pi session in its own herdr tab
scripts/superagent status    # 0 healthy · 1 down · 2 a part is failing · 3 waiting for setup
scripts/superagent stop      # the router exits; its workers keep going
```

## Watching it

Everything happens in the herdr workspace `superagent`:

| Tab | What it shows |
| --- | --- |
| `engine log` | the router's log as it happens: every poll, judgement, launch and receipt |
| `engine` | the router itself, a pi session that stays quiet while its loop runs in the background |
| one per ticket | that ticket's worker, live, labelled `#141 · <issue title>` |

The panel at <http://127.0.0.1:8788/> answers three questions at a glance: does anything need me, what
is running, and what did the judge decide.

## Documentation

| Read | When you want |
| --- | --- |
| [Operator guide](docs/operator-guide.md) | to ask for work, watch it, and fix what goes wrong |
| [Architecture](docs/architecture.md) | the map: what runs, in what order, and which file owns each rule |
| [Design decisions](docs/design-decisions.md) | the reasons, each with the failure that taught it |
| [Formal verification](docs/formal-verification.md) | what the TLA+ specifications prove, and what they do not |
| [Adaptation ledger](ADAPTATION.md) | how the vendored engine is bound, and how to prove it unmodified |

## Repository layout

| Path | What it holds |
| --- | --- |
| `src/core/` | the vendored engine: tickets, evaluations, assignments, the outbox queue |
| `src/pi/extension.ts` | the router: wires the parts together and runs the loop |
| `src/pi/source-github.ts`, `gh-api.ts` | GitHub in: issues, comments and reviews become triggers |
| `src/pi/assessor.ts`, `judge.ts` | the judge: one candidate at a time, answered through `ticket_decide` |
| `src/pi/executor.ts`, `herdr-workers.ts` | workers: pi sessions in herdr tabs, and records that outlive the router |
| `src/pi/worker-role.ts`, `report-tool.ts`, `workspace.ts` | inside a worker: the report tool, the guard, the workspace |
| `src/pi/outbox.ts`, `receipts.ts` | GitHub out: what each ending says, each message posted once |
| `src/pi/store.ts` | the engine's SQLite store |
| `src/pi/server.ts` | the panel and its local API |
| `scripts/superagent` | start, stop, restart and status, with exit codes a health check can read |
| `formal/` | the TLA+ specifications |

## Development

```sh
npm install
npm run check            # typecheck and the full suite: no model calls, no network
scripts/check-formal     # model-check all three specifications (about five minutes; needs a JDK)
```

The suite clears every `PI_SUPERAGENT_*` variable before it runs (`test/setup.ts`), so no test can reach a
live router.

MIT licensed. The vendored engine is MIT licensed too; see [NOTICE](NOTICE).
