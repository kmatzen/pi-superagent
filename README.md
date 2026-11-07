# pi-superagent

**Open a GitHub issue. An agent does the work and answers you there.**

pi-superagent watches one GitHub repository. Open an issue with a concrete request, and a pi worker
takes it on. It can answer a question on the issue or open a pull request with a code change. Reply
on the issue to clarify the task, or request changes on the PR to send feedback to the same worker.

Each worker runs in its own herdr terminal tab. You can open the tab at any point to watch the
session, type a suggestion, or take over.

## Install

Use macOS or Linux with Git, Node 22.19 or later, [pi](https://github.com/earendil-works/pi),
[herdr](https://herdr.dev), and the [GitHub CLI](https://cli.github.com).
Sign into a model provider in pi and confirm your model appears in `pi --list-models`.
Use a GitHub account with write access to the repository you want to watch.

```sh
gh auth login
gh auth setup-git
pi install npm:pi-superagent
npm install -g pi-superagent
```

Pi loads the extension in router and worker sessions. The global npm install puts the
`superagent` command on your PATH. Use the same package version for both.

## Run your first ticket

Substitute the GitHub repository you want the worker to change. `init` checks the local tools
and your GitHub access, then saves the repository in `~/.pi/superagent/config.env`.

```sh
superagent init your-org/your-repo
herdr                      # keep it open, then use another terminal
superagent start
superagent status
```

Wait for the first GitHub poll in the **engine log** tab, then open a new issue asking for a small
change. The first poll records existing issues as the starting point. Watch for the acknowledgement
on your issue. The worker clones the watched repository into its own directory, switches to a ticket
branch, and posts the pull request on the issue. Request a change on the PR to send it back to the
worker. Merge when you are satisfied.

To supply your own workspace setup, set `PI_SUPERAGENT_PREPARE`. A replacement worker keeps the same
ticket directory. To narrow who can start work or give the router its own GitHub identity, see
[`config.example.env`](config.example.env). Stop the router with `superagent stop`.

## How a request travels

1. **Intake.** The router polls GitHub for new issues, comments and submitted reviews. By default it
   accepts input from authors GitHub identifies as owners, organization members or collaborators.
   The first poll records already-open issues as a baseline. Recent comments on them can still start work.
2. **Judgement.** A headless pi session reads the thread and calls `ticket_decide` to accept,
   ignore or stop. An accepted request opens a ticket. The router acknowledges it on GitHub and
   starts a worker. Later comments on the open ticket go directly to that worker.
3. **Report.** The worker calls `ticket_report`, and the router posts the result. If the worker
   needs a decision, it asks on the issue. Launch failures, crashes and runs that end without a
   report also get a reply. The router retries the first crash automatically.
4. **Review.** When the worker opens a PR, it includes the URL in its report. The ticket stays
   open for review until the PR merges or closes, even if the change belongs to another repository.
   An answer or investigation can finish with a ready report alone.

Closing the issue stops work on an ordinary ticket. Reopening it makes a fresh request.

## How the router tracks work

Earlier versions used Markdown cards and terminal output to infer whether a worker had finished.
Today the worker reports through a tool call, and the ticket engine records the transition.
A router restart can replay the last GitHub poll safely because the engine recognizes previously
accepted trigger IDs. The outbox tracks acknowledgements and replies separately so it can retry a
failed post.

The engine comes from DeepSeek's research prototype. Three TLA+ models cover ticket transitions,
GitHub intake and worker cleanup across more than 1.5 million distinct states.
[Upstream project](https://github.com/deepseek-ai/dsh-superagent-prototype) ·
[Verification scope](docs/formal-verification.md)

## Watch a worker

Open the `superagent` workspace in herdr to inspect the router or a worker.

| Tab | What it shows |
| --- | --- |
| `engine log` | the router's log as it happens: every poll, judgement, launch and receipt |
| `engine` | the router itself, a pi session that stays quiet while its loop runs in the background |
| one per ticket | that ticket's worker, live, labelled `#141 · <issue title>` |

The local panel shows tickets waiting for your input, running workers and recent decisions.
[Open the panel](http://127.0.0.1:8788/)

## Documentation

| Guide | Use it to |
| --- | --- |
| [Operator guide](docs/operator-guide.md) | Request work, follow progress and diagnose failures |
| [Architecture](docs/architecture.md) | Trace a request through the source files |
| [Design decisions](docs/design-decisions.md) | Understand why the router handles retries, reviews and stops this way |
| [Formal verification](docs/formal-verification.md) | Check the properties, model bounds and assumptions |
| [Adaptation ledger](ADAPTATION.md) | Verify the upstream copy and locate the local adapters |

## Repository layout

| Path | What it holds |
| --- | --- |
| `src/core/` | the vendored engine: tickets, evaluations, assignments, the outbox queue |
| `src/pi/extension.ts` | the router: wires the parts together and runs the loop |
| `src/pi/source-github.ts`, `gh-api.ts` | GitHub in: issues, comments and reviews become triggers |
| `src/pi/pulls.ts` | pull requests: bound to their ticket, followed until merged or closed |
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
npm run check:packed     # pack, install globally into a temporary prefix, run both halves from there
scripts/check-formal     # model-check all three specifications (about five minutes; needs a JDK)
```

`npm publish` runs `npm run check` and `npm run check:packed` before uploading the package.

The suite clears every `PI_SUPERAGENT_*` variable before it runs (`test/setup.ts`), so no test can reach a
live router.

Both projects use the MIT license. [Upstream attribution](NOTICE)
