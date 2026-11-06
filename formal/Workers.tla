--------------------- MODULE Workers ---------------------
(*
  Worker records, their herdr tabs, and the pi agents in them. Mirrors
  src/pi/herdr-workers.ts and the executor's launch guard:

    - a ticket has at most one live worker (PiExecutor.start launches an assignment
      once, and the engine runs one assignment at a time);
    - closeStaleTabs closes a tab only when herdr no longer knows the record's agent
      (agentGet answers agent_not_found), so the sweep cannot take a live agent's tab;
    - a finished worker's tab lingers for follow-up. This model closes it once its
      agent is gone; the code also closes it once the agent sits idle, a stronger
      cleanup that none of the claims below depend on;
    - a record's slot is reused only after its tab is closed.

  Leaves out: herdr's own failures, the inbox and cursor files, the window in which a
  launch has a tab but no record yet, and timers (lingering is modeled as "eventually").
  Bounds: one ticket, two workers with fixed tabs (w1 in ta, w2 in tb), three launches.
*)
EXTENDS Integers, FiniteSets

CONSTANTS w1, w2, ta, tb, free, live, ended

Workers == {w1, w2}
TabOf(w) == IF w = w1 THEN ta ELSE tb
Tabs == {ta, tb}
States == {free, live, ended}      (* model values from the config *)

VARIABLES launches, rec, tabs, agent

vars == <<launches, rec, tabs, agent>>

Init ==
  /\ launches = 0
  /\ rec = [w \in Workers |-> [state |-> free, tab |-> TabOf(w)]]
  /\ tabs = {}
  /\ agent = [w \in Workers |-> FALSE]     (* no agent process until launched *)

(* ---- engine actions ---- *)

(* Launch (PiExecutor.start, HerdrWorkers.launch): a fresh worker only when no record
   is live; with one ticket in the model, the guard is global. The tab opens with the
   agent. *)
(* Launches are bounded, as Intake bounds crashes: W5 then reads "after the last
   launch, the sweeps reach a fixpoint". *)
Launch(w) ==
  /\ launches < 3
  /\ launches' = launches + 1
  /\ rec[w].state = free
  /\ \A j \in Workers : rec[j].state # live
  /\ rec' = [rec EXCEPT ![w].state = live]
  /\ tabs' = tabs \cup {TabOf(w)}
  /\ agent' = [agent EXCEPT ![w] = TRUE]

(* The agent process dies (crash, kill, herdr restart). The record and its tab
   survive — this is the zombie state the sweep exists for. *)
AgentDies(w) ==
  /\ agent[w]
  /\ agent' = [agent EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<launches, rec, tabs>>

(* Report: the worker reports; its record ends, its tab lingers for follow-up, and its
   agent, finished rather than crashed, stays in the pane. *)
Report(w) ==
  /\ rec[w].state = live
  /\ rec' = [rec EXCEPT ![w].state = ended]
  /\ UNCHANGED <<launches, tabs, agent>>

StopByHuman(w) ==
  /\ rec[w].state = live
  /\ rec' = [rec EXCEPT ![w].state = ended]
  /\ UNCHANGED <<launches, tabs, agent>>

(* closeStaleTabs: close the tab of a record whose agent is gone. The guard is the
   shipped code's: find the owning record, then ask herdr whether its agent lives. *)
Sweep(w) ==
  /\ rec[w].state = live
  /\ ~agent[w]
  /\ TabOf(w) \in tabs
  /\ tabs' = tabs \ {TabOf(w)}
  /\ UNCHANGED <<launches, rec, agent>>

(* The linger tab of a finished worker closes once its agent is gone. *)
LingerClose(w) ==
  /\ rec[w].state = ended
  /\ ~agent[w]
  /\ TabOf(w) \in tabs
  /\ tabs' = tabs \ {TabOf(w)}
  /\ UNCHANGED <<launches, rec, agent>>

(* A record's slot is reused only after its tab is closed, so nothing points at a
   reused slot. *)
Retire(w) ==
  /\ rec[w].state = ended
  /\ TabOf(w) \notin tabs
  /\ rec' = [rec EXCEPT ![w].state = free]
  /\ UNCHANGED <<launches, tabs, agent>>

Terminate == UNCHANGED vars

Next ==
  \/ Terminate
  \/ \E w \in Workers : Launch(w)
  \/ \E w \in Workers : AgentDies(w)
  \/ \E w \in Workers : Report(w)
  \/ \E w \in Workers : StopByHuman(w)
  \/ \E w \in Workers : Sweep(w)
  \/ \E w \in Workers : LingerClose(w)
  \/ \E w \in Workers : Retire(w)

Fairness ==
  /\ \A w \in Workers : WF_vars(Report(w)) /\ SF_vars(Sweep(w)) /\ SF_vars(LingerClose(w))
  /\ \A w \in Workers : SF_vars(Retire(w))

Spec == Init /\ [][Next]_vars /\ Fairness

(* ------------------------------------------------------------ the claims ---- *)

TypeOK ==
  /\ launches \in 0..3
  /\ rec \in [Workers -> [state: States, tab: Tabs]]
  /\ tabs \in SUBSET Tabs
  /\ agent \in [Workers -> BOOLEAN]

(* W1. At most one live worker: the launch guard, checked exhaustively. *)
W1_OneLive == \A j \in Workers : \A k \in Workers :
  j # k => ~((rec[j].state = live) /\ (rec[k].state = live))

(* W2. A live agent's tab is never closed: in every reachable state, every worker
   whose record is live and whose agent is alive has its tab open. The sweep's guard
   (agent liveness) is what makes this an invariant, not a race. *)
W2_SweepKeepsLiveAgents ==
  [][\A w \in Workers : (rec[w].state = live /\ agent[w]) => TabOf(w) \in tabs]_vars

(* W3. A record never resurrects: ended goes only to free (retire), free only to
   live (launch), live only to ended. No live -> free skip, no ended -> live. *)
W3_NoResurrect == [][\A w \in Workers :
  /\ rec[w].state = ended  => rec'[w].state \in {ended, free}
  /\ rec[w].state = live => rec'[w].state \in {live, ended}
  /\ rec[w].state = free => rec'[w].state \in {free, live}]_vars

(* W4. A tab is never closed while its record is live AND its agent is alive —
   the operational statement of W2 for the sweep step itself. *)
W4_NoTabLossUnderWork == [][\A w \in Workers :
  (rec[w].state = live /\ agent[w] /\ TabOf(w) \in tabs)
    => TabOf(w) \in tabs']_vars

(* W5. Liveness: after finitely many launches, every dead agent's tab is eventually
   closed (sweep + linger close run to a fixpoint) — the workspace cannot fill with
   zombies. *)
W5_ZombieTabsGone == []<>(\A w \in Workers : ~agent[w] => TabOf(w) \notin tabs)

=====================
