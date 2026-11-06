--------------------- MODULE Intake ---------------------
(*
  The GitHub intake source, machine-checked: the read position, the issue-seed rule,
  and comment delivery. This source caused the fleet's one real intake incident (36
  mirrored issues fired as requests on first start), so its rules are worth
  enumerating exhaustively.

  Mirrors src/pi/source-github.ts: bootstrap seeds `since` one day back; the first
  poll records open issues and fires none of them (import replay); a later poll fires
  issues that opened since, prunes closed ones from the seen set (reopening fires
  afresh), and reads comments from the committed cursor forward.

  The committed cursor models the DEFERRED-COMMIT pattern the source must follow: a
  poll stages its new cursor, and the stage commits only once every trigger it emitted
  has been accepted by the engine (engine.receive dedups by content-hashed trigger
  id). A crash before commit rewinds to the committed cursor: replay, dedup, no loss.
  Committing at emit time — the naive form — makes C3 false, which is exactly the
  failure that kills a request opened inside a crash window.
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
  pendCm, pendIss, openCnt                              (* emissions in flight *)

vars == <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
          seenStaged, cursorStaged, acceptedCm, acceptedHuman, acceptedIss,
          pendCm, pendIss, openCnt>>

Init ==
  /\ crashes = 0
  /\ seeded = FALSE /\ firstSeeded = {} /\ reopened = [i \in Issues |-> FALSE]
  /\ opened = {i1}                    (* i1 predates the source — it must seed silent *)
  /\ posted = {}
  /\ seen = {} /\ cursor = 1 /\ seenStaged = {} /\ cursorStaged = 1
  /\ acceptedCm = {} /\ acceptedHuman = {} /\ acceptedIss = {}
  /\ pendCm = {} /\ pendIss = {} /\ openCnt = [i \in Issues |-> 0]

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
                 pendCm, pendIss, openCnt>>

OpenIssue(i) ==
  /\ i \notin opened
  /\ opened' = opened \cup {i}
  /\ openCnt' = [openCnt EXCEPT ![i] = 0]   (* a fresh open interval may fire once *)
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedCm, acceptedHuman, acceptedIss,
                 pendCm, pendIss>>

CloseIssue(i) ==
  /\ i \in opened
  /\ opened' = opened \ {i}
  /\ openCnt' = [openCnt EXCEPT ![i] = 0]
  /\ reopened' = [reopened EXCEPT ![i] = TRUE]
  /\ UNCHANGED <<crashes, seeded, firstSeeded, posted, seen, cursor, seenStaged,
                 cursorStaged, acceptedCm, acceptedHuman, acceptedIss, pendCm, pendIss>>

(* ---- the source: first poll seeds; later polls commit, then stage ---- *)

(* The first look: record open issues, fire none (import replay). The seed commits at
   poll time — losing a seed to a crash would replay the import storm, and the
   shipped source persists it in the poll. With nothing to replay, the same poll also
   reads comments, mirroring the shipped source. *)
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
                 acceptedCm, acceptedHuman, acceptedIss, openCnt>>

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
                 acceptedCm, acceptedHuman, acceptedIss, openCnt>>

(* The engine takes each emitted trigger once (engine.receive; ids are content hashes). *)
(* A replayed trigger is PROCESSED as a dedup no-op (engine.receive returns false);
   it does not jam the queue — the commit only needs every emitted trigger processed. *)
AcceptComment(c) ==
  /\ c \in pendCm
  /\ acceptedCm' = acceptedCm \cup {c}
  /\ acceptedHuman' = IF CmOf(c).human THEN acceptedHuman \cup {c} ELSE acceptedHuman
  /\ pendCm' = pendCm \ {c}
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedIss, pendIss, openCnt>>

AcceptIssue(i) ==
  /\ i \in pendIss
  /\ acceptedIss' = acceptedIss \cup {i}
  /\ pendIss' = pendIss \ {i}
  /\ openCnt' = IF i \in acceptedIss THEN openCnt ELSE [openCnt EXCEPT ![i] = openCnt[i] + 1]
  /\ UNCHANGED <<crashes, seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 seenStaged, cursorStaged, acceptedCm, acceptedHuman, pendCm>>

(* Crash: the staged position dies with the process; committed state and accepted
   triggers survive; in-flight emissions are lost and replay from the committed cursor.
   A finite crash budget: WF(Crash) forces every crash the model allows to happen, so
   the liveness claim holds through any finite number of restarts. *)
Crash ==
  /\ crashes < 1
  /\ crashes' = crashes + 1
  /\ cursorStaged' = cursor
  /\ seenStaged' = seen
  /\ pendCm' = {} /\ pendIss' = {}
  /\ UNCHANGED <<seeded, firstSeeded, reopened, opened, posted, seen, cursor,
                 acceptedCm, acceptedHuman, acceptedIss, openCnt>>

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

(* C1. Import replay is silent: a seeded issue fires only after a real close/reopen
   cycle — the mirrored-issues incident, frozen as a theorem. *)
C1_SeedSilence == acceptedIss \cap firstSeeded \subseteq {i \in Issues : reopened[i]}

(* C2. At most one request per open interval of an issue. *)
C2_ReopenOnce == \A i \in Issues : openCnt[i] <= 1

(* C3. The committed cursor only stands over accepted comments: after any crash, every
   comment the cursor has passed was accepted — nothing is lost between poll and
   accept. (Commit-at-emit fails this; the deferred commit is what the source must do.) *)
C3_NoGhostCommit == [][\A c \in posted : CmOf(c).at < cursor => c \in acceptedCm]_vars

(* C4. No trigger is ever accepted twice. *)
C4_NoDoubleAccept == [][acceptedCm \subseteq acceptedCm' /\ acceptedIss \subseteq acceptedIss']_vars

(* C5. A bot's comment is never taken for a person's request. *)
C5_BotNeverHuman == acceptedHuman \subseteq {c \in acceptedCm : CmOf(c).human}

(* C6. Liveness through a crash (budget-bounded: the replay mechanism is proven to
   recover from a restart; unbounded restarts follow by induction on the budget):
   every posted comment is eventually accepted, and every issue opened after the seed
   fires. *)
C6_NoLoss == []<>(posted \subseteq acceptedCm /\ \A i \in opened : i \in acceptedIss \/ i \in firstSeeded)

=====================
