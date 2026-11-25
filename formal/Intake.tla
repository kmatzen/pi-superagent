--------------------- MODULE Intake ---------------------
(*
  The GitHub intake source: its read position, its seed rule, and comment delivery.
  Its first version fired every pre-existing issue as a request on its first start,
  so its rules are worth checking in every interleaving.

  Mirrors src/pi/source-github.ts: bootstrap seeds `since` one day back; the first
  poll records the open issues and fires none of them; a later poll fires issues
  opened since, drops closed ones from the seen set (so a reopened issue fires again),
  and reads comments from the committed cursor forward.

  The cursor follows the deferred-commit rule: a poll stages its new cursor, and the
  stage commits at the next poll, once the engine has taken every trigger the poll
  emitted (engine.receive dedups by content-derived trigger id). A crash before the
  commit rewinds to the committed cursor: replay, dedup, no loss. Committing at read
  time instead makes C3 false, which is the bug this model found in shipped code.

  The ready sweep (Intake.sweep, wired into the router's tick) is modelled here at the one
  point where it touches this module: its trigger enters `engine.receive` like any other,
  and intake's guard refuses a sweep trigger that claims to be a person's message. C7 is
  that guard — the door a person's message walks through to wake a ticket its author
  stopped, so a sweep that faked provenance could override a stop the operator ordered.
  C8 is the emission's own rule: one trigger in flight, one per pass. Its capacity,
  cooldown, ticket and cursor rules are in Sweep.tla; this model's 113,281 states of poll
  and comment interleaving times the sweep's state does not close, and every sweep step
  leaves the poll's variables alone, so C1-C6 carry over unchanged.

  Leaves out: reviews (they follow the same deferred cursor), pull requests and the
  stop on a closed thread, pagination, edited or deleted comments, comment bodies.
  Bounds: two issues, two comments, one crash; one sweep emission, on i1.
*)
EXTENDS Integers, FiniteSets

CONSTANTS i1, i2, c1, c2        (* model values: two issues, two comments *)

Issues  == {i1, i2}
(* Comment facts are fixed: issue, time, and whether a person wrote it. c2 is a bot's. *)
CmOf(c) == [issue |-> i1,
            at    |-> IF c = c1 THEN 2 ELSE 3,
            human |-> c # c2]
Comments == {c1, c2}
Times == 1..4
MaxNat(S) == IF S = {} THEN 0 ELSE CHOOSE m \in S : \A n \in S : n <= m

VARIABLES
  crashes,                                              (* bounded restarts, for liveness *)
  seeded, firstSeeded, reopened,                        (* the import-replay ghost *)
  opened, posted,                                       (* the outside world *)
  seen, cursor, seenStaged, cursorStaged,               (* committed and staged positions *)
  acceptedCm, acceptedHuman, acceptedIss,               (* engine.receive, dedup by id *)
  pendCm, pendIss, openCnt,                             (* emissions in flight *)
  pendSweep, claim, sweptIss, sweptHuman                (* the sweep: emission, its human claim, what entered *)

vars == <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
          seenStaged, cursorStaged, acceptedCm, acceptedHuman, acceptedIss,
          pendCm, pendIss, openCnt, pendSweep, claim, sweptIss, sweptHuman>>

(* The sweep's own state. It is in every older action's UNCHANGED list and every sweep
   action leaves the poll's state alone, so C1-C6 are untouched by the sweep. *)
sweepVars == <<pendSweep, claim, sweptIss, sweptHuman>>

Init ==
  /\ crashes = 0
  /\ seeded = FALSE /\ firstSeeded = {} /\ reopened = [i \in Issues |-> FALSE]
  /\ opened = {i1}                    (* i1 predates the source — it must seed silent *)
  /\ posted = {}
  /\ seen = {} /\ cursor = 1 /\ seenStaged = {} /\ cursorStaged = 1
  /\ acceptedCm = {} /\ acceptedHuman = {} /\ acceptedIss = {}
  /\ pendCm = {} /\ pendIss = {} /\ openCnt = [i \in Issues |-> 0]
  /\ pendSweep = {} /\ claim = FALSE /\ sweptIss = {} /\ sweptHuman = {}

(* ---- the outside world ---- *)
(* Posting causality: a comment materializes at wall time, never behind the newest
   timestamp any poll has observed (the cursor only advances by reading, and GitHub
   `at` is creation time). *)
PostComment(c) ==
  /\ c \notin posted
  /\ CmOf(c).at >= cursorStaged
  /\ posted' = posted \cup {c}
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, seen, cursor,
                 seenStaged, cursorStaged, acceptedCm, acceptedHuman, acceptedIss,
                 pendCm, pendIss, openCnt, sweepVars>>

OpenIssue(i) ==
  /\ i \notin opened
  /\ opened' = opened \cup {i}
  /\ openCnt' = [openCnt EXCEPT ![i] = 0]   (* a fresh open interval may fire once *)
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedCm, acceptedHuman, acceptedIss,
                 pendCm, pendIss, sweepVars>>

CloseIssue(i) ==
  /\ i \in opened
  /\ opened' = opened \ {i}
  /\ openCnt' = [openCnt EXCEPT ![i] = 0]
  /\ reopened' = [reopened EXCEPT ![i] = TRUE]
  /\ UNCHANGED <<crashes, seeded, firstSeeded, posted, seen, cursor, seenStaged,
                 cursorStaged, acceptedCm, acceptedHuman, acceptedIss, pendCm, pendIss, sweepVars>>

(* ---- the source: first poll seeds; later polls commit, then stage ---- *)

(* The first look records the open issues and fires none of them. The seed commits at
   once: losing it to a crash would fire the whole backlog, and the shipped source
   saves it inside the poll. Comments are read in the same poll, as in the shipped
   source. *)
FirstPoll ==
  /\ seeded = FALSE
  /\ seeded' = TRUE
  /\ firstSeeded' = opened
  /\ seen' = opened
  /\ seenStaged' = opened
  /\ pendCm' = {c \in posted : CmOf(c).at >= cursor}
  /\ cursorStaged' = IF pendCm' = {} THEN cursor ELSE 1 + MaxNat({CmOf(c).at : c \in pendCm'})
  /\ pendIss' = {}
  /\ UNCHANGED <<crashes, reopened, opened, posted, cursor,
                 acceptedCm, acceptedHuman, acceptedIss, openCnt, sweepVars, sweepVars>>

(* A later poll: commit the previous stage — only once every trigger it emitted has
   been accepted (the deferred-commit rule). Then stage the next look. *)
Poll ==
  /\ seeded
  /\ pendCm = {} /\ pendIss = {}
  /\ cursor' = cursorStaged
  /\ seen' = seenStaged
  /\ LET newIss == opened \ seenStaged IN
     /\ pendIss' = newIss
     /\ pendCm' = {c \in posted : CmOf(c).at >= cursor'}
     /\ seenStaged' = (seenStaged \cup newIss) \cap opened
     /\ cursorStaged' = IF pendCm' = {} THEN cursor' ELSE 1 + MaxNat({CmOf(c).at : c \in pendCm'})
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, posted,
                 acceptedCm, acceptedHuman, acceptedIss, openCnt, sweepVars>>

(* The engine takes each emitted trigger once. Ids are content hashes, so a replayed
   trigger is processed as a no-op (engine.receive reports a duplicate) rather than
   jamming the queue: the commit needs only every emitted trigger processed. *)
AcceptComment(c) ==
  /\ c \in pendCm
  /\ acceptedCm' = acceptedCm \cup {c}
  /\ acceptedHuman' = IF CmOf(c).human THEN acceptedHuman \cup {c} ELSE acceptedHuman
  /\ pendCm' = pendCm \ {c}
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedIss, pendIss, openCnt, sweepVars>>

AcceptIssue(i) ==
  /\ i \in pendIss
  /\ acceptedIss' = acceptedIss \cup {i}
  /\ pendIss' = pendIss \ {i}
  /\ openCnt' = IF i \in acceptedIss THEN openCnt ELSE [openCnt EXCEPT ![i] = openCnt[i] + 1]
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedCm, acceptedHuman, pendCm, sweepVars>>

(* ---- the ready sweep: the router's own request for an idle issue ---- *)

(* The board is quiesced: the pass's live gates are a free slot and an empty eval queue, and
   a trigger queued for Eval or an Eval in progress is the judge's work. The thread must be
   on the board the poll read (`i1 \in seen`) — the sweep reads that board, it does not
   re-read GitHub — and open. `claim` is the emitter's `human` flag as it stands in the
   source, and the model lets it be either value: C7 then checks the guard in Intake.receive
   rather than restating the flag, which is the shape of a careless later edit. *)
EmitSweep(claiming) ==
  /\ seeded /\ pendCm = {} /\ pendIss = {} /\ pendSweep = {} /\ sweptIss = {}
  /\ i1 \in seen /\ i1 \in opened
  /\ pendSweep' = {i1}
  /\ claim' = claiming
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedCm, acceptedHuman, acceptedIss,
                 pendCm, pendIss, openCnt, sweptIss, sweptHuman>>

Sweep == EmitSweep(FALSE)

(* The emitter after the careless edit: the same pass, setting `human: true`. *)
SweepClaimingHuman == EmitSweep(TRUE)

(* Intake.receive: a trigger carrying the sweep's marker and `human: true` is refused —
   nothing recorded, the emission dropped, no slot taken. A sweep can never walk the
   `resumes` door and wake a ticket its author stopped. *)
RefuseSweep ==
  /\ pendSweep # {} /\ claim
  /\ pendSweep' = {} /\ claim' = FALSE
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedCm, acceptedHuman, acceptedIss,
                 pendCm, pendIss, openCnt, sweptIss, sweptHuman>>

(* The engine takes the sweep's request: a trigger like any other, recorded as swept and
   never in `sweptHuman`, whatever the emission claimed. *)
AcceptSweep ==
  /\ pendSweep # {} /\ ~claim
  /\ sweptIss' = sweptIss \cup pendSweep
  /\ sweptHuman' = sweptHuman \cup {i \in Issues \cap sweptIss' : claim}
  /\ pendSweep' = {} /\ claim' = FALSE
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedCm, acceptedHuman, acceptedIss,
                 pendCm, pendIss, openCnt>>

(* Crash: the staged position dies with the process; committed state and accepted
   triggers survive; emissions in flight are lost and replay from the committed cursor.
   The crash budget is finite and WF(Crash) spends it, so the liveness claim is checked
   through a restart; the replay argument is the same for each further one. *)
Crash ==
  /\ crashes < 1
  /\ crashes' = crashes + 1
  /\ cursorStaged' = cursor
  /\ seenStaged' = seen
  /\ pendCm' = {} /\ pendIss' = {}
  /\ UNCHANGED <<seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 acceptedCm, acceptedHuman, acceptedIss, openCnt, sweepVars>>

Terminate == UNCHANGED vars

Next ==
  \/ Terminate
  \/ \E c \in Comments : PostComment(c)
  \/ \E i \in Issues : OpenIssue(i)
  \/ \E i \in Issues : CloseIssue(i)
  \/ FirstPoll
  \/ Poll
  \/ \E c \in Comments : AcceptComment(c)
  \/ \E i \in Issues : AcceptIssue(i)
  \/ Sweep
  \/ SweepClaimingHuman
  \/ RefuseSweep
  \/ AcceptSweep
  \/ Crash

Fairness ==
  /\ \A c \in Comments : WF_vars(PostComment(c)) /\ SF_vars(AcceptComment(c))
  /\ \A i \in Issues : WF_vars(OpenIssue(i)) /\ SF_vars(AcceptIssue(i))
  /\ SF_vars(FirstPoll) /\ SF_vars(Poll) /\ WF_vars(Crash)

Spec == Init /\ [][Next]_vars /\ Fairness

(* ------------------------------------------------------------ the claims ---- *)

TypeOK ==
  /\ crashes \in 0..1
  /\ seeded \in BOOLEAN /\ firstSeeded \in SUBSET Issues /\ opened \in SUBSET Issues
  /\ posted \in SUBSET Comments
  /\ seen \in SUBSET Issues /\ seenStaged \in SUBSET Issues
  /\ cursor \in Times /\ cursorStaged \in Times
  /\ acceptedCm \in SUBSET Comments /\ acceptedHuman \in SUBSET Comments
  /\ acceptedIss \in SUBSET Issues
  /\ pendCm \in SUBSET Comments /\ pendIss \in SUBSET Issues
  /\ openCnt \in [Issues -> 0..2] /\ reopened \in [Issues -> BOOLEAN]
  /\ pendSweep \in SUBSET Issues /\ claim \in BOOLEAN
  /\ sweptIss \in SUBSET Issues /\ sweptHuman \in SUBSET Issues

(* C1. The first look is silent: a seeded issue fires only after a real close and
   reopen. *)
C1_SeedSilence == acceptedIss \cap firstSeeded \subseteq {i \in Issues : reopened[i]}

(* C2. At most one request per open interval of an issue. *)
C2_ReopenOnce == \A i \in Issues : openCnt[i] <= 1

(* C3. The committed cursor only stands over accepted comments: after any crash, every
   comment the cursor has passed was accepted — nothing is lost between poll and
   accept. (Commit-at-emit fails this; the deferred commit is what the source must do.) *)
C3_NoGhostCommit == [][\A c \in posted : CmOf(c).at < cursor => c \in acceptedCm]_vars

(* C4. Acceptance is permanent. Accepting by id is a set union, so a replay adds
   nothing by construction; what TLC checks is that nothing accepted is ever lost. *)
C4_NoDoubleAccept == [][acceptedCm \subseteq acceptedCm' /\ acceptedIss \subseteq acceptedIss']_vars

(* C5. A bot's comment is never taken for a person's request. *)
C5_BotNeverHuman == acceptedHuman \subseteq {c \in acceptedCm : CmOf(c).human}

(* C6. Liveness through a crash: every posted comment is eventually accepted, and
   every issue opened after the seed fires. The model allows one crash; the replay
   argument is the same for each further one. *)
C6_NoLoss == []<>(posted \subseteq acceptedCm /\ \A i \in opened : i \in acceptedIss \/ i \in firstSeeded)

(* C7. A sweep trigger never enters the engine as a person's request. `SweepClaimingHuman`
   is the emitter after a careless edit, so this checks the guard in Intake.receive: let
   AcceptSweep ignore `claim` — the code before the guard — and C7 fails. That is the door
   a sweep would use to wake a ticket its author stopped. *)
C7_SweepNeverHuman == sweptHuman = {}

(* C8. One sweep trigger in flight: the pass emits at most one, and the next pass waits for
   the engine to take it. *)
C8_OneSweepInFlight == Cardinality(pendSweep) <= 1

=====================
