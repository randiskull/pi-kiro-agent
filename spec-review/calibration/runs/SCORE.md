# Pass 8 score (rubric 1) - WITHDRAWN

**The 30/30 below is not evidence about the rubric.** The answer key was
relabelled (c1 G1) because both of these runs failed that gate, and then these
same two runs were scored against the new key with nothing re-run. The ship bar's
rule 4 forbids resolving a miss by choosing a run, and it had no clause covering
a relabel; it now does (`../README.md`, ship bar rule 4, and `expected.json`
`shipBar.relabelling`). The arithmetic below is correct and reproduces exactly;
what it measures is two runs against a key fitted to them. Both runs are kept as
history, with `countsTowardsShipBar: false` in their `RUN.json`.

Produced by `node spec-review/calibration/score.mjs runs/2026-10-17-r1-other-claude-opus-5-5 runs/2026-10-17-r1-other-gpt-6-astra` against `expected.json` (run A is the Claude run, run B the GPT run). The scorer was committed after the fact; it reproduces every case line and both totals below, and names each run by its directory where the original said run A and run B.

`score.mjs` now also checks the blobs each run recorded against the rubric, the
key and the cases as they stand (`expected.json` `shipBar.blobs`, ship bar rule
5), so re-running it on any run below prints one `blobs:` line per run and a
closing `runs that do not count:` line, and it exits 1. **Every case line and
both totals below are unchanged.** For this pair the exit was 0 before that
check existed, on `30/30` with no miss, which is the withdrawn result this file
opens by retracting: the retraction was prose, and the scorer disagreed with it.
It no longer does.

`score.mjs` scores a run on the cases its `RUN.json` lists. Both runs below
predate c7 and c8, so re-running the command above prints one more line per run,
`not in this run (added to the set after it): c7, c8`, and a closing
`cases not reviewed: c7, c8 (in 2 of 2 run(s); ...)` line, because a run that did
not review every case has not met the set. That is a second reason the exit is 1;
the blob check above is the first, and it subsumes this one, since a case left out
of `scoredAgainst.cases` has no blob recorded either. Every other line is
unchanged.

```
=== run A (2026-10-17-r1-other-claude-opus-5-5)
  c1: reject  gates FPPPP D14 D22 D31 D43 D53 D63  OK
  c2: revise  gates FFFFF D13 D22 D33 D42 D51 D64  OK
  c3: revise  gates PPFPP D14 D23 D33 D43 D53 D64  OK
  c4: pass    gates PPPPP D14 D23 D33 D43 D53 D64  OK
  c5: revise  gates PFPPP D14 D23 D33 D43 D53 D64  OK
  c6: revise  gates PPPPP D12 D23 D33 D43 D53 D64  OK
=== run B (2026-10-17-r1-other-gpt-6-astra)
  c1: reject  gates FPPPP D14 D22 D31 D43 D53 D64  OK
  c2: revise  gates FFFFF D13 D22 D32 D43 D51 D64  OK
  c3: revise  gates PPFPP D14 D23 D34 D43 D53 D64  OK
  c4: pass    gates PPPPP D14 D23 D34 D43 D53 D64  OK
  c5: revise  gates PFPPP D14 D23 D34 D43 D53 D64  OK
  c6: revise  gates PPPPP D12 D23 D34 D43 D53 D64  OK
gate agreement: 30/30 
cases with a miss: 0
```

# Held-out run (rubric 1, unchanged)

A third run by a harness and model that took no part in passes 1 to 8:
kiro-cli 2.32.0, `claude-sonnet-5`. It is the honest measurement of Rubric 1 as
pass 8 left it, because nothing was changed before or after it and it ran from a
clone that could not reach the key. Protocol and the reasons for each miss:
`2026-10-17-r1-kiro-cli-claude-sonnet-5/NOTES.md`.

```
=== 2026-10-17-r1-kiro-cli-claude-sonnet-5
  c1: revise  gates FPPPP D14 D21 D31 D44 D54 D64  MISS: outcome revise (want reject)
  c2: revise  gates FFPPF D14 D23 D33 D43 D51 D64  MISS: G3 pass (want fail); G4 pass (want fail)
  c3: revise  gates PPFPP D14 D23 D33 D44 D53 D64  OK
  c4: pass    gates PPPPP D14 D24 D34 D44 D53 D64  OK
  c5: revise  gates PFPPF D14 D24 D32 D44 D54 D64  MISS: G5 fail (want pass)
  c6: revise  gates PPPPP D12 D24 D34 D44 D54 D64  OK
gate agreement with run A: 27/30  (disagree: c2 G3, c2 G4, c5 G5)
gate agreement with run B: 27/30  (disagree: c2 G3, c2 G4, c5 G5)
cases with a miss: 3
```

Pass 8's 30/30 does not hold for a reviewer the set was not tuned on.

Two of the three misses were wording defects and are now fixed in the rubric:
`reject` outranks `revise` (c1), and G5 judges an out-of-scope item's sentence
rather than whether its named target resolves (c5). The third, c2 G3 and G4, is a
pair of judgement labels, left alone and since ratified as `fail` on 2026-10-19:
this run's findings were on D2, D3 and D5, so it argued against neither
(`expected.json` `labelledBy`).

