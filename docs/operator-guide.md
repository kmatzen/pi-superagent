# Operator guide

Most of the time, the issue is the only window you need. Ask for a change there, answer any questions
in the thread, and review the pull request when it arrives. If you want to see a command run or help
a worker past a snag, its terminal is open to you too.

## Ask for work

Open an issue in the repository you configured with `superagent init`. A sentence about the outcome
and one detail that matters to you usually give the worker a good place to start.

> **Show the export shortcut in the Help menu**
>
> I always forget how to export from the keyboard. Could you show the existing shortcut beside
> Export in the Help menu? Please use the same wording as the File menu.

The **judge** reads new requests and decides which ones call for action. When it accepts yours,
the router acknowledges it on the issue. Look for a tab with that issue number in the
`superagent` herdr workspace. Inside is the **worker**, the pi session doing the work.

An aside to a teammate can stay an aside. If the judge passes over a comment, you can find its
reason in the engine log. Once your issue has an open ticket, further comments go to the worker.

### Who can start work

By default the router accepts authors whose GitHub association is `OWNER`, `MEMBER` or
`COLLABORATOR`. The panel counts requests from other authors as filtered. To choose the permitted
accounts yourself, set `PI_SUPERAGENT_ALLOWED` to their logins. This list replaces the default rule.

### Follow up and review changes

Comment on the issue to steer an active worker. If it needs a decision, it posts a question on
the thread and the panel lists it under *Needs a person*. Reply there to continue.

For a code change, the worker opens a pull request and the router links it on the issue. The panel
shows `review of #N` while the PR is open. Comments and reviews on that PR reach the same worker.
Merging ends the ticket as merged. Closing the PR unmerged also ends the ticket, and you can
comment on the issue to ask for another attempt. The router checks PRs in other repositories every
two minutes. An answer, investigation or operation can finish with the worker’s ready report.

When one issue needs several PRs, in one repository or across several, the worker lists them in
the order you should merge them. The router keeps one status comment on the issue, edited in place:
each PR in that order, its state (draft, ready to merge, conflict, merged), and who acts next. Each
report links it. When you merge one PR and others stay open, the worker is woken to make the
follow-on change the rest need, such as a version pin or a rebase. The ticket ends when the last
PR is merged or closed.

A comment or submitted review on a PR without a ticket goes to the judge. The router replies in
that PR’s conversation.

### Choose the GitHub accounts

Workers open PRs as the account signed in through the local `gh` CLI. Blocking `gh` with
`PI_SUPERAGENT_BLOCKED` disables that workflow. By default the router uses the same account and
adds a hidden marker to its comments so it can distinguish them from yours.

To have the router reply under its own name, give that account access to the watched repository.
Save its token in a file only you can read, set `PI_SUPERAGENT_GITHUB_TOKEN_FILE` to the path and
`PI_SUPERAGENT_GITHUB_SELF` to the login, then restart. Look for `githubAs="token file"` in the
`router.start` log entry. Workers still use the local CLI account, which the router also uses to
read their PRs.

### Stop a ticket

Close the issue to stop its ticket on the next poll. When a ticket is waiting for its own PR,
merge or close that PR to record the review outcome. Reopen the issue to request work again.
You can also stop a ticket through the local panel API.

```sh
curl -X POST -H 'x-superagent-request: 1' "http://127.0.0.1:8788/api/tickets/<id>/stop"
```

## Watch a worker

