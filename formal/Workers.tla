--------------------- MODULE Workers ---------------------
(*
  The herdr worker/tab lifecycle, machine-checked: worker records, their tabs, and
  the agent processes behind them. Mirrors src/pi/herdr-workers.ts and the engine's
  worker bookkeeping:

    - at most one live worker per ticket (engine.launch guard);
    - closeStaleTabs closes a tab only when the record's agent is gone (agentGet
      answers agent_not_found); a live agent's tab is untouchable by the sweep,
      which is what keeps a busy worker's terminal from vanishing mid-report;
    - a finished worker lingers (record ended, tab open) for human follow-up, and
      its tab closes once its agent is gone;
    - a record retires only after its tab is closed, and the record itself is never
      lost while a tab references it.

  Two workers w1, w2, fixed tabs tabOf(w1) = ta, tabOf(w2) = tb.
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

(* engine.launch: a fresh worker for a ticket only when no record for that ticket is
   live. (One ticket in the model: the guard is global.) The tab opens with the agent. *)
(* Bounded launches (as Intake bounds crashes): the liveness claim is "after finitely
   many launches, the sweep reaches a fixpoint" — every generation's zombies get
   cleaned, and with launches finite, that covers the limit. *)
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

(* ReportDone: the worker reports; its record ends, its tab LINGERS open for the
   human, and the agent (finished, not crashed) keeps serving the pane. *)
Report(w) ==
  /\ rec[w].state = live
  /\ rec' = [rec EXCEPT ![w].state = ended]
  /\ UNCHANGED <<launches, tabs, agent>>

StopByHuman(w) ==
  /\ rec[w].state = live
  /\ rec' = [rec EXCEPT ![w].state = ended]
  /\ UNCHANGED <<launches, tabs, agent>>

(* closeStaleTabs: for a tab owned by a record whose agent is gone, close it. The
   guard is exactly the shipped code's: owner lookup + agent liveness probe. *)
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

(* The engine retires a record only after its tab is closed (nothing points at it). *)
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

(* W1. At most one live worker at a time — the engine.launch guard, exhaustively. *)
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
