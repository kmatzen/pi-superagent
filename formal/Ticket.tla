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

CONSTANTS t1, t2, k1, k2, m11, m12, m21, m22   (* model values: threads, ticket slots, messages *)

(* ---- the finite world ---- *)
Threads    == {t1, t2}
TicketIds  == {k1, k2}
(* m11, m12 arrive on t1; m21, m22 on t2. m11 and m21 are a person's; m12, m22 a bot's. *)
Msgs       == {m11, m12, m21, m22}
ThreadOf(m) == IF m \in {m11, m12} THEN t1 ELSE t2
Human(m)   == m \in {m11, m21}
States     == {"free", "live", "stopped", "done", "dropped"}
AsgStates  == {"pend", "run", "end"}
Reports    == {"none", "progress", "waiting", "ready", "blocked", "failed", "dropped"}
MaxAsg     == 3   (* bound on assignments per ticket: the cap makes the state space finite *)

(* ---- state ---- *)
(* tickets: per slot — lifecycle state, assignment states (newest last), latest report,
   subscribed threads, undelivered human messages (ticket.inputs/undelivered, model.ts). *)
VARIABLES
  batch,          \* the Evaluation's queued triggers: accept attaches every one of them (Tickets.create loops evaluation.triggerIds)
  tickets,
  delivered,      \* messages the source has emitted (ids are content hashes: intake.ts dedups)
  evalQ,          \* messages queued for Eval (queueForEval)
  evaluating,     \* threads with an open Evaluation — one per thread by construction (model.ts `evaluating?`)
  ackPend, ackSent  \* outbox halves for acknowledgements (ports.ts ReplyStatus)

vars == <<batch, tickets, delivered, evalQ, evaluating, ackPend, ackSent>>

Init ==
  /\ tickets = [k \in TicketIds |-> [state |-> "free", asg |-> <<>>, lastReport |-> "none",
                                     subs |-> {}, humanIn |-> {}]]
  /\ batch = {} /\ delivered = {} /\ evalQ = {} /\ evaluating = {}
  /\ ackPend = {} /\ ackSent = {}

(* ------------------------------------------------------------------- intake ----
  Intake.receive (intake.ts): a message reaches every live subscriber, and an ended,
  not-human-stopped ticket that a person's message resumes (`resumes` in receive:
  `ticket?.ended?.by !== 'human'`). It is queued for Eval only when NO ticket's worker
  decides it (`if (!this.owners(trigger).length) this.queueForEval(trigger)`);
  a bot's message owns nothing, so it is always queued. *)
Deliver(m) ==
  /\ m \notin delivered
  /\ LET owners == {k \in TicketIds : tickets[k].state = "live" /\ ThreadOf(m) \in tickets[k].subs}
     IN evalQ' = IF Human(m) /\ owners # {} THEN evalQ ELSE evalQ \cup {m}
  /\ tickets' = [k \in TicketIds |->
        IF ThreadOf(m) \in tickets[k].subs /\
           (tickets[k].state = "live" \/ (Human(m) /\ (tickets[k].state = "done" \/ tickets[k].state = "dropped")))
        THEN [tickets[k] EXCEPT !.humanIn = IF Human(m) THEN @ \cup {m} ELSE @]
        ELSE tickets[k]]
  /\ delivered' = delivered \cup {m}
  /\ UNCHANGED <<batch, evaluating, ackPend, ackSent>>

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
  /\ UNCHANGED <<tickets, delivered, ackPend, ackSent>>

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
                                           subs |-> {th}, humanIn |-> {m \in b : Human(m)}]]
     /\ LET cand == {m \in b : Human(m) /\ m \notin ackPend \cup ackSent} IN
        IF cand = {} THEN ackPend' = ackPend
        ELSE \E m0 \in cand : ackPend' = ackPend \cup {m0}
     /\ batch' = batch \ b
  /\ evaluating' = evaluating \ {th}
  /\ UNCHANGED <<evalQ, delivered, ackSent>>

(* ignore: the Evaluation ends, nothing is authorized. *)
VerdictIgnore(th) ==
  /\ th \in evaluating
  /\ evaluating' = evaluating \ {th}
  /\ batch' = batch \ {m \in batch : ThreadOf(m) = th}
  /\ UNCHANGED <<tickets, evalQ, delivered, ackPend, ackSent>>

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
  /\ UNCHANGED <<batch, delivered, evalQ, evaluating, ackPend, ackSent>>

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
                               ![k].state = IF r = "ready" THEN "done" ELSE IF r = "dropped" THEN "dropped" ELSE @,
                               ![k].asg = IF r = "ready" \/ r = "dropped" THEN allEnd ELSE @]
  /\ UNCHANGED <<batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Tickets.retry (tickets.ts): a blocked/failed latest report makes the ticket
  retryable; the stalled Assignment ends and a fresh pending one is appended. *)
