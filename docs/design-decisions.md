# Design decisions

## Taking requests from GitHub

**Use a single intake path.** Issues, comments and submitted reviews all enter through
`source-github.ts`. Sharing the path keeps identity checks consistent whether someone is asking
for new work or steering a worker already running. Maintainers can make either request in the
GitHub thread where they will review the result.

**Check the author before routing the message.** An accepted request starts a worker with a shell
on the operator’s machine. A comment on an existing ticket goes straight to that worker, so a
permission check in the judge alone would miss follow-ups. The engine checks `scopeOf` first.
By default it admits the GitHub associations `OWNER`, `MEMBER` and `COLLABORATOR`. A missing
association fails the check. Setting `PI_SUPERAGENT_ALLOWED` replaces that rule with a login list.

**Establish a baseline on the first poll.** An early version treated an entire backlog as new work
when the operator connected a repository. The source now saves the initial set of open issues and
seeds the review cursor. Closing and reopening an issue makes it eligible again. Its updated
timestamp distinguishes the new trigger from the earlier one. See `Intake.tla` C1 and C2.

**Save later read positions after delivery.** A poll stages its read position for the next poll to
commit. If the router crashes after reading a comment but before the engine receives it, the old
position lets the router read it again. Stable trigger IDs make that replay safe. The initial
baseline commits immediately because it represents history already present at setup. TLC found
the comment-loss case in the original implementation. The regression test reproduces that event
order. See `Intake.tla` C3 and C6.

## Deciding what deserves a ticket

**Apply policy in code.** The router checks the author against current bot patterns even when a
stored trigger identifies the author as human. An older trigger once caused an agent’s request
for test approval to become a ticket to run the test. After the judge answers, the router also
checks whether an open ticket already owns the thread. The judge once accepted a duplicate despite
having the existing ticket in its prompt.

**Give the judge one request at a time.** Judging in the operator’s pane tied it up for an entire
model turn. Sending 41 candidates into one active turn produced answers out of order, and some
candidates expired before the judge got to them. The assessor now reuses one headless pi session
without extensions, skills or context files. It opens the session once because startup took 20 to
45 seconds and concurrent requests used to start separate judges.

## Running a worker

**Record outcomes through a tool.** A worker calls `ticket_report` with `ready`, `blocked`,
`failed` or `cancelled`. Only the engine updates the ticket. A reviewer can therefore distinguish
a worker saying “done” in conversation from a recorded ready report. When a run ends without a
report, the worker records a failure. See `Ticket.tla` I2.

**Post the outcome where the person asked.** Reports, questions, crashes and launch failures appear
on the GitHub thread with the next action available to the requester. The outbox deduplicates
repeated failures so a broken setup command produces one notice across many polls. A worker quiet
for 15 minutes appears on the panel. A long-running build can trigger this flag and continue.

**Keep tool use within the assignment.** Worker tool hooks check file edits and writes against the
ticket workspace, block configured commands and disable delegation by default. The prepare hook
also gets a PATH with shims for blocked commands. Operators can use these controls to restrict
personal tools such as `gh`. The brief asks workers sharing the machine to run builds sequentially,
bound parallel jobs and clean up processes when they finish.

**Replace a crashed worker once.** The engine records the failed attempt, frees its slot and
requeues unread comments. The replacement gets the original workspace and a brief explaining the
crash. A second crash on the same ticket requires attention. The limit applies per router process
and prevents a persistent fault from spawning a new tab every few seconds.

**Count active work against the cap.** A parked worker retains its session for follow-ups and frees
a slot for queued work. A reply can briefly take the active count above the cap. Counting every
open session used to leave a queue of 22 tickets waiting while an idle worker occupied one of four
slots.

**Check the tab before closing it.** A finished worker gets ten minutes for follow-ups. The router
closes its tab once pi is idle and checks again every ten minutes while it is busy. Startup cleanup
handles tabs with no owning record or whose agent herdr no longer knows. Since herdr has no guarded
close operation, the liveness check matters whenever someone could still be working in a tab.
See `Workers.tla` W2, W4 and W5.

## Ending a ticket

**Respect an explicit stop.** Once a person stops a ticket, later messages, wake-ups and retries
cannot resume it. Asking again creates a new ticket with its own history. See `Ticket.tla` I1.

**Follow the GitHub conversation.** When an issue disappears from the open set, the router can
observe the closure even if it cannot distinguish deletion, manual closure and closure by merge.
It stops the ticket and queues a notice. For a ticket awaiting its own PR, the PR’s merge or close
determines the outcome. Reopening an issue lets its author ask again.

**Bind the PR before processing a ready report.** A worker that changes a repository opens a PR and
includes its URL in its report. A number such as `#5` could also name an issue. Binding the URL
first lets the engine hold the ticket open for review. Merging or closing the PR ends the ticket,
and the issue receives the outcome. An investigation or deployment can finish with a ready report
alone. The worker knows which repository it changed, even when the request originated elsewhere.

The router calls the vendored engine’s `bindThread` and `threadClosed` transitions. It gets review
activity on the watched repository during the regular poll. For a PR elsewhere it polls every two
minutes, using three API calls per check.

**Route review feedback to the worker.** A submitted review on a bound PR goes to its ticket.
A review on an unrelated PR can reach the judge as a new request. GitHub accepts replies in the
PR conversation through its issue number. Opening a PR alone produces no request, so a worker can
deliver a change without triggering another worker to review it.

## Operating the router

**Keep ticket state in one store.** One router owns the synchronous SQLite store in its state
directory. All writes from an engine command commit together. Recovery reopens the same directory.
The router role is tied to the appointed process because pi also loads the extension in worker
and judge sessions. Previously those sessions could each start a router.

**Report health through exit codes.** A scheduled check can act on `superagent status`. Code 0
means healthy or intentionally stopped. Code 1 indicates a router failure that a restart may fix.
Code 2 directs the operator to a failing component, including a GitHub source that failed three
polls in a row. Code 3 identifies a setup problem.

**Limit panel access to local callers.** The panel binds to loopback, validates the Host header
and requires `x-superagent-request: 1` for API calls. These checks prevent a page on another
site from reading the queue or pausing the router through DNS rebinding.

## Maintaining the engine

The engine and its test suite match the pinned upstream revision. Local adapters live in
`src/pi/`, so an upstream fix can be imported and compared directly with its source.
[Adaptation ledger](../ADAPTATION.md)

The three TLA+ models live beside the implementation. Their actions name the functions they mirror
and their headers record the assumptions. When a transition changes, update its model and run
`scripts/check-formal`. The intake model’s crash counterexample is one case where checking all
orderings within a small bound found a failure the tests had missed.
[Architecture](architecture.md) · [Formal verification](formal-verification.md)
