# Formal verification

Three parts of pi-superagent, the places where a bad ordering would quietly lose or duplicate work, are
specified in TLA+ and checked exhaustively by TLC, the TLA+ model checker:

| Specification | Models | States explored (distinct) | Claims |
| --- | --- | --- | --- |
| [`Ticket.tla`](../formal/Ticket.tla) | the engine's ticket lifecycle (`src/core`) | 12,325,891 (1,398,882) | 7 |
| [`Intake.tla`](../formal/Intake.tla) | the GitHub source (`source-github.ts`) | 565,551 (113,281) | 6 |
| [`Workers.tla`](../formal/Workers.tla) | worker records, tabs and agents (`herdr-workers.ts`) | 347 (94) | 5 |

Every claim holds in every reachable state. The specifications have already paid for themselves: the
intake model found a bug in shipped code, a read position saved before the engine held its triggers, so
that a crash at the wrong moment lost a request for good. TLC printed the exact interleaving, and the fix
shipped with that interleaving as a regression test. Along the way TLC also caught two mistakes in the
models themselves (a dropped evaluation batch, and a stopped ticket brought back to life), which is
exactly what a checker is for.

## Running the checks

```sh
scripts/check-formal    # all three specifications, about five minutes
```

The script needs a JDK (`brew install openjdk`, or point `JAVA` at one) and downloads `tla2tools.jar` to
`~/.cache/tla2tools/` on first use. It exits 0 only when every specification is checked to completion. A
missing JDK, a parse error, a violated claim or a truncated run each exits 1 with a short reason: a check
that stays silent is treated as a failed one.

## What each specification proves

### `Ticket.tla`: the ticket lifecycle

- **I1 StopAbsorbing.** A ticket a person stopped is never live again.
- **I2 DoneFromReady.** A completed ticket always has a *ready* report, so completing without one is
  unreachable, not merely untested.
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

## Why the results mean something

**Each action mirrors real code.** Every action in a specification names the function whose guards it
copies. When that function changes, the action must change with it, and the check must run again.

**Each header says what the model leaves out.** Leaving behavior out narrows what a claim covers. A claim
holds for the behaviors the model includes, and for a left-out feature only as far as that feature's code
passes through the same guards. For example, every path that could resume a ticket checks the same
`ended.by === 'human'` guard that I1 relies on. The headers list what is missing so that a reader can
check this for themselves.

**The bounds are small on purpose.** Two threads, two ticket slots and four messages; two issues, two
comments and one crash; two workers and three launches. Small bounds let TLC visit every state in
minutes, and ordering bugs almost always show up at small sizes. They are still bounds, not a proof for
every size, and each header states its own.

**Liveness rests on stated fairness.** The "eventually" claims (LT_Delivered, C6, W5) assume that an
action which stays enabled eventually happens. Each specification writes its fairness assumptions down,
next to the claims, so they can be argued with. Crashes and launches are bounded, so "eventually" always
has an end.

**Lessons from TLC, so you can skip them.** A property with primed variables (`[][...]_vars`) goes under
`PROPERTY`, never `INVARIANT`. `UNCHANGED` takes a tuple `<<...>>`, not a set. An action that assigns
`x'` must not also list `x` in its `UNCHANGED`: the contradiction silently disables the action, and only
`-coverage 1` will show it. A specification whose runs can finish needs an explicit stuttering step
(`Terminate == UNCHANGED vars`), or TLC reports every finished run as a deadlock; stuck work is then
caught by the liveness claims. And naming a state `open` broke the parse, which is why the intake model
says `opened`.

## What the proofs do not say

A model proves things about the model. These cover the control flow described above, not the judge's
decisions, GitHub's behavior (status codes, rate limits, pagination), SQLite, herdr, or the network.
Newer behavior is tested but not modeled: reviews, the stop on a closed conversation, and the outbox's
check before a retry.

What the specifications do guarantee: no implementation that follows these transitions can reach a
forbidden state, and the liveness claims hold under the stated fairness. When the code a specification
mirrors changes, upstream's ticket transitions included, the specification must change with it.
