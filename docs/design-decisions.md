# Design decisions

Each section states a rule the system keeps and the failure that taught it. Where each rule lives is
mapped in [architecture.md](architecture.md); the proofs are in [formal-verification.md](formal-verification.md).

## GitHub is the only way in

Every request arrives as an issue, a comment or a review on one repository. There is no command-line
submission, no board and no label vocabulary.

Each extra door grows its own answers to "is this a person?" and "is this addressed to me?", and the
agent's behavior then depends on which door a request happened to use. With one door, the identity rules
live in one file (`source-github.ts`) and the admission rule in one function (`policyOf` in `router.ts`).

## The first look is silent

The first time the source sees a repository, it records every open issue and fires none of them. Only
issues opened afterward are requests.

The first version, pointed at a repository with a backlog, fired every open issue at once. A backlog is
history, not a queue of fresh requests. Closing and reopening an issue, though, is a person saying "go
again": a closed issue leaves the seen set and fires when it returns, under a new trigger id, because the
id includes the issue's last update. The review cursor seeds the same way. (`Intake.tla` C1, C2.)

## Read positions commit late; seeds commit at once

A poll stages its read positions, and they commit at the start of the next poll, once the engine holds
every trigger they produced.

Committing at the moment of reading leaves a window: if the process dies between reading a comment and
handing it to the engine, the saved position already points past a request the engine never saw, and
that request is gone. A position that commits late can only cause a replay, and replays are free because
the engine accepts each trigger id once. A seed is the mirror image: losing one would replay the backlog,
and a seed can never swallow a request, so it commits immediately. The model checker found the early
commit in shipped code; the fix ships with the counterexample as a regression test. (`Intake.tla` C3, C6.)

## Code admits; the model judges

A policy gate in code admits a trigger only from a person who is not on the bot list. Only then does
the judge see it. When the judge accepts a thread that already has an open ticket, the router overrules
it and records an ignore.

A model's verdicts wobble; the deterministic layer keeps a wobble from turning bot traffic, the agent's
own comments or a duplicate into work. Both checks were learned. A trigger stored before bot names were
matched as patterns still said "human", and an agent asking the operator to approve a test became a ticket
to run it; the gate now checks the author again. And the judge once opened a second ticket on a thread
whose first ticket was right there in its prompt.

## The judge works alone, one question at a time

Judgements go to a headless pi session that loads no extensions, skills or context files, never to the
operator's own pane, and the assessor hands it one candidate per turn.

Judging in the operator's pane made the pane look frozen for every model turn. Sending candidates in a
burst was worse: 41 of them steered into one running turn came back out of order, and the tail expired
unanswered. The judge is also opened once and shared: opening a session takes 20 to 45 seconds, and
before that rule every eval arriving in the window opened its own.

## Workers report through a tool, never in prose

A worker ends its assignment by calling `ticket_report` with a state: ready, blocked, failed or
cancelled. Only *ready* completes a ticket.

A model that says "done" in prose while having done nothing must be unable to complete anything. In the
lifecycle model, completing without a *ready* report is not merely untested but unreachable
(`Ticket.tla` I2). A run that ends without a report completes nothing either: the worker files it as a
failure, and the person hears about it on the thread.

## Every ending reaches the thread

Whatever ends a worker's run is posted on the issue: its report, its question, a crash, a run that ended
without a report, a launch that never got going. Each message says what happened and what the person can
do next. The one exception is the 15-minute quiet flag, which stays on the panel: a long build is not news.

The person who asked is on GitHub, not on the panel. An ending they cannot see is a request that died in
silence, and a question they cannot see is a worker waiting forever. The same ending posts once per
assignment, so a launch that fails on every poll says so once, not every 30 seconds.

## A worker is fenced in

Inside a worker, a guard refuses delegation tools, refuses blocked commands, and refuses writes outside
the ticket's workspace. The workspace's setup script, which runs before pi does, meets the blocked
commands as refusing shims first on its PATH. The brief also tells the worker that the machine is shared.

Delegated work leaves the mandate, the workspace and the report behind. Blocked commands are the
operator's personal tools (`gh`, for instance), and the operator's identity is not the worker's to use.
The shared-machine brief exists because workers run side by side with each other and with people:
sequential builds, bounded parallel jobs, and no process left running after the report.

## A crash gets one fresh worker, not a loop

When a worker crashes, the router retries the ticket once on its own, through the engine's retry. The
crashed attempt ends on record, the comments it never read go to the new worker, and the new worker's brief
says what happened, because the old one's changes are still in the workspace. A second crash on the same
ticket waits for a person. Either way, the crashed worker's slot is freed at once.

