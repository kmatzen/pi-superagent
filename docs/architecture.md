# Architecture

This is the map: what runs, in what order, and which file owns each rule. The reasons behind the rules
are in [design-decisions.md](design-decisions.md); the proofs about them are in
[formal-verification.md](formal-verification.md).

## The path of one request

```
 GitHub: issues, comments, reviews                     the only way in
     │  polled every 30 s through the gh CLI            gh-api.ts
     ▼
 GitHub source        seed rule · deferred read positions · own-writing filter
     │  Trigger: content-derived id, thread #N           source-github.ts
     ▼
 engine               policy gate: a person, not a bot  src/core, router.ts
     │  Evaluation: the thread's waiting triggers
     ▼
 judge                one candidate at a time, answered through ticket_decide
     │  accept                                          assessor.ts, judge.ts
     ▼
 engine               ticket + pending assignment; acknowledgement queued
     ▼
 executor             a pi worker in its own herdr tab and workspace
     │  ticket_report: ready · blocked · failed · cancelled
     ▼                                                  executor.ts, herdr-workers.ts
 engine               the report lands on the ticket; the receipt is queued
     ▼
 outbox               the comment, posted on the issue once  outbox.ts
```

A crash anywhere on this path loses nothing and doubles nothing:

- **GitHub to source.** Read positions are staged during a poll and committed at the next one, after the
  engine holds every trigger they produced. A crash replays the last poll instead of skipping it.
- **Source to engine.** Trigger ids derive from content: a comment from its author, time and body; an
  issue from its number, title and last update; a review from GitHub's own id. The engine accepts an id
  once, so a replay is a no-op.
- **Inside the engine.** Each command is one SQLite transaction: its writes land together or not at all.
- **Engine to executor.** The engine's calls to start, deliver to and stop a worker run only after the
  command commits, so a worker never acts on a write that could still roll back.
- **Executor and worker.** A worker writes its events and reports to files; the router reads them from a
  cursor it persists. A restarted router resumes reading where the last one stopped, and adopts the
  running worker instead of starting a second.
- **Outbox to GitHub.** A message is marked sent only once GitHub accepts it. A retry first looks for the
  comment on the issue, in case the last attempt landed before the process died.

## The parts

**The engine: `src/core/` (vendored, unmodified).** The state machine. `intake.ts` hands a trigger to the
ticket that owns its thread and queues an Evaluation only when no ticket does; `evals.ts` turns an
accepted Evaluation into a ticket; `assignments.ts` records reports and keeps one running assignment per
ticket; `tickets.ts` stops, retries and wakes tickets; `replies.ts` queues acknowledgements and replies,
each under a key that is queued once. The engine is synchronous and does no I/O of its own: everything
that touches a process, the network or a model arrives through a port in `ports.ts`.

**The router: `src/pi/extension.ts`.** The composition root. It builds the store, the GitHub source, the
outbox, the judge, the executor and the panel, then runs the loop. Every 30 seconds, and whenever its own
pi session goes idle, the loop polls GitHub, hands new triggers to the engine, stops tickets whose thread
has closed, lets the engine start due evaluations, launches queued work, flags workers that have gone
quiet for 15 minutes, and flushes the outbox. Three failed polls in a row put an error in `health.json`.

**GitHub in: `source-github.ts` and `gh-api.ts`.** The source reads issues, issue and pull-request
comments, and submitted reviews. Its first look at a repository records what already exists and fires
none of it. Its read positions commit one poll late, as described above. It ignores its own writing,
recognized by the account it posts from or by the hidden marker every reply carries, and it marks
authors matching the bot patterns as not human. `gh-api.ts` talks to GitHub through the `gh` CLI, so the
credentials stay in the operator's keyring; every call is asynchronous, issue and pull-request lists are
paginated, and comments are read forward from the cursor.

**The judge: `assessor.ts` and `judge.ts`.** The engine's policy gate, defined in `router.ts`, admits a
trigger only from a person who is not on the bot list. That check is code, not a model call. An admitted
trigger becomes a candidate: the thread, its messages, the tickets already on it, and a link to the
issue. The assessor sends candidates to the judge one at a time. The judge is a headless pi session with
no extensions, skills or context files and a single tool, `ticket_decide`. If the judge accepts a thread
that already has an open ticket, the router overrules it: that thread's messages belong to its worker.

