# Calibration set for the spec-review rubric

Six specs with known answers. The rubric (`spec-review/rubric.md`) may only
merge, or change, when two independent reviewer runs over this set meet the ship
bar below. The set stays as a regression suite: every rubric edit re-runs it.

**Never give a reviewer this directory.** The answers are in `expected.json`,
and the cases are near-copies of each other, so a reviewer that can see more than
one case can diff its way to the mutation. A reviewer gets the rubric, the case
under review, `c2.md` when the case cites it (c2 is not a near-copy of the
others), and a checkout. Nothing else.

## The cases

The names are opaque on purpose: a reviewer that sees `c3.md` learns nothing.

| Case | What it is | Built to test |
| --- | --- | --- |
| c1 | mutant of c4 | D2, D3 and `reject`: a deliberate-looking change that overturns §5e.3 without superseding it, against the spec's own Goal |
| c2 | real spec (`dual-host-pi-gsd.md`) | that a strong diagnosis does not carry an open contract (G1) or an unevidenced criterion (G4) |
| c3 | mutant of c4 | G3: the test is still there, the fail-first step is not |
| c4 | real spec (`acp-print-mode-exit.md`), the exemplar, corrected by calibration | false fails: this one should pass |
| c5 | mutant of c4 | G2: a nonexistent commit and a misspelled symbol |
| c6 | mutant of c4 | D1: the causal chain replaced by a hedge, with the evidence left in place |

c2 and c4 are frozen copies of two specs that were untracked in the
maintainer's working copy on 2026-10-17. They are frozen so the answers cannot
drift: `test/spec-lint.test.ts` pins each case's sha256, so an edit to a case
fails CI until `expected.json` is updated on purpose.

Every case cites code as of commit `61bb96f`, so it is linted and reviewed
against that commit, not against `main`. c4 and the mutants cite
`docs/specs/dual-host-pi-gsd.md`, which in this set is `cases/c2.md`
(`expected.json` `aliases`).

## Running the deterministic half

```
node scripts/spec-lint.mjs --ref 61bb96f \
  --alias docs/specs/dual-host-pi-gsd.md=spec-review/calibration/cases/c2.md \
  spec-review/calibration/cases/c*.md
```

c3 must fail `[G3]`, c5 must fail `[G2]` naming both `6ea0517` and
`serveBridgeHTTP`, and the other four must pass. `npm test` runs the same check
(`test/spec-lint.test.ts`), so CI holds it.

## Running a reviewer pass

Calibration reviewers are **blind to lint** and review every case, including the
two lint fails. In production lint runs first and a lint failure is never
reviewed; here the point is to measure the reviewer half on its own.

For each case, in a **fresh session** (one case per session, never two):

```
git worktree add ../pk-cal 61bb96f
mkdir -p ../pk-cal-input
cp spec-review/rubric.md spec-review/calibration/cases/c2.md ../pk-cal-input/
cp spec-review/calibration/cases/c1.md ../pk-cal-input/spec.md
```

`c2.md` is copied for every case because the others cite it. Then give the
reviewer this prompt, working directory `../pk-cal`:

> Review the implementation spec in ../pk-cal-input/spec.md against the rubric in
> ../pk-cal-input/rubric.md, following its Review procedure, skipping step 1
> (lint). The repository is checked out at the commit the spec was written
> against. Where the spec cites `docs/specs/dual-host-pi-gsd.md`, read
> ../pk-cal-input/c2.md. Write only the verdict file described in the rubric,
> with the first line `spec-review verdict for spec.md blob <sha>`, where
> `<sha>` is `git hash-object ../pk-cal-input/spec.md`.

Save each verdict as `runs/<run-id>/<case>.verdict.md`, where `<run-id>` is
`<yyyy-mm-dd>-r<rubric>-<harness>-<model>`, and commit both runs with their score.

## Ship bar

From `expected.json` `shipBar`, in short:

1. **Two runs**, each a fresh session per case. They differ in session, and at
   least one differs from the other in harness or model.
2. **Every expectation met, in both runs**: the outcome, every gate label,
   every dimension threshold, and, where a case lists `mustQuoteOneOf`, a finding
   quoting one of those strings with the expected tag. A `revise` on c4 is a
   false fail and counts as a miss.
3. **Gate agreement**: the two runs agree on all 30 gate decisions (6 cases x
   5 gates). Dimensions are held to thresholds, not to agreement.
4. A disagreement or a miss means the rubric's wording is wrong. Fix the
   wording, bump `Rubric:` if the meaning changed, and re-run **both** passes.
   Never resolve it by choosing the run that agrees with the answer key.

## How the set was corrected

