--------------------- MODULE Sweep ---------------------
(*
  The ready sweep: Intake.sweep, wired into the router's tick.

  Intake is activity-driven. A thread produces a trigger when something happens on it,
  so an open issue whose last activity is behind the polls produces none: it is never
  received, never judged, and gets no worker. Measured 2026-11-24, six agent-ready
  issues sat 62 to 84 hours against five free worker slots. The sweep is the fix, and it
  is bounded by rules a reader cannot check by eye:

    - a pass runs only with a free slot and an empty eval queue, and emits one trigger;
    - one issue is asked about once a day, and the day rollover is what renews it;
    - a thread with a ticket on it is not idle work: live, finished, or stopped;
    - a thread with activity newer than the sweep's read position belongs to the
      comment path, which already heard it;
    - the trigger is the router's own request: `human: false`, checked at intake.

  The model states those rules as a state machine over one thread, and checks that no
  interleaving of the sweep with the world breaks them. The intake-side claim — that the
  guard in Intake.receive is what keeps a sweep trigger out of the `resumes` door — is in
  Intake.tla C7, where the poll, the seed, and the comment cursor are modelled too.

  Bounds: one thread (the rules are per-thread), one worker slot (C3 asks only whether a
  pass can run past the slots it has), two days, three moments of activity.
*)
EXTENDS Integers, FiniteSets