# Held-out pair, after the review fixes (rubric 1 at `f64d2eb`)

Two passes run against the rubric, cases and key as the review-item fixes left
them, by two models that took part in no earlier pass and in no wording fix.
`gsd` 1.22.0 on `us.anthropic.claude-fable-5-1` (Bedrock, us-west-2) and
`kiro-cli` 2.32.0 on `gpt-5.6-sol`. Twelve sessions, six per pass, each in its
own directory off one ref-stripped clone; all twelve exited 0, all twelve header
blobs match their case, and the isolation audit is clean. Protocol and
deviations are in each run's `NOTES.md`.

```
$ node spec-review/calibration/score.mjs \
    spec-review/calibration/runs/2026-10-17-r1-gsd-us-anthropic-claude-fable-5-1 \
    spec-review/calibration/runs/2026-10-17-r1-kiro-cli-gpt-5-6-sol
=== 2026-10-17-r1-gsd-us-anthropic-claude-fable-5-1
  c1: reject  gates PPPPP D14 D22 D31 D43 D53 D62  MISS: G1 pass (want fail)
  c2: revise  gates FFFFP D13 D22 D32 D43 D51 D63  MISS: G5 pass (want fail)
  c3: revise  gates PPFPP D14 D24 D34 D44 D53 D64  OK
  c4: pass    gates PPPPP D14 D24 D33 D44 D53 D64  OK
  c5: revise  gates PFPPP D14 D24 D33 D43 D53 D64  OK
  c6: revise  gates PPPPP D12 D23 D33 D44 D53 D64  OK
=== 2026-10-17-r1-kiro-cli-gpt-5-6-sol
  c1: reject  gates PPPPP D14 D22 D31 D44 D53 D64  MISS: G1 pass (want fail)
  c2: revise  gates FFFFF D13 D22 D33 D43 D51 D64  OK
  c3: revise  gates PPFFP D14 D23 D34 D44 D53 D64  MISS: G4 fail (want pass)
  c4: pass    gates PPPPP D14 D23 D34 D44 D53 D64  OK
  c5: revise  gates PFPPP D13 D24 D34 D44 D54 D64  OK
  c6: revise  gates PPPPP D12 D23 D33 D44 D53 D64  OK
gate agreement: 28/30  (disagree: c2 G5, c3 G4)
cases with a miss: 4
exit=1
```

**The ship bar is not met.** Both runs are committed with
`countsTowardsShipBar: false` and a `whyNot` saying which cases missed. Nothing
in the rubric, the cases or `expected.json` was touched after these verdicts
were collected, so the measurement stands as taken.

## What the result says

**c1 G1, in both runs, is the result that matters.** Two models in two harnesses
independently passed a gate the key says fails, and both found the underlying
defect: run 1 as five `D3` findings on the contradiction plus two `D2` findings
on the unargued second bridged turn, run 2 as one `D2` finding naming the exact
mechanism (`§5e.3`: kiro keeps the MCP client it built at the first
`session/new`, so the retired port is still what it calls). Neither read it as
an *open contract*. The key's reading is that c1's contract cannot be closed
because `useResume` is computed before `resolveSession()`, so a per-turn reset
sends a delta prompt to an empty session and no wording of the mutation decides
that. G1's opening sentence reaches it ("what it does in each case the spec
names"); **G1's `Fails` list does not** - every bullet there describes a spec
that offers a choice, and c1 offers none. Two reviewers applied the list.

Rule 4's relabelling clause forbids the convenient move here, which is the
clause doing its job against its own author: the label cannot be changed to
`pass` because two runs said so. Either c1's `G1 fail` is re-derived from how
the case is constructed, or G1 is reworded to separate "open contract" from
"decided but unargued", and the construction and the gate are made to agree.
Both are rubric work, and both force another pair of passes.

**c3 G4, in run 2, reproduces review item 10 on a fresh model.** The same run
passed c4's G4 and failed c3's on text that is byte-identical: `diff c4.md c3.md`
touches only the negative-control step and a "before and after" phrase, while
criterion 6 and the verification step the finding quotes are the same in both.
G4 says "at least one Verification plan step produces that evidence" and also
"A documentation criterion's evidence is the named file", and does not say which
governs when the criterion is documentation. Run 2 applied one sentence to c4
and the other to c3. This is a sharper demonstration than pass 8 produced,
because it is one model, one rubric, two readings of the same words.

**c2 G5, in run 1, is reviewer variance, not a wording defect.** Run 1 raised no
out-of-scope finding at all; run 2, under the same rubric text, failed G5 and
cited the transport item. Worth recording while the key is open: the key's c2 G5
reason names two items, and one of them, "unchanged: all traffic stays on
kiro-cli under the user's entitlement", does state a disposition the rubric
lists. The gate still fails on the transport item alone, so the verdict is
right and the reason overstates - the same shape of error as the c2 G2 reason
corrected this round.

