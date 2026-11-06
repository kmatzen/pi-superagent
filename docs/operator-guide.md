# Operator guide

Everything you need to ask for work, watch it happen, and set it right when it goes wrong.

## Asking for work

Open an issue on the watched repository (`PI_SUPERAGENT_GITHUB_REPO`) and say plainly what you want
done:

```
Title: Rename the Export button to "Ship"
Body:  The primary button in the header should say Ship instead of Export. Keep the keyboard shortcut.
```

Within about a minute the judge's acknowledgement appears on the issue, and a tab named for the issue
opens in the `superagent` herdr workspace with the worker inside. When the worker finishes, its report
arrives on the issue as a reply.

The judge accepts a concrete action someone asks the agent to take, even one that calls itself a test.
It ignores chatter, notes addressed to other people, and new requests on a thread that already has an
open ticket. An ignore posts nothing on the issue; the reason is in the engine log.

- **Follow-ups.** Comment on the same issue. While its ticket is open, your comments go straight to its
  worker.
- **Pull requests.** A comment on a pull request's conversation reaches the agent like any other. A
  submitted review, whether it approves or requests changes, fires a fresh judgement, and the answer
  lands in the pull request's conversation.
- **Questions from a worker.** A worker that needs you reports *blocked* with one question. The question
  is posted on the issue (and listed on the panel under *Needs a person*); answer it with a comment.
- **Stopping.** Close the issue, or merge the pull request that closes it. Within one poll the ticket
  stops and says so on the thread. Reopen the issue to run the request again. Without GitHub, the panel
  API stops a ticket too:
  `curl -X POST -H 'x-superagent-request: 1' http://127.0.0.1:8788/api/tickets/<id>/stop`.

## Watching

- **The herdr workspace `superagent`.** The `engine log` tab streams every poll, judgement, launch and
  receipt. Each worker has its own tab, labelled `#<issue> · <title>`; it is an ordinary pi session, so
  you can read along, type into it, or press Esc to interrupt it.
- **The panel** at <http://127.0.0.1:8788/>. It shows what needs a person, what is running and queued,
  and what the judge decided.
- **The log itself:** `tail -F ~/.pi/superagent/engine.log`. Each line is one event with its fields, so
  `grep eval.decided` lists every judgement with its reason.

## Running it

```sh
scripts/superagent status    # 0 healthy · 1 down · 2 a part is failing · 3 waiting for setup
scripts/superagent restart   # safe at any time: workers keep running and the new router adopts them
scripts/superagent stop      # leaves a marker, so the health check will not restart it
scripts/superagent start     # clears the marker
```

Settings live in `~/.pi/superagent/config.env`. Start from [`config.example.env`](../config.example.env),
which explains each setting and its default, and restart to apply a change.

The launchd job in [`launchd/`](../launchd/com.example.superagent-health.plist) runs `status` every five
minutes and starts a router that is down. It leaves a deliberately stopped router alone. Install it once:

```sh
sed "s|__HOME__|$HOME|g" launchd/com.example.superagent-health.plist \
  > ~/Library/LaunchAgents/com.example.superagent-health.plist
launchctl load ~/Library/LaunchAgents/com.example.superagent-health.plist
```

The job expects the checkout at `~/git/pi-superagent`; edit its `cd` if yours lives elsewhere.

### The account the agent posts as

Left alone, the agent posts from `gh`'s sign-in — yours. Then every acknowledgement and receipt on an issue
is authored by `matzen_adobe`, and the thread cannot be read as a conversation with an agent.

Give it an account of its own. Create a machine account (or a GitHub App, whose login ends in `[bot]`),
give it write access to the watched repository, and put a fine-grained token for it — that repository only,
Issues read and write — where only you can read it:

```sh
umask 077
printf '%s' 'github_token_for_the_agent_account' > ~/.pi/superagent/github.token
```

The router reads that file per request, so rotating the token is a file write, not a restart, and passes it
only to the `gh` child. Nothing else about the deployment changes; restart, then prove it:

```sh
scripts/superagent identity   # speaks as: <the bot login> (token file …) · repo · the router's last check
gh api repos/OWNER/REPO/issues/1/comments --jq '.[-1].user.login'   # who actually wrote the last reply
```

`PI_SUPERAGENT_GITHUB_SELF` names the bot account when its login could be yours (a `[bot]` suffix, or a
login matching `PI_SUPERAGENT_BOTS`, is adopted on its own); `status` then exits 3 with `github-identity`
if the credential belongs to someone else, which is the failure that makes every receipt the operator's.
With no token file at all, the agent shares your login and is told apart only by the reply footer it signs.
Workers never get the credential: `gh` is blocked for them, and `GH_TOKEN` is stripped from their env.

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

**No acknowledgement after a few minutes.** Run `status` first. Then
`grep eval.decided ~/.pi/superagent/engine.log | tail`: `kind=ignore` comes with the judge's reason, and a
clearer comment or a reopened issue asks again. A `judge.prompt` line with no `eval.decided` after it
means the judge is wedged; `restart` fixes it.

**`status` exits 2.** Read `~/.pi/superagent/health.json`. A failing `source` means the router cannot
reach GitHub; check `gh auth status`. The error clears on the next good poll.

**`status` exits 3.** Read `~/.pi/superagent/setup.json`: it names what is missing and where to fix it. A
`github-identity` problem means the credential and `PI_SUPERAGENT_GITHUB_SELF` name different accounts, so
`scripts/superagent identity` says which is which; a `github-token-readable` one means the token file needs
`chmod 600`.

**A worker looks stuck.** Open its tab and read it. Type into it to steer, or press Esc to interrupt.

**The issue says the worker stopped without reporting a result.** It ended a run without calling
`ticket_report`, so whatever it concluded is still in its tab. The worker is still open: a reply on the
issue steers it, and closing the issue drops the ticket.

**The issue says the worker crashed.** The router has already started a fresh worker on it, once, and the
new worker's brief says what happened. If the issue says the fresh worker crashed too, nothing runs the
ticket until `superagent restart`, and closing the issue drops it.

**The issue says a worker could not start.** The notice quotes the error, usually from the setup script
(`PI_SUPERAGENT_PREPARE`). The router retries on every poll, without posting again, until the cause is
fixed or the issue is closed.
