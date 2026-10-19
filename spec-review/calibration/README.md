# Calibration set for the spec-review rubric

Eight specs with known answers. The rubric (`spec-review/rubric.md`) may only
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
>
> **Rubric 2's first pair ran, missed, and Rubric 3 is what those misses bought.**
> The pair was `kiro-cli` on `gpt-5.6-terra` and `pi` on
> `us.anthropic.claude-opus-5`: sixteen clean sessions, blobs matching, and
> **seven run-cases missed across five cases**. The miss that mattered was not a
> gate's wording: **neither run read D1's feature column**, scoring c7 and c8
> alike, which fails `shipBar.featureColumn`. Rubric 3 answers that and three
> smaller items ("Rubric 3", below). It also stales that pair by blob, on purpose,
> so **Rubric 3 has no run at all** and seven run directories all record
> `countsTowardsShipBar: false`. See "Rubric 2's first pair" below and
> `runs/SCORE.md`.

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
| c7 | feature spec written for the set (R8 and R9 of `docs/design/v3-engine.md`), at ref `68ffb40` | false fails on a **feature** spec: this one should pass, and its Problem is measured |
| c8 | mutant of c7, at ref `68ffb40` | D1's feature column: the same Problem with every measurement replaced by an assertion |

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

c1 to c6 cite code as of commit `61bb96f`, so they are linted and reviewed
against that commit, not against `main`. c4 and its mutants cite
`docs/specs/dual-host-pi-gsd.md`, which in this set is `cases/c2.md`
(`expected.json` `aliases`). c7 and c8 cite `docs/design/v3-engine.md`, which
`61bb96f` predates, so they carry their own ref, `68ffb40` (`expected.json`
`cases.<name>.ref`): the last commit on `main` before this set merged, so a
clone checked out there cannot reach the key either. A case with no `ref` uses
the set's.

## Running the deterministic half

```
node scripts/spec-lint.mjs --ref 61bb96f \
  --alias docs/specs/dual-host-pi-gsd.md=spec-review/calibration/cases/c2.md \
  spec-review/calibration/cases/c[1-6].md
node scripts/spec-lint.mjs --ref 68ffb40 spec-review/calibration/cases/c[78].md
```

c3 must fail `[G3]`, c5 must fail `[G2]` naming both `6ea0517` and
`serveBridgeHTTP`, and the other six must pass. `npm test` runs the same check
(`test/spec-lint.test.ts`), so CI holds it.

## Running a reviewer pass

Calibration reviewers are **blind to lint** and review every case, including the
two lint fails. In production lint runs first and a lint failure is never
reviewed; here the point is to measure the reviewer half on its own.

For each case, in a **fresh session** (one case per session, never two), from a
clone that has never held the key:

