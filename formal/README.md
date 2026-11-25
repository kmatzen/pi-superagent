# TLA+ models

A worker finishes just as the router restarts. Should the router start another worker, adopt the
one it finds, or close the tab? Small differences in timing matter here. These three models let
TLC, the TLA+ model checker, explore the possible orderings within a set of bounds. Start with
the model closest to the code you’re changing.

| Specification | Code it models | Distinct states |
| --- | --- | ---: |
| [Ticket.tla](Ticket.tla) | Ticket lifecycle in `src/core/` | 924,784 |
| [Intake.tla](Intake.tla) | GitHub polling in `src/pi/source-github.ts`, and the ready sweep's trigger at `engine.receive` | 385,777 |
| [Sweep.tla](Sweep.tla) | The ready sweep's own rules in `Intake.sweep` (`src/core/intake.ts`) | 482 |
| [Workers.tla](Workers.tla) | Worker records and herdr tabs in `src/pi/herdr-workers.ts` | 94 |

Each accompanying `.cfg` file sets the bounds and selects the properties to check.
[Property definitions and assumptions](../docs/formal-verification.md)

## Run the checks

From the repository root, run `scripts/check-formal`. All three checks take about five minutes and
require a JDK. The script downloads the TLC jar on first use. To rerun just the intake model, run
this command from the `formal/` directory.

```sh
java -XX:+UseParallelGC -Xmx4g -cp ~/.cache/tla2tools/tla2tools.jar tlc2.TLC -config Intake.cfg Intake.tla
```

## Update a model

Each action names the implementation function it represents. When you change a transition or its
guards, update the corresponding action and rerun TLC. Keep the scope and exclusions in the model
header current. Choose bounds small enough to explore exhaustively during development.