CONSTANTS none, live, stopped, done     (* model values: the thread's ticket state *)
CONSTANT d1, d2                         (* model values: two days *)

TStates == {none, live, stopped, done}
Days == {d1, d2}
Times == 1..3
MaxNat(S) == IF S = {} THEN 0 ELSE CHOOSE m \in S : \A n \in S : n <= m

VARIABLES
  slots,                        (* free worker slots *)
  day,                          (* what the cooldown counts in *)
  tstate,                       (* the thread's ticket state: none, live, finished, stopped *)
  sweptCnt,                     (* sweeps of this thread today *)
  lastAt,                       (* the thread's newest accepted activity *)
  cursor,                       (* the sweep's read position *)
  pend, claim,                  (* an emission in flight, and the human flag it carries *)
  swept, mark,                  (* swept, and the thread's activity as the emission saw it *)
  decided, sweptAfter,          (* the thread had work on it, and any sweep after that *)
  sweptHuman,                   (* an accepted sweep that claimed a person spoke: the guard's record *)
  askedNoSlot                   (* a pass that emitted with no free slot: what SW3 forbids *)

vars == <<slots, day, tstate, sweptCnt, lastAt, cursor, pend, claim, swept, mark, decided, sweptAfter,
          sweptHuman, askedNoSlot>>

Init ==
  /\ slots = 1 /\ day = d1 /\ tstate = none /\ sweptCnt = 0
  /\ lastAt = 0 /\ cursor = 0
  /\ pend = FALSE /\ claim = FALSE
  /\ swept = FALSE /\ mark = 0
  /\ decided = FALSE /\ sweptAfter = FALSE /\ sweptHuman = FALSE /\ askedNoSlot = FALSE

(* ---- the world the sweep reads ---- *)

(* A person comments: the thread is no longer quiet, and the comment path (Intake.tla) is
   the one that hears it. *)
PostComment(t) ==
  /\ t \in Times
  /\ t > lastAt
  /\ lastAt' = t
  /\ UNCHANGED <<slots, day, tstate, sweptCnt, cursor, pend, claim, swept, mark, decided, sweptAfter, sweptHuman, askedNoSlot>>

(* A pass reads the board and advances its position past the activity it saw. A pass with
   nothing newer to read is a stutter, so the cursor never moves backwards and never runs
   ahead of what the sweep has read. *)
SweepPass ==
  /\ pend = FALSE
  /\ cursor' = IF cursor >= lastAt THEN cursor ELSE 1 + MaxNat({lastAt})
  /\ UNCHANGED <<slots, day, tstate, sweptCnt, lastAt, pend, claim, swept, mark, decided, sweptAfter, sweptHuman, askedNoSlot>>

(* ---- the sweep ---- *)

(* The pass's own gates: a free slot, a quiet thread, no ticket in any state on it, and
   this thread not asked about today. `pend = FALSE` is the rest of the tick: one trigger
   per pass, and the eval queue empty is what makes `pend` the queue's whole content. *)
Sweepable ==
  /\ pend = FALSE /\ sweptCnt = 0
  /\ slots > 0
  /\ tstate = none
  /\ lastAt <= cursor

Sweep ==
  /\ Sweepable
  /\ pend' = TRUE /\ claim' = FALSE
  /\ askedNoSlot' = askedNoSlot \/ slots = 0
  /\ mark' = lastAt
  /\ UNCHANGED <<day, tstate, sweptCnt, lastAt, cursor, slots, swept, sweptAfter, decided, sweptHuman>>

(* The emitter after the careless edit: the same pass, setting `human: true`. Modelled so
   SW1 checks the intake guard rather than the flag it is written on. *)
SweepClaimingHuman ==
  /\ Sweepable
  /\ pend' = TRUE /\ claim' = TRUE
  /\ askedNoSlot' = askedNoSlot \/ slots = 0
  /\ mark' = lastAt
  /\ UNCHANGED <<day, tstate, sweptCnt, lastAt, cursor, slots, swept, sweptAfter, decided, sweptHuman>>

(* Intake.receive refuses it: the emission is dropped, nothing is swept, no slot is taken. *)
RefuseSweep ==
  /\ pend /\ claim
  /\ pend' = FALSE /\ claim' = FALSE
  /\ UNCHANGED <<slots, day, tstate, sweptCnt, lastAt, cursor, swept, mark, sweptAfter, decided, sweptHuman, askedNoSlot>>

(* The judge accepts the request: a worker takes the slot, the thread's day is spent, and
   `sweptAfter` records the one case the ticket rule must prevent — a sweep of a thread
   that already had work on it. *)
AcceptSweep ==
  /\ pend /\ ~claim
  /\ swept' = TRUE
  /\ sweptCnt' = sweptCnt + 1
  /\ sweptAfter' = sweptAfter \/ decided
  /\ slots' = IF slots > 0 THEN slots - 1 ELSE slots
  /\ tstate' = live
  /\ sweptHuman' = sweptHuman \/ claim
  /\ pend' = FALSE /\ claim' = FALSE
  /\ UNCHANGED <<day, lastAt, cursor, mark, decided, askedNoSlot>>

(* The worker's life ends two ways, and both return the slot. The cooldown is cleared on
   both, so what keeps the thread off the sweep is the ticket rule, not a counter: a
   person's stop is terminal (the Mandate is withdrawn), and finished work is decided. *)
FinishTicket ==
  /\ tstate = live
  /\ tstate' = done
  /\ decided' = TRUE
  /\ sweptCnt' = 0
  /\ slots' = 1
  /\ UNCHANGED <<day, lastAt, cursor, pend, claim, swept, mark, sweptAfter, sweptHuman, askedNoSlot>>

StopTicket ==
  /\ tstate = live
  /\ tstate' = stopped
  /\ decided' = TRUE
  /\ sweptCnt' = 0
  /\ slots' = 1
  /\ UNCHANGED <<day, lastAt, cursor, pend, claim, swept, mark, sweptAfter, sweptHuman, askedNoSlot>>

(* The cooldown is a day, not a number that never resets: tomorrow the same idle thread is
   offered again and the rules decide once more. *)
NewDay ==
  /\ day = d1
  /\ day' = d2
  /\ sweptCnt' = 0
  /\ UNCHANGED <<slots, tstate, lastAt, cursor, pend, claim, swept, mark, decided, sweptAfter, sweptHuman, askedNoSlot>>

(* A worker on *another* ticket takes the last slot and later gives it back. Without this the model's only slot
   is the one the swept thread takes, so a free slot and a swept thread are the same fact, `slots > 0` gates
   nothing, and SW3 proves nothing about capacity. *)
WorkerStarts ==
  /\ slots = 1
  /\ slots' = 0
  /\ UNCHANGED <<day, tstate, sweptCnt, lastAt, cursor, pend, claim, swept, mark, decided, sweptAfter, sweptHuman, askedNoSlot>>

WorkerEnds ==
  /\ slots = 0
  /\ slots' = 1
  /\ UNCHANGED <<day, tstate, sweptCnt, lastAt, cursor, pend, claim, swept, mark, decided, sweptAfter, sweptHuman, askedNoSlot>>

Terminate == UNCHANGED vars

Next ==
  \/ Terminate
  \/ \E t \in Times : PostComment(t)
  \/ SweepPass
  \/ Sweep
  \/ SweepClaimingHuman
  \/ RefuseSweep
  \/ AcceptSweep
  \/ FinishTicket
  \/ StopTicket
  \/ NewDay
  \/ WorkerStarts
  \/ WorkerEnds

Fairness ==
  /\ WF_vars(SweepPass) /\ WF_vars(Sweep) /\ SF_vars(AcceptSweep) /\ SF_vars(RefuseSweep)
  /\ WF_vars(PostComment(1)) /\ WF_vars(PostComment(2)) /\ WF_vars(PostComment(3))
  /\ WF_vars(FinishTicket) /\ WF_vars(StopTicket) /\ WF_vars(NewDay)

Spec == Init /\ [][Next]_vars /\ Fairness

(* ------------------------------------------------------------ the claims ---- *)

TypeOK ==
  /\ slots \in 0..1
  /\ day \in Days /\ tstate \in TStates /\ sweptCnt \in 0..1
  /\ lastAt \in 0..3 /\ cursor \in 0..4
  /\ pend \in BOOLEAN /\ claim \in BOOLEAN
  /\ swept \in BOOLEAN /\ mark \in 0..3
  /\ decided \in BOOLEAN /\ sweptAfter \in BOOLEAN
  /\ sweptHuman \in BOOLEAN /\ askedNoSlot \in BOOLEAN

(* The cursor never runs backwards, and never past what the sweep read. *)
CursorMonotonic == [][cursor <= cursor' /\ cursor' <= 1 + lastAt']_vars


(* SW1. A sweep trigger never enters as a person's request. `sweptHuman` is what the accepted emission claimed,
   so this checks the guard in AcceptSweep: it takes an emission only when no person is claimed. Remove that
   guard — the shape of the code before intake's check — and SW1 fails. This is the door a sweep would use to
   wake a ticket its author stopped, and the reason Intake.receive refuses the trigger outright. *)
SW1_SweepNeverHuman == sweptHuman = FALSE

(* SW2. One sweep per thread per day. NewDay is the only thing that renews it. *)
SW2_SweepOncePerDay == sweptCnt <= 1

(* SW3. The sweep never asks when it has no slot: `running = maxWorkers` is slots = 0, the state the acceptance
   criterion says must not sweep. `askedNoSlot` records the emission, because the slot is what the pass's gate
   reads — between the emission and the accept other work can take the slot, and the executor queues that launch
   behind maxConcurrent. Drop `slots > 0` from Sweepable — the mutation that makes a liveness lane a launcher —
   and SW3 fails. *)
SW3_SweepWithinCapacity == askedNoSlot = FALSE

(* SW4. A thread that already had work on it is never swept: the ticket rule is checked
   with the day's cooldown cleared, so this is the rule about tickets and not the counter. *)
SW4_SweepSkipsDecided == sweptAfter = FALSE

(* SW5. A thread whose activity is newer than the sweep's read position is left to the
   comment path: `mark` is that activity as the emission saw it. *)
SW5_SweepSkipsLiveActivity == swept => mark <= cursor

(* SW6. A person's stop is terminal: nothing here makes a stopped thread work again, so
   the sweep — and everything downstream of it — never sees it as an idle issue. *)
SW6_StopIsTerminal == [](tstate = stopped => [](tstate = stopped))

(* SW7. Liveness: a thread that stays quiet, unowned and slot-backed is eventually asked
   about. This is the starvation the sweep exists to end, and the fairness assumptions are
   the tick's: the pass keeps running, and the engine keeps taking what it emits. *)
SW7_QuietIssueIsSwept ==
  <>[]((\A t \in Times : lastAt <= t) /\ slots > 0 /\ tstate = none) => <>swept

=====================