**And a fifth finding, on a key reason corrected this round.** Both runs failed c2
G2 on `"Negative control first (per repo engineering rule)"`, saying no such
rule is named or present - and **run 2 said it after reading
`docs/releasing.md`**, the file that correction points at. The correction said a
reviewer who finds that file is right not to fail on this half. That reads the
gate too narrowly. `docs/releasing.md` does state the procedure (revert, run,
it must fail, restore, it must pass) but never as a general engineering rule and
never under the name "negative control", and c2 names no source at all. G2's
first sentence settles it: the source must be "named precisely enough to open",
so an unnamed source fails whether or not something matching it exists. G2's
example then muddies it, failing `"Per the repo rule"` only *"with no rule in
the repo"*, which conditions on existence rather than naming. The verdict `G2
fail` is unaffected; it has three grounds, not one, and the example sentence
should drop the existence clause. Both runs also failed G2 on the
`"ASCII-only ... per repo convention"` line, correctly: no such convention
exists anywhere in the checkout.

**What worked.** Both runs got c1's `outcome: reject`, which the `claude-sonnet-5`
run got wrong, so the item-8 precedence fix is confirmed by two of two fresh
runs. c5 G5 passed in both, so the item-20 G5 rewrite is confirmed. c6's twelve
lines are identical in both runs, and every gate on c1, c3, c4, c5 and c6 agreed
except c3's G4. No run leaked the key, and the one session that probed for
`spec-review/` was refused by the clone.

A format defect turned up that is not in the 22 items: the rubric asks the
reviewer for `Reviewer: <harness>, <model>`, and run 1's six sessions could not
see their own model id and guessed wrongly six different ways, once naming a
model that was not used. The field belongs to the harness; `RUN.json` is the
record to trust.

# Where Rubric 1 stands

**No run counts.** Five run directories, and every one records
`countsTowardsShipBar: false` with its reason. The first three record
pre-review blobs in `RUN.json`, and ship bar rule 5 counts a run only when its
recorded blobs match the committed ones, so the wording fixes staled them on
purpose; that is the mechanism working, because a stale run is now visible
rather than plausible. The two newest recorded the blobs that were current when
they ran and were not stale then - they simply miss, four cases between them.

**Rubric 2 stales those two as well, and that is not a retraction of their
measurement.** The G1, G2, G4 and G5 wording fixes change `spec-review/rubric.md`,
and the corrected c1, c2 and c4 reasons change `expected.json`, so neither blob
in any committed `RUN.json` matches the committed file any more and rule 5 now
counts none of the five runs. The four misses above stand as the honest
measurement of Rubric 1, which is what the wording fixes were made from. **Rubric
2 has no run at all**, and the two models that produced those misses are spent
under rule 6, so meeting the bar needs a seventh and an eighth.

The bar still needs two passes that each miss no case, at a comparable
capability level, by models that took part in no pass and no wording fix (rules
6 and 7). **Six models are now spent:** `claude-opus-5-5` and `gpt-6-astra`
(passes 1 to 8), `claude-sonnet-5` (the first held-out run, whose misses drove
two fixes), `claude-opus-4.8` (it reviewed the bus spec from a worktree sharing
this branch's object database, so it could read the key), and
`us.anthropic.claude-fable-5-1` and `gpt-5.6-sol` (this pair). The next attempt
needs a seventh and eighth, and the rubric fixes the findings above call for
will spend them: this is exactly the cost `shipBar.heldOut` was written to make
visible, and it is the reason criterion 12 is a gate on the spec rather than a
box to tick.

Until two passes are committed, criterion 12 is unmet and the README says so.

**Decision, 2026-10-17: the bus merges with criterion 12 open.** The four misses
above are rubric-wording defects, not defects in anything the bus builds, and
holding the mechanism that catches them out of the repo costs more than landing
it with the gap recorded. The wording work is listed in issue 67 and deferred to
Rubric 2, where the set also gets the feature case it is missing. Nothing here
is retracted by that decision: five runs, five `countsTowardsShipBar: false`,
and the spec's criterion 12 says `Open`.

# Rubric 2's first pair

The first runs ever made against Rubric 2, and the first made by a script rather
than by hand: `node scripts/calibrate.mjs run`, documented in
`../README.md` ("The runner") and tested in `test/calibrate.test.ts`. Two models
that took part in no earlier pass and in no wording fix, in two different
harnesses on two different routes: `kiro-cli` 2.32.0 on `gpt-5.6-terra`
(seat-billed through the official client) and `pi` 1.3.0 on
`us.anthropic.claude-opus-5` (Amazon Bedrock, us-west-2). Sixteen sessions,
eight per pass, each in its **own copy** of a ref-stripped clone with `origin`
removed; all sixteen exited 0, all sixteen header blobs match their case, the
isolation audit is clean for every one, and no session's `Reviewer:` line needed
correcting, because the runner supplies it. Protocol and per-case diagnosis are
in each run's `NOTES.md`.

```
$ node spec-review/calibration/score.mjs \
    spec-review/calibration/runs/2026-10-19-r2-kiro-cli-gpt-5-6-terra \
    spec-review/calibration/runs/2026-10-19-r2-pi-us-anthropic-claude-opus-5
