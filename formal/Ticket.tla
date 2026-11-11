--------------------- MODULE Ticket ---------------------
(*
  The engine's ticket lifecycle (src/core, byte-identical to upstream). Every action
  cites the code whose guards it copies. TLC visits every reachable state, so a
  violation is an ordering this model allows; where the model is faithful, the code
  allows it too.

  Leaves out (a claim covers these only as far as their code passes the same guards):
  - context threads, follows and pull-request closes, eval expiry, policy
    revalidation, and attention;
  - everything about an assignment but its state, and every report but the latest.
  Bounds: two threads, two ticket slots, four messages, each delivered once.
*)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS t1, t2, k1, k2, m11, m21   (* model values: threads, ticket slots, messages *)

(* ---- the finite world ---- *)
Threads    == {t1, t2}
TicketIds  == {k1, k2}
(* m11 arrives on t1, m21 on t2; both are a person's. *)
Msgs       == {m11, m21}   (* bounded 2026-11-09 for the worker-Session vars: m12 and m22, the bot messages, order intake, and every ticket-level claim here is about a person's message and a worker. Intake.tla keeps the bot messages and its own claims. *)
ThreadOf(m) == IF m = m11 THEN t1 ELSE t2
Human(m)   == TRUE   (* both messages in the bounded world are a person's; the bot-message intake claims live in Intake.tla *)
States     == {"free", "live", "stopped", "done", "dropped"}
AsgStates  == {"pend", "run", "end"}
Reports    == {"none", "progress", "waiting", "ready", "blocked", "failed", "dropped"}
MaxAsg     == 2   (* bound on assignments per ticket: the cap makes the state space finite *)

(* ---- state ---- *)
(* `released[k]`: the worker of a live ticket was freed after it asked a person (the operator's rule
   2026-11-08, measured: 5 stopped workers held tabs and slots while 13 tickets queued). The ticket stays
   live; its Assignment ends with reason "released"; a fresh worker starts on the person's answer. *)
(* tickets: per slot — lifecycle state, assignment states (newest last), latest report,
   subscribed threads, undelivered human messages (ticket.inputs/undelivered, model.ts). *)
VARIABLES
  released,       \* tickets whose worker was freed (it asked, or it finished and a person must merge), awaiting the next request
  working,        \* tickets whose worker Session exists: the tab, the agent, the slot (the executor's live map)
  pullOpen,       \* tickets following their own pull request that a person has not merged yet
  gone,           \* tickets whose worker Session died outside the engine (a restart adopts, then the session is gone)
  batch,          \* the Evaluation's queued triggers: accept attaches every one of them (Tickets.create loops evaluation.triggerIds)
  tickets,
  delivered,      \* messages the source has emitted (ids are content hashes: intake.ts dedups)
  evalQ,          \* messages queued for Eval (queueForEval)
  evaluating,     \* threads with an open Evaluation — one per thread by construction (model.ts `evaluating?`)
  ackPend, ackSent  \* outbox halves for acknowledgements (ports.ts ReplyStatus)

vars == <<released, working, pullOpen, gone, batch, tickets, delivered, evalQ, evaluating, ackPend, ackSent>>

(* A worker is waiting on a person, so its agent is worth more free than warm: it asked a question, it needs an
   answer, or its own pull request is open and only a person can merge it. *)
asksAHuman(k) == tickets[k].lastReport \in {"blocked", "waiting"}
                   \/ (tickets[k].lastReport = "ready" /\ k \in pullOpen)

Init ==
  /\ released = [k \in TicketIds |-> FALSE]
  /\ working = {}
  /\ pullOpen = {}
  /\ gone = {}
  /\ tickets = [k \in TicketIds |-> [state |-> "free", asg |-> <<>>, lastReport |-> "none",
                                     subs |-> {}, humanIn |-> {}, stopKind |-> "none"]]
  /\ batch = {} /\ delivered = {} /\ evalQ = {} /\ evaluating = {}
  /\ ackPend = {} /\ ackSent = {}

(* ------------------------------------------------------------------- intake ----
  Intake.receive (intake.ts): a message reaches every live subscriber, and an ended
  ticket whose Mandate was not withdrawn, when a person's message resumes it (`resumes`
  in receive: `!mandateWithdrawn(ticket)`, model.ts — the same facts as I1 below). It is queued for Eval only when NO ticket's worker
  decides it (`if (!this.owners(trigger).length) this.queueForEval(trigger)`);
  a bot's message owns nothing, so it is always queued. *)
Deliver(m) ==
  /\ m \notin delivered
  /\ LET owners == {k \in TicketIds : tickets[k].state = "live" /\ ThreadOf(m) \in tickets[k].subs}
     IN evalQ' = IF Human(m) /\ owners # {} THEN evalQ ELSE evalQ \cup {m}
  /\ tickets' = [k \in TicketIds |->
        IF ThreadOf(m) \in tickets[k].subs /\
           (tickets[k].state = "live" \/ (Human(m) /\ (tickets[k].state = "done" \/ tickets[k].state = "dropped"
             \/ (tickets[k].state = "stopped" /\ tickets[k].stopKind = "conversation"))))
        THEN [tickets[k] EXCEPT !.humanIn = IF Human(m) THEN @ \cup {m} ELSE @]
        ELSE tickets[k]]
  /\ delivered' = delivered \cup {m}
  /\ UNCHANGED <<pullOpen, working, gone, released, batch, evaluating, ackPend, ackSent>>

(* ------------------------------------------------------------------- evals ----
  Evals start per thread with queued triggers (evals.ts); accept creates the ticket
  with its first pending Assignment and the acknowledgement the accept carries
  (Tickets.create -> Replies.acknowledgeAccepted: send only `if (!existing)`, keyed by
  the trigger id — the outbox half of at-most-once). *)
StartEval(th) ==
  /\ \E m \in evalQ : ThreadOf(m) = th
  /\ th \notin evaluating
  /\ evaluating' = evaluating \cup {th}
  /\ evalQ' = evalQ \ {m \in evalQ : ThreadOf(m) = th}
  /\ batch' = batch \cup {m \in evalQ : ThreadOf(m) = th}
  /\ UNCHANGED <<pullOpen, working, gone, released, tickets, delivered, ackPend, ackSent>>

(* The one-ticket rule as the accept guard: an accept on a thread that a live ticket
   already follows becomes an ignore. The router enforces it in code (its ticket_decide
   tool overrules the judge, extension.ts), and intake's owners rule points the same way. *)
VerdictAccept(th, k) ==
  /\ th \in evaluating
  /\ tickets[k].state = "free"
  /\ \A j \in TicketIds : tickets[j].state = "live" => th \notin tickets[j].subs
  /\ LET b == {m \in batch : ThreadOf(m) = th} IN
     /\ b # {}
     /\ tickets' = [tickets EXCEPT ![k] = [state |-> "live", asg |-> <<"pend">>, lastReport |-> "none",
                                           subs |-> {th}, humanIn |-> {m \in b : Human(m)},
                                           stopKind |-> "none"]]
     /\ LET cand == {m \in b : Human(m) /\ m \notin ackPend \cup ackSent} IN
        IF cand = {} THEN ackPend' = ackPend
        ELSE \E m0 \in cand : ackPend' = ackPend \cup {m0}
     /\ batch' = batch \ b
  /\ evaluating' = evaluating \ {th}
  /\ UNCHANGED <<pullOpen, working, gone, released, evalQ, delivered, ackSent>>

(* ignore: the Evaluation ends, nothing is authorized. *)
VerdictIgnore(th) ==
  /\ th \in evaluating
  /\ evaluating' = evaluating \ {th}
  /\ batch' = batch \ {m \in batch : ThreadOf(m) = th}
  /\ UNCHANGED <<pullOpen, working, gone, released, tickets, evalQ, delivered, ackPend, ackSent>>

(* ---------------------------------------------------------------- execution ----
  The Executor starts the newest pending Assignment when none runs — its contract,
  mirroring HerdrWorkers: one worker session per live record. *)
Launch(k) ==
  /\ tickets[k].state = "live"
  /\ LET asg == tickets[k].asg IN
     /\ Len(asg) > 0
     /\ asg[Len(asg)] = "pend"
     /\ \A i \in 1..Len(asg) : asg[i] # "run"
     /\ tickets' = [tickets EXCEPT ![k].asg = [asg EXCEPT ![Len(asg)] = "run"]]
  /\ working' = working \cup {k}
  /\ gone' = gone \ {k}
  (* `released` is the latest Assignment's end reason in code, so a worker starting clears the flag: the ticket
     has a worker again, whatever freed the previous one. R1 is the claim this keeps true. *)
  /\ released' = [released EXCEPT ![k] = FALSE]
  /\ UNCHANGED <<pullOpen, released, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Assignments.report (assignments.ts): only a live ticket with a running Assignment
  reports; a `ready` report ends the ticket completed (no followed threads here), a
  `dropped` report ends it dropped; end() ends every unfinished Assignment
  (tickets.ts end: `for (const assignment of stopping) assignment.state = 'ended'`).
  Nothing else in the model can produce "done". *)
Report(k, r) ==
  /\ r \in Reports \ {"none"}
  /\ tickets[k].state = "live"
  /\ \E i \in 1..Len(tickets[k].asg) : tickets[k].asg[i] = "run"
  /\ LET allEnd == [j \in 1..Len(tickets[k].asg) |-> "end"] IN
     /\ tickets' = [tickets EXCEPT ![k].lastReport = r,
                               ![k].state = IF r = "ready" /\ k \notin pullOpen THEN "done"
                                            ELSE IF r = "dropped" THEN "dropped" ELSE @,
                               ![k].asg = IF r = "ready" \/ r = "dropped" THEN allEnd ELSE @]
     (* A report that ENDS the ticket disposes its Session (the executor's ending path). A `ready` report on a
        ticket that follows its own open pull request ends no ticket, and the Session survives it — that is the
        shape measured on 2026-11-09: 15 tickets sat `ready` on an unmerged pull request, 4h to 21h, each still
        holding a tab, an agent and a slot. R5 is the claim that this is fixed. *)
     /\ IF tickets'[k].state \in {"done", "dropped"} THEN working' = working \ {k} ELSE UNCHANGED working
  /\ UNCHANGED <<pullOpen, gone, released, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* A worker pushes its own pull request, which the router follows. The ticket stays open: only a person
   merges, and the close is what ends it (Tickets.threadClosed). *)
OpenPull(k) ==
  /\ tickets[k].state = "live"
  /\ k \notin pullOpen
  /\ pullOpen' = pullOpen \cup {k}
  /\ UNCHANGED <<released, working, gone, tickets, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* PullFollower observes the merge, engine.threadClosed ends the ticket with its result, and the ending
   disposes the Session. *)
