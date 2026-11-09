#!/usr/bin/env python3
"""Extend formal/Ticket.tla with the pull-request merge, the worker Session, and the dead-session sweep.

Adds vars `working` (the executor's live map: a tab, an agent, a slot), `pullOpen` (the ticket follows its own
unmerged pull request) and `gone` (its Session died outside the engine), plus the actions that move them, and
the claims R5, R6, W1. Run from the repository root; it edits in place and is safe to re-run only on the
unpatched file.
"""
from pathlib import Path
import re

P = Path("formal/Ticket.tla")
C = Path("formal/Ticket.cfg")
NEW = "pullOpen, working, gone"
s = P.read_text()

s = s.replace(
    """VARIABLES
  released,       \\* tickets whose asking worker was freed, awaiting the answer that restarts one""",
    """VARIABLES
  released,       \\* tickets whose worker was freed (it asked, or it finished and a person must merge), awaiting the next request
  working,        \\* tickets whose worker Session exists: the tab, the agent, the slot (the executor's live map)
  pullOpen,       \\* tickets following their own pull request that a person has not merged yet
  gone,           \\* tickets whose worker Session died outside the engine (a restart adopts, then the session is gone)""",
    1)
assert "  working,        \\*" in s

s = s.replace("  /\\ released = [k \\in TicketIds |-> FALSE]",
              "  /\\ released = [k \\in TicketIds |-> FALSE]\n  /\\ working = {}\n  /\\ pullOpen = {}\n  /\\ gone = {}", 1)


def widen(match: re.Match) -> str:
    inner = match.group(1)
    return "UNCHANGED <<" + (NEW + ", " if "pullOpen" not in inner else "") + inner + ">>"


# Order matters: un-constrained TLA+ vars float free, so every action's UNCHANGED list is widened before the new actions land.
s = re.sub(r"UNCHANGED <<([^>]*?)>>", widen, s)

s = s.replace("""  /\\ tickets' = [tickets EXCEPT ![k].asg = [asg EXCEPT ![Len(asg)] = "run"]]
  /\\ UNCHANGED""",
              """  /\\ tickets' = [tickets EXCEPT ![k].asg = [asg EXCEPT ![Len(asg)] = "run"]]
  /\\ working' = working \\cup {k}
  /\\ gone' = gone \\ {k}
  /\\ UNCHANGED""", 1)

s = s.replace("""     /\\ tickets' = [tickets EXCEPT ![k].lastReport = r,
                               ![k].state = IF r = "ready" THEN "done" ELSE IF r = "dropped" THEN "dropped" ELSE @,
                               ![k].asg = IF r = "ready" \\/ r = "dropped" THEN allEnd ELSE @]""",
              """     /\\ tickets' = [tickets EXCEPT ![k].lastReport = r,
                               ![k].state = IF r = "ready" /\\ k \\notin pullOpen THEN "done"
                                            ELSE IF r = "dropped" THEN "dropped" ELSE @,
                               ![k].asg = IF r = "ready" \\/ r = "dropped" THEN allEnd ELSE @]
     (* A report that ENDS the ticket disposes its Session (the executor's ending path). A `ready` report on a
        ticket that follows its own open pull request ends no ticket, and the Session survives it — that is the
        shape measured on 2026-11-09: 15 tickets sat `ready` on an unmerged pull request, 4h to 21h, each still
        holding a tab, an agent and a slot. R5 is the claim that this is fixed. *)
     /\\ IF tickets'[k].state \\in {"done", "dropped"} THEN working' = working \\ {k} ELSE UNCHANGED working""", 1)
s = s.replace("  /\\ UNCHANGED <<pullOpen, working, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>\n\n(* Tickets.retry",
              "  /\\ UNCHANGED <<pullOpen, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>\n\n(* Tickets.retry", 1)

s = s.replace("""Release(k) ==
  /\\ tickets[k].state = "live"
  /\\ ~released[k]
  /\\ tickets[k].lastReport \\in {"blocked", "waiting"}
  /\\ LET asg == tickets[k].asg IN
     /\\ Len(asg) > 0
     /\\ asg[Len(asg)] = "run"
     /\\ tickets' = [tickets EXCEPT ![k].asg = [asg EXCEPT ![Len(asg)] = "end"]]
  /\\ released' = [released EXCEPT ![k] = TRUE]""",
              """Release(k) ==
  /\\ tickets[k].state = "live"
  /\\ k \\in working
  /\\ ~released[k]
  /\\ asksAHuman(k)
  /\\ LET asg == tickets[k].asg IN
     /\\ Len(asg) > 0
     /\\ tickets' = [tickets EXCEPT ![k].asg = IF asg[Len(asg)] = "run"
                                              THEN [asg EXCEPT ![Len(asg)] = "end"] ELSE asg]
  /\\ released' = [released EXCEPT ![k] = TRUE]
  /\\ working' = working \\ {k}""", 1)

