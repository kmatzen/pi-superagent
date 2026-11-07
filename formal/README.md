# TLA+ models

TLC explores the possible event orderings in three bounded models. Each model covers a failure that
can be hard to reproduce in a running router, such as a crash between reading a comment and saving it.

| Specification | Code it models | Distinct states |
| --- | --- | ---: |
| [Ticket.tla](Ticket.tla) | Ticket lifecycle in `src/core/` | 1,398,882 |
| [Intake.tla](Intake.tla) | GitHub polling in `src/pi/source-github.ts` | 113,281 |
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
