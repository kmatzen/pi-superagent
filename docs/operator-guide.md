# Operator guide — ten minutes

## The one thing

Open a GitHub issue on the watched repo (`PI_SUPERAGENT_GITHUB_REPO`) that says, plainly, what you want done. That is the whole interface.

```
Title: Rename the export button to "Ship" in caramel's header
Body:  The primary button should say Ship, not Export. Keep the keyboard shortcut.
```

Within about a minute the engine acknowledges on the issue ("On it — …") if the judge accepts, and a worker
tab appears in the `superagent` herdr workspace doing the work. The finished result lands as a reply on the
issue. If the judge ignores it (chatter, a question for a person, or the thread already has an open ticket),
the reason is logged where the panel can show it.

## Watching

- **herdr → workspace `superagent`**: one tab per active ticket, live pi sessions, labelled `#<issue> · <title>`.
- **`engine log` tab** (first tab): every judgement and dispatch, streaming.
- **Panel**: <http://127.0.0.1:8788/> — needs-a-person, what's running, judge decisions with reasons.
- The `engine` tab is a control panel; it stays quiet while work runs. Judge turns happen in a separate
  headless session, and workers are their own tabs.

## Asking well

The judge is a model reading your words with one rule: a concrete action asked of the agent is a job.

- Good: "Rename X to Y in repo Z. Keep W unchanged." Bounded, actionable, yours.
- Ignored: "what do you think about…", notes to other humans, "this issue needs no action".
- One request per issue; follow-ups as comments on the same issue reach the same ticket's worker.
- A comment on a pull request reaches the agent too, and a submitted review ("changes requested")
  fires a fresh judgement; replies post into the PR's conversation.
- A ticket you want killed: comment "stop" on the issue, use the panel, or
  `curl -X POST -H 'x-superagent-request: 1' http://127.0.0.1:8788/api/tickets/<id>/stop`.

## Operating

```sh
~/git/pi-superagent/scripts/superagent status    # 0 ok, 1 down, 2 a part is failing, 3 waiting for setup
~/git/pi-superagent/scripts/superagent restart   # safe: workers survive; the router adopts its tickets
tail -F ~/.pi/superagent/engine.log              # everything the engine did
sqlite3 ~/.pi/superagent/tickets.db 'select value from ticket' | head   # the raw ledger
```

Settings live in `~/.pi/superagent/config.env` (copy `config.example.env` there); the repo is the one that matters. A scheduled health check
runs `status` and restarts on exit code 1, leaving a deliberate `stop` alone (it honours the stop marker).

## When something is wrong

- **No acknowledgement after ~5 min**: `status` first. Then `tail -20 ~/.pi/superagent/engine.log` — a
  `judge.prompt` with no `eval.decided` means the judge is wedged: `restart` fixes it.
- **Issue silently ignored**: the panel's Eval table shows the judge's reason. Reopening the issue, or
  adding a clearer comment, fires a fresh judgement.
- **Worker stuck**: open its tab in herdr and read it — it is a normal pi session; you can type into it.
- **Worker died mid-work**: the ticket reports `failed` on the issue with one sentence saying why. Open a
  fresh issue (or comment) to retry; the engine starts a clean worker.

## Costs

Every judgement and every ticket is a pi session (model spend). The judge is capped and queued
(`PI_SUPERAGENT_MAX_EVALS`, default 2 in flight); workers are capped at 4 (`PI_SUPERAGENT_WORKERS`). A
request that is not a job costs one short judge turn.