MergePull(k) ==
  /\ k \in pullOpen
  /\ tickets[k].state = "live"
  /\ tickets[k].lastReport = "ready"
  /\ pullOpen' = pullOpen \ {k}
  /\ tickets' = [tickets EXCEPT ![k].state = "done"]
  /\ working' = working \ {k}
  /\ UNCHANGED <<released, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* The worker Session dies outside the engine: the process exits, or a router restart adopts the ticket and the
   session behind it is already gone. Nothing in the engine asked for this. *)
SessionDies(k) ==
  /\ k \in working
  /\ k \notin gone
  /\ gone' = gone \cup {k}
  /\ UNCHANGED <<released, working, pullOpen, tickets, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Router.recover (extension.ts), which runs at every router start: a ticket left `running` with no Session
   behind it — the ones a restart adopts whose worker is already dead (measured 2026-11-09: 21 assignments 4h+,
   oldest 34.7h) — frees the claim, says so on the ticket, and starts a fresh worker. The model makes the death
   (SessionDies) and the engine's response (Sweep) separate so R6 can say the response always comes. *)
Sweep(k) ==
  /\ k \in gone
  /\ k \in working
  /\ tickets[k].state = "live"
  /\ LET asg == tickets[k].asg IN
     /\ tickets' = [tickets EXCEPT ![k].asg = IF Len(asg) > 0 /\ asg[Len(asg)] = "run"
                                              THEN [asg EXCEPT ![Len(asg)] = "end"] ELSE asg]
  /\ released' = [released EXCEPT ![k] = TRUE]
  /\ working' = working \ {k}
  /\ UNCHANGED <<pullOpen, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Tickets.retry (tickets.ts): a blocked/failed latest report makes the ticket
  retryable; the stalled Assignment ends and a fresh pending one is appended. *)