c4 was frozen from a real spec and labelled a pass by reading it. Eight
calibration passes on 2026-10-17 (one Claude and one GPT model per pass, both
harness `other`) showed that label was wrong: both runs failed c4, and agreed
with each other far more than with the key. Every finding below was checked
against the code at `61bb96f` before the cases changed, and each was applied to
c4 and its four mutants alike, leaving every mutation unchanged except c1's
(pass 4).

- **Pass 1.** A trace reason the code cannot emit (`teardownChild` aborts
  `childAbort` first, so the abort listener's `close("signal-abort")` is the one
  traced); pi host API and ordering with no versioned source; no plan step for
  `npm run verify` or the throwing-handler criterion; an out-of-scope line with
  no disposition. c2's G3 label was also wrong (`expected.json` `why`), and
  G2's wording was ambiguous about claims credited to an unnamed source: the
  rubric now says such a claim is a citation. That settled a meaning; it did not
  pick a run.
- **Pass 2.** After `session/new` is answered the child is unref'd while
  `startSession()` waits for kiro's MCP servers, and only the referenced bridge
  listener held the loop open through that wait. Unref'ing the listener, the
  fix itself, would expose it, so the exemplar now keeps the child referenced
  through the startup gate. Also: no plan step captured criterion 2's trace,
  criterion 1's bound was undecidable, and the list of `teardownChild` callers
  was incomplete.
- **Pass 3.** c4 passed in both runs; gate agreement 29/30. The causal bullet
  credited 6ea0510 with making the listener outlive a turn, but before it the
  bridge was session-scoped, and a one-shot run ends no session either. The
  criterion 4 test asserted a private function's call count rather than the
  registry and bridge state. c1's quote list accepted only the rewritten side
  of its contradiction; it now also accepts Goal 3.
- **Pass 4.** Gate agreement 29/30. Both runs scored c4's causal chain 3:
  it did not cite the commit that first mounted the bridge (2303d19, with
  d47b48e binding it to the session). One run found that the quit teardown
  step bought nothing it claimed: the orphan reaper's `exit` hook already
  SIGTERMs every child on an orderly exit. Checking that turned up a real
  hazard: pi reuses one module per cwd across sessions, and pi-subagents emits
  `session_shutdown` with `reason: "quit"` for each subagent it disposes, so the
  registry-wide teardown would kill the parent's child mid-turn. The step is
  now out of scope with that evidence. c1 mutated that step, so it was rebuilt
  on the same contradiction (Goal 3 and §5e.3): it now closes the bridge after
  every turn.
- **Pass 5.** c4 passed in both runs; gate agreement 29/30. One run held c4's
  causal chain at 3: before d47b48e the bridge rode the per-turn signal, and
  the 0.2.0 live check exited cleanly. pi never aborts that signal when a run
  completes, and the 0.2.0 check ran with a clean agent home, so no bridge
  was mounted; c4 now says both. Both runs rejected c1 with D3 1: closing the
  bridge every turn overturns §5e.3 without superseding it, which is the
  rubric's own `reject` row, so the label was wrong, not the runs. The one
  gate split (G1 on c1) was the mutation leaving the remount path open; it now
  states it.
- **Pass 6.** Every case met its expectations in one run and five in the
  other; gate agreement 29/30. The split was G2 on c1: one run read the
  mutation's remount step as a claim about the code at the ref, not a proposed
  change. It now says it adds the call. The wording was the defect.
- **Pass 7.** Gate agreement 28/30, two splits, both wording. c1 G1: the
  mutation still left open how kiro learns the new URL on a resumed turn; it
  now removes the resume branch, so every turn sends `session/new`. c2 G5: two
  out-of-scope items give a reason and no disposition, the defect pass 1 fixed
  in c4. G5 now says a reason alone is not a disposition, and c2 G5 is `fail`.
- **Pass 8.** Gate agreement 30/30. Both runs failed c1 on G1 with the same
  evidence: `useResume` is computed before `resolveSession()` and still picks
  the delta prompt, so a session reset every turn sends a delta to an empty
  session. Checked at `61bb96f`, that is right: a per-turn bridge cannot be
  given a closed contract without rewriting turn planning, so c1 G1 is `fail`.
  With that label both runs meet every expectation.

The verdicts of passes that graded superseded cases are not kept.

## Known limits of Rubric 1's set

- **All six are defect specs.** No feature spec is calibrated, so the feature
  column of D1 is untested. `docs/specs/spec-review-bus.md` is the first feature
  spec; Rubric 2 should add one feature case and a mutant of it.
- **Five of six derive from one exemplar** (c4 and its four mutants). The set can teach a rubric to grade
  that spec's shape well. Add real specs as they are reviewed.
- **The c2 labels are judgement, not construction.** A mutant's answer follows
  from the edit that made it; c2's follows from reading it. The maintainer
  ratifies them before the first run counts (`expected.json` `labelledBy`).
