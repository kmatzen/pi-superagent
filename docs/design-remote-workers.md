# The whole fleet on atscloud; the laptop becomes a window

Status: accepted (2026-11-11). Owner: the router's operator. Touches ops provisioning, the
`scripts/superagent` supervisor paths, and the panel's reach story. No engine change: the router,
the judge, and the workers on one box is the topology the code already runs.

## Why

The measured failure is the laptop, not the code: a VPN drop takes corpnet from the router, the
judge, and every worker at once, and a closed lid does the same politely. atscloud is inside
corpnet — no VPN, no sleep, real uptime. The operator's decision (2026-11-11): move the **whole**
system — router, state, judge, and workers — to atscloud, and keep the laptop as a window: panel,
CLI, the operator's seat.

The big consequence: co-located parts stay co-located. Router, judge, and workers on one server
means the existing herdr/tmux launch path, the in-process report tool, and the loopback panel all
work as they do today. The remote-launcher machinery a split deployment needs is deferred to the
day the fleet spans hosts.

## Topology

```
atscloud server (one home for the fleet)          laptop (window)
  router (pi extension, engine, judge)              ssh -L 8788:127.0.0.1:8788 → panel
  workers (herdr/tmux sessions)                     scripts/superagent --state ssh-mounted? no:
  ~/.pi/superagent/  (db, logs, archive)              operate remotely: ssh + the panel
  ~/.pi/superagent-work/ (ticket checkouts)           (local copy of the repo stays for development)
  panel 127.0.0.1:8788 + panel token                corpnet access for browsing: VPN, laptop-only
  supervisor: cron/systemd --user (Linux),
  replacing launchd
```

- The panel stays loopback-bound and token-guarded; the operator reaches it with
  `ssh -L 8788:127.0.0.1:8788 <host>` — the laptop's VPN state then affects only viewing, never the fleet.
- GitHub and every corpnet resource are native from atscloud (the operator's measured fact,
  2026-11-11). The corp proxy goes in the router's and workers' environment.

## What must move (a checklist, not a hope)

1. **Provision** (`scripts/provision-remote` + `scripts/provision-harness`, both re-runnable):
   node + npm, `pi`, `pi-superagent` from the packed tarball, `gh`, git identity (the bot), tmux,
   `herdr`, proxy exports, the workers root — and the pi harness, skills and extensions included.
2. **Secrets**: the bot gh token and worker token files, 0600, inside a home directory the audit
   proves is not world-readable (atscloud is multi-user — this is the one security step with teeth).
   The operator's keychain stays on the laptop. API keys stay behind doorman; a worker that needs
   one gets it the same way today, and a doorman lane on the server is its own later decision.
3. **State**: stop the laptop router, `rsync` `~/.pi/superagent` (db, archive, kv, outbox) and the
   live ticket worktrees that matter, start on the server. Downtime is minutes; the seen set and
   open tickets carry over because the database is the fleet's memory.
4. **Supervision**: launchd has no meaning on Linux. `scripts/superagent` keeps start/stop/status
   (herdr + tmux are portable), and the health/backup job moves from the launchd plist to cron on
   the server (`remedy` + `backup` daily, the same two commands as today). A boot-resume story:
   cron `@reboot superagent remedy` — the watchdog class already heals boots it broke.
5. **The laptop's role after**: development stays on the laptop (repo, tests, gates); deployment
   targets the server (`scripts/superagent --session ... deploy` over ssh, rsync of the packed
   tarball — the same artifact `check-packed` proves); the panel is a tunnel away.

## Failure semantics that change, and ones that don't

- VPN drop (laptop): fleet unaffected. Viewing the panel fails until the tunnel is back — an
  operator inconvenience, deliberately the worst case.
- Server reboot: workers die with it (tmux), the router restarts via @reboot/cron, assignments
  resume by the existing relaunch rules (the re-grant path, ticket counters, seen set).
- The router and workers share a box: a wedged worker can cost CPU — the cap (8) and the watchdog
  are the same controls as today; disk gets the byte budget at the new work root.
- Nothing about dedupe, receipts, close rules, or formal proofs changes: the engine does not know
  what OS it runs on, and that is the point.

## The harness ships with the fleet

A worker is its harness — skills, extensions, `AGENTS.md`, the voice files, model and trust
settings. Workers load `~/.pi/agent` on their own box, so the move is not real until the harness is
there too (`scripts/provision-harness`): a manifest of the portable parts (not sessions, logs,
backups, caches, `node_modules`), the laptop's home prefix rewritten to the server's in the JSON
that carries it, provider credentials (`auth.json`) at 0600 beside the git tokens, and the npm
packages reinstalled from `npm/package.json` — the manifest's truth, not 398 MB of copied
laptop binaries. The laptop-only services behind some MCP servers and doorman stay laptop-only; a
worker that needs one asks the way it asks today, and the pilot records which asks need a lane.

## Pilot, then cut over

1. Pick the host (operator names it), run the provision script, prove: `pi` runs, `gh api user`
   says the bot, a git clone and push work through the proxy, tmux + herdr start.
2. Ship the packed tarball there, run `superagent init` + `status` — gates green on the new box.
3. One ticket end to end with a copy of the state (a copied database, panel on a tunnel): launch,
   report, pull request, close.
4. Cutover night: stop the laptop router (say so on the board), rsync state, start the server
   router, watch the first ticks, retire the launchd job. Rollback is the same rsync in the other
   direction.

## Deferred, on purpose

- Remote launcher (router on one host, workers on others): the design seam is the `WorkerLauncher`
  port; build it when the fleet spans hosts, not before.
- Multi-user isolation beyond file modes (separate account per fleet): decide after the pilot's
  disk and permission experience.
- doorman for server-side API keys: its own design.