Retry(k) ==
  /\ tickets[k].state = "live"
  /\ tickets[k].lastReport \in {"blocked", "failed"}
  /\ Len(tickets[k].asg) < MaxAsg
  /\ LET asg == tickets[k].asg IN
     /\ asg[Len(asg)] # "pend"
     /\ tickets' = [tickets EXCEPT ![k].asg = Append([asg EXCEPT ![Len(asg)] = "end"], "pend"),
                               ![k].lastReport = "none"]
  /\ UNCHANGED <<batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Tickets.wake (tickets.ts): an ended ticket resumes under its unchanged Mandate on a
  person's undelivered message. Its first guard is the claim checked below:
  `if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) return`
  — a ticket a person stopped never resumes, through any door. *)
Wake(k) ==
  /\ tickets[k].state \in {"done", "dropped"}
  /\ tickets[k].humanIn # {}
  /\ Len(tickets[k].asg) < MaxAsg
  /\ tickets' = [tickets EXCEPT ![k].state = "live",
                             ![k].asg = Append(tickets[k].asg, "pend"),
                             ![k].lastReport = "none",
                             ![k].humanIn = {}]
  /\ UNCHANGED <<batch, delivered, evalQ, evaluating, ackPend, ackSent>>

(* Tickets.stop (tickets.ts), from a stop Decision (engine.ts), the panel API, or a
  conversation closed on GitHub: end(by = 'human', outcome = 'stopped'); every
  unfinished Assignment ends with it. *)
StopByHuman(th, k) ==
  /\ tickets[k].state = "live"
  /\ th \in tickets[k].subs
  /\ tickets' = [tickets EXCEPT ![k].state = "stopped",
                             ![k].asg = [i \in 1..Len(tickets[k].asg) |-> "end"]]
  /\ evaluating' = evaluating \ {th}
  /\ batch' = batch \ {m \in batch : ThreadOf(m) = th}
  /\ UNCHANGED <<delivered, evalQ, ackPend, ackSent>>

(* The outbox flushing a queued acknowledgement: pending -> sent, never back. *)
SendAck(a) ==
  /\ a \in ackPend
  /\ ackPend' = ackPend \ {a}
  /\ ackSent' = ackSent \cup {a}
  /\ UNCHANGED <<batch, tickets, delivered, evalQ, evaluating>>

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
  \/ \E k \in TicketIds : Retry(k)
  \/ \E k \in TicketIds : Wake(k)
  \/ \E th \in Threads, k \in TicketIds : StopByHuman(th, k)
  \/ \E a \in Msgs : SendAck(a)

Fairness ==
  /\ \A m \in Msgs : WF_vars(Deliver(m))
  /\ \A th \in Threads : WF_vars(StartEval(th)) /\ WF_vars(VerdictIgnore(th))
  /\ \A th \in Threads, k \in TicketIds : WF_vars(VerdictAccept(th, k))
  /\ \A k \in TicketIds : WF_vars(Launch(k)) /\ WF_vars(Report(k, "ready")) /\ WF_vars(Wake(k))

Spec == Init /\ [][Next]_vars /\ Fairness

(* ------------------------------------------------------------ the claims ---- *)

TypeOK ==
  /\ batch \in SUBSET Msgs
  /\ tickets \in [TicketIds -> [state: States, asg: Seq(AsgStates), lastReport: Reports,
                                subs: SUBSET Threads, humanIn: SUBSET Msgs]]
  /\ delivered \in SUBSET Msgs /\ evalQ \in SUBSET Msgs /\ evaluating \in SUBSET Threads
  /\ ackPend \in SUBSET Msgs /\ ackSent \in SUBSET Msgs

(* I1. A ticket a person stopped is never live again — `wake`, `attach` and intake all
   check `ended.by === 'human'`; "stopped" is absorbing in every transition. *)
I1_StopAbsorbing == [][\A k \in TicketIds : tickets[k].state = "stopped" => tickets[k].state' = "stopped"]_vars

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

=====================