```
git clone --no-local --no-checkout . ../pk-cal && cd ../pk-cal
git checkout --detach 61bb96f    # 68ffb40 for c7 and c8, in a clone of its own
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

`c2.md` is copied for c1 to c6, because c4 and its mutants cite it; c7 and c8
cite nothing outside their clone, so their input directory holds only the
rubric and `spec.md`, and the prompt drops its `c2.md` sentence. Give the verdict
path explicitly, so parallel sessions cannot overwrite each other. Then give the
reviewer this prompt, working directory `../pk-cal`:

> Review the implementation spec in ../pk-cal-input/spec.md against the rubric in
> ../pk-cal-input/rubric.md, following its Review procedure, skipping step 1
> (lint). The repository is checked out at the commit the spec was written
> against. Where the spec cites `docs/specs/dual-host-pi-gsd.md`, read
> ../pk-cal-input/c2.md. Write only the verdict file described in the rubric,
> with the first line `spec-review verdict for spec.md blob <sha>`, where
> `<sha>` is `git hash-object ../pk-cal-input/spec.md`, and with the line
> `Reviewer: <harness>, <model>` copied exactly.

Before sending it, replace `<harness>, <model>` in the prompt with the harness
and the model id the session was launched with, the same values `RUN.json`
records. The rubric makes the runner responsible for that line, because a model
cannot see its own model id (Rubric 1's runs show what happens otherwise). After
the session, check that the verdict's line is the one given; a verdict whose
line differs is corrected from `RUN.json` and the correction noted in
`NOTES.md`.

### The runner

`node scripts/calibrate.mjs run --harness <harness> --model <id>` does all of
the above for one pass: the clones, the ref strip, the leak check, an input
directory and a prompt per case, the sessions, the verdict checks, the isolation
audit and `RUN.json`. `--dry-run` stops after the clones and the prompts and
before the first session, which is how to read what a session will be sent;
`--cases c3,c7` re-runs part of a pass; `--jobs` sets how many sessions run at
once. Two passes are two invocations, which is also what keeps them in separate
processes. `test/calibrate.test.ts` holds its checks, each against a case it has
to catch.

Writing it down closed two gaps in the protocol above:

- **A clone keeps its `origin`.** Deleting every ref does not stop
  `git fetch origin`, and `origin` here is the repository that holds the key. The
  runner removes the remote. Every clone made by hand before this was one fetch
  from the answers, and no isolation audit would have shown it, because no
  session fetched.
- **One clone shared by every session of a pass.** The sessions of a pass run at
  the same time, and a reviewer that writes into its working directory
  (`kiro-cli` rewrites `.kiro/agents/*.json`) leaves traces the next session can
  read. The runner copies the ref-stripped clone once per case and leak-checks
  each copy.
- **The harness brings its own tools.** A clone a reviewer cannot read the key
  from is not isolation if the session can search somewhere else. `kiro-cli`'s
  default agent on the maintainer's machine is `amzn-builder`, which carries MCP
  servers, and the first attempt at the Rubric 2 pass had
  `@builder-mcp/WorkspaceSearch` run inside a reviewer session. That attempt was
  killed and the pass re-run; nothing from it was read beyond the tool log, and
  no verdict it produced was kept or scored. The runner now writes a workspace
  agent declaring no MCP server into each `kiro-cli` session's own copy and names
  it on the command line, and gives `pi` the flags that keep this machine's
  extensions, skills, prompt templates and MCP servers out of the session: one of
  those extensions injects guidance into every turn.

Two things it deliberately does not do: decide whether a pass met the bar, and
set `countsTowardsShipBar`. It writes that field `false`, with a `whyNot` saying
the pass has not been scored, and a human who has read `score.mjs` flips it with
`calibrate.mjs finalize <run-dir> --counts true --why "<reason>"`. A runner that
graded its own pass would be pass 8's defect with a script behind it.

Save each verdict as `runs/<run-id>/<case>.verdict.md`, where `<run-id>` is
`<yyyy-mm-dd>-r<rubric>-<harness>-<model>`. `<harness>` and `<model>` are the
public names: this repository is public, so name a publicly available harness and
model, or write the harness `other`. Where a model is reachable under both an
internal alias and a public one, record the public identifier. Each run directory
also carries `RUN.json` with the blobs it was scored against (ship bar rule 5),
and its `scoredAgainst.cases` must list every case in the set: `score.mjs`
scores a run on the cases listed there, names any case missing from it, and
exits 1 if one is. Commit both runs with their score.

## Ship bar

From `expected.json` `shipBar`, in short:

1. **Two runs**, each a fresh session per case. They differ in session, and at
   least one differs from the other in harness or model.
2. **Every expectation met, in both runs**: the outcome, every gate label,
   every dimension threshold, and, where a case lists `mustQuoteOneOf`, a finding
   quoting one of those strings with the expected tag. A `revise` on c4 is a
   false fail and counts as a miss. Those strings are matched as substrings, so
   **none of them ends in sentence punctuation**: Rubric 2's pair cost a correct
   finding a miss on a single full stop (`shipBar.quoteMatching`,
   `test/calibration-ship-bar.test.ts`).
3. **Gate agreement**: the two runs agree on every gate decision, 40 since
   Rubric 2 (8 cases x 5 gates; 30 before c7 and c8). Dimensions are held to
   thresholds, not to agreement.
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
   those match the committed blobs. **All seven runs here are visibly stale**
   rather than plausibly current: five record Rubric 1's blobs, and Rubric 3's
   wording fixes staled the two that recorded Rubric 2's. That is the mechanism
   working, and it is the standing cost of a fix - see rule 4.
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
8. **Both runs separate c7 from c8 on D1**, c7 at 3 or more and c8 at 2 or less
   (`shipBar.featureColumn`). Rule 2 already asks this of each run; it is a rule
   of its own because rule 3 cannot see it - c7 and c8 are `pass` on all five
   gates, so the pair added ten gate decisions and no fail, and the feature
   column is the only thing it discriminates. **This is the rule no reviewing
   model has yet satisfied**, and it is numbered last only so rules 4 to 7 keep
   the numbers the rest of this repository cites.

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
| c2 G3 and G4 `pass`, key `fail` | both are c2 labels set by reading the spec rather than by an edit to it | left as they stand, and ratified as `fail` on 2026-10-19: this run's findings were on D2, D3 and D5, so it argued against neither label (`expected.json` `labelledBy`) |

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

## Rubric 2

Rubric 2 changes four gates and one field, each for a miss or a key reason
above, and nothing else. It was drafted by `claude-opus-5-5`, which was already excluded. The answer
key's labels did not move: every case scores the same gates the same way as
under Rubric 1, and what changed is the text a reviewer reads to reach them.

| change | for | what it says now |
| --- | --- | --- |
| G1 gains an **Also fails, with no choice offered** bullet, a **Not G1** bullet, and a line saying the list is the gate | c1 G1, both runs of the pair | every part of the opening sentence (trigger, each named case, errors, depended-on names) now has a bullet, and none needs the spec to offer a choice; a decided but unargued behaviour is D2, a contradiction D3 |
| G2's example names instead of conditioning on existence | c2 G2's reason | an unnamed source fails on being unnamed, whether or not a similar document exists, and a reviewer does not repair the citation |
| G4 splits **behaviour** and **documentation** criteria and says which sentence governs each | c3 G4 against c4 G4 on identical text | a documentation criterion needs the file named and its required content stated, and no Verification plan step |
| G5 says what the words "dropped", "unchanged" and "no follow-up" do, and that a descriptive word is a reason | c2 G5's reason, which counted an "unchanged" item as having no disposition | each of the three words is a disposition on its own, so c3 to c6's "No follow-up" item still passes; a word describing the item ("not needed") is a reason beside one, not a disposition |
| `Reviewer:` is written by the runner | the pair's six self-reported model ids | the runner gives the line or writes it; an unknown reviewer is `unknown, unknown`. The spec's `## Attribution` line has the same limit and the same rule |

It also adds two cases, c7 and c8 ("The feature cases", below). Two reasons in
`expected.json` were corrected with the wording, and no label: c2 G2 now
fails on three unnamed sources rather than one, and c2 G5 on the transport item
alone. c1's G1 reason now argues the label from the mutation and the code at
`61bb96f` (`useResume` is decided before `resolveSession()` runs and still
selects the delta prompt), which is what `shipBar.relabelling` asks of a label
that a run has questioned. c4, which had only a D5 reason, gained G1, G4 and G5
reasons arguing its pass labels under Rubric 2's wider G1, its G4 split and its
G5 wording, and they cover c3, c5 and c6 where the text is shared. `shipBar.heldOut` names every spent model, and
`shipBar.spent` lists them for a script to read.

The two runs that measure Rubric 2 must come from models outside that list, and
they spend two more. They have now run: "Rubric 2's first pair", below.

## The feature cases

Rubric 2 adds c7 and c8, the set's first feature-typed pair, so D1's feature
column has an expectation for the first time. c7 is not a copy of an existing
spec: `docs/specs/spec-review-bus.md` was the only feature spec in the repository,
and it describes this calibration set, so a reviewer given it would be reading
about the answer key. c7 instead takes two requirements of the v3 engine design
(R8 and R9 of `docs/design/v3-engine.md`) that no spike blocks, and writes them
up as a small, buildable spec with its Problem measured at `68ffb40`: the reader
driven with the design doc's recorded v3 payloads, and a `jq` count over every
committed v2 capture. Both measurements were re-run before the case was frozen
and reproduce.

c8 removes exactly those measurements and states the same findings as
assertions. Everything else, including the gaps' ties to code, is unchanged, so
the pair differs only in what D1's feature anchors 2 and 3 separate.

c7's labels are judgement, as c4's were when it was frozen, and c4 needed eight
passes to become a passing exemplar. A first pass that fails c7 is evidence
about c7 before it is evidence about the rubric, and is checked against the
code at `68ffb40` the way c4's corrections were.

## Rubric 2's first pair, and what it measured

Two runs, by the runner above, against Rubric 2 exactly as it stood when they
ran. **Rubric 3 has since staled them both by blob**, which is rule 5 doing its
job; every case line and both totals are unchanged, because the verdicts are the
same files. Harnesses and models: `kiro-cli` 2.32.0 on `gpt-5.6-terra` and `pi` 1.3.0 on
`us.anthropic.claude-opus-5` (Bedrock, us-west-2). Sixteen sessions, all exited
0, all sixteen header blobs match, the isolation audit is clean for every one,
and both runs record blobs that match the committed files. **Seven run-cases
miss, across five cases, and the bar is not met.** Full output, diagnosis and
the decisions that follow: `runs/SCORE.md`; protocol per run: each run's
`NOTES.md`.

| result | which rule it bears on |
| --- | --- |
| **Both runs scored c7 and c8 at `D1 4`** | `shipBar.featureColumn`, failed by the pair. The pair's whole purpose is this column, and on its first outing neither reviewer read it. **No reviewing model got this right, and no rewording of a gate changes it**, which makes it the first item of Rubric 3. |
| Run B failed c1's G1, deriving the key's mechanism from the code at `61bb96f` | `shipBar.relabelling`, satisfied. The Rubric 1 pair left c1's `G1 fail` open because two runs disputed it and a label may not move because a run said so. It is now re-derived from the construction, so **the label stays**. Three of four models still reach the defect and file it as `D2` or `D3`, so G1's `Fails` list is the fix. |
| Run A failed c6's G5 on `Follow-up spec, owner: the maintainer` | A **new** G5 wording question, the third round running: G5 asks for "a named spec, issue or owner" and then says it judges the sentence rather than the citation, which settles existence and is silent on whether a role names an owner. |
| Run B's c6 quoted the key's `mustQuoteOneOf` sentence without its full stop | A defect in the key, not the verdict. The matcher is a substring test, so one character turned a correct finding into a `MISS`. Drop terminal punctuation from those strings. |
| c2's G2 (run A) and c3's G3 (run B), each missed by one run and caught by the other | Reviewer variance with no shared reading to fix. Run A filed ten findings on c2 and none on a source; run B passed all five of c3's gates and missed the removed fail-first step. |

**c7's judgement labels held.** Both runs passed c7 on all five gates and scored
it `D1 4`, and both passed all five of c8's gates, which is what the key says. So
the open question about c7 ("A first pass that fails c7 is evidence about c7",
above) is answered: the gates are confirmed by two models in two harnesses, and
the single label neither confirmed is c8's `D1 <=2`.

Neither `expected.json` nor the rubric was edited for this result, for the reason
the last round gives: an edit changes a blob and stales the runs keyed to it.
`gpt-5.6-terra` and `us.anthropic.claude-opus-5` are spent all the same, bringing
the count to eight, and they join `shipBar.spent` in the same commit as the
wording fixes.

## Rubric 3

Rubric 3 answers the four items Rubric 2's pair produced, and nothing else. **No
answer-key label moved**, in any case, on any gate or dimension: every change is
to the text a reviewer reads, or to one key string's punctuation.

| change | for | what it says now |
| --- | --- | --- |
| **D1 gains a precondition paragraph beside its table**, and the Review procedure gains a step that lists the Problem's evidence | c8's `D1 4` in **both** runs (`shipBar.featureColumn`) | measurement is a precondition of a feature 3 or 4, not one of several credits; tying each gap to its code is the rest of row 4 and carries no score alone; **the evidence the spec presents is scored, not whether its conclusions turn out to be true**; and an empty evidence list caps D1 at 2 before the rest of the spec is read |
| **G1's `Not G1` bullet says that finding the D2 or the D3 does not answer G1**, and the Review procedure gains a step that lists the cases the spec names | c1's `G1 pass` in run A, and in both runs of the previous pair | the two questions are asked of different things - D2 and D3 about the behaviour the spec chose, G1 about the cases it left without one - and they arrive together, because a change that overturns a decision usually leaves the path that decision protected undecided |
| **G5 says an owner may be a person, a role or a team** | c6's `G5 fail` in run A | the gate asks that an item name where it goes, not that the destination be an individual; how specific the name is is not G5's question, and what fails is an item naming no destination of any kind |
| **No `mustQuoteOneOf` string ends in sentence punctuation** (`shipBar.quoteMatching`) | c6's quote miss in run B | the matcher is a plain substring test, so a key string carrying the sentence's full stop asks for a character the reviewer has no reason to copy. Six strings lost one, five in c1 and one in c6; the text quoted is unchanged |

The first two are the ones worth reading twice, because they are the same shape:
**a reviewer that found the defect scored it in the wrong place.** Run A found
c1's contradiction and filed it as `D3`; both runs read c8's Problem, checked its
claims against the checkout, found them true and scored `D1 4`. Neither is a
reviewer failing to understand the spec. Both are a reviewer answering a question
the rubric did not quite ask, so both fixes are a listing step in the procedure
rather than another sentence in a gate: the gate text had the right meaning and
no place in the reviewer's workflow that forced the question.

**`Rubric:` is bumped to 3** because G5's meaning changes (a role is now
explicitly a disposition) and D1's feature anchors are now read with a
precondition in front of them. The two procedure steps and the punctuation fix
would not have bumped it on their own.

`gpt-5.6-terra` and `us.anthropic.claude-opus-5` join `shipBar.spent` in the same
commit, bringing it to eight, and `shipBar.heldOut` says why. Rubric 3 was
drafted by `us.anthropic.claude-opus-5`, which its own run had already spent, so
the draft excludes nothing that was not already excluded. **The next pair needs a
ninth and a tenth model**, and this is the cost `shipBar.heldOut` exists to make
visible.

## Known limits of the set

- **Two feature cases against six defect cases.** c7 and c8 calibrate D1's
  feature column on one spec's shape.
- **Six of eight derive from two exemplars** (c4 and its four mutants, c7 and
  its one). The set can teach a rubric to grade those shapes well. Add real
  specs as they are reviewed.
- **The c2 and c7 labels are judgement, not construction.** A mutant's answer
  follows from the edit that made it; c2's and c7's follow from reading them.
  They were ratified on 2026-10-19 with none changed (`expected.json`
  `labelledBy`); the held-out run had put c2's G3 and G4 in question, but its
  findings were on D2, D3 and D5, so it argued against neither. Ratification
  records who stands behind a label, not that it was derived.
- **The eligible model pool is shrinking.** Every pass spends its models: six
  are now excluded, all named in `expected.json` `shipBar.heldOut` since
  Rubric 2. A set that can only be
  validated by models it has never seen is a set that gets harder to validate
  each time it is corrected. Rubric 2 adds c7 and c8 rather than re-tuning the
  original six, so that a model's exclusion costs less.
- **Rubric 1 asked the reviewer for a field it cannot know.** A verdict's
  `Reviewer: <harness>, <model>` line was self-reported, and the six sessions of
  one run guessed their own model six different ways, once naming a model that
  was not used. Rubric 2 has the runner write it. The line is still only as
  honest as the runner, and `RUN.json` stays the record to trust.
