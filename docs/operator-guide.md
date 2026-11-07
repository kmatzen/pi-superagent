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

**Status exits 3.** Read `~/.pi/superagent/setup.json` for the missing prerequisite and its location.

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
