# formal/

TLA+ specifications of the three places in pi-superagent where a bad ordering would quietly lose or
duplicate work. TLC, the TLA+ model checker, explores every reachable state of each one.

| Specification | Models | Distinct states |
| --- | --- | --- |
| `Ticket.tla` | the engine's ticket lifecycle (`src/core`) | 1,398,882 |
| `Intake.tla` | the GitHub source (`src/pi/source-github.ts`) | 113,281 |
| `Workers.tla` | worker records, tabs and agents (`src/pi/herdr-workers.ts`) | 94 |

Each `.cfg` file names its specification's constants and lists the invariants and properties TLC checks.
What every claim means, and what none of them say, is in
[docs/formal-verification.md](../docs/formal-verification.md).

## Running

`scripts/check-formal` checks all three in about five minutes and exits 0 only when every one completes.
To check one by hand, from this directory:

```sh
java -XX:+UseParallelGC -Xmx4g -cp ~/.cache/tla2tools/tla2tools.jar tlc2.TLC -config Intake.cfg Intake.tla
```

## Changing a specification

- Every action names the function whose guards it mirrors. When that function changes, change the action
  and run the check again.
- Every header lists what its model leaves out. A claim covers a left-out feature only as far as that
  feature's code passes through the same guards, so keep the list current.
- Keep the bounds small. A check that takes hours stops being run, and a check nobody runs proves nothing.