Retry(k) ==
  /\ tickets[k].state = "live"
  (* Tickets.retry -> canRetry -> waitsForPerson: a person's message removes the stall a retry answers, and a
     released ticket with no answer yet stays retryable from the panel — the new Assignment is then the latest,
     which is exactly what clears `released` here (code: the flag is the latest Assignment's end reason). *)
  /\ ~(released[k] /\ tickets[k].humanIn # {})
  /\ tickets[k].lastReport \in {"blocked", "failed"}
  /\ Len(tickets[k].asg) < MaxAsg
  /\ LET asg == tickets[k].asg IN
     /\ asg[Len(asg)] # "pend"
     /\ tickets' = [tickets EXCEPT ![k].asg = Append([asg EXCEPT ![Len(asg)] = "end"], "pend"),
                               ![k].lastReport = "none"]
  /\ released' = [released EXCEPT ![k] = FALSE]
  /\ UNCHANGED <<pullOpen, working, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* PiExecutor.release + Tickets.release: the worker of a live ticket asked a person and its agent, tab and slot
   are freed. Its Assignment ends with reason "released"; the ticket stays live, so a person's stop stays
   absorbing (I1) and no second ticket can open on the thread (I4). Only a worker that asked may be released,
   which is what R3 checks. *)
Release(k) ==
  /\ tickets[k].state = "live"
  /\ k \in working
  /\ ~released[k]
  /\ asksAHuman(k)
  /\ LET asg == tickets[k].asg IN
     /\ Len(asg) > 0
     /\ tickets' = [tickets EXCEPT ![k].asg = IF asg[Len(asg)] = "run"
                                              THEN [asg EXCEPT ![Len(asg)] = "end"] ELSE asg]
  /\ released' = [released EXCEPT ![k] = TRUE]
  /\ working' = working \ {k}
  /\ UNCHANGED <<pullOpen, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Tickets.wake widened for a released worker (the manager's door): the person's undelivered message starts a
   fresh Assignment, exactly as it resumes an ended ticket. R2 is the claim this action exists to make true. *)
