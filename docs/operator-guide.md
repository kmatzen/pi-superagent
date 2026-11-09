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
superagent status    # 0 healthy · 1 down · 2 a part is failing · 3 waiting for setup
superagent restart   # safe at any time: workers keep running and the new router adopts them
superagent stop      # leaves a marker, so the health check will not restart it
superagent start     # clears the marker
```

In a checkout, the same script is `scripts/superagent`.

Settings live in `~/.pi/superagent/config.env`. [`config.example.env`](../config.example.env), shipped
with the package, explains each setting and its default. Restart to apply a change.

On macOS, the launchd job in [`launchd/`](../launchd/com.example.superagent-health.plist) runs `status`
every five minutes and starts a router that is down. It leaves a deliberately stopped router alone.
Install it once:

```sh
plist="$(npm root -g)/pi-superagent/launchd/com.example.superagent-health.plist"   # launchd/ in a checkout
sed "s|__HOME__|$HOME|g" "$plist" > ~/Library/LaunchAgents/com.example.superagent-health.plist
launchctl load ~/Library/LaunchAgents/com.example.superagent-health.plist
```

The job finds `superagent`, `pi` and `herdr` on its own PATH: Homebrew's directories, `/usr/local/bin` and
`~/.npm-global/bin`. If `command -v superagent` or `command -v pi` prints a directory outside those, as nvm's
do, add it to the job's PATH. From a checkout, replace `superagent` in the job with the script's full path.

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

**The board is busy and nothing starts.** `tick n=…` carries `launchPending` (launches waiting for a free
worker slot) and `open`/`running`/`parked`. Waiting launches are the queue doing its job, not a stall; the
router no longer waits a pass on them.

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

**Start refuses with “carries a git credential in the clear”.** A watched checkout stores its credential in
the remote URL, where every worker can read it. The message names the file, the line and the mode; the fix
is in [Keep the git credential out of .git/config](#keep-the-git-credential-out-of-gitconfig). On a plain
`start` nothing was started, so the fix costs nothing to apply.

On `restart` it is not free: `restart` is `stop; start`, and the scheduled health check is
`status || start`. So a checkout that gains a credential *while the fleet runs* ends the fleet — the router is
stopped, the start is refused, and the health check keeps refusing every five minutes until the URL is fixed.
That is the intended posture: waking ~20 worker sessions over a disclosed credential is worse than a stopped
router. The fix is the URL, not a second restart; the same `restart` succeeds once the credential is out of it.

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

## What a worker is given (2026-11-10)

A ticket's text is prompt content, so a worker session now starts with `--no-extensions` (the harness in
`~/.pi/agent` is yours, with your watchers and your credentials) and a `HOME` under
`<state>/worker-homes/<ticket>`, with `PI_SUPERAGENT_GITHUB_TOKEN_FILE`, `PI_OPS_*`, `SSH_AUTH_SOCK`,
`GH_TOKEN`, `GITHUB_TOKEN` and cloud credential names removed from its environment.

The consequence to plan for: a worker can no longer run `gh` as you, so it cannot open a pull request
with your login. It works in its checkout, commits to its branch, and reports; the router's receipts and
reports carry the ticket. To hand a worker GitHub access, give it a fine-grained single-repository token
in that home directory — do not restore the ambient login, which is the operator's whole account.

## What the router cannot read (2026-11-10)

A ticket that follows a pull request ends when the router reads that pull request land. When the router's GitHub
account cannot see the repository, GitHub answers 404 — the same answer it gives for a pull request that does not
exist — so the router keeps the ticket waiting (it will not end a ticket on a guess) and says so on the ticket:

```
#227: I cannot follow https://github.com/matzen_adobe/fleet-board/pull/69, so this ticket can never end on it.
GitHub answers 404 for `matzen_adobe/fleet-board`, which is what it says of a repository the account I run as
(matzenbot_adobe) cannot read … Two doors: grant that account read access to `matzen_adobe/fleet-board`, or
comment here when the work has landed and I will take your word for it.
```

Check it with the token the router reads with, and never paste the token anywhere:

```sh
GH_TOKEN=$(cat ~/.pi/superagent/github-token) gh api repos/OWNER/REPO --jq .full_name
```

A 404 there is the whole cause: add that account as a read-only collaborator, or give the router a token scoped to
the repository. It takes effect on its own — the readability answer expires every 15 minutes — so there is nothing to
restart. Check the grant itself, not the intention: `gh api repos/OWNER/REPO/collaborators --jq '[.[].login]'` as the
repository's owner must list the bot. Measured 2026-11-09, the answer to this ask was "addressed" while the
collaborator list of both repositories named only their owner. In the log the lines are `pull.read_failed` (`permanent: true` on a 404 for a repository the account
cannot see) and `pull.blind_notice`, said once per ticket per pull request, not once per poll. A terminal receipt
refuses to state an outcome it never saw: where the ticket's record says a pull request closed and the router cannot
read it, it says it cannot read it and asks, instead of claiming "closed without merging" — measured 2026-11-09 on
board #309, where the sentence was false and the issue closed on it.