To see the work itself, open the herdr tab labeled `#<issue> · <title>`. It’s an ordinary pi
session. You can read the output, type a suggestion or press Esc to interrupt a command. For a
view across all your issues, open the local panel. It shows what’s running, what’s queued and
which workers need an answer. [Open the panel](http://127.0.0.1:8788/)

The **engine log** tab tells the other half of the story. It records when the router checked
GitHub, what the judge decided and when a worker started. To follow the same log from another
terminal, run `tail -F ~/.pi/superagent/engine.log`.

## Manage the router

```sh
superagent status    # 0 healthy · 1 down · 2 up and not beating · 3 waiting for setup · 4 a part is failing
superagent remedy    # what the health job runs: 1 starts, 2 restarts, 0 and 3 and 4 do nothing
superagent restart   # safe at any time: workers keep running and the new router adopts them
superagent stop      # leaves a marker, so the health check will not restart it
superagent start     # clears the marker; refuses a checkout with uncommitted code (--allow-dirty overrides)
superagent backup    # one sqlite-safe copy of tickets.db per day into <state>/archive, last 14 kept
```

In a checkout, the same script is `scripts/superagent`.

Settings live in `~/.pi/superagent/config.env`. [`config.example.env`](../config.example.env), shipped
with the package, explains each setting and its default. Restart to apply a change.

On macOS, the launchd job in [`launchd/`](../launchd/com.example.superagent-health.plist) runs
`superagent remedy` every five minutes. It **starts** a router that is down (code 1) and **restarts** one that
is up and not beating (code 2, the stalled tick loop), which is the fault a running router refuses to fix: the
router is up, so `start` answers "already running" and the stall would stay loud and permanent. It does nothing
to a router that is healthy (0), waiting for setup (3), carrying a part a restart cannot fix (4), or stopped on
purpose: `remedy` honours the stop marker on its own, so a deliberate stop stays deliberate. A parked loop is
recovered within five minutes, and a restart costs the router's tab and nothing else, because the workers are
their own sessions and the new router adopts them. Restarts are capped at one per
`PI_SUPERAGENT_RESTART_COOLDOWN_MIN` (30), so a fault a restart cannot fix cannot restart the router forever —
and a healthy beat clears that cap, because a loop that dies in the boot right after a watchdog restart used to
be outside the remedy for the full cooldown (measured 2026-11-11: an outage lasted 25 minutes that way). Where
a restart resumes a session too full to boot an engine, clearing that session id is part of the remedy, and
"The tab is up and the engine is down" under "When something goes wrong" is that case.
Install it once:

```sh
plist="$(npm root -g)/pi-superagent/launchd/com.example.superagent-health.plist"   # launchd/ in a checkout
sed "s|__HOME__|$HOME|g" "$plist" > ~/Library/LaunchAgents/com.example.superagent-health.plist
launchctl load ~/Library/LaunchAgents/com.example.superagent-health.plist
```

The job finds `superagent`, `pi` and `herdr` on its own PATH: Homebrew's directories, `/usr/local/bin` and
`~/.npm-global/bin`. If `command -v superagent` or `command -v pi` prints a directory outside those, as nvm's
do, add it to the job's PATH. From a checkout, put the script's full path in front of `remedy`, one path and no
`cd`, and reload the job after every upgrade of the script.

A job installed from an older file heals nothing. The one to look for runs `cd $HOME/git/` plus a checkout path
and then `./scripts/superagent`, which checks and heals whatever repository that path names today, and whose
only remedy is `start`: it answers "already running" every five minutes over a stalled router. Read what is
installed, then re-render and reload it from the file above:

```sh
launchctl print "gui/$(id -u)/com.example.superagent-health" | grep -A4 arguments    # what runs now
launchctl bootout "gui/$(id -u)/com.example.superagent-health"
sed "s|__HOME__|$HOME|g" "$plist" > ~/Library/LaunchAgents/com.example.superagent-health.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.example.superagent-health.plist
```

`/tmp/superagent-health.log` carries every pass, each line dated, so a remedy that repeats reads as one:
`2026-11-09T15:20:03Z health: running and not beating: health.json is 16 min old ...; restarting the router`.
The job ends with `superagent backup`: once a day it writes an integrity-checked copy of `tickets.db` into
`<state>/archive`, keeping the last 14. The database is the queue, the read positions and the receipts; a box
that loses its disk loses all of it, and the code rebuilds from a clone in a minute.

`superagent start` refuses a checkout whose `src/` or `scripts/` has uncommitted changes, because the router
runs those files as they are: on 2026-11-10 an uncommitted edit to the script ran live and posted on the board.
`--allow-dirty` (or `PI_SUPERAGENT_ALLOW_DIRTY=1`) launches mid-edit anyway.

### Keep the git credential out of .git/config

A remote URL that carries its credential — `https://x-access-token:ghp_…@github.com/org/repo.git` — is a
live secret in a file git writes 0644. Every user and every process on the box reads it, and the first
`git remote -v`, `git config --list` or failed push a worker prints carries it into a transcript, a board
row, an issue body. Measured on the deployment box (issue #314): the watched checkout's `.git/config`,
`-rw-r--r--`, held a 40-character `ghp_` classic token with `repo` scope — read/write on every repository
the account reaches — and one settled ticket checkout, written 18 hours later, held that same token.

`superagent start` refuses to deploy over one, `setupProblems` reports it (status code 3), and a worker is
refused a clone that carries one. Every finding prints masked: a guard that echoed the token it found would
publish it. A token carried in a config **section name** counts too —
`[url "https://x-access-token:ghp_…@github.com/"] insteadOf = git@github.com:` is a documented way to make a
token the credential store, and it puts the secret in a header rather than a `key = value` line. Measured
before that was closed: the scanner returned no findings for exactly that file, so `status` and the panel
called the box clean while `start` refused it. One file, one answer: `url (section name)`.

**The router masks what it publishes.** A worker's report quotes what the worker printed, and `git remote -v`
in a checkout that stores its token in the remote URL prints the token. Every issue comment the router posts
passes through the same mask, so a token and a `://user:password@` URL leave the box as `ghp_***` and
`://user:***@`, and the log records the count only (`github.credential_redacted`, `count: 2`) — never the
value. A body with nothing to mask is posted byte for byte, and masking is idempotent, so a report quoting the
guard's own masked line is not a finding. The mask sits on the write, not in a prompt, so no future wording
skips it. It cannot cover what a worker publishes by itself — a worker's `gh pr create` body goes out of its
own shell — which is why moving the credential out of the URL, and rotating one that URL exposed, stay the
primary controls and this is the backstop.

Move the credential out of the URL and into a file only you can read:

```sh
umask 077
printf '%s\n' '<the token>' > ~/.pi/superagent/deploy-git-token            # 0600, and the file is the store
cd ~/git/pi-superagent
git remote set-url origin https://github.com/kmatzen/pi-superagent.git     # the same URL, credential removed
U=credential.https://github.com/kmatzen/pi-superagent.git
git config --local "$U.useHttpPath" true
git config --local --add "$U.helper" ''                 # clears the helpers inherited from ~/.gitconfig
git config --local --add "$U.helper" '!f(){ echo username=x-access-token; echo "password=$(cat "$HOME/.pi/superagent/deploy-git-token")"; }; f'
chmod 600 .git/config
git ls-remote origin HEAD && git push --dry-run origin HEAD                # the helper answers for this repo
git remote -v                                                             # prints no secret now
```

The empty `helper` line is what makes it work on a box whose `~/.gitconfig` already names a helper: the
first helper that answers wins, so an inherited `gh` helper hands git a *different* account's token, and a
private repository answers that account 404. Measured here — `gh` is signed in as an account that cannot see
the repository, so `gh auth git-credential` is not a usable store for this checkout, and the clone that
proved it failed with `Repository not found` until the inherited helpers were cleared.

`PI_SUPERAGENT_WATCHED_CHECKOUTS` adds checkouts to the scan. The deployment's own checkout and the ticket
checkouts under the worktree root are always scanned, and the ticket checkouts are looked for one level past
the ticket directory: the product clones into `<worktrees>/<ticket>/`, while a worker told "clone into your
workspace" clones into `<worktrees>/<ticket>/repo/` — measured, 26 of the 29 live checkouts are the second
shape. A linked worktree is read through its common dir, because that is where its remotes live. The scan
descends one level and no deeper, so a `node_modules` full of nested `.git` directories costs nothing.

"The deployment's own checkout" is the checkout the `superagent` command lives in, followed through a symlink:
a link on your PATH (`npm install -g` leaves one, and a hand link into a checkout is the documented
alternative) points at the same checkout it was written in, so the scan cannot be dodged by how the command
is installed. Measured before that: through a link, the guard scanned the link's own directory, found no
checkout, printed nothing, and `start` exited 0 over a checkout holding a `repo`-scoped token.

Rotating a token a URL has exposed is a web-UI action: GitHub exposes no API for creating or rotating
personal access tokens (a classic token asks 404), and a `ghp_` classic token cannot be scoped narrower than
`repo`. Mint a fine-grained token for the one repository with `contents: write` and `pull_requests: read`,
write it into the 0600 file, and `git ls-remote` proves the swap. Rotation then touches no git config.

Read which file feeds which role before you narrow a scope, and rotate every token the box holds, not only
the one the URL exposed. `PI_SUPERAGENT_GITHUB_TOKEN_FILE` is the router's own GitHub identity — it reads and
writes the watched board repository, files issues and posts receipts — and `PI_SUPERAGENT_WORKER_TOKEN_FILE`
is the identity a worker pushes its branch and opens its pull request as. Neither is the deployment's git
token, and scoping either one to a single code repository stops intake or stops the worker's push: the
one-repository recipe above is for the git credential only. Measured on the deployment box: three 0600 token
files in the state directory — the GitHub token (one file behind both settings above), the deployment's git
token, and the panel secret — and two of them are *separate* `repo`-scope classic tokens, so the URL exposed
one while the other kept read/write on every repository the account reaches.

Revoking the token is also what cleans the copies you cannot see: every worker home keeps a 0600
`~/.git-credentials` holding the worker token (62 of them on this box, written by the deployment for workers
that never finished). Revoke first, then delete the worker homes — deleting first leaves a live token behind.

## When several issues arrive at once

By default, four workers can run at once. If you open a fifth issue while all four are busy, its
ticket waits in the queue on the panel. A worker waiting for your answer can **park**. It keeps
its tab and its conversation history, and another ticket can use the free slot. When you reply,
the parked worker picks up where it left off. Set `PI_SUPERAGENT_MAX_WORKERS` to change the limit.

The judge reads one request at a time. Workers can build and test side by side, so their
instructions ask them to limit parallel jobs and clean up any processes they start. If a worker
goes quiet for 15 minutes, it appears under *Needs a person* on the panel. A long build can be
quiet, too. Take a look in the tab before interrupting it.

Label an open issue `priority:high` to put it in the next free slot. Queue order is priority
first, then oldest updated, and one priority launch per poll, because 38 pending tickets sharing
4 slots starves just as well in a priority lane that takes them all. The label never bypasses the
worker cap: it ranks the queue, it does not add a worker. Every grant line in `engine.log` names
the lane that won — `wonSlot: priority`, `wonSlot: oldest-starved` (queue win by age) or
`wonSlot: unanswered` (the thread has operator input no worker delivered) — and the panel's
ticket row repeats it under *wonSlot*. Measured 2026-11-19, the reason the
label exists: parking four tickets freed all four slots, and the router refilled them in 45
seconds with the oldest asks. Parking is not a stop either, so answer or withdraw the replies on
a thread you want to keep parked: a parked thread with unanswered operator input re-earns a
worker up to twice a day, and 6 times a day while it carries `priority:high`.

## When something goes wrong

**No acknowledgement after a few minutes.** Run `superagent status`, then inspect the most recent
decisions with `grep eval.decided ~/.pi/superagent/engine.log | tail`. For `kind=ignore`, read the
reason before posting a clearer request. If the log stays at `judge.prompt` without a decision,
restart the router with `superagent restart`.

**Someone else's issue gets no acknowledgement.** Check their GitHub author association, or look for
their login in `PI_SUPERAGENT_ALLOWED` if you configured a list. The panel's count of filtered triggers rises
by one for each request it dropped this way.

**A ticket stays open after a ready report.** Look for `review of #N` on the panel. Merge or close
that PR to finish the ticket. The router checks the watched repository on each poll and other
repositories every two minutes.

**Status exits 2.** Read `~/.pi/superagent/health.json` to identify the failing component. For a
GitHub source error, check `gh auth status`. The next successful poll clears the error.

**Status exits 2 and `health.json` names a `tick`.** The loop is not beating: a pass has been running longer
than `PI_SUPERAGENT_TICK_STALL_MS`, and `tick.stage` names where it is parked (`poll`, `reconcile`,
`recovery`, `drain`). `engine.log` repeats it as `tick.stalled`, with the stage's own time, and a pass that
never finishes is given up on (`tick.abandoned`) so the loop keeps its beat. A replacement that wedges in the
same place stops the replacing (`tick.abandon_skipped`, `3 passes in flight`): three passes are allowed live at
once, because an abandoned pass keeps its `gh` children and those have no timeout, and past that the alarm is
the product. The stage `tick.abandon_skipped` names is what to fix; a restart clears a router wedged this way,
which is the one case where it does. The line `tick n=…` is the
liveness line: its `gapMs` is the time since the last pass finished, read against `PI_SUPERAGENT_TICK_MS`.
A stall the fleet caused says so: `tick.stalled` carries `running` and `cap` next to `launchPending`, and
`health.json`'s `detail` names the cause in words — `tick stalled in drain for 6.0s (pass 6.1s): 12 launches
queued, 18 busy against the cap of 8` — because `superagent status` prints that sentence and a person reading
it over a wall should not have to open `config.env` to learn the cap. `router.start` logs `maxWorkers` and
`tickMs` for the same reason.
A `engine_tick` (or the panel's tick) asked for while a pass is parked does its work and says nothing: the
liveness line and `health.json` belong to the pass that owns the loop, so a tick by hand cannot switch off the
alarm you are reading.

**Status exits 2 saying `health.json is N min old`.** Nothing is reporting, which is the same fault with no
report attached: the process is alive in herdr, but the loop that rewrites that file on every pass is not
running — a pass blocked synchronously cannot report its own stall. Restart it (`scripts/superagent restart`).
A router paused on purpose keeps writing, one line per beat, so a pause never reads as stale; the dial is
`PI_SUPERAGENT_HEALTH_STALE_MIN` (15).

**The tab is up and the engine is down.** `superagent start` says `the router did not report ready within
60s`, `status` says `running and not beating: health.json is N min old`, and `engine.log` holds no
`router.start` stamped after the router's tab: pi is sitting in the tab and no engine was ever created in it,
so `ready` is missing and `health.json` keeps the timestamp of the router that died. The cause is usually the
session `start` resumes, the id in `<state>/session-id`: a pi session at the top of its context window has no
room left for its startup turn, and the extension is never reached. herdr prints the number — `herdr agent get
superagent` shows it as `tokens.context_usage`, and the tab header shows the same bar. A restart resumes the
same session, so it reproduces the fault: measured 2026-11-23, four starts and two remedy passes reported the
same two lines and nothing else. Clear the id and start fresh:

```sh
rm ~/.pi/superagent/session-id && superagent restart    # the next start writes a fresh id
```

That costs the router its chat log and nothing else: `tickets.db` is the engine's memory, the workers are
their own sessions, and a fresh id is minted on the next start. `start` and `status` name this case when herdr
reports the router's session at `PI_SUPERAGENT_CONTEXT_FULL_PCT` (80) percent or more, and `remedy` clears the
id on that reading, so the restart it makes opens a fresh session. A boot that did write its `router.start`
keeps its session id: that is the stall a restart does fix, and the router's history is not the price of
fixing it.

**The board is busy and nothing starts.** `tick n=…` carries `launchPending` (launches waiting for a free
worker slot) and `open`/`running`/`parked`. Waiting launches are the queue doing its job, not a stall; the
router no longer waits a pass on them. `drainMs=0 drained=false launchPending=22` is that reading: the pass
asked for the launches, found the cap full, and left them to the queue, which starts them on the pass that
finds a slot. A `drainMs` at your `PI_SUPERAGENT_LAUNCH_DRAIN_MS` on every pass means the pass is spending its
budget on a gate that cannot open — check `running` against `cap`.

Read the backlog per pass, not the fleet size. Measured on the live router over 1,690 tickets' worth of
`engine.log` (2026-11-09, #303): the 35 runs that queued at most one launch per pass beat every **30.0 s**,
and 17 of those runs were already over `PI_SUPERAGENT_MAX_WORKERS` with an empty queue; the one run that queued
a median of **12 launches per pass** with 18 workers on a cap of 8 beat every **2,780 s**. A fleet over its cap
is not the fault — it is the condition that makes a queued launch slow, and the old code waited a whole pass on
that queue. Startup takeover is one reason `running` can exceed `cap`: workers that outlived the previous
router are adopted without checking the cap, which is a policy question the code does not decide.

**Status exits 3.** Read `~/.pi/superagent/setup.json` for the missing prerequisite and its location. One
prerequisite is a credential in a checkout's git config; see
[Keep the git credential out of .git/config](#keep-the-git-credential-out-of-gitconfig).

**Start refuses with “carries a git credential in the clear”.** The router's own checkout, or one you listed in
`PI_SUPERAGENT_WATCHED_CHECKOUTS`, stores its credential in the remote URL, where every worker can read it. The
message names the file, the line and the mode; the fix is in
[Keep the git credential out of .git/config](#keep-the-git-credential-out-of-gitconfig). Nothing was started, so
the fix costs nothing to apply, and the same `start` or `restart` succeeds once the credential is out.

A ticket checkout under the state directory is different: a worker pushes with the box's GitHub login, so start
removes a credential a worker wrote into its own clone and says so (“removed a git credential from … line N”,
masked), then starts. It strips the `user:token@` part of a URL, deletes a line holding a bare GitHub token,
and leaves `ssh://git@…` alone. Until 2026-11-15 start refused these too, and one leaked worker folder kept the
fleet down for 15 hours after a reboot, with nobody told. A ticket worktree linked to a repository outside the
state directory is still refused: that repository is not the fleet's to edit.

**A worker looks stuck.** Open its herdr tab to inspect the current command. Type a message to steer
the worker or press Esc to interrupt it.

**A run ended without a report.** Inspect the worker’s tab for its last output. The session stays
open. Reply on the issue to continue or close the issue to drop the ticket.

**A worker crashed.** The router retries the first crash automatically and tells the replacement
what happened. After a second crash, inspect the failure and run `superagent restart` to retry,
or close the issue to stop.

**A worker could not start.** Read the error on the issue. Check repository access if the clone
failed, or inspect `PI_SUPERAGENT_PREPARE` if you use a custom setup command. The router retries
on each poll and posts the launch failure once.

## The panel's write endpoints (2026-11-10)

`POST /api/executor/pause` and `POST /api/tickets/<id>/stop` need the panel secret, because binding to
`127.0.0.1` keeps out remote callers and keeps out nothing local. The router writes it to
`panel-token` in the state directory (`0600`) at startup:

```sh
curl -X POST -H "x-superagent-request: 1" -H "x-superagent-token: $(cat ~/.pi/superagent/panel-token)" \
  -H 'content-type: application/json' -d '{"paused":true}' http://127.0.0.1:8788/api/executor/pause
```

## What a worker is given (2026-11-11)

A worker runs as you. It is a pi in a herdr tab with your whole harness loaded, your `HOME`, your keys and your
logins (operator, 2026-11-10: "agents should have all the power"). Its `gh` acts as the bot: the router names
the bot's token file in the tab (`PI_SUPERAGENT_WORKER_TOKEN_FILE`, from `PI_SUPERAGENT_WORKER_TOKEN_FILE` in
config.env), and the worker role reads it, so the token never appears on a command line.

What bounds a worker is the guard in its own pi: the commands in `PI_SUPERAGENT_BLOCKED` are refused, and writes
stay inside its workspace. Treat both as guardrails for an honest agent, not confinement: a name block is a
pattern on the command text, so a worker that copies or renames a binary walks past it, and a symlink inside
its workspace defeats the write check (audit 2026-11-11). A per-worker `HOME` existed in the code until
2026-11-11 and never reached a herdr worker; it is gone, and the router deletes `<state>/worker-homes` at
startup. Plan on that trust: a ticket's text is prompt content, so only people you would hand your terminal to
should be able to file work — that is what the intake scope decides, and the next section says who it is.
