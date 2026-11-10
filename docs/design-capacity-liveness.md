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
