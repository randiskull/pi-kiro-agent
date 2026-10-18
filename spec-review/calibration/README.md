# Calibration set for the spec-review rubric

Six specs with known answers. The rubric (`spec-review/rubric.md`) may only
merge, or change, when two independent reviewer runs over this set meet the ship
bar below. The set stays as a regression suite: every rubric edit re-runs it.

> **The ship bar is not met, and the earlier 30/30 is withdrawn.** Pass 8
> reported agreement on all 30 gate decisions. That number was produced by
> relabelling the answer key to match what those two runs said and then scoring
> the same two runs against the new key, with nothing re-run; see "How the set
> was corrected", pass 8, and `runs/SCORE.md`. Three later runs, each held out
> from every pass and scored against the key as it stood, each missed cases: one
> missed three of six, and a fresh pair run after the review fixes missed four
> of twelve between them. Five run directories are committed and all five record
> `countsTowardsShipBar: false`. Rubric 1 still has no passing result. The bus
> spec merged with its criterion 12 open, by maintainer decision: the four
> misses are rubric-wording defects, they are listed in issue 67, and they are
> deferred to Rubric 2.

**Never give a reviewer this directory, and never give one a worktree of this
branch.** The answers are in `expected.json`, and the cases are near-copies of
each other, so a reviewer that can see more than one case can diff its way to the
mutation. `git worktree add` shares the object database and the refs, so from a
worktree the key is one `git show <branch>:spec-review/calibration/expected.json`
away: a worktree is not isolation. Use `git clone --no-local`, strip the refs, and
check that the key's blob is absent. A reviewer gets the rubric, the case under
review, `c2.md` when the case cites it (c2 is not a near-copy of the others), and
that clone. Nothing else.

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
maintainer's working copy on 2026-10-17. Both originals are now committed under
`originals/`, with their sha256 and the one edit made on the way in, so a
reviewer can check a case against the text it came from; they are kept out of
`docs/specs/` because a spec committed there is a live spec that enters the queue
and ships in the tarball, and these two are a known-defective pair. The cases are
frozen so the answers cannot drift: `test/spec-lint.test.ts` pins each case's
sha256, so an edit to a case fails CI until `expected.json` is updated on purpose.
`c2.md` is byte-identical to `originals/dual-host-pi-gsd.md`; `c4.md` is the
original corrected over eight passes, and the diff between them is that audit
trail.

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

For each case, in a **fresh session** (one case per session, never two), from a
clone that has never held the key:

```
git clone --no-local --no-checkout . ../pk-cal && cd ../pk-cal
git checkout --detach 61bb96f
git for-each-ref --format='%(refname)' | xargs -r -n1 git update-ref -d
git reflog expire --expire=now --all && git gc --prune=now
git cat-file -e <expected.json blob> && echo "LEAK: the key is reachable" && exit 1
```

The last line is the check, not a comment: if that blob resolves, the clone can
read the answers and the run is void. Then, per case, an input directory outside
the repository and under a name that says nothing about the case:

```
in=$(mktemp -d)
cp spec-review/rubric.md spec-review/calibration/cases/c2.md "$in"/
cp spec-review/calibration/cases/c1.md "$in"/spec.md
```

`c2.md` is copied for every case because the others cite it. Give the verdict
path explicitly, so parallel sessions cannot overwrite each other. Then give the
reviewer this prompt, working directory `../pk-cal`:

> Review the implementation spec in ../pk-cal-input/spec.md against the rubric in
> ../pk-cal-input/rubric.md, following its Review procedure, skipping step 1
> (lint). The repository is checked out at the commit the spec was written
> against. Where the spec cites `docs/specs/dual-host-pi-gsd.md`, read
> ../pk-cal-input/c2.md. Write only the verdict file described in the rubric,
> with the first line `spec-review verdict for spec.md blob <sha>`, where
> `<sha>` is `git hash-object ../pk-cal-input/spec.md`.

Save each verdict as `runs/<run-id>/<case>.verdict.md`, where `<run-id>` is
`<yyyy-mm-dd>-r<rubric>-<harness>-<model>`. `<harness>` and `<model>` are the
public names: this repository is public, so name a publicly available harness and
model, or write the harness `other`. Where a model is reachable under both an
internal alias and a public one, record the public identifier. Each run directory
also carries `RUN.json` with the blobs it was scored against (ship bar rule 5).
Commit both runs with their score.

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
   wording, bump `Rubric:` if the meaning changed (from this file's first merge
   onwards), and re-run **both** passes. Never resolve it by choosing the run
   that agrees with the answer key.

   The answer key may be **relabelled** only when the new label follows from how
   the case was built - the mutation applied, or the frozen text, checked against
   the code at the ref - and never because a run said so. A relabel re-runs both
   passes, and the runs that prompted it do not count towards the new key. This
   is the clause pass 8 was missing, and breaking it is why its result is
   withdrawn.
