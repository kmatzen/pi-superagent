# Formal verification

When is it safe to mark a GitHub comment as read? An early router saved its place as soon as it
read the comment. If it crashed before passing the message to the ticket engine, it restarted one
comment too far ahead. From the requester’s point of view, the worker had simply ignored them.

TLC found the precise sequence that lost the comment. It works by trying every ordering of events
allowed by a small model written in TLA+. That sequence became a regression test, and the router
now waits until the engine has received the comment before saving its place.

The project checks three such models. The ticket model asks who owns each conversation and how
work can end. The intake model follows messages across polls and crashes. The worker model follows
terminal tabs as agents start, finish and leave tabs behind.

| Specification | Models | States explored (distinct) | Claims |
| --- | --- | --- | --- |
| [`Ticket.tla`](../formal/Ticket.tla) | the engine's ticket lifecycle (`src/core`) | 12,325,891 (1,398,882) | 7 |
| [`Intake.tla`](../formal/Intake.tla) | the GitHub source (`source-github.ts`) | 565,551 (113,281) | 6 |
| [`Workers.tla`](../formal/Workers.tla) | worker records, tabs and agents (`herdr-workers.ts`) | 347 (94) | 5 |

The counts include repeat visits to a state. The numbers in parentheses count each distinct
state once. All listed properties hold within the bounds below. TLC also caught two errors in the
models themselves, one that dropped a batch of requests and another that revived a stopped ticket.

## Running the checks

```sh
scripts/check-formal    # all three specifications, about five minutes
```

The script needs a JDK (`brew install openjdk`, or point `JAVA` at one) and downloads `tla2tools.jar` to
`~/.cache/tla2tools/` on first use. It exits 0 only when every specification is checked to completion.
It exits 1 and prints the reason if Java is missing, a specification fails to parse, TLC finds a
violation or a run ends early.

## What each specification proves

### `Ticket.tla`: the ticket lifecycle

- **I1 StopAbsorbing.** A ticket a person stopped is never live again.
- **I2 DoneFromReady.** Every completed ticket has a recorded *ready* report.
- **I3 OneRunning.** A ticket has at most one running assignment.
- **I4 NoSecondTicket.** No ticket is created for a thread that a live ticket already follows, in any
  interleaving, including a follow-up that arrives in the middle of an evaluation.
- **I5 OutboxOnce and I6 SentMonotonic.** Each acknowledgement is queued at most once and sent at most
  once, and a sent message stays sent.
- **LT_Delivered.** Under the stated fairness, every incoming message eventually reaches intake: intake
  never stalls.

### `Intake.tla`: the GitHub source

- **C1 SeedSilence.** An issue that was open at the first look is never accepted unless it is closed and
  reopened.
- **C2 ReopenOnce.** An issue fires at most one request per open interval.
- **C3 NoGhostCommit.** The committed read position never passes a comment the engine has not accepted.
  This is the claim that found the bug: commit at read time, and TLC produces a crash that loses a request.
- **C4 NoDoubleAccept.** Acceptance is by id and permanent: a replayed trigger adds nothing, and nothing
  accepted is ever lost.
- **C5 BotNeverHuman.** A bot's comment is never accepted as a person's.
- **C6 NoLoss.** Through a crash, every posted comment is eventually accepted, and every issue opened
  after the first look eventually fires.

### `Workers.tla`: tabs, records and the sweep

- **W1 OneLive.** A ticket has at most one live worker.
- **W2 SweepKeepsLiveAgents and W4 NoTabLossUnderWork.** A worker whose record is live and whose agent is
  alive always keeps its tab. The sweep's liveness check makes this an invariant rather than a race.
- **W3 NoResurrect.** A record only moves forward, from free to live to ended, and returns to free only
  when it is retired. An ended record never becomes live again.
- **W5 ZombieTabsGone.** After any finite number of launches, every dead agent's tab is eventually closed:
  the workspace cannot fill up with abandoned tabs.

## Interpreting the results

Each action names the function whose guards it mirrors. A change to that function may change which
states the implementation can reach. Update the model and rerun the check when a transition changes.
For example, I1 depends on every path that might resume a ticket checking `ended.by === 'human'`.

The ticket model has two threads, two ticket slots and four messages. The intake model has two
issues, two comments and one crash. The worker model has two workers and three launches. These
bounds let TLC explore every ordering in minutes. Each model header records its exclusions.

The eventual-delivery and cleanup properties (LT_Delivered, C6 and W5) also depend on fairness.
An action that stays enabled must eventually run. The bounds on crashes and launches give the
system a chance to finish delivery or cleanup.

## Maintaining the models

- Put temporal formulas such as `[][A]_vars` under `PROPERTY`. Use `INVARIANT` for state predicates.
- Pass a tuple such as `<<x, y>>` to `UNCHANGED`. If an action assigns `x'`, omit `x` from that
  tuple unless the assignment really must preserve its value. Use `-coverage 1` to spot disabled actions.
- Give a model with a valid terminal state an explicit stuttering step (`Terminate == UNCHANGED vars`).
  This lets TLC distinguish normal termination from a deadlock. Liveness checks still detect stuck work.
- The intake model uses the state name `opened` because `open` caused a parse error.

## Scope

The models describe control flow. The judge’s decisions, GitHub API behavior, SQLite, herdr and network
failures have their own behavior outside these bounds. Integration tests cover review routing,
closing a conversation, checking for a previous post before retrying, and notifying the thread
when a worker’s run ends. Consult the test suite for those cases and the model headers for the
assumptions behind each property.