Resurrect(k) ==
  /\ released[k]
  /\ tickets[k].state = "live"
  /\ tickets[k].humanIn # {}
  /\ Len(tickets[k].asg) < MaxAsg
  /\ tickets' = [tickets EXCEPT ![k].asg = Append(tickets[k].asg, "pend"),
                             ![k].lastReport = "none",
                             ![k].humanIn = {}]
  /\ released' = [released EXCEPT ![k] = FALSE]
  /\ UNCHANGED <<pullOpen, working, gone, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Tickets.wake (tickets.ts): an ended ticket resumes under its unchanged Mandate on a
  person's undelivered message. A stop withdraws the Mandate, so it closes the door — with one
  exception the operator's own notices promise: the conversation stop, whose ending was GitHub
  closing the thread, and the person who closed it is the one who reopens it (TicketStopKind).
  A ticket a person stopped from the panel, and the repeat guard's stop, resume through no door. *)
Wake(k) ==
  /\ (tickets[k].state \in {"done", "dropped"}
      \/ (tickets[k].state = "stopped" /\ tickets[k].stopKind = "conversation"))
  /\ tickets[k].humanIn # {}
  /\ Len(tickets[k].asg) < MaxAsg
  /\ tickets' = [tickets EXCEPT ![k].state = "live",
                             ![k].asg = Append(tickets[k].asg, "pend"),
                             ![k].lastReport = "none",
                             ![k].humanIn = {},
                             ![k].stopKind = "none"]
  /\ UNCHANGED <<pullOpen, working, gone, released, batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Tickets.stop (tickets.ts): end(outcome = 'stopped'); every unfinished Assignment
  ends with it. `by` is whose act it was ("human" for the panel's, "router" for the
  router's own) and `stopKind` says which: "operator" from the panel, "loop" from the
  router's repeat guard, "conversation" from GitHub closing the thread. Only the last
  one leaves the Wake door open (code: `mandateWithdrawn` in model.ts). *)
StopByRouter(th, k, kind) ==
  /\ tickets[k].state = "live"
  /\ th \in tickets[k].subs
  /\ kind \in {"loop", "conversation"}
  /\ tickets' = [tickets EXCEPT ![k].state = "stopped",
                             ![k].stopKind = kind,
                             ![k].asg = [i \in 1..Len(tickets[k].asg) |-> "end"]]
  /\ evaluating' = evaluating \ {th}
  /\ batch' = batch \ {m \in batch : ThreadOf(m) = th}
  /\ working' = working \ {k}
  /\ UNCHANGED <<pullOpen, gone, released, delivered, evalQ, ackPend, ackSent>>