=== 2026-10-19-r2-kiro-cli-gpt-5-6-terra
  blobs: match, but RUN.json says countsTowardsShipBar is not true, so the run does not count
  c1: reject  gates PPPPP D14 D22 D31 D43 D52 D64  MISS: G1 pass (want fail)
  c2: revise  gates FPFFF D13 D22 D32 D43 D52 D64  MISS: G2 pass (want fail)
  c3: revise  gates PPFPP D14 D24 D34 D44 D54 D64  OK
  c4: pass    gates PPPPP D14 D23 D34 D44 D53 D64  OK
  c5: revise  gates PFPPP D13 D24 D34 D44 D52 D64  OK
  c6: revise  gates PPPPF D12 D24 D34 D44 D52 D64  MISS: G5 fail (want pass)
  c7: pass    gates PPPPP D14 D24 D34 D44 D54 D64  OK
  c8: pass    gates PPPPP D14 D24 D34 D44 D54 D64  MISS: outcome pass (want revise); D1 4 (want <=2); no finding quotes any mustQuoteOneOf string
=== 2026-10-19-r2-pi-us-anthropic-claude-opus-5
  blobs: match, but RUN.json says countsTowardsShipBar is not true, so the run does not count
  c1: reject  gates FPPPP D14 D22 D31 D43 D53 D62  OK
  c2: revise  gates FFFFF D13 D23 D33 D43 D51 D64  OK
  c3: pass    gates PPPPP D14 D24 D33 D44 D53 D64  MISS: outcome pass (want revise); G3 pass (want fail)
  c4: pass    gates PPPPP D14 D23 D34 D44 D53 D64  OK
  c5: revise  gates PFPPP D14 D23 D34 D44 D53 D64  OK
  c6: revise  gates PPPPP D12 D23 D34 D44 D53 D64  MISS: no finding quotes any mustQuoteOneOf string
  c7: pass    gates PPPPP D14 D24 D33 D44 D54 D64  OK
  c8: revise  gates PPPPP D14 D24 D32 D44 D54 D64  MISS: D1 4 (want <=2); no finding quotes any mustQuoteOneOf string
gate agreement: 36/40  (disagree: c1 G1, c2 G2, c3 G3, c6 G5)
cases with a miss: 7
runs that do not count: 2/2 (2026-10-19-r2-kiro-cli-gpt-5-6-terra, 2026-10-19-r2-pi-us-anthropic-claude-opus-5) - the ship bar asks for two that do
exit=1
```

**The ship bar is not met.** Both runs are committed with
`countsTowardsShipBar: false` and a `whyNot` naming the cases that missed.
Nothing in the rubric, the cases, `expected.json` or `score.mjs` was touched
after these verdicts were collected, so the measurement stands as taken.

## What the result says

**The c7/c8 feature column is the headline, and it is not a wording question.**
`shipBar.featureColumn` asks both runs to separate the two cases on D1, c7 at 3
or more and c8 at 2 or less. **Both runs scored both cases at `D1 4`.** The pair
was added to the set because the 40 gate decisions cannot measure the feature
column: c7 and c8 are `pass` on all five gates, so the pair widened the set by
ten gate decisions and no fail, and D1 is the only thing it discriminates. On its
first outing it caught what it was built to catch. Run A's c7 and c8 verdicts are
byte-identical apart from the header blob, all gates `pass`, every dimension 4,
`## Findings` empty in both. Run B did reach `revise` on c8, but from two `D3`
findings about the design doc's status line, never from the Problem being
asserted rather than measured. **Neither reviewer read D1's feature column**, and
no rewording of a gate changes that.

**c1's `G1 fail` is now settled in the key's favour, and the gate's wording is
what is left over.** The Rubric 1 pair left this open: two models passed a gate
the key says fails, and `shipBar.relabelling` forbids relabelling because two
runs said so. Run B failed it, and derived the key's exact mechanism from the
code at `61bb96f`: `streamViaAcp` still computes `plan` from `planAcpTurn()` and
builds a delta prompt whenever `plan.mode === "resume"`, so with the resume
branch removed a resumable turn sends only the delta into a brand-new kiro
session that holds no history, and the spec names `/resume`, `fork` and `reload`
as cases, so the case is undecided rather than impossible. **The label is
re-derived from the construction, so it stays.** The open item is narrower and
sharper than it was: three of four models reach the defect and file it as `D2` or
`D3`, reading c1 as a decided-but-wrong design. G1's opening sentence covers the
case; G1's `Fails` list still describes only specs that offer a choice, and c1
offers none. That list is the fix, not the label.

**c2's `G2 fail` and c3's `G3 fail` are reviewer variance, confirmed in both
directions.** Run A passed c2's G2 having filed ten findings and not one on a
source: it never audited citations, which is not a reading of G2. Run B failed
all five of c2's gates, G2 included. Run A caught c3's missing fail-first step;
run B passed all five of c3's gates and filed its findings elsewhere. One miss
each, on cases the other run got right, with no shared reading to fix.

