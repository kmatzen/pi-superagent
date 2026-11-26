# pi-superagent

Open a GitHub issue and tell pi-superagent what you’d like to change. A coding agent works on it
in a checkout on your machine and opens a pull request for you to review. If you ask for a
revision, the same agent picks it up.

You can follow the conversation on GitHub or open the agent’s terminal to see what it’s trying
and lend a hand.

## Install

You’ll need Git, Node 22.19 or later, and three tools on a Mac or Linux machine. Pi runs the coding
sessions. Herdr gives each session a terminal tab. The GitHub CLI (`gh`) lets the agent read issues
and open pull requests using your account. [pi](https://github.com/earendil-works/pi) ·
[herdr](https://herdr.dev) · [GitHub CLI](https://cli.github.com)

Sign in to a model provider in pi and check that your model appears in `pi --list-models`. Then
sign in to GitHub with an account that can write to the repository you want to use.

```sh
gh auth login
gh auth setup-git
pi install npm:pi-superagent
npm install -g pi-superagent
```

The first install gives pi the extension. The second gives you the `superagent` command to start,
stop and check on it. Keep the two at the same version when you update.

## Try it on one issue

Choose a repository and open herdr in your terminal.

```sh
superagent init your-org/your-repo
herdr
```

Leave herdr open. In a second terminal, start the **router**, the background session that watches
your repository and sends work to the right agent.

```sh
superagent start
superagent status
```

In herdr, find the `superagent` workspace and wait for the first GitHub poll in the **engine log**
tab. That first look records the issues already open. Now open a new issue with a small request.
For example, “Show the keyboard shortcut next to Export in the Help menu.”

When the router accepts the request, it replies on the issue and opens a **ticket**, its record of
the work. A **worker** is the pi session assigned to that ticket. It gets its own checkout and a
tab labeled with the issue number. You can type into the tab, though usually a comment on the
issue is enough. If the worker needs a decision, it asks there.

A code change comes back as a pull request. Review the diff as usual. The ticket stays open while
you discuss the change and ends when you merge or close the PR. You can also ask a question, such
as where the shortcut is defined. For that, an answer on the issue can finish the job.

## While the worker runs

- **On GitHub**, reply on the issue to add a detail, or on the pull request to request a revision.
  To stop work before there’s a PR, close the issue. Reopening it makes a fresh request. When the
  work finishes with no PR to wait on — an answer, an operation — the router closes the issue too,
  because an open issue is a request the router hears again. Commenting on a closed issue starts the
  work again.
- **In herdr**, open the tab with the issue number to see the worker’s commands and output. The
  **engine log** tab shows what the router picked up and which requests it accepted.
- **In the local panel**, look under *Needs a person* to see who’s waiting for an answer. You can
  also see running workers, queued work and recent decisions. [Open the panel](http://127.0.0.1:8788/)

By default, the router listens to authors GitHub identifies as owners, organization members or
collaborators. You can choose particular logins, give the router its own GitHub account, or supply
a custom workspace setup. Run `superagent stop` when you want to stop the router.
[Operator guide](docs/operator-guide.md) · [Configuration examples](config.example.env)

## How it works

A separate pi session called the **judge** reads a new request and decides whether there’s work to
do. Once a ticket is open, follow-up comments go straight to its worker. The worker reports the
outcome through a tool call, which lets the router distinguish a finished run from a question or
a crash. The router stores the ticket on disk, so after a restart it can find the worker and pick
up the conversation. [Architecture](docs/architecture.md) · [Design decisions](docs/design-decisions.md)

The ticket engine comes from DeepSeek’s dsh-superagent-prototype. Three TLA+ models check how
tickets, incoming messages and worker tabs behave when events arrive in different orders. The models check
the design: `scripts/check-formal` reads `formal/`, never `src/`, so a code change that leaves the design is
caught by `npx vitest run` and not by TLC.
[Upstream project](https://github.com/deepseek-ai/dsh-superagent-prototype) ·
[Adaptation ledger](ADAPTATION.md) · [Formal verification](docs/formal-verification.md)

## Development

```sh
npm install
npm run check            # Type-check and run the test suite
npm run check:packed     # Install the tarball and exercise both the CLI and the pi extension (from a checkout;
                         # the installed package does not ship the script)
scripts/check-formal     # Check all three models (about 17 minutes with a JDK, measured 2026-11-11)
.github/workflows/ci.yml # GitHub Actions: typecheck and tests on every pull request and push, the formal
                         # check nightly
```

The test suite clears `PI_SUPERAGENT_*` settings to isolate its router from yours.
Publishing runs both npm checks before uploading the package.

Both projects use the MIT license. [Upstream attribution](NOTICE)
