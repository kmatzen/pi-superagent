# Keeping the fleet running: liveness that does not depend on the worker

Status: L2 shipped (2026-11-10); L1, L3, L4 proposed. Owner: the router's operator. Affects `src/pi` (executor,
extension), the panel's load line, `formal/`, and one scheduled audit. No `src/core` change is required for the
first increment.

Measured on 2026-11-10, at 04:10Z, with the router healthy: `tick n=199 running=8 parked=4 cap=8 open=23`,
ticks ~1.2 s, 110 workers released in the previous 24 h (41 `ready`, 55 `blocked`, 14 `quiet`), 10 of the 18
newest followed pull requests merged, and all eight board issues the router had ended by asking a person were
closed. The ask/delivery split and the closure ask work in production.

Four of eight worker sessions were alive and doing nothing, 5 to 11 hours each, and four board issues labelled
for the agent had no live ticket, the oldest starved 45 hours. Those two facts are related, but not the way the
first version of this document said. See *Correction* below.

| ticket | pane state | silent | what it last said |
| --- | --- | --- | --- |
| #194 | idle | 10.7 h | "Reported. Nothing new came in, so I changed nothing" — finished, pull request ready |
| #335 | idle | 7.6 h | "Built it — seed control shipped, ready at pull request 316" — finished, pull request ready |
| #347 | done | 5.6 h | "Now writing the artifact. First the machine-readable registry:" — turn ended mid-work |
| #349 | done | 5.2 h | mid-diagnosis, last words about a provider stream contract error — the turn died |

The router published `running=8 cap=8` the whole time. Every one of those slots was a lie, and the cost landed
where the operator cannot see it: four board issues labelled for the agent had no live ticket, the oldest
starved 45 hours.

## Root cause, in one sentence

**A crash is recorded as a failure even when the worker's own last word was `ready`, so the router relaunches
work that is already shipped** — and the report the worker made, the only record of what it finished, is what
gets overwritten.

The code already knew the shape of the hole. `src/pi/extension.ts:303` excludes `ready` from the
release-when-a-human-is-the-only-blocker rule with the comment: *"that report ends the ticket, and ending it
needs the worker's own turn-end bookkeeping (measured: releasing on ready left the ticket unended)"*. So the
cooperative path is load-bearing by design, and the cases above are the workers that never reach it.

## Correction (2026-11-10, same day, after shipping the guard below)

The first version of this document claimed the four idle sessions held four of eight worker **slots**, and that
this starved the queue. That was wrong, and the code says so: the launch gate is `gateClosed = running >=
capacity` (src/pi/executor.ts:343) and `get running()` counts workers **on a turn** (src/pi/executor.ts:118),
while `parked` counts the alive-and-settled rest. The tick at 04:10Z read `running=8 parked=4 cap=8`: the four
idle sessions were the parked four, they were visible all along, and they took no slots.

What the four cost is real but smaller: a live session, a herdr tab, and a panel entry per ticket that will never
speak again, with no signal that distinguishes "waiting for a person" from "dead". What starved the queue is a
different problem, and the doc now names it: **cap 8 against turns that run for hours, with no aging and no
fairness among labelled asks**. Four busy workers on long builds is enough; at 04:25Z the freed slots went to
relaunches (D2), and the queue sat, which is what the guard fixes. `executor.quiet()` (src/pi/executor.ts:302) is the only silence detector, and it *reports once per silent
stretch* — it never frees the slot it reports.

Three defects follow from the same root, and each one was measured on 2026-11-10:

- **D1 — parked workers are never reaped.** A settled worker keeps its session, tab, and live entry forever
  (measured: 4 parked, 5.2 to 10.7 h). It costs no slot, so it does not starve the queue; it costs tabs, memory,
  and an honest panel. `executor.quiet()` (src/pi/executor.ts:302) is the only silence detector, and it
  *reports once per silent stretch*.
- **D2 — relaunch has no memory of the report.** `src/pi/extension.ts:310` relaunches on any `origin ===
  'crash'` with no look at the last report's state. After the operator freed the four slots by closing the
  panes (04:25:32Z), the engine relaunched all four tickets, including the two whose workers had reported the
  work shipped with a pull request open for review. Freed capacity went to work that was already done.
- **D3 — starvation is invisible, and unaged.** The tick publishes `running`, `parked` and `cap`, never the
  depth of labelled work waiting for a slot, and the launch order has no aging. A 45-hour wait reads as
  `running=8 cap=8`.

## Design

Four mechanisms, each one testable on its own, in the order that pays.

### L1 — liveness from an outside signal

> Status 2026-11-10: the guard (L2) shipped the same day; L1 is not yet built, and its value is now re-ranked —
> it reaps parked sessions and labels them honestly, it does not recover capacity.

