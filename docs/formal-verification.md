# Formal verification

Three subsystems of pi-superagent are specified in TLA+ and checked to exhaustion
by TLC, on every run of `./scripts/check-formal`:

| Spec | Models | States checked | Claims |
| --- | --- | --- | --- |
| `formal/Ticket.tla` | the core ticket lifecycle (`src/core`) | 12,325,891 (1,398,882 distinct) | 7 |
| `formal/Intake.tla` | the GitHub intake source (`source-github.ts`) | 565,551 (113,281 distinct) | 6 |
| `formal/Workers.tla` | worker records, tabs, agents (`herdr-workers.ts`) | 347 (94 distinct) | 5 |

Zero violations; every model action carries a comment naming the real function it
mirrors. This is not decoration: writing the specs found **two model bugs and one
real design bug** (a dropped eval batch, a resurrected stopped ticket, and a
commit-then-crash window that loses a request — see C3 below).

## Running

```
./scripts/check-formal        # all specs, ~5 min, exit 0 only on a completed proof
```

It needs a JDK (`brew install openjdk` once; `JAVA=` overrides) and fetches
`tla2tools.jar` to `~/.cache/tla2tools/` on first use. A parse error, an
invariant violation, a missing java, a truncated run: all exit 1 with a one-line
reason. Silent success is treated as failure by design.

## What each spec proves

### `Ticket.tla` — the lifecycle (`formal/README.md` has the details)

- **I1 StopAbsorbing** — a ticket a person stopped is never live again.
- **I2 DoneFromReady** — `done` implies a `ready` report; silent success is
  unrepresentable.
- **I3 OneRunning** — at most one running assignment per ticket.
- **I4 NoSecondTicket** — no ticket for a thread a live ticket follows, under
  every interleaving, including a follow-up arriving mid-Evaluation.
- **I5 OutboxOnce / I6 SentMonotonic** — each acknowledgement queued and sent
  exactly once.
- **LT Delivered** — with minimal fairness, every emitted message is eventually
  delivered.

### `Intake.tla` — the source that once fired 36 mirrored issues as requests

- **C1 SeedSilence** — an issue open at the first look is never accepted; it can
  fire only after a real close/reopen cycle. The import-storm incident, frozen.
- **C2 ReopenOnce** — at most one request per open interval of an issue.
- **C3 NoGhostCommit** — the committed `since` cursor only stands over comments
  the engine has *accepted*. This is why the cursor commit is deferred: a poll
  stages its cursor, and the stage lands only after every trigger it emitted is
  in the engine. Committing at emit time — the naive form — makes C3 false: a
  crash between poll and accept loses the request permanently. TLC produced the
  exact counter-example trace.
- **C4 NoDoubleAccept** — a replayed trigger is deduped by content-hashed id,
  never accepted twice.
- **C5 BotNeverHuman** — a bot comment is never taken for a person's request.
- **C6 NoLoss** — through a crash (bounded restarts; generalizes by induction),
  every posted comment is eventually accepted and every issue opened after the
  seed fires.

### `Workers.tla` — tabs, records, and the sweep

- **W1 OneLive** — at most one live worker at a time.
- **W2 SweepKeepsLiveAgents / W4 NoTabLossUnderWork** — a live agent's tab is
  never closed: `closeStaleTabs` guards on agent liveness (`agent_not_found`),
  making untouchability an invariant, not a race.
- **W3 NoResurrect** — record state moves only `free→live→ended→free(retire)`;
  a record never resurrects and never retires while its tab is open.
- **W5 ZombieTabsGone** — after finitely many launches, every dead agent's tab
  is eventually closed: the workspace cannot fill with zombies.

## Method (what makes these proofs mean something)

**Mirror, don't invent.** Every action cites the real function it abstracts
(`core/evals.ts` accept, `closeStaleTabs`, poll/seed/cursor). A change to those
transitions must be mirrored here and the check re-run.

**Abstraction honesty rule.** Every removed feature (context threads, follows,
eval expiry, policy revalidation, attention, network) only removes transitions
that could end or resume a ticket — the abstraction weakens toward soundness and
never toward false comfort. Each spec header states its removed features.

**Bounded for exhaustiveness.** Real numbers are infinite; models bound them: 2
threads, 2 slots, 3 assignments, crash budgets, launch budgets. The claims are
mechanism claims ("the replay recovers from a restart"), which generalize: a
fixed finite bound that exercises the mechanism covers the argument. The bounds
are in the spec headers.

**Liveness via fairness.** "Eventually delivered / eventually cleaned" claims
(`LT`, `C6`, `W5`) are temporal properties under stated fairness assumptions
(minimal: enabled source/accept/sweep actions fire infinitely often; crash
budgets bounded with `WF`). Fairness assumptions are written in the spec, so a
reader can attack them.

**TLC patterns that bit us** (save yourself the hour): action invariants must be
`[][...]_vars` **PROPERTY**s, not `INVARIANT` lines (TLC 2.19 rejects boxed
formulas there); `UNCHANGED` needs tuples `<<...>>`, not sets; an action that
assigns `x'` must not list `x` in its `UNCHANGED` (self-contradiction = a silent
dead action — find it with `-coverage 1`); `open` is a reserved word; a liveness
run needs the terminate step as an explicit `UNCHANGED vars` action.

## Scope — what the proofs do NOT say

The model proves the model. Binding force ends at the abstraction: the specs
cover the control flow named above, not the judge's text decisions, the GitHub
API's behavior (response codes, rate limits), the database layer, or the network.
The guarantee is: **no implementation following these transitions can reach a
forbidden state, and liveness holds under the stated fairness.** When `src/core`
ticket transitions change upstream, these specs must be updated and re-run —
that is the contract of the byte-identical core rule.
