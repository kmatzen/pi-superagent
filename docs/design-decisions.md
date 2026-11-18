# Design decisions

## Why work starts on GitHub

A reviewer who spots a problem in a pull request already has the diff and a place to leave a
comment. Asking them to copy that comment onto a separate task board would split the conversation
just when the worker needs its context. Issues, comments and reviews therefore enter through the
same source, `source-github.ts`. A new request can open a ticket, and feedback can reach the
worker that made the change.

**Check the author before routing the message.** An accepted request starts a worker with a shell
on the operator’s machine. A comment on an existing ticket goes straight to that worker, so a
permission check in the judge alone would miss follow-ups. The engine checks `scopeOf` first.
By default it admits the GitHub associations `OWNER`, `MEMBER` and `COLLABORATOR`. A missing
association fails the check. Setting `PI_SUPERAGENT_ALLOWED` replaces that rule with a login list.

**Establish a baseline on the first poll.** An early version treated an entire backlog as new work
when the operator connected a repository. The source now saves the initial set of open issues and
seeds the review cursor. Closing and reopening an issue makes it eligible again. Its updated
timestamp distinguishes the new trigger from the earlier one. See `Intake.tla` C1 and C2.

**Spend the intake label, and close the issue a ticket finished on.** *(The label half is superseded: see
"Delete the labels" below. Closing the finished issue stands.)* That timestamp is GitHub's
`updated_at`, and GitHub moves it when a comment lands — including the router's own receipt. A
labelled issue therefore re-asked on every poll, and the router's speech was what recruited the next
worker: measured 2026-11-09, 26-31 label triggers in a burst at every completed tick, one ticket
reporting the same sentence 93 times in 20 hours, another waking a fourth worker nine hours after
its merge. The label is an act, not a state, so the source journals the grant it takes
(`source:github:<repo>:label-grants`), takes the label off, and hands the grant back only when the
label comes off. A finished ticket then closes its issue, because intake hears open issues and a
`ready` report with no pull request leaves nothing to wait on. A person's comment, or a reopen,
still starts the work: that is new inbound speech, and the only thing that is.

**Check the label's author and its moment, not just the journal.** *(Superseded: see "Delete the labels".)* The journal above is per-repository
state, so it does not survive a rebuilt database, and a label a token without rights cannot take off is a
standing ask with nothing behind it. The second lock asks GitHub who applied the label — the issue events
feed, the only read that answers — and compares that moment with the router's own last reply on the
issue. A label older than the router's last reply is an ask it heard and answered; a label newer than it is
a person asking a second time, which is the door intake keeps open. The check is deliberately *not* "a
human applied it": `superagent intake` labels with the deployment's own token, so a real ask and the
router's speech carry the same login (measured 2026-11-09: one board issue labelled by the operator login,
another by the bot login, both deliberate). An unreadable answer fails open, because losing intake costs
more than the loop the journal already stops. The trigger now names the label's author too: it used to
credit the issue's author and hardcode `human: true`, which is what made every one of the 8 label triggers
on one ticket read as the operator asking again.