The executor gains a second source of truth for "is this worker working": the pane it runs in. The host already
answers it — the agent table reports `working`, `idle`, `done`, `blocked` per pane, with the pane's cwd, which
is the worker's workspace.

```
verdict(worker) =
  'working'   if pane is working
  'awaiting'  if pane is blocked            // a person is the only blocker: park, do not reap
  'lost'      if pane is idle|done and no report arrived and quietSeconds > LOST_MINUTES
  'running'   otherwise (starting, between reports)
```

`lost` is terminal and the router acts on it: release the slot, stop the ticket with a new stop kind
`liveness`, and re-offer the work under L4. Default `LOST_MINUTES = 6`, one poll per tick, and the pane read is
one batched call for the whole fleet, not one per worker.

Why the pane and not a worker heartbeat: it needs no change to the worker prompt, it covers a worker killed by
the host, and it works for the panes that exist right now. A cooperative turn-end heartbeat (L1b) is strictly
better on precision and stays on the roadmap; it must not be the primary signal, for the same reason the
report is not.

### L2 — relaunch consults the last report

> **Shipped 2026-11-10** in this branch: a crash keeps the state the worker itself reported (`src/pi/executor.ts`
> crash path) and the relaunch reads it (`src/pi/extension.ts`), with two tests. The table below is the rule.

The crash branch reads what the dead worker last said:

| last report | action |
| --- | --- |
| `ready` | do not relaunch — announce, and let the ticket end on the receipt; the delivery exists |
| `blocked` / `waiting` | do not relaunch — park, the ticket is a question waiting for a person |
| `failed`, `lost`, or nothing | relaunch, bounded by L4 |

This is a six-line guard on `src/pi/extension.ts:310`, and it is the difference between a freed slot that frees
the queue and a freed slot that re-runs a shipped change.

### L3 — publish starvation, then card it

The load line becomes `running/cap parked queued starved oldestStarvedH` where `starved` counts board issues
labelled for the agent with no live ticket, and `oldestStarvedH` is the age of the longest-waiting one. A
starved count above zero for more than 30 minutes posts one board card naming the issues and the slot
arithmetic, rate-limited to one card per 12 hours. The operator learns the queue exists from the board, not
from an audit.

### L4 — bounded re-entry

Each ticket carries a relaunch budget (3), stored on the assignment, decremented by L1 and L2. Exhausted means
the ticket parks with a visible ask naming the cause of each attempt, and it never churns again without a human
reply. Without L4, L1's reaper turns a poison ticket into a worker factory.

## Metric definitions (shipped, live in the tick line)

Two numbers, because one number answered two questions silently and disagreed with an independent audit twice on
2026-11-10: PR 56 counted a spent grant label, PR 58 counted an open ticket as a worker.

- **`starved`** — labelled asks the engine has never put anyone on: no ticket, or a ticket whose only assignment
  is a queued launch. Answers *what would a free slot unblock?* Age is `oldestStarvedH`.
  Measured 2026-11-10, that sentence overpromises for part of the queue: the mandate to launch comes from the
  one-shot `agent-requested` grant, and a standing `agent-ready` label whose grant was spent by earlier workers
  entitles the ask to nothing. Issue 274 sat 49.4 hours with 6 of 8 launch slots free for exactly that reason
  (one ticket, two assignments, both `ended`). So a free slot unblocks a queued-launch ask, and unblocks nothing
  for a grant-spent one; the panel cannot tell you which is which yet, which is the open ask in board issue 358.

- **`unanswered`** — labelled asks with no worker on them now. A live session, a queued launch, `ready` awaiting
  review, and `blocked` awaiting a person all clear it. Answers *what does the board still owe an answer to?*
- The gap `unanswered - starved` is work that ran and ended on a ticket nobody reviewed. Capacity does not close
  it; only review does. Measured at deploy: `starved=2`, `unanswered=4`, oldest 46.9h.
- The label counted is the standing `agent-ready`, never the one-shot `agent-requested` grant the router spends.

## Invariants

Add to `formal/Ticket.tla` (names indicative):

- **I6 slot liveness.** Every assignment in `running` leaves `running` within `LOST` ticks, or the ticket is
  parked. No `running` state persists by silence.
- **I7 no queue starvation with free capacity.** If a labelled ask has no assignment and a slot is free, that
  ask gets an assignment within `K` ticks. This is the invariant the 45-hour starve violated.
- **I2 stays.** `running <= cap` at every tick, with `running` now defined by verdict, not by bookkeeping.

No vacuous proofs: I7 must be falsified by the current model (a worker that never reports), then shown true
under L1+L4.

## Tests

1. A worker that goes silent with a live pane reports `running`; at `LOST_MINUTES` with an `idle` pane it
   reports `lost`, the slot frees, and the tick's `running` drops.