A lost tab or a killed process is usually bad luck, and one retry rides it out without waking anyone. A
worker that crashes every time is a bug, and looping on it would open a new tab every few seconds while
hiding the problem. One retry per ticket per router process is the same bound that startup recovery uses,
and the lifecycle model already covers it: `Ticket.tla` lets a retry happen at any moment after a failed
report.

## A person's stop is final

Once a person stops a ticket, nothing revives it: no new message, no wake-up, no retry. A request made
again becomes a new ticket.

A stop is a person saying "not now". An agent that resumes what it was told to stop teaches everyone that
their words do not count. (`Ticket.tla` I1.)

## A closed conversation stops its ticket

GitHub ends a conversation in three ways: a merge closes the issue it names, a close says no, and a
deletion says never mind. All three look the same from a poll, because the thread leaves the set of open
issues and pull requests. The router then stops the ticket with a person's stop, posts one notice on the
thread, and stays quiet until the issue is reopened.

Closing the issue is the one stop that needs no tool and no knowledge of the system. Tickets on threads
from other sources are left alone: the router can only tell whether a GitHub thread is open.

## A review is a request; opening a pull request is not

A submitted review, whether it requests changes or approves, is a person speaking about delivered work,
on a conversation the ticket already owns. It fires a fresh judgement, and the reply lands in the pull
request's own conversation (on GitHub a pull request is also issue N, so no second address is needed).

Opening a pull request is a delivery, not a request. Treating every opening as a trigger would make the
agent a mandatory reviewer of its own output, a loop that feeds itself.

## Only work holds a slot

The cap counts workers on a run. A worker between runs, waiting on a person's answer or simply done, is
parked: it keeps its session and its context, and its slot goes to the next ticket in the queue. A reply
puts it back on a run, even past the cap for a while.

A slot is the machine's capacity, and an idle session uses almost none of it. When every live worker held
a slot, a queue of 22 tickets waited while one of the four slots belonged to a worker that had finished its
run without saying so.

## A tab is closed only when nobody is in it

A finished worker's tab stays open for ten minutes of follow-up and then closes only if its pi sits idle;
while the agent is busy, the router looks again every ten minutes instead of giving up.
The startup sweep closes a worker tab only when no record owns it or herdr no longer knows its agent.

Worker tabs do outlive their purpose: a restart adopts a worker, a stop starts a newer one, and the older
tab stays behind, so a sweep has to exist. But herdr has no guarded close, and a tab is someone's
terminal. The liveness check is the single guard that keeps the sweep away from an agent that is still
working. (`Workers.tla` W2, W4, W5.)

## One router, one store, one state directory

One router runs at a time, and one process holds the engine. The store is synchronous SQLite, and
everything the system knows lives in one directory.

The engine's commands are atomic only if the store is synchronous: an asynchronous driver would turn that
atomicity into a comment. One directory makes the crash model concrete. A restart is "start again with
this directory", which is exactly what the specifications model. One router per process matters too: the
judge and every worker load this same extension, and each of them used to boot a router of its own.

## Health is an exit code

`superagent status` answers with a number: 0 healthy, 1 down, 2 a part is failing, 3 waiting for setup.
A router that fails three polls in a row reports its GitHub source as failing.

A scheduled check should act without reading prose, and each code has one remedy: a restart may fix 1
and fixes neither 2 nor 3. A router that cannot reach GitHub otherwise looks healthy forever, answering
nothing.

## The panel is local and cannot be steered from a web page

The panel binds 127.0.0.1, refuses any Host header but 127.0.0.1 and localhost, and serves its API only
to callers that send `x-superagent-request: 1`.

A browser will not let another site forge either one. Without them, any page you visit could read the
queue, or pause the engine, by rebinding a hostname to localhost.

## The engine stays byte-identical to upstream

`src/core/` and its test suite are vendored from upstream and never edited. Every adaptation, from the
judge's prompt to the GitHub shapes, lives in `src/pi/`.

The engine is the part the lifecycle specification models and upstream maintains. Untouched, an upstream
fix can be re-vendored by copying, and the specification keeps describing the code that runs. The
[adaptation ledger](../ADAPTATION.md) says how to prove the copy is exact.

## The specifications live beside the code

`formal/` holds three TLA+ specifications, and `scripts/check-formal` checks all of them exhaustively in
about five minutes. Every action names the function it mirrors; every header states what the model
leaves out.

A proof that cannot be re-run in one command rots. These are cheap to keep honest, and they have paid:
the intake specification found a request-losing bug in shipped code.