**Delete the labels.** The operator retired them on 2026-11-10 ("These labels are obsolete"; "unlabeled
issues should absolutely be processed"), and on 2026-11-11 the router still wrote `agent-requested` on every
re-grant, read a journal of label grants, and asked GitHub who applied each label. All of it is gone: the
source reads no label and writes none, `superagent intake` (which only stamped the label) exits with a note
saying so, and a re-grant is a trigger marked `via: grant` and nothing else. What a label used to decide, the
router decides from its own tickets (`regrantable`): an issue that never had a ticket is starved work, an
open ticket qualifies by the state of its work, and an issue whose tickets all ended is never re-granted,
because that is finished work waiting on its pull requests, or a stop. A person's comment on a stopped
ticket's issue goes to the judge, which may open a new ticket.

**Stop a ticket that repeats itself.** The Nth report that lands with nothing new on the thread recruits
a worker that can only report it again, so at `PI_SUPERAGENT_REPORT_CAP` (3) the ticket says so on itself
and stops recruiting. The signature is the quiet thread, not the sentence: #255 wrote “Nothing to merge:
this pull request landed…”, then “The mandate is already satisfied…”, then “Close this ticket: its pull
request merged…”, and #227 wrote “eighty-sixth identical dispatch”, “Still waiting on one click”,
“Resumed run: state is unchanged” — a fingerprint over the wording matches none of it, and their states
flipped between `ready` and `blocked`. So the streak is the same report state with no new inbound speech
between the reports, where the router's own receipt and a re-grant are not speech. A person's
comment, or a report that changed state, restarts the count. The journal is the router's, not the
aggregate's: an Assignment keeps its last report, so the 93 receipts of one worker session are one
report in the ticket.

**A 404 from a repository you cannot see is not a vanished pull request.** GitHub answers 404,
not 403, for a private repository a token cannot read, and the pull-request reader returned
`undefined` for every 404. A follow whose read returns `undefined` is finished: the engine ends
the ticket and the router posts "closed without merging, so this ticket ends". Measured
2026-11-09, the router's account cannot read the private repository its own code lives in, so it
told the board twice in one day that an open, ready, mergeable pull request had closed without
merging, and ended the ticket that was fixing the board. The reader now asks the repository
(once, cached): visible means the pull request is absent and the wait ends, invisible means the
read is unreadable, the follow stays open, and the failure is said once per thread with the
matching `pull.read_readable` when it recovers. Absent and unreadable are different answers; only
the first one ends a wait.

**Repair a close a failed read wrote down.** The fix above stops the next false close; it does not undo
the ones already in the database, and a recorded close is permanent by design — a closed follow is not
read again, so nothing is there to notice the truth. Measured 2026-11-09 on the live board: 21 **live**
tickets hold a closed follow on a pull request that is open, with no open follow left, which means they
are followed by nothing, can be ended by nothing, and never read a review on the pull request they are
waiting for; 39 ended tickets took that same false close as their terminal end, and their pull requests
are still open. So the follower re-checks a recorded close once per start (`pull.reopened` in the log,
once per thread, no API call where the watched repository’s open-thread list already answers) and
re-binds the thread on the tickets that are **live**, which clears the recorded close and gives the wait
back. Tickets that already ended are left ended: reopening 39 of them in one start recruits 39 sessions
unasked, and an end a person should undo is the operator’s door, not the router’s. The repair is silent,
because the router writing on a thread is what recruits a session — the same reason its receipt is not
inbound speech.

**Say a report nobody received.** A worker's report travels: the pane appends it to
`reports.jsonl`, the router reads the file and files it on the ticket. When the ticket has no
live worker by then — it ended on the worker's own report, and a queued copy of its mandate
started a second run in the same tab — the router drops the report, the report tool has already
answered `reported`, and the file's cursor has moved past the line, so nothing retries it.
Measured 2026-11-09 on #255: the report at 08:59:23Z ended the run, a queued copy of the same
mandate woke the same tab at ~09:01Z, its `ticket_report` answered `reported`, and the issue's
comment count never moved. Every later run of that ticket read the last receipt as proof the
previous one had spoken. The drop is now said in the engine log (`worker.report_dropped`) and
answered to the worker as `not recorded`, because a report nobody received is indistinguishable
from a worker that went silent, and an operator who cannot tell the two keeps spending sessions
on the same proof.

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

A worker can write “done” in its terminal while the person who opened the issue is still waiting
on GitHub. To finish a run, it calls `ticket_report` with an outcome. A *ready* report can carry
the link to a PR. A *blocked* report carries the question the requester needs to answer. The other
outcomes are *failed* and *cancelled*. Only the engine writes the result to the ticket.
See `Ticket.tla` I2.

The summary is posted for the person who asked, so the report tool checks it in the worker's own turn,
by the rules the operator's replies follow: line 1 is the news or the ask in at most 23 plain words,
with no file paths, code or commit ids; at most 160 words come before a `Details (skippable):` line,
and at most six bullets after it. A report that fails is refused with the reasons, and the worker
rewrites it. Working detail goes in `notes` instead. The router keeps each ticket's latest notes and
puts them in the next worker's brief, never on the issue. A writing rule in the brief alone was only
advice: on 2026-11-13 a worker posted its own to-do list, file paths first, as a ticket's update.

If a run ends without a report, the router posts a failure on the thread. Launch errors and crashes
also get a reply there, so the person who asked knows what happened. The outbox recognizes repeat
failures. One broken setup command deserves one notice, even if the router tries it on every poll.
A quiet worker is a different case. After 15 minutes of silence it appears on the panel, where the
operator can see whether it needs help or is simply waiting for a build.

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

**Every end closes the issue, and a promised check survives a merge.** A ticket resumed on a reopened
issue can end again, and each end posts its own note and closes the issue again; both were once per
ticket, so on 2026-11-13 #387's second end left it open in silence. A merge that ends a ticket whose
worker asked to be called back to check on something still running does not cancel the call: the
note says the check still happens, the issue stays open, and the check's report ends the ticket. Only
a stop by a person or the router cancels it.

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

**Report health through exit codes.** A scheduled check can act on `superagent status`, and each
code names its remedy: 0 means healthy or intentionally stopped, do nothing. Code 1 indicates a
router failure that a restart may fix, so the check starts it. Code 2 means the router is up and
not beating, its tick loop stalled, so the check restarts it: only `start` refuses a running
router, so a stall with `start` as its only remedy is a loud no-op every five minutes. Code 3
identifies a setup problem, and code 4 directs the operator to a failing component, including a
GitHub source that failed three polls in a row; a restart fixes neither, so the check reports and
does not restart. `superagent remedy` is that mapping as a command, and it honours the stop marker
without being told to, so a deliberate stop stays deliberate.

**Restart the beat, not the parts.** Letting a scheduled job restart the router is a policy call, so it is
narrow: the job restarts only the fault a restart cures, a tick loop wedged inside a pass, and never a part
that reports an error, because restarting a router does not bring a GitHub source back. A restart ends one
per `PI_SUPERAGENT_RESTART_COOLDOWN_MIN` (30) for the same reason: a fault a restart cannot fix would
otherwise restart the router every five minutes forever. It is a survivable act, which is what makes it
allowed at all: the workers are their own herdr sessions, and the new router adopts them on its first pass.
A healthy beat deletes the cooldown stamp (2026-11-11): the cap protected the router from a restart loop, not
the fleet from a second death, and an outage that began in the boot right after a watchdog restart stayed
unhealable for 25 minutes.

**Judge retained workspaces by bytes, not by count (2026-11-11).** Keeping the newest 20 settled checkouts was
meant to bound the disk; the kept set measured 58 GB because one build tree is 15 GB. `PI_SUPERAGENT_WORK_BUDGET_GB`
caps the work root, and settled checkouts over it go oldest-first — the same two safety rules as the count sweep:
never unpushed work, never an open ticket.

**Sweep under disk pressure, open tickets included (2026-11-17).** Both sweeps above touch settled tickets only,
and they ran once, at startup. Lookbook reached 377 MB free with 42 of its 49 workspaces on OPEN tickets; the
full disk left a 0-byte worker cursor, every restart crashed reading it, and the fleet stayed dead for 8 hours.
The router now reads free space on every tick and, below `PI_SUPERAGENT_MIN_FREE_GB` (20), drops the *checkout*
of an open ticket no worker is sitting in, oldest first, at most every 15 minutes. That is the code, not the
work: GitHub holds the branch, the next launch re-clones, and the ticket directory — reports, notes, inbox — is
what a reopened issue and a woken worker come back to, so it stays. Commits on no remote, uncommitted edits to
tracked files, a stash, a new file git does not ignore (an agent's uncommitted script or note) and a live
worker's checkout are never touched. Ignored files (the .venv, build output, downloaded models) do not count as
work: they are most of a 2 GB ML workspace, and they are rebuilt, not recovered. `worktree.pressure_sweep` reports what went, by how much, and the free space left after.

**Under pressure, clear the shared caches first, and stop launching (2026-11-18).** The pass above was written
and never deployed, and it would not have saved the box: it refilled to 0 bytes ten hours after a cleanup, and
32 of the 47 GB was the uv package cache in the operator's HOME, which every worker shares and no sweep read.
Below the floor the router now runs `uv cache clean` and `npm cache clean --force` before touching any checkout:
the tools wait for an install in flight instead of cutting it, and a venv keeps every file it hard-linked out of
the cache, so the only cost is a re-download. Below half the floor the executor starts no new worker: a launch is
a clone plus an install, and 68 were queued when the disk hit 0. Running workers are never stopped for disk; the
pause lifts on the first tick above half the floor (`disk.launches_paused` / `disk.launches_resumed`). The brief
also tells workers what never belongs on the box: model weights, datasets, checkpoints, and output left in /tmp.

**Skip, never sweep, a non-directory in the work root (2026-11-11).** A stray log file there made the sweep
`readdirSync` a file; the sweep runs after every intake, its rejection was unhandled, and every tick died for
25 minutes. Files in the root are counted as strays, logged once, and left alone.

**A running assignment with no start time belongs to boot recovery (2026-11-11).** Marked running, dead before
the launch was recorded: judged by the ticket's age it passes the 15-minute stall window every tick forever —
480 warnings a day of one ticket, and a release it cannot need. The sweep skips it; recovery owns the race.

**Back up the memory, not the code (2026-11-11).** The code rebuilds from a clone in a minute; `tickets.db` —
the queue, read positions, receipts — has no other copy. The health job runs `superagent backup` daily: a
sqlite-safe copy, integrity-checked, 14 kept.

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