**Workers: `executor.ts`, `herdr-workers.ts` and `worker-role.ts`.** Each running assignment gets one
worker, a pi session that herdr starts in a new tab, in a workspace of its own. Router and worker talk
through files in `workers/<session>/`: inputs land in `inbox/`, and the worker appends events and reports
to `events.jsonl` and `reports.jsonl`. The files and the tab outlive the router, which is why a restart
adopts workers rather than replacing them. Inside the worker, `worker-role.ts` registers `ticket_report`
and the guard from `workspace.ts`: no delegation tools, no blocked commands, no writes outside the
workspace. A finished worker's tab lingers for ten minutes of follow-up and then closes if its pi sits
idle. At startup the router also closes worker tabs that no record owns or whose agent herdr no longer
knows.

**GitHub out: `outbox.ts`.** Acknowledgements, receipts and notices are queued under ids, and an id is
never queued twice. A message counts as sent only once GitHub accepts it; a failed post stays pending for
the next pass. Every comment ends with an invisible marker, `<!-- superagent -->`, which lets the source
recognize the agent's writing even when the agent and the operator share one GitHub account. Sent entries
are pruned after 30 days.

**The panel: `server.ts`.** A page and a small JSON API on 127.0.0.1, port 8788 by default, computed
from the engine's store on every request, so the page can show no count the API would deny. It refuses
any Host header other than 127.0.0.1 or localhost, and any API call without `x-superagent-request: 1`,
so a web page elsewhere cannot read or steer it. If the port is taken, the panel binds a free one and logs
which; it never takes the router down.

**The start script: `scripts/superagent`.** Starts the router as a pi agent in a herdr tab, stops it, and
reports its health as an exit code: 0 healthy, 1 down, 2 a part is failing, 3 waiting for setup. The
launchd job in `launchd/` runs it every five minutes, restarts a router that is down, and leaves alone a
router that was stopped on purpose.

## The state directory

Everything the system knows lives in one directory, `~/.pi/superagent` unless `PI_SUPERAGENT_STATE` says
otherwise.

| Path | What it holds |
| --- | --- |
| `tickets.db` | the engine's SQLite store, including read positions and the outbox |
| `config.env` | deployment settings, read by the start script |
| `engine.log` | the router's log, rotated at 5 MB |
| `health.json`, `setup.json`, `ready` | what `superagent status` reads |
| `workers/<session>/` | one directory per worker: its record, inbox, events and reports |
| `work/<ticket>/` | one workspace per ticket |
| `worker-bin/` | shims that refuse blocked commands, first on the PATH of each workspace's setup script |

To start over, stop the router and delete the directory. The next first look treats every open issue as
history.

## Where each guarantee lives

| Guarantee | Enforced by | Proved in |
| --- | --- | --- |
| One ticket per thread | intake routing in the engine; the router overrules a second accept | `Ticket.tla` I4 |
| A ticket completes only on a *ready* report | `core/assignments.ts` | `Ticket.tla` I2 |
| A person's stop is final | guards in `core/tickets.ts` and `core/intake.ts` | `Ticket.tla` I1 |
| One running assignment per ticket | the executor's launch guard | `Ticket.tla` I3 |
| Each acknowledgement queued and sent once | outbox keys in `core/replies.ts` | `Ticket.tla` I5, I6 |
| Issues older than the router fire nothing | the seed rule | `Intake.tla` C1 |
| One request per open interval of an issue | the seen set | `Intake.tla` C2 |
| No comment lost to a crash | deferred read positions | `Intake.tla` C3, C6 |
| No trigger accepted twice | content-derived ids | `Intake.tla` C4 |
| A bot never passes for a person | bot patterns and the policy gate | `Intake.tla` C5 |
| A live agent's tab is never swept | the liveness check in `closeStaleTabs` | `Workers.tla` W2, W4 |
| Dead workers' tabs do not pile up | the sweep and the linger close | `Workers.tla` W5 |
