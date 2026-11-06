# Design decisions

The decisions that shaped this system, each with the force that produced it.
(How the parts fit: [architecture.md](architecture.md). Proofs:
[formal-verification.md](formal-verification.md).)

## GitHub issues are the only front door

Every request arrives as an issue or a human comment on the wired repo; there is
no CLI submission path, no board, no labels. **Because** the first version
accepted requests from several surfaces and each one grew its own trust rules
(who is a person here? what is addressed to me?) — with two doors, the agent's
behavior depends on which one a request slipped through, and that is how you get
an agent doing work nobody asked for. One door makes the identity rules local to
one file (`source-github.ts`) and one gate (`assessor.ts`).

## A first look never fires existing issues (the seed rule)

**Because** the incident: mirroring a repo with 36 existing issues fired all 36
as requests on first start. Issues predating the source are recorded silently;
only issues that open afterward fire; closing then reopening counts as a real
"go again" (closed issues leave the seen set). Frozen as `Intake.tla C1/C2`.

## Read positions commit late, seeds commit early

The comment cursor and seen-set stage during a poll and land at the next poll,
once their triggers are in the engine. **Because** commit-at-emit plus a crash
leaves the cursor past a request the engine never accepted — silently lost
forever; a lost stage just replays (ids are content hashes, the engine dedups).
The seed is the mirror case: a lost seed re-runs the import storm, and seeding
can never swallow a request, so it commits immediately. Both directions proved
in `Intake.tla C3/C6`; the shipped form is the counter-example trace turned into
a test.

## The engine core is byte-identical to upstream

`src/core/**` and its test are vendored from the upstream prototype and never
edited — diff against upstream must stay empty. **Because** the core is the
proven part (its lifecycle is what `Ticket.tla` models); every adaptation
(judge prompt, GitHub shapes, herdr bindings, panel) lives in `src/pi/**`, so
upstream fixes can be re-vendored mechanically and the proof keeps its warrant.

## Judgment is one model call behind a structural gate

The gate decides mechanically first (person? addressed? this repo? reply
marker?), and only gated triggers get one assessor call with the thread.
**Because** the judge model changes its mind; the mechanical layer must absorb
bot traffic and self-echoes so a judge wobble cannot open tickets from the
agent's own comments. Judge prompt text lives in `src/pi/judge.ts`, tuned
against real accepted/ignored samples; thresholds are config, not code.

## A finished worker lingers; the sweep only touches provably-dead agents

`closeStaleTabs` closes a tab only when its record's agent answers
`agent_not_found`. A reported worker's tab stays open for follow-up until its
agent dies. **Because** an earlier sweep keyed on tab age closed tabs of
mid-report workers — the report landed with nowhere to show. The liveness
probe as the single guard is `Workers.tla W2/W4`; the no-zombie-pile-up is W5.

## Workers report; they do not declare victory in prose

A worker ends its assignment by calling the report tool with a verdict
(`ready | blocked | failed`) plus text; the engine ends a ticket only on
`ready`. **Because** "silent success is the defect class": a model that says
"done" in prose while producing nothing must be structurally unable to complete
a ticket. `Ticket.tla I2` makes silent success unrepresentable in the model.

## A human stop is absorbing

Once a person stops a ticket, no trigger, wake, or attach can make it live
again; a new request needs a new ticket. **Because** a stopped ticket is a
person's "not now", and an agent that resumes what it was told to stop learns
fast that human words mean nothing. `Ticket.tla I1`.

## One supervisor, one SQLite writer, one state dir

Everything (store, cursors, worker records, config, logs) lives under
`~/.pi/superagent/`; SQLite is the single writer of record; the panel is
read-mostly. **Because** the multi-machine ambitions died of coordination
bugs — the fleet runs one supervisor per repo and SSHes where it needs GPUs.
Deleting the directory resets the system, which makes the crash model in the
specs exactly the operational reality.

## A review is a request; opening a PR is not

A submitted review — "changes requested", "approved" — is a person speaking about delivered work, on
the same conversation the ticket already owns. It fires a fresh judgement and the reply posts into the
PR's own thread (a PR is issue N on GitHub, so the reply path needs no second address). Opening a PR is
**not** a trigger: a PR is a delivery, and making every opening one turns the agent into a mandatory
reviewer of its own fleet's output — a self-feeding loop. Reviews ride the same deferred-cursor rule as
comments; a first look seeds the review cursor silent, so a restart never rereads history as requests.

## Formal specs live beside the code and run in one command

`formal/*.tla` + `scripts/check-formal`, checked to exhaustion; every spec
action names the real function it mirrors; headers state every removed feature
and bound. **Because** a proof you cannot re-run in one command rots; and
because the specs found three real bugs (two model, one shipped) in days — the
doc-rotation fear was the lesser risk.
