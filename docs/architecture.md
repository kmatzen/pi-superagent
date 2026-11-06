# Architecture

pi-superagent turns GitHub issues into worked-and-reported changes, run by a
supervisor engine and pi worker sessions. This document is the map: what runs,
in what order, and which file owns which rule. (Why the rules are shaped this way
is [design-decisions.md](design-decisions.md); the proofs about them are
[formal-verification.md](formal-verification.md).)

## The path of one request

```
 GitHub issue / comment / review  (the only front door)
        │  poll, ~60 s
        ▼
 source-github.ts ── seed rule, cursors, human/bot marking
        │  Trigger {issue, comment, review, human}
        ▼
 gate (assessor.ts)  ── human? asking? for-this-repo?   [judge.ts: model verdict]
        │  accepted trigger
        ▼
 core/engine.ts ── intake → Evaluation → Ticket → Assignment (SQLite, src/core/store.ts)
        │  one pending Assignment per live ticket
        ▼
 executor.ts → herdr: spawn a pi worker session in its own tab (herdr-workers.ts)
        │  worker calls report-tool: ready | blocked | failed (+ report text)
        ▼
 core commits the report → ticket done (ready) → outbox → GitHub comment on the issue
```

Every arrow is crash-safe: triggers are content-hashed ids the engine dedups, the
SQLite store is the single writer of record, and the outbox sends each ack exactly
once (both properties are proved in [formal-verification.md](formal-verification.md)).

## Components

**`src/core/` — the engine (vendored, byte-identical to upstream).** The state
machine: `intake.ts` fans a trigger to live subscribers and queues an `Evaluation`
only when no worker decides it; `evals.ts` turns an accepted evaluation into a
Ticket (one per thread — a live ticket following a thread blocks a second one);
`assignments.ts` keeps at most one running Assignment per ticket; `tickets.ts`
ends tickets (`ready` completes; a human stop is absorbing); `replies.ts` +
outbox queue keyed by trigger id sends each acknowledgement once. `src/core/**`
is never edited — see the byte-identical rule in
[design-decisions.md](design-decisions.md).

**`src/pi/source-github.ts` — the intake source.** Polls one repo's issues,
comments and submitted reviews. Three rules carry all the safety:

- *Seed silence*: the first look records currently-open issues and fires none of
  them — importing a repo with existing issues must not fan a storm of requests.
  Reopening an issue is a real request, so closed issues leave the seen set and
  fire afresh.
- *Comment cursor*: a persisted `since` timestamp; each poll reads comments at or
  after it and advances it to newest + 1 ms. The cursor is a position, not a
  filter — it commits only after the triggers it produced are safely in the
  engine, so a crash replays (dedups) rather than loses.
- *Human/bot marking*: comments by the agent's own login (`githubSelf`) and by
  listed bot accounts are marked `human: false`, so the agent's own report
  comments can never re-trigger work.

**`src/pi/assessor.ts` + `judge.ts` — the gate.** Decides `work | ignore` for a
trigger: structural checks first (is it a person, is it addressed at the agent,
is it about this repo), then one model call with the issue thread. Judge prompt
and thresholds live in `src/pi`, not `src/core`, so tuning never breaks the
byte-identical rule.

**`src/pi/executor.ts` + `herdr-workers.ts` — workers.** One worker = one pi
session in one herdr tab, per Assignment. Records persist under the state dir
(`worker.json` per worker) with `sessionId`, `tabId`, `paneId`, `endedAt`,
`tabSettledAt`. A finished worker lingers: the record ends, the tab stays open
for follow-up, and `closeStaleTabs` later closes only tabs whose owning record's
agent is provably gone (`agent_not_found`) — a live agent's tab is untouchable by
the sweep. `retireOrphans` reclaims records no adopted worker owns.

**`src/pi/router.ts` + `server.ts` + `worker-view.ts` — the loop and visibility.**
The router polls sources, calls the engine, drives the executor. `server.ts`
serves the panel (default port 200): tickets, assignments, workers, logs, live
herdr tab status — the human surface for one supervisor.

**State** lives in `~/.pi/superagent/`: the SQLite store, per-worker records,
source cursors (`seen`/`since`), config (`config.env`), logs. Deleting it resets
the system; the proofs' crash model is exactly "restart with this directory".

## Configuration

`config.env` in the state dir: `PI_SUPERAGENT_GITHUB_REPO` (the only front door;
unset = intake off), `PI_SUPERAGENT_GITHUB_SELF` (the agent's GitHub login, for
bot marking), panel port, judge model. Day-to-day operation is in
[operator-guide.md](operator-guide.md).

## Where each guarantee lives

| Guarantee | Owner | Proof |
| --- | --- | --- |
| One ticket per thread | `core/evals.ts` accept guard | `Ticket.tla I4` |
| Done only from `ready` | `core/tickets.ts` | `Ticket.tla I2` |
| Human stop is absorbing | `core` guards, no other door | `Ticket.tla I1` |
| One running assignment | `core/assignments.ts` | `Ticket.tla I3` |
| Each ack sent once | `core/replies.ts` outbox key | `Ticket.tla I5, I6` |
| Import replay is silent | `source-github.ts` seed rule | `Intake.tla C1, C2` |
| No comment lost to a crash | deferred cursor commit | `Intake.tla C3, C6` |
| Bot comments never pose as people | `source-github.ts` marking + gate | `Intake.tla C5` |
| Sweep never kills a live agent's tab | `herdr-workers.ts` guard | `Workers.tla W2, W4` |
| No zombie tab pile-up | sweep + linger close | `Workers.tla W5` |