**c6 produced two separate items, one of them a defect in the key.** Run A failed
c6's G5 on the out-of-scope item `Credit-metering rebuild on session_start.
Follow-up spec, owner: the maintainer.`, because the item names no *specific*
spec, issue or owner. G5 asks for "a named spec, issue or owner" and then says it
"judges the sentence, not the citation", which settles existence and is silent on
specificity; a role is a sentence that decides where an item goes while naming
nobody. **That is a new wording question Rubric 2's G5 fix did not reach**, and it
is the third round in which G5's text has produced a miss. Run B's c6 miss is of a
different kind: its `D1` finding is the one the key asks for, on the right
sentence, with the right tag and the right score, and it quotes
`The bridge probably holds the loop open` without the sentence's full stop, which
the key's `mustQuoteOneOf` string carries. The matcher is a substring test, so one
character fails it. **Scoring that as a calibration miss measures punctuation, not
judgement**; the fix is to drop terminal punctuation from the `mustQuoteOneOf`
strings, and it was deliberately not applied before scoring.

**What the runner itself established.** Three isolation holes the hand-run passes
had are closed and tested, and one of them was live: the Rubric 1 pair's sessions
could reach `@builder-mcp/WorkspaceSearch`, and the first attempt at run A
reproduced that and **was killed with nothing kept**. `--trust-tools` does not
close it (smoke-tested: the MCP tool still runs); a per-session agent with
`mcpServers: {}` does. The clone now has `origin` removed, so it cannot fetch the
repository that holds this key on this branch, and each session gets its own
working copy instead of sharing one. `scripts/calibrate.mjs` also refuses to set
`countsTowardsShipBar: true`: it writes `false` with a `whyNot` saying the score
has not been run, and `finalize` is a separate command a human runs with a
reason. A runner that could declare its own pass to have met the bar is the
pass 8 defect in automated form.

**A disclosed concern about capability.** `shipBar.capabilityMatched` asks the two
runs to be at a comparable level, because a strong-weak pair cannot distinguish an
ambiguous rubric from a reviewer that could not do the task. Both models are
current flagship ids, which is the defensible reading, and the 36/40 agreement
supports it. Against it: run A spent 63s to 78s per case where run B spent 219s
to 431s, and run A returned two verdicts with no findings at all. The difference
is recorded rather than resolved, because resolving it means re-running a lane on
a third model and spending it under rule 6.

# Where Rubric 2 stands

**No run counts, and now seven of the eight run directories say so for a reason
of its own.** The five Rubric 1 runs are stale by blob, on purpose: the wording
fixes that Rubric 2 is made of changed `spec-review/rubric.md` and
`expected.json`, so rule 5 counts none of them. These two are not stale - their
recorded blobs match the committed files, and `score.mjs` says `blobs: match` for
both - **they simply miss, seven run-cases between them, across five distinct
cases.**

Four distinct pieces of work come out of this pair, and they are not equal:

1. **The feature column needs no rubric change at all.** D1's anchors already say
   "measured" versus "asserted"; two flagship reviewers did not apply them to a
   spec whose Problem is one and then the other. Whether that is D1's text, the
   review procedure's silence about reading the Problem for evidence, or the
   prompt, it is the open question the next revision has to answer first, because
   it is the only miss in this pair that no reviewing model got right.
2. **G1's `Fails` list** must separate "open contract" from "decided but
   unargued". The label is settled; the list is what three of four reviewers
   applied instead of the gate's opening sentence.
3. **G5 needs one more sentence**, on whether a role names an owner. Third round,
   third G5 miss, and each round's fix has been a narrower reading of the same
   gate.
4. **`mustQuoteOneOf` should not end in a full stop.** The smallest item here and
   the clearest: it cost a correct finding a `MISS`.

Each of 1 to 4 changes a blob and stales both runs above, which is the cost
`shipBar.heldOut` exists to make visible. **Eight models are now spent**: the six
listed in `expected.json` `shipBar.spent`, plus `gpt-5.6-terra` and
`us.anthropic.claude-opus-5` from this pair. The next attempt needs a ninth and a
tenth. **Neither name was added to `shipBar.spent` in this commit, for the reason
the last round gives:** editing `expected.json` changes its blob and would stale
the two runs keyed to it, turning the result above from a measurement into a
stale one. The list is brought up to date in the same commit as the wording fixes
in 1 to 4, which is the commit that stales these runs anyway.

Criterion 12 of `docs/specs/spec-review-bus.md` stays `Open`, and the README says
so. The 2026-10-17 decision stands for the same reason it was taken: these are
defects in the rubric's wording and in one key string, not in anything the bus
builds, and the mechanism that found them is working. It found them on a rubric
revision, by a script, with the isolation holes closed.

# Rubric 3 lands, and stales both runs above

All four items are fixed in the same commit, and **both runs above are now stale
by blob**, which is the mechanism doing what rule 5 describes. Re-running the
command in "Rubric 2's first pair" prints `blobs: stale` for each run instead of
`blobs: match`, and **every case line and both totals are unchanged**, because
nothing a run recorded moved: the scorer reads the verdicts, and the verdicts are
the same files.

**No answer-key label moved**, on any gate or any dimension, in any case. What
changed:

| item | where | what it was |
| --- | --- | --- |
| 1 | `rubric.md` D1 and the Review procedure | measurement is now a stated precondition of a feature 3 or 4, outside the anchor table, with a procedure step that lists the Problem's evidence and caps D1 at 2 when the list is empty |
| 2 | `rubric.md` G1 and the Review procedure | `Not G1` now says that finding the D2 or the D3 does not answer G1, and a procedure step lists the cases the spec names before any gate is decided |
| 3 | `rubric.md` G5 | an owner may be a person, a role or a team |
| 4 | `expected.json` | six `mustQuoteOneOf` strings lost a terminal full stop, five in c1 and one in c6, and `shipBar.quoteMatching` states the rule |

Items 1 and 2 are the same shape, and the shape is why they are procedure steps
and not more gate text. **In both, a reviewer found the defect and scored it in
the wrong place.** Run A found c1's contradiction with the design doc and filed
it as `D3`; both runs read c8's Problem, checked its claims against the checkout,
found them true, and scored `D1 4`. Neither is a reviewer that misread the spec.
Both are a reviewer answering a question the rubric did not quite ask of them, at
the moment it mattered. G1's `Also fails, with no choice offered` bullet, added in
Rubric 2 for exactly c1, already covered the case and still did not get applied:
**the gate text was right and had no place in the workflow that forced the
question.** So Rubric 3 puts the question in the procedure, where step 3 already
makes a reviewer work through a list.

Two further notes on what this does and does not buy:

- **Item 4 was larger than the pair revealed.** The test written for it found
  five more offending strings in c1 that no run had reached, because no run
  quoted those sentences. One miss exposed a defect in six key strings, and the
  test now also checks that every string is still findable in its case, so
  trimming one into something unquotable fails too.
- **Nothing here has been measured.** Rubric 3's text is an argument about why
  two reviewers scored what they scored. Whether it changes what a reviewer
  does is the next pair's question, and the pair before this one is the
  cautionary case: Rubric 2's G1 bullet was written for c1, read correctly, and
  one of two reviewers passed c1's G1 anyway.

`shipBar.spent` is now eight, with `gpt-5.6-terra` and
`us.anthropic.claude-opus-5` added in this commit rather than the last, for the
reason the last section gives. Criterion 12 of `docs/specs/spec-review-bus.md`
stays `Open`: **Rubric 3 has no run at all**, and the next pair needs a ninth and
a tenth model.

# Rubric 3's first pair

`2026-10-20-r3-kiro-cli-claude-opus-4-7` (run A) and
`2026-10-20-r3-pi-us-anthropic-claude-opus-4-6-v1` (run B), the ninth and tenth
models. Both collected by `scripts/calibrate.mjs` at `5a7ccaf`, blobs matching,
isolation audit clean for all sixteen sessions, no `Reviewer:` line correction.
Run A spent 209s to 266s per case, run B 288s to 641s.

```
gate agreement: 34/40  (disagree: c1 G2, c2 G2, c3 G2, c3 G3, c4 G2, c6 G2)
cases with a miss: 9  (run A 4, run B 5)
```

**The ship bar is not met.** Nine cases miss, agreement fell from 36/40 to
34/40, and run B returns the pair's only false fail, a `revise` on c4.

## What the result says

**1. All four of Rubric 3's changes did what they were written to do, in both
runs.** This is the primary result and it is independent of everything below it.

| change | measured by | run A | run B |
| --- | --- | --- | --- |
| D1's feature-column precondition | c7 `D1 >= 3`, c8 `D1 <= 2` | 4 and 2 | 4 and 2 |
| G1's "finding the D2 or the D3 does not answer G1" | c1 `G1 fail` | fail | fail |
| G5's person-or-role-or-team clause | c6 `G5 pass` | pass | pass |
| `mustQuoteOneOf` punctuation | every quote in c1, c6, c8 | matched | matched |

**`shipBar.featureColumn` is met, by both runs, for the first time in the set's
history.** It was the only rule in `expected.json` that no reviewing model had
ever satisfied: four models had seen c7 and c8 and all four scored them the same
on D1, which is the one thing that pair discriminates. Run A's c8 finding
reaches the new paragraph in its own words, naming the absent command, row,
trace and ref and then quoting the cap: a Problem "that names the right code and
states its findings as claims is a 2 however well those claims hold up". The fix
was followed for the reason it was written.

**2. Six of the six gate disagreements come from one defect, and it is in the
harness, not the rubric.** The calibration prompt says "following its Review
procedure, skipping step 1 (lint)" and supplies no lint output. The rubric's
step 3 is **"Work through every item lint listed under notes (G2 reviewer
half)"**, so step 3 has no input. G2 splits itself the same way: its script half
owns "a repo path that does not exist at the ref", and its reviewer half opens
"lint lists, without failing, every identifier it could not find, every path
outside the repo, every gitignored local path, and every path marked `(new)`.
For each one, the spec must either create it or attribute it to a named source."

G2's reviewer half is therefore **defined as a function of a list calibration
never hands over**, and the boundary between the halves is left to the reviewer
to guess. The two runs guessed opposite ways:

- Run B did lint's job. It found `docs/specs/dual-host-pi-gsd.md` absent at
  `61bb96f` and failed G2 on it in c1, c3, c4 and c6: every case that cites the
  path except c5, where it had two real G2 defects to report instead.
- Run A treated the path as resolving, never raised it, and skipped step 3. On
  c3, where the `- **Negative control` bullet is deleted and `lint.fail` is
  `["G3"]`, run A read the absence as lint's business and passed G3; run B read
  it as its own and failed it, correctly.

`expected.json` `aliases` maps that path to `cases/c2.md`, and the deterministic
half is handed it on the command line (`spec-lint.mjs --alias ...`), so **lint
resolves the path and the reviewer is not told that it does.** Lint's notes for
c4 list nine unresolved symbols, five local paths, four external names and one
placeholder, and never mention the aliased path: that is both the list the
reviewer should have worked through and the proof the path was never a G2
question. The prompt's one alias sentence, "Where the spec cites `X`, read
`<file>`", says where the content is and not that the citation resolves, so a
reviewer that checks the filesystem is contradicted by the harness rather than
informed by it.

The cost is concrete: **c4's false fail has exactly one finding in it**, the G2
item on the aliased path. Delete that finding and c4 is clean. One harness
defect produced four of run B's five G2 misses, both of run A's G3 misses, the
drop in agreement, and the only false fail in the pair.

So `shipBar.agreement`'s rule 4 ("any disagreement means the rubric wording is
ambiguous: fix the wording and re-run both") **must not be applied to these six
disagreements.** They measure the instrument. Fixing G2's or G3's wording in
response to them would be tuning the rubric to a defect in the runner, which is
the pass 8 mistake in a new costume.

**3. What is left is one real shape, and it is not acted on yet.** Strip the
harness defect and five misses remain, and four of them are the same thing: **a
finding that describes anchor N, scored as anchor N+1.**

| case | run | the finding says | scored | key |
| --- | --- | --- | --- | --- |
| c1 D3 | A and B | the Approach "overturns" §5e.3 while claiming to preserve it; fix: "promote this to a supersede" | 2 | 1 |
| c1 outcome | A and B | the same finding | revise | reject |
| c6 D1 | A and B | "probably" hedges a cause the snapshot "already settles" | 3 | 2 |
| c6 outcome | A | the same finding | pass | revise |

Both runs, independently, wrote D3 anchor 1 and the reject row in prose and then
scored anchor 2 and answered `revise`. This is the third time the set has seen
this shape: Rubric 2's pair found c1's contradiction and filed it as D3, and
read c8's Problem correctly and scored `D1 4`. Rubric 3 answered those two by
adding listing steps to the procedure, and the steps worked. **Nothing in the
rubric binds a written finding back to the anchor row it came from**, and that is
where these four misses live.

The fifth is **c2's G3, missed by both runs**, so the set's second both-miss
after the feature column. c2's negative control exists and gives two outcomes
with no mechanism, and the GSD-home test it names builds the wiring itself.
Neither run raised it.

Neither is acted on in this commit. The harness defect has to be fixed first,
because a pair run under a contradictory instrument cannot tell an ambiguous
anchor table from a reviewer guessing at the lint boundary, and a Rubric 4
written on top of this pair would be arguing from five misses when four of them
may move once the reviewer is handed step 3's input.

## Where this leaves the ship bar

`shipBar.spent` is now ten: `claude-opus-4.7` and
`us.anthropic.claude-opus-4-6-v1` join it, because `heldOut` spends any model
that took part in a pass, whatever the pass turns out to have measured. The
next pair needs an eleventh and a twelfth model.

**That is the binding constraint on criterion 12 now, and it should be said
plainly.** The bar asks for two unspent models that agree on all 40 gate
decisions and miss nothing in eight cases. Ten models have been spent across
four attempts and no attempt has come closer than 36/40. Each attempt costs two
models and buys one round of wording fixes, and the supply of comparable
top-tier models is finite. Either the next pair clears it or the bar's shape,
not the rubric's wording, is what needs the argument.

Criterion 12 of `docs/specs/spec-review-bus.md` stays `Open`. Both run
directories carry `countsTowardsShipBar: false`, set by
`calibrate.mjs finalize`, with the reason recorded there.

## Rubric 4, written after this pair and against it

The two misses above that were not the runner's are now answered, and the pair
that found them does not count towards the result.

**c2's G3.** Rubric 3's Fails list named a reason that is not the defect, a test
described only as passing, and a run with no stated expectation for the
unchanged side. c2's negative control is none of those: it states a reason, in
the right area. What it does is offer two of them, and name a check whose own
setup supplies what the pre-change failure is attributed to. Both are now Fails
items, with a paragraph beneath explaining them, and both were checked against
the six cases this key passes on G3 before the wording went in. The label did
not move.

**The anchor-row off-by-one.** A dimension's score is never higher than the
lowest anchor row its own findings describe; the outcome is never softer than
the findings, and the `reject` row is tested rather than left unasked; and the
old step 7 of the Review procedure splits so that reading the findings back
against both tables, and correcting step 6's numbers, is a step of its own.
c1's `D3` and c6's `D1` gain reasons in `expected.json` recording the
construction and all three sightings. Neither label moved.

**What this does to these two runs.** Both go stale again, which is the second
time, and `score.mjs` will keep printing `blobs: stale` for each with every case
line unchanged. That is rule 5 doing its job twice over: the verdicts are the
same files and the measurement they recorded still stands as taken, against a
rubric that has moved on.

**And what it does not do.** `shipBar.heldOut` is narrowed to a model whose
output moved the rubric's text, which would have returned both of these models
to the pool, since Rubric 3 was written before they ran. Rubric 4 spends them
again on the narrow rule too, because its two fixes answer their misses
directly. They may be re-run as a non-gating probe under
`shipBar.capabilityMatched`: the tightest test of these two fixes available, and
still not a pass. `shipBar.spent` stays at ten and Rubric 4's gating pair needs
an eleventh and a twelfth model.

## Rubric 4's probe: 38 of 40, the best yet, and it cannot count

`node spec-review/calibration/score.mjs runs/2026-10-20-r4-kiro-cli-claude-opus-4-7 runs/2026-10-20-r4-pi-us-anthropic-claude-opus-4-6-v1`

```
gate agreement: 38/40  (disagree: c1 G1, c3 G3)
cases with a miss: 8
runs that do not count: 2/2 - the ship bar asks for two that do
```

**Both models were spent before this ran, and the run is labelled a probe for
that reason.** `claude-opus-4.7` and `us.anthropic.claude-opus-4-6-v1` were
Rubric 3's first pair, and Rubric 4's two fixes answer that pair's misses, so
they are inside the tuning loop under `shipBar.heldOut`'s narrow reading as well
as its broad one. `shipBar.capabilityMatched` allows a non-gating probe, and the
reason to spend the compute was that the tightest test of a fix is the model that
committed the defect, asked again under the corrected instrument.

**38/40 is the best gate agreement the set has recorded** (34/40, then 36/40,
then 38/40), and it is still short: rule 3 asks for agreement on *every* gate
decision, which is 40. Eight run-cases miss against a bar of none. The number is
evidence and not progress towards the bar, because neither run could have
counted.

### What Rubric 4 was written for

| fix | run A | run B |
| --- | --- | --- |
| G3's two new Fails entries (c2) | **`G3 fail`** | **`G3 fail`** |
| the dimension ceiling (c1 `D3`) | **1, correct** | 2, wanted 1 |
| the outcome read-back (c1) | **`reject`, correct** | `revise`, wanted `reject` |

**The G3 fix landed in both runs, and that closes the set's second both-miss.**
No reviewing model had ever failed c2's G3. Both of these do, and the case's own
construction is what the new Fails entries describe: a reason given as two
alternatives, and a control whose setup supplies the condition its failure is
attributed to. That is the second time a change to the rubric's text has closed
a miss no model got right, after D1's feature column.

**The read-back rule is split, and a split is not a landing.** It corrected
c1's `D3` and outcome in run A and changed nothing in run B. One pair cannot
separate that from session variance, and the rule is not touched again here.

### Three things this probe found that Rubric 4 did not anticipate

**1. The ceiling does not carry across dimensions.** Both runs score c1's `D2`
at 3 with a `D2` finding that describes anchor 2 in words. Run A does it three
lines below a `D3` where the same rule *did* carry. So the off-by-one is not a
property of the two instances Rubric 4 was derived from: it reappears on a
dimension the set had never seen it on, under a rule written to stop it. That is
the most useful thing here, and it argues the rule's text is not carrying rather
than that c1 and c6 were special.

**2. c2's `G2` is a new both-miss, and the likely cause is this branch's own
harness fix.** c2's G2 fails on three claims credited to sources the spec never
names. Lint's notes cannot list those: they are prose attributions, not
unresolved paths or symbols. Handing a reviewer the notes and naming them step
3's input gives it a route to reading G2's reviewer half as the notes and nothing
more, and both runs took it. The fix that bought six gate disagreements has a
cost, and this is the first sight of it. It is recorded and not acted on: a
second pair under the same harness is what would tell a side effect from a
coincidence.

**3. c8's quote rule was penalising a correct finding, and that one is fixed.**
Both runs scored c8 `D1 2` correctly, with reasoning taken straight from Rubric
3's measurement precondition, and both were marked a miss on the quote alone.
Run A quoted `"## Problem"` - which is what the rubric's Findings section tells a
reviewer to do, since a finding about something missing quotes the nearest
heading, and what is missing from c8 is the Problem section's measurement.
`## Problem` was not in c8's `mustQuoteOneOf`. It is added, which follows from
the rubric as written and from how c8 was built, the standard
`shipBar.relabelling` sets. `cases with a miss` went from 9 to 8 on that one
edit, and both probe runs are now stale by blob, which is rule 5 again.