new_actions = """
(* A worker pushes its own pull request, which the router follows. The ticket stays open: only a person
   merges, and the close is what ends it (Tickets.threadClosed). *)
OpenPull(k) ==
  /\\ tickets[k].state = "live"
  /\\ k \\notin pullOpen
  /\\ pullOpen' = pullOpen \\cup {k}
  /\\ UNCHANGED <<released, working, gone, tickets, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* PullFollower observes the merge, engine.threadClosed ends the ticket with its result, and the ending
   disposes the Session. *)
MergePull(k) ==
  /\\ k \\in pullOpen
  /\\ tickets[k].state = "live"
  /\\ tickets[k].lastReport = "ready"
  /\\ pullOpen' = pullOpen \\ {k}
  /\\ tickets' = [tickets EXCEPT ![k].state = "done"]
  /\\ working' = working \\ {k}
  /\\ UNCHANGED <<released, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* The worker Session dies outside the engine: the process exits, or a router restart adopts the ticket and the
   session behind it is already gone. Nothing in the engine asked for this. *)
SessionDies(k) ==
  /\\ k \\in working
  /\\ k \\notin gone
  /\\ gone' = gone \\cup {k}
  /\\ UNCHANGED <<released, working, pullOpen, tickets, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* The sweep the router owes the fleet (measured 2026-11-09: 21 assignments ran 4h+ against dead Sessions,
   oldest 34.7h, answers unread): a ticket whose Session is gone frees the agent the way a question does, so the
   person's next message starts a fresh worker (Resurrect). *)
Sweep(k) ==
  /\\ k \\in gone
  /\\ k \\in working
  /\\ tickets[k].state = "live"
  /\\ LET asg == tickets[k].asg IN
     /\\ tickets' = [tickets EXCEPT ![k].asg = IF Len(asg) > 0 /\\ asg[Len(asg)] = "run"
                                              THEN [asg EXCEPT ![Len(asg)] = "end"] ELSE asg]
  /\\ released' = [released EXCEPT ![k] = TRUE]
  /\\ working' = working \\ {k}
  /\\ UNCHANGED <<pullOpen, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

"""
anchor = "(* Tickets.retry (tickets.ts):"
assert s.count(anchor) == 1
s = s.replace(anchor, new_actions.lstrip("\n") + anchor, 1)

s = s.replace("MaxAsg     == 3", "MaxAsg     == 2", 1)
s = s.replace("(* ---- state ---- *)", """(* A worker is waiting on a person, so its agent is worth more free than warm: it asked a question, it needs an
   answer, or its own pull request is open and only a person can merge it. *)
asksAHuman(k) == tickets[k].lastReport \\in {"blocked", "waiting"}
                   \\/ (tickets[k].lastReport = "ready" /\\ k \\in pullOpen)

(* ---- state ---- *)""", 1)

s = s.replace("  \\/ \\E k \\in TicketIds : Release(k)",
              "  \\/ \\E k \\in TicketIds : Release(k)\n  \\/ \\E k \\in TicketIds : OpenPull(k)\n  \\/ \\E k \\in TicketIds : MergePull(k)\n  \\/ \\E k \\in TicketIds : SessionDies(k)\n  \\/ \\E k \\in TicketIds : Sweep(k)", 1)
s = s.replace("/\\ \\A k \\in TicketIds : WF_vars(Release(k)) /\\ WF_vars(Resurrect(k))",
              "/\\ \\A k \\in TicketIds : WF_vars(Release(k)) /\\ WF_vars(Resurrect(k))\n  /\\ \\A k \\in TicketIds : WF_vars(Sweep(k)) /\\ WF_vars(MergePull(k))", 1)

s = s.replace("""R3_ReleaseNeedsAQuestion ==
  []([Unchanged <<tickets, batch, delivered, evalQ, evaluating, ackPend, ackSent>>]_vars
       => \\A k \\in TicketIds : released' = [released EXCEPT ![k] = released[k]])""",
              """(* R3. Nothing is taken from under a turn: a step that frees a worker implies the person is the only thing it
   can be waiting for — it asked, it needs an answer, its pull request waits on a merge, or its Session is dead.
   A step formula, so it goes in PROPERTY. *)
R3_ReleaseNeedsAQuestion ==
  [][\\A k \\in TicketIds : (released'[k] /\\ ~released[k])
        => (asksAHuman(k) \\/ k \\in gone)]_vars

(* R5. Nobody sits on a merge: while a live ticket's own pull request is open and its worker reported `ready`,
   the ticket eventually has no worker Session, so the agent, tab and slot are free while a person decides. The
   ticket itself stays open — it is the visible ask — and the merge that never happens is not a stranded agent. *)
R5_ReadyWaitsWithNoWorker ==
  []<>\\A k \\in TicketIds : (tickets[k].state = "live" /\\ tickets[k].lastReport = "ready" /\\ k \\in pullOpen)
    => k \\notin working

(* R6. A Session that died outside the engine is never left claimed: the sweep runs, and the next message then
   starts a fresh worker (R2). *)
R6_DeadSessionIsFreed ==
  []<>\\A k \\in TicketIds : k \\in gone => k \\notin working

(* W1. A worker Session belongs to a live ticket: an ended, stopped, dropped or merged ticket never holds one.
   This is what makes R5 and R6 about the agent rather than about an unused variable. *)
W1_SessionNeedsALiveTicket ==
  working \\subseteq {k \\in TicketIds : tickets[k].state = "live"}""", 1)

s = s.replace("""  /\\ evaluating' = evaluating \\ {th}
  /\\ batch' = batch \\ {m \\in batch : ThreadOf(m) = th}
  /\\ UNCHANGED <<released, delivered, evalQ, ackPend, ackSent>>""",
"""  /\\ evaluating' = evaluating \\ {th}
  /\\ batch' = batch \\ {m \\in batch : ThreadOf(m) = th}
  /\\ working' = working \\ {k}
  /\\ UNCHANGED <<released, delivered, evalQ, ackPend, ackSent>>""", 1)
P.write_text(s)

c = C.read_text()
c = c.replace("  R1_SlotFreed", "  R1_SlotFreed\n  R5_ReadyWaitsWithNoWorker\n  R6_DeadSessionIsFreed\n  W1_SessionNeedsALiveTicket", 1)
c = c.replace("  R3_ReleaseNeedsAQuestion", "  R3_ReleaseNeedsAQuestion")
C.write_text(c)
print("patched: working/pullOpen/gone, OpenPull/MergePull/SessionDies/Sweep, R5, R6, W1, R3 as a step formula; MaxAsg 3 -> 2")