StopByHuman(th, k) ==
  /\ tickets[k].state = "live"
  /\ th \in tickets[k].subs
  /\ tickets' = [tickets EXCEPT ![k].state = "stopped",
                             ![k].stopKind = "operator",
                             ![k].asg = [i \in 1..Len(tickets[k].asg) |-> "end"]]
  /\ evaluating' = evaluating \ {th}
  /\ batch' = batch \ {m \in batch : ThreadOf(m) = th}
  /\ working' = working \ {k}
  /\ UNCHANGED <<pullOpen, gone, released, delivered, evalQ, ackPend, ackSent>>

(* The outbox flushing a queued acknowledgement: pending -> sent, never back. *)
SendAck(a) ==
  /\ a \in ackPend
  /\ ackPend' = ackPend \ {a}
  /\ ackSent' = ackSent \cup {a}
  /\ UNCHANGED <<pullOpen, working, gone, released, batch, tickets, delivered, evalQ, evaluating>>

(* A finished system has nothing left to do; this stuttering step makes stopping legal
   instead of a deadlock. It also means TLC's deadlock check finds nothing here:
   progress is the liveness claim's job. *)
Terminate == UNCHANGED vars

Next ==
  \/ Terminate
  \/ \E m \in Msgs : Deliver(m)
  \/ \E th \in Threads : StartEval(th)
  \/ \E th \in Threads, k \in TicketIds : VerdictAccept(th, k)
  \/ \E th \in Threads : VerdictIgnore(th)
  \/ \E k \in TicketIds : Launch(k)
  \/ \E k \in TicketIds, r \in Reports : Report(k, r)
  \/ \E k \in TicketIds : Release(k)
  \/ \E k \in TicketIds : OpenPull(k)
  \/ \E k \in TicketIds : MergePull(k)
  \/ \E k \in TicketIds : SessionDies(k)
  \/ \E k \in TicketIds : Sweep(k)
  \/ \E k \in TicketIds : Resurrect(k)
  \/ \E k \in TicketIds : Retry(k)
  \/ \E k \in TicketIds : Wake(k)
  \/ \E th \in Threads, k \in TicketIds : StopByHuman(th, k)
  \/ \E th \in Threads, k \in TicketIds, kind \in {"loop", "conversation"} : StopByRouter(th, k, kind)
  \/ \E a \in Msgs : SendAck(a)

Fairness ==
  /\ \A m \in Msgs : WF_vars(Deliver(m))
  /\ \A th \in Threads : WF_vars(StartEval(th)) /\ WF_vars(VerdictIgnore(th))
  /\ \A th \in Threads, k \in TicketIds : WF_vars(VerdictAccept(th, k))
  /\ \A k \in TicketIds : WF_vars(Launch(k)) /\ WF_vars(Report(k, "ready")) /\ WF_vars(Wake(k))
  /\ \A k \in TicketIds : WF_vars(Release(k)) /\ WF_vars(Resurrect(k))
  /\ \A k \in TicketIds : WF_vars(Sweep(k)) /\ WF_vars(MergePull(k))

Spec == Init /\ [][Next]_vars /\ Fairness

(* ------------------------------------------------------------ the claims ---- *)

TypeOK ==
  /\ released \in [TicketIds -> BOOLEAN]
  /\ batch \in SUBSET Msgs
  /\ tickets \in [TicketIds -> [state: States, asg: Seq(AsgStates), lastReport: Reports,
                                subs: SUBSET Threads, humanIn: SUBSET Msgs,
                                stopKind: {"none", "operator", "loop", "conversation"}]]
  /\ delivered \in SUBSET Msgs /\ evalQ \in SUBSET Msgs /\ evaluating \in SUBSET Threads
  /\ ackPend \in SUBSET Msgs /\ ackSent \in SUBSET Msgs

(* I1. A stop is absorbing, for the stops that withdraw the Mandate: the panel's and the
   repeat guard's. The conversation stop is the exception the operator's notices promise —
   GitHub closed the thread, and the person who closed it can reopen it (see `Wake`). *)
I1_StopAbsorbing == [][\A k \in TicketIds
  : tickets[k].state = "stopped" /\ tickets[k].stopKind # "conversation"
    => tickets[k].state' = "stopped"]_vars

(* I2. "Done" implies the worker reported `ready`: the only producer of "done" is
   Report(k, "ready"). Silent success is unrepresentable. *)
I2_DoneFromReady == \A k \in TicketIds : tickets[k].state = "done" => tickets[k].lastReport = "ready"

(* I3. At most one running Assignment per ticket — the executor contract that
   runningAssignment's single lookup assumes. *)
I3_OneRunning ==
  \A k \in TicketIds : \A i, j \in 1..Len(tickets[k].asg) :
        tickets[k].asg[i] = "run" /\ tickets[k].asg[j] = "run" => i = j

(* I4. One ticket per thread, at the only door that matters: no ticket is ever created
   for a thread a live ticket already follows — under every interleaving, including a
   follow-up delivered mid-Evaluation (a queue that momentarily outlives its owners is
   benign: the next Evaluation judges it, and the accept guard releases it). *)
I4_NoSecondTicket ==
  [][\A k \in TicketIds :
        (tickets'[k].state = "live" /\ tickets[k].state = "free") =>
          \A j \in TicketIds : (j # k /\ tickets[j].state = "live") =>
            tickets'[k].subs \cap tickets[j].subs = {}]_vars

(* I5. An acknowledgement is queued at most once and sent at most once: the outbox key
   is the trigger id, `send` only fires `if (!existing)`, and sent never returns. *)
I5_OutboxOnce == ackPend \cap ackSent = {}
I6_SentMonotonic == [][ackSent \subseteq ackSent']_vars

(* LT. Liveness: every incoming message eventually reaches intake. *)
LT_Delivered == []<>(\A m \in Msgs : m \in delivered)

(* R1. A released ticket holds no worker: the slot and the agent are truly freed, and no state has both a
   released ticket and a running Assignment on it. *)
R1_SlotFreed == \A k \in TicketIds :
  released[k] => \A i \in 1..Len(tickets[k].asg) : tickets[k].asg[i] # "run"

(* R2. A person's answer to a released worker is never stranded: while an answer waits on a released ticket, a
   worker eventually runs there again — the one escape being the person's own stop, which withdraws the request
   (the counter-example TLC produced for the stronger form, 2026-11-08: a stopped ticket keeps its answer
   unanswered, which is what a stop means). This is the claim the release is only safe with. *)
R2_AnswerGetsAWorker ==
  []<>\A k \in TicketIds : (released[k] /\ tickets[k].humanIn # {}) =>
    <>((\E i \in 1..Len(tickets[k].asg) : tickets[k].asg[i] = "run")
        \/ tickets[k].state = "stopped"
        \/ Len(tickets[k].asg) = MaxAsg)   (* the model's assignment bound, not a behavior: the real code appends without one *)

(* R3. Nothing is taken from under a turn: a step that frees a worker implies the person is the only thing it can
   be waiting for — it asked, it needs an answer, its own pull request waits on a merge — or its Session is dead.
   A step formula, so it is checked as a property. *)
R3_ReleaseNeedsAQuestion ==
  [][\A k \in TicketIds : (released'[k] /\ ~released[k]) => (asksAHuman(k) \/ k \in gone)]_vars

(* R5. Nobody sits on a merge: while a live ticket's own pull request is open and its worker reported `ready`,
   the ticket eventually has no worker Session, so the agent, tab and slot are free while a person decides. The
   ticket itself stays open — it is the visible ask. Measured 2026-11-09: 15 tickets in exactly this state, 4h
   to 21h each. *)
R5_ReadyWaitsWithNoWorker ==
  []<>\A k \in TicketIds : (tickets[k].state = "live" /\ tickets[k].lastReport = "ready" /\ k \in pullOpen)
    => k \notin working

(* R6. A Session that died outside the engine is never left claimed: the sweep runs, and the person's next
   message then starts a fresh worker (R2). Measured 2026-11-09: 21 assignments 4h+ on dead Sessions, oldest 34.7h. *)
R6_DeadSessionIsFreed ==
  []<>\A k \in TicketIds : k \in gone => k \notin working

(* W1. A worker Session belongs to a live ticket: an ended, stopped, dropped or merged ticket never holds one.
   This is what makes R5 and R6 about the agent rather than about an unused variable. *)
W1_SessionNeedsALiveTicket ==
  working \subseteq {k \in TicketIds : tickets[k].state = "live"}

(* R4. Resurrection appends, never reuses: a freed Assignment is never set back to running, so a released
   worker's record cannot come back and two agents can never act on one ticket. *)
R4_NoReusedAssignment ==
  [][\A k \in TicketIds : \A i \in 1..Len(tickets[k].asg) :
        tickets[k].asg[i] = "end" => \A j \in 1..Len(tickets'[k].asg) :
          j <= Len(tickets[k].asg) => tickets'[k].asg[j] # "run" \/ j > i]_vars

=====================
