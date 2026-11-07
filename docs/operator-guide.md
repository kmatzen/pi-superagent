# Operator guide

Use the GitHub thread to request work and answer the worker. Open its herdr tab when you need to
inspect the session or intervene directly.

## Asking for work

Open an issue on the watched repository (`PI_SUPERAGENT_GITHUB_REPO`) and describe the change you want. Include anything the worker should preserve.

```
Title: Rename the Export button to "Ship"
Body:  The primary button in the header should say Ship instead of Export. Keep the keyboard shortcut.
```

When the judge accepts the request, the router replies on the issue and opens a worker tab in the
`superagent` herdr workspace. Look for the issue number in the tab title. The worker’s report
appears on the same thread.

The judge accepts a concrete action someone asks the agent to take, even one that calls itself a test.
It ignores chatter, notes addressed to other people, and new requests on a thread that already has an
open ticket. An ignore posts nothing on the issue; the reason is in the engine log.

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

- **The herdr workspace `superagent`.** The `engine log` tab streams every poll, judgement, launch and
  receipt. Each worker has its own tab, labelled `#<issue> · <title>`; it is an ordinary pi session, so
  you can read along, type into it, or press Esc to interrupt it.
- **The panel** at <http://127.0.0.1:8788/>. It shows what needs a person, what is running and queued,
  and what the judge decided.
- **Engine log.** `tail -F ~/.pi/superagent/engine.log`. Each line is one event with its fields, so
  `grep eval.decided` lists every judgement with its reason.

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

## Capacity

Up to four workers can be on a run at once (`PI_SUPERAGENT_MAX_WORKERS`); further tickets wait their
turn, queued on the panel. A worker between runs, waiting on your answer or simply done, is *parked*: it
keeps its tab and everything it knows, but gives up its slot, so the queue keeps moving. A reply puts it
back on a run. The judge answers one request at a time. Every worker's brief says the machine is shared:
sequential builds, bounded parallel jobs, nothing left running after the report.

A worker on a run that emits nothing for 15 minutes is flagged on the panel, and only there, under *Needs a
person*: steer it, stop it, or accept its work. The flag does not stop the worker. If it is only running a
long build, let it be; the flag clears when the worker reports.

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