**Left open for the maintainer:** run B's c8 finding was also correct and quoted
a verbatim sentence from the same section that is not one of the four listed.
Widening the list to any sentence in the section would make the rule vacuous;
widening it to that sentence is tuning the key to a run. Not acted on.

### Where this leaves criterion 12

`shipBar.spent` is still **ten** - a probe spends nothing, because both models
were already spent. The gating pair still needs an **eleventh and a twelfth**.

What has changed is the shape of the argument. Of the misses still standing,
**c3's G3 and c1's G1 are the only two gate disagreements**, and both are cases
where one run reached a defect the other read as satisfied. The rest are
dimensions and outcomes, which the bar holds to thresholds rather than to
agreement. A pair that agrees on 38 of 40 gate decisions, meets
`shipBar.featureColumn`, and fails the bar on dimension thresholds in three
cases is a different kind of failure from 28 of 30 with four cases missed, and it
is worth saying which: **the gates are nearly stable and the dimension anchors
are not.** If the next pair reproduces that, the honest conclusion is that the
anchor tables need work the gates did not, and that the bar's demand for every
dimension threshold in both runs may be asking a 1-to-4 judgement to be
reproducible in a way gate decisions are.

Criterion 12 of `docs/specs/spec-review-bus.md` stays `Open`. Both probe
directories carry `countsTowardsShipBar: false`, set by `calibrate.mjs
finalize`, with the reason recorded there.
