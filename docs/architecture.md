# Architecture

A GitHub issue is where people talk about the work. A ticket is how pi-superagent remembers whose
turn it is. The **router** keeps the two in step. It watches the repository, asks a **judge** to
interpret new requests, and gives each accepted task to a **worker** with its own terminal and
checkout.

## Follow a comment through the system

Imagine adding “Please keep the keyboard shortcut” to an issue while a worker is editing the menu.
On its next poll, the router reads your comment through the GitHub CLI. The GitHub source turns it
into a **trigger**, a message with an ID and a thread. The engine checks who sent it, finds the
ticket that already owns the thread and queues the comment for that worker.

A new thread takes one extra step. The judge reads the request and calls `ticket_decide`. An
acceptance opens a ticket and queues an acknowledgement on GitHub. The worker later calls
`ticket_report` with its outcome. If the report links a pull request, the router records that link
before the engine processes the report. That’s how an issue can stay active through code review
even after the worker has finished its first edit.

## If the router restarts halfway through

Suppose the router reads your comment and loses power a moment later. Whether the worker received
it depends on where the router stopped. Three records let it resume the conversation.

- **The GitHub read position** records how far the router has read. A poll saves its new position
  at the start of the next poll, after the engine has received the triggers. On replay, stable IDs
  let the engine recognize a comment, issue or review it has already seen.
- **The ticket and worker records** say who has the assignment. Each engine command commits its
  changes in one SQLite transaction. Worker starts, deliveries and stops follow that commit.
  The worker’s tab and files can outlive the router, which uses a saved position to resume reading
  the worker’s events and reports.
- **The outbox** records what the router owes the GitHub thread. If a reply was pending when the
  router stopped, a retry looks for the comment on GitHub before posting it again.

## The parts

### Ticket engine

The vendored state machine lives in `src/core/`. `intake.ts` routes triggers to an existing ticket
or queues an evaluation. `evals.ts` turns an accepted evaluation into a ticket.
`assignments.ts` records reports and tracks the running assignment. `tickets.ts` handles stops,
retries and wake-ups. `replies.ts` gives each acknowledgement or reply a stable queue key.
The synchronous engine reaches storage, processes and models through the interfaces in `ports.ts`.

### Router and intake

`src/pi/extension.ts` creates the store, GitHub source, judge, executor, outbox and panel. By default
the router polls every 30 seconds and also wakes when its pi session goes idle. A pass delivers new
triggers, reconciles PRs and closed threads, evaluates requests, starts pending work, checks for quiet
workers and flushes replies. Three consecutive GitHub poll failures set an error in `health.json`.

A pull read answers in three ways, not two (`PullRead` in `pulls.ts`): GitHub's body, the word `absent`
when the same token can read the repository and GitHub has no such number, and `unreadable` when the read
itself said nothing — a 404 from an account the repository is invisible to, a 403 from an IP allowlist, a
5xx, a dead token. Only the first two end a ticket's wait, because GitHub answers HTTP 404 for a pull request
that is gone and for one the token cannot see with the same bytes. An unreadable read keeps the follow open, is
named once per pull request per window (`pull.unreadable`, then `pull.unreadable_escalated`), and is counted
under `pulls` in `health.json` as `degraded` — a repository the token will never see is not an outage to
restart. The probe that tells the two apart asks the REPOSITORY the same question with the SAME token, because
the operator's rule of 2026-11-08 is that every call to GitHub is the one configured account. The window's read
count restarts with the router; the escalation and the first-seen time do not, because the measured incident is
a router that restarts. A report URL that is not a pull request link is `pull.parse_failed`.

`source-github.ts` tracks issues, comments and submitted reviews. It recognizes the router’s own
comments by the bot login or a hidden marker. `scopeOf` in `router.ts` checks each author’s GitHub
association or the configured login list before the trigger can reach a judge or worker.
`gh-api.ts` runs the CLI asynchronously, paginates issue and PR lists, and reads comments forward
from the saved position.

### Judge

`policyOf` in `router.ts` checks human authorship and bot patterns. For a request that needs a
decision, `assessor.ts` assembles the thread, messages, existing tickets and issue link.
`judge.ts` runs one candidate at a time in a headless pi session with a single tool, `ticket_decide`.
The session excludes extensions, skills and context files. The router overrides an acceptance if
an open ticket already owns the thread.