5. **Runs are keyed to blobs, not to the `Rubric:` number.** A wording fix that
   keeps the meaning does not bump the number, yet every edit re-runs the set, so
   a check on the number would let those edits through with stale runs. Each run
   directory's `RUN.json` records the git blob of `rubric.md`, of `expected.json`
   and of each case as they stood when it was scored, and a run counts only when
   those match the committed blobs. The three runs here all record
   pre-review blobs, so all three are visibly stale rather than plausibly current.
6. **The two runs are at a comparable capability level.** The bar measures
   agreement between them, so a strong-plus-weak pair cannot tell an ambiguous
   rubric from a reviewer that could not do the task, which is the distinction
   rule 4 rests on. A deliberately cheap model may be run as a **non-gating
   robustness probe** and recorded in that run's `NOTES.md`; it is evidence that
   the wording is followable, never one of the two runs, and it never amends the
   rubric on its own.
7. **Neither run may be in the tuning loop.** A model that took part in a pass,
   or in a wording fix made in response to one, is excluded
   (`expected.json` `shipBar.heldOut`).

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
- **Pass 8.** Gate agreement 30/30, and **this result is withdrawn.** Both runs
  failed c1 on G1 with the same evidence: `useResume` is computed before
  `resolveSession()` and still picks the delta prompt, so a session reset every
  turn sends a delta to an empty session. Checked at `61bb96f`, that is right on
  the merits: a per-turn bridge cannot be given a closed contract without
  rewriting turn planning, so `fail` is the label the construction supports, and
  c1's `mutation` text in `expected.json` now says so instead of claiming the
  contract is closed. What is not sound is the procedure. The key was relabelled
  because both runs failed that gate, and then the same two runs were declared to
  meet the new key with nothing re-run. Rule 4 forbids exactly that, and it had
  no clause covering a relabel, which is the hole it was tripped through. The
  honest reading of pass 8 is that it measured two runs against a key fitted to
  them, so its 30/30 is not evidence about the rubric. Both run directories are
  kept, as history and as the record of the defect, with
  `countsTowardsShipBar: false` in their `RUN.json`.

The verdicts of passes that graded superseded cases are not kept. Passes 1 to 7
therefore cannot be re-scored; only pass 8's verdicts survive, and they are the
ones withdrawn above.

## The held-out run, and what it measured

After pass 8 was scored, one run was made by a harness and model that took no
part in passes 1 to 8 (kiro-cli 2.32.0, `claude-sonnet-5`), against the rubric,
the cases and the key exactly as pass 8 left them, from a clone that could not
reach the key. It missed three of six cases and agreed with either pass-8 run on
27 of 30 gate decisions (`runs/2026-10-17-r1-kiro-cli-claude-sonnet-5/NOTES.md`).

| miss | what it showed | what changed |
| --- | --- | --- |
| c1 outcome `revise`, key `reject` | the reviewer applied "any failed gate makes the outcome `revise`" literally; the key's `reject` comes from a row that overlaps it with no precedence rule | the rubric now states that `reject` outranks `revise`, and that a `reject` on a spec with a failed gate is a valid verdict |
| c5 G5 `fail`, key `pass` | it could not resolve the sibling spec an out-of-scope item names, raised that under G2, and failed G5 on the same citation - one citation counted against two gates | G5 now judges the sentence and not the citation: a named target that does not resolve is a G2 finding |
| c2 G3 and G4 `pass`, key `fail` | both are c2 labels set by reading the spec rather than by an edit to it, and both are still awaiting ratification | left as they stand; recorded in `expected.json` `labelledBy` as open for the maintainer |

Two of the three were wording defects, which is rule 4 working as intended. The
cost is that `claude-sonnet-5` is now in the tuning loop and cannot be one of the
two passes that meet the bar.

## The pair run after the review fixes, and what it measured

