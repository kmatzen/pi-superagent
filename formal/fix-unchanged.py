#!/usr/bin/env python3
"""Drop from each action's UNCHANGED list every variable the action assigns.

A widened UNCHANGED list that also names an assigned var makes the action identically false, which is how this
model ran "green" over 10k states with no worker Session reachable. Run from the repository root.
"""
import re
from pathlib import Path

P = Path("formal/Ticket.tla")
text = P.read_text()
lines = text.split("\n")
starts = [i for i, line in enumerate(lines) if re.match(r"^[A-Z][A-Za-z0-9]*(\(.*\))?\s*==", line)]
bounds = starts + [len(lines)]

for a, b in zip(bounds, bounds[1:]):
    block = lines[a:b]
    joined = "\n".join(block)
    assigned = set(re.findall(r"\b([a-zA-Z]+)'(?:\s*=|\s*\\cup|\s*\\\{)", joined))
    if not assigned:
        continue
    for idx, line in enumerate(block):
        match = re.search(r"UNCHANGED <<([^>]+)>>", line)
        if not match:
            continue
        keep = [v.strip() for v in match.group(1).split(",") if v.strip() not in assigned]
        if len(keep) == len(match.group(1).split(",")):
            continue
        head = re.match(r"\s*/\\\s*", line).group(0)
        block[idx] = head + (("UNCHANGED <<" + ", ".join(keep) + ">>") if keep else "TRUE")
        lines[a:b] = block
        print(f"{lines[a].split('==')[0].strip():16} UNCHANGED drops {sorted(assigned)}")
        break

P.write_text("\n".join(lines))