### Workers

`executor.ts` schedules an assignment and `herdr-workers.ts` starts pi in a new tab. By default the
worker gets a clone of the watched repository on its own ticket branch. Under `workers/<session>/`,
the router writes prompts to `inbox/` and the worker appends to `events.jsonl` and `reports.jsonl`.
A restarted router can adopt the tab and resume reading those files.

Inside the session, `worker-role.ts` registers `ticket_report` and the tool guards in `workspace.ts`.
The worker observes the order of its own events, so it can report a run that ended without a
report. A crash frees the slot immediately. On the first crash the router starts a replacement in
the same workspace and includes the previous failure in its brief.

A parked worker keeps its context and releases its slot. A finished worker’s tab stays open for
ten minutes. If pi is still busy, the router checks again ten minutes later. At startup it also
checks for tabs with no owning record or no corresponding herdr agent.

### Pull requests and replies

`pulls.ts` binds each reported PR to its ticket with `bindThread` before the engine processes
the report. That order matters. A ready report on a ticket with an open PR leaves it awaiting review.
When the PR leaves the watched repository’s open list, the follower checks whether it merged or
closed and calls `threadClosed`. For another repository it checks every two minutes and routes
comments and reviews through the qualified thread ID, `owner/repo#N`.

`receipts.ts` formats reports, questions, crashes and launch failures for the GitHub thread.
`outbox.ts` queues messages by ID. Failed posts remain pending, and a recurring launch failure
produces one notice. The source recognizes the hidden `<!-- superagent -->` marker on outgoing
comments. Sent entries expire after 30 days.

### Panel and process management

`server.ts` reads the engine store for each page or API request. It listens on `127.0.0.1:8788`
by default and logs the chosen port if it has to bind a free one. It checks the Host header against
loopback names and requires `x-superagent-request: 1` on API calls.

`scripts/superagent` configures the repository, starts or stops the router and reports health.
The macOS job in `launchd/` checks every five minutes. It restarts a down router and respects the
operator’s stop marker.

## The state directory

The router stores its local state under `~/.pi/superagent`. Set `PI_SUPERAGENT_STATE` to use a different directory.

| Path | What it holds |
| --- | --- |
| `tickets.db` | the engine's SQLite store, including read positions and the outbox |
| `config.env` | deployment settings, read by the start script |
| `engine.log` | the router's log, rotated at 5 MB |
| `health.json`, `setup.json`, `ready` | what `superagent status` reads |
| `workers/<session>/` | one directory per worker: its record, inbox, events and reports |
| `work/<ticket>/` | one workspace per ticket |
| `worker-bin/` | shims that refuse blocked commands, first on the PATH of each workspace's setup script |

To start over, stop the router and delete the directory. On the next start, the first poll records existing open issues as history.

## Where each guarantee lives

| Guarantee | Enforced by | Proved in |
| --- | --- | --- |
| One ticket per thread | intake routing in the engine; the router overrules a second accept | `Ticket.tla` I4 |
| A ticket completes only on a *ready* report | `core/assignments.ts` | `Ticket.tla` I2 |
| A person's stop is final | guards in `core/tickets.ts` and `core/intake.ts` | `Ticket.tla` I1 |
| One running assignment per ticket | the executor's launch guard | `Ticket.tla` I3 |
| Each acknowledgement queued and sent once | outbox keys in `core/replies.ts` | `Ticket.tla` I5, I6 |
| The initial poll treats existing open issues as history | the seed rule | `Intake.tla` C1 |
| One request per open interval of an issue | the seen set | `Intake.tla` C2 |
| No comment lost to a crash | deferred read positions | `Intake.tla` C3, C6 |
| No trigger accepted twice | content-derived ids | `Intake.tla` C4 |
| A bot never passes for a person | bot patterns and the policy gate | `Intake.tla` C5 |
| Only authors admitted by the source scope reach the judge or a worker | the source scope, `scopeOf` | tests only |
| A ticket with a pull request ends with it, as merged or closed | binding before the report, `threadClosed` | tests only |
| A live agent's tab is never swept | the liveness check in `closeStaleTabs` | `Workers.tla` W2, W4 |
| Dead workers' tabs do not pile up | the sweep and the linger close | `Workers.tla` W5 |