Two more runs were made once the review-item fixes landed, against the rubric,
the cases and the key as commit `f64d2eb` left them, by two models that took
part in no earlier pass and in no wording fix: `gsd` 1.22.0 on
`us.anthropic.claude-fable-5-1` and `kiro-cli` 2.32.0 on `gpt-5.6-sol`. Twelve
sessions, each in its own directory off one ref-stripped clone, all twelve
exiting 0 with header blobs matching their case, and an isolation audit that
came back clean. They agreed with each other on 28 of 30 gate decisions and
**four of the twelve cases carry a miss**, so the bar is not met. Nothing was
changed after the verdicts were collected; `runs/SCORE.md` has the numbers and
each run's `NOTES.md` has its protocol and deviations.

| miss | what it showed | what it calls for |
| --- | --- | --- |
| c1 G1 `pass`, key `fail`, in **both** runs | both reviewers found c1's defect and filed it as `D3` (the Approach contradicts Goal 3, criterion 4 and the out-of-scope line) and `D2` (the safety argument never reaches a second bridged turn). Neither read it as an open contract. G1's opening sentence reaches the key's reading; G1's `Fails` list does not, because every bullet there describes a spec that offers a choice and c1 offers none | rule 4's relabelling clause forbids changing the label because two runs said so. Either c1's `G1 fail` is re-derived from the construction, or G1 is reworded to separate "open contract" from "decided but unargued". Open |
| c3 G4 `fail`, key `pass` | the same run passed c4's G4 and failed c3's on byte-identical text: c3 is a mutant of c4 touching only the negative control and one phrase, and criterion 6 and the verification step the finding quotes are the same in both. This reproduces the "one run decided identical text both ways" defect on a fresh model | G4 says both "at least one Verification plan step produces that evidence" and "A documentation criterion's evidence is the named file" without saying which governs a documentation criterion. Open |
| c2 G5 `pass`, key `fail` | reviewer variance, not wording: that run raised no out-of-scope finding at all, while the other run under the same rubric text failed G5 and cited the transport item | nothing in the rubric. But the key's c2 G5 reason names two items and one of them does state a listed disposition, so the reason overstates while the verdict holds |

Both runs got c1's `outcome: reject` right, where the `claude-sonnet-5` run did
not, so the precedence fix is confirmed. Both passed c5 G5, so the G5 rewrite is
confirmed. Both also failed c2 G2 on the unnamed "repo engineering rule", one of
them after reading the file the key's corrected reason points at, which says the
corrected reason reads G2 too narrowly: the gate asks that a source be named
precisely enough to open, so an unnamed source fails whether or not something
matching it exists, and G2's example should stop conditioning on existence.

The cost: `us.anthropic.claude-fable-5-1` and `gpt-5.6-sol` are now spent too,
and the fixes above will spend the next pair. Neither the rubric nor the key was
edited to record that, on purpose: any edit to `expected.json` changes its blob
and stales the two runs keyed to it, so `shipBar.heldOut` is brought up to date
in the same commit as the wording fixes, and both are measured by the pair after
that.

## Known limits of Rubric 1's set

- **All six are defect specs.** No feature spec is calibrated, so the feature
  column of D1 is untested. `docs/specs/spec-review-bus.md` is the first feature
  spec; Rubric 2 should add one feature case and a mutant of it.
- **Five of six derive from one exemplar** (c4 and its four mutants). The set can teach a rubric to grade
  that spec's shape well. Add real specs as they are reviewed.
- **The c2 labels are judgement, not construction.** A mutant's answer follows
  from the edit that made it; c2's follows from reading it. The maintainer
  ratifies them before the first run counts (`expected.json` `labelledBy`), and
  the held-out run put G3 and G4 specifically in question.
- **The eligible model pool is shrinking.** Every pass spends its models: six
  are now excluded. `expected.json` `shipBar.heldOut` still names the first
  four, because adding the newest two would change that file's blob and stale
  the two runs keyed to it; it is updated in the same commit as the rubric fixes
  those runs call for. A set that can only be
  validated by models it has never seen is a set that gets harder to validate
  each time it is corrected. Rubric 2 should add cases rather than keep
  re-tuning these six, so that a model's exclusion costs less.
- **The rubric asks the reviewer for a field it cannot know.** A verdict's
  `Reviewer: <harness>, <model>` line is self-reported, and the six sessions of
  one run guessed their own model six different ways, once naming a model that
  was not used. `RUN.json` is the record to trust; Rubric 2 should have the
  harness write that line or drop it.