2. A worker whose last report is `ready` and whose pane dies is not relaunched (D2 regression).
3. A ticket with an exhausted budget parks and posts the ask, naming the cause of each attempt.
4. `starved` counts a labelled issue with no live ticket, and the card fires once per 12 h.
5. Startup takeover: adopted panes are judged by verdict, so the startup relaunch (src/pi/extension.ts:896)
   cannot re-spawn a shipped ticket.

## Rollout

1. Land L1 in observe-only: compute and log the verdict, change nothing. One day of `verdict=lost` lines
   against real panes calibrates `LOST_MINUTES` and proves the pane read is affordable.
2. **Done 2026-11-10.** L2 shipped with the correction above: a crash keeps the worker's report, and the relaunch
   reads it. Safe to ship on its own, and it is the difference between a freed slot that frees the queue and a
   freed slot that re-runs a shipped change.
3. Turn L1 enforcement on behind the same flag; land L3 with the panel and card; land L4 with the budget field.
4. Add I6/I7 to the formal model with the falsification, and extend the operator guide with the queue line.

Estimated size: ~150 lines in `src/pi`, ~40 in the panel, 1 TLA+ invariant set, 5 tests. No protocol change, no
worker-prompt change, no new dependency.

## Interim (no engine change, available today)

The operator's lever for a leaked slot is the pane: closing the tab ends the session, and the engine's crash
path frees the slot. Proven 2026-11-10 at 04:25:32Z, four slots in one action. It relaunches, so pair it with a
look at the last report (L2 in human form) before closing the panes of tickets that already shipped.

The audit that produced this document is three scripts in the operator's local scripts directory — the ticket
census, the board/PR reconcile, and the stuck-ticket probe — and they are the scheduled check that L3 replaces.

## Approved policies, not yet implemented (2026-11-10)

The operator approved both of these. Nothing in the code implements them yet, so this section is the
handoff. Measured reason: 14 of 22 open tickets sat parked on one report summary, `the worker finished its
run without calling ticket_report`, and 5 standing asks sat 57 hours in the queue with 8 free slots.

### 1. A silent worker gets one nudge, then the failure a person owns

Today `worker-role.ts` files the failure on `agent_settled` whenever no `ticket_report` landed in that run
(`SILENT_FINISH`). New rule: the first silence writes a nudge into the worker's own inbox and files no
report; the second consecutive silence files the failure, which is the case a human owns.

- The nudge rides the inbox as a `.json` file with `{ text, mode: 'followUp' }`. `drain()` sends it, so no
  router change and no state machine change. `003-execution.md` still sees one report per assignment.
- **One nudge per worker, not per run.** A counter reset on `agent_start` lets a worker that finishes
  silently be nudged forever. Proved by test, and the reason the first implementation was reverted.
- Four tests encode the old rule and must be restated with it, not deleted: the refused-pull-request report
  (a refused report is no report, so the first silence nudges), the busy-events test (a `selfNudge` event
  joins the log), the reported-then-silent test (the next silent run is nudged), and the two inbox-listing
  tests (the nudge file is not a router input, so filter it out).

### 2. A worker that ends its turn re-earns the launch, with a cap

`agent-requested` is spent by the first worker, so a standing `agent-ready` ask entitles nothing after it.
New rule: when a worker for an ask ends, the ask gets one fresh grant, and the cap is small (two per issue
per day). The queue sweep in `extension.ts` then starts it.

- The cap must be a stored counter with a date, not a label count: labels are the operator's surface, and a
  label the router adds and removes is a surface that lies.
- The starved metric must count a re-granted ask as entitled, or `starved=0` becomes a lie again; the gloss
  above this section is the one that fixes the reading, this section fixes the number.

## The reconcile pass (approved, same date)

Four sites release a worker, each with its own predicate: a closed pull request, the stalled-launch sweep,
the duplicate-worker sweep, and the 15-minute quiet rule. Fold them into one pass over live workers with a
named rule list, and delete the duplicated `awaitsAHuman` predicate (a closure copy and a module copy).
That file is 1496 lines and every liveness fix of this week landed in it; the fold is the seam for splitting
the tick loop from the rules. Behaviour must not change, so the tests pin each rule as it moves.

### What the fold shipped, and what it did not (2026-11-10)

Shipped: the duplicated predicate is gone. `awaitsAHumanState` is the one rule, exported, and the closure
in the router aliases it; `awaitsAHumanTop` and its copy of the body no longer exist. The stalled sweep and
the quiet rule now ask the same function the same question.

Not shipped: the single call site. The three sweeps still run in three places in the tick, and the order is
a fact this document now has to carry: the stalled-launch sweep and the duplicate sweep run after intake,
and the quiet rule runs after the launch loop, because its release depends on the report it files in the
same step. A move that keeps that order provable needs the three sweeps' tests to move with them, and the
first attempt at the move lost scope twice in the splice. It is a half-day of careful work, not a fold.
