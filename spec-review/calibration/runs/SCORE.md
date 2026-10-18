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
pair of judgement labels awaiting the maintainer's ratification and was left
alone (`expected.json` `labelledBy`).

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
rather than plausible. The two newest record the current blobs and are not
stale - they simply miss, four cases between them.

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
