# Spec review rubric

Rubric: 4

This is the bar an implementation spec in `docs/specs/` must clear before anyone
builds it. It is written for a reviewer that is not the author: a teammate
following it by hand, or an agent in any harness given this file, the spec and a
checkout. The design behind it is `docs/specs/spec-review-bus.md`.

A review has two halves, run in this order:

1. **Lint** (`node scripts/spec-lint.mjs <spec>`). Deterministic: structure, spec
   type, attribution, the resolvable half of G2, and the presence half of G3. A
   spec that fails lint is not reviewed; its state is `lint-fail` until the
   author fixes it.
2. **Review**. A reviewer applies the five gates and scores the six dimensions
   below, then writes a verdict file.

The anchors below are written without quoting any calibration case, so a case
cannot be graded by recognising its text. `test/rubric-anchors.test.ts` holds
that: every quoted example of three or more words in this file is grepped
against `spec-review/calibration/cases/*.md`, and a match fails. Section
headings and the negative-control bullet are exempt, because this rubric
requires them of every spec and lint checks for them.

## Spec types

The type is decided by the sections present, never declared:

| Type | Required sections | What D1 grades |
| --- | --- | --- |
| **defect** | `## Observed failure` and `## Root cause` | Diagnosis |
| **feature** | `## Problem`, containing the measured current behaviour | Grounding |

A spec with an `## Observed failure` is a defect spec even if it also has a
`## Problem`. Every spec also needs the header bullets `Status`, `Area`,
`Target...` and `Related`, and the sections `Goal`, `Scope` (with `### In scope`
and `### Out of scope`), `Approach`, `Acceptance criteria`, `Verification plan`,
`Risks` and `Attribution`. `## Attribution` names the authoring harness and model
as `Spec: <harness>, <model>`. Lint checks all of this. This repository is
public: name only a publicly available harness, and write any other harness as
`other`. The same rule applies to a verdict's `Reviewer:` line, and two
`other` harnesses count as the same harness for reviewer independence.

## Gates

Pass or fail. **Any failed gate makes the outcome `revise`**, whatever the
dimensions say, unless a `reject` condition in the Outcome table also holds:
`reject` outranks `revise`. Each failed gate needs at least one finding tagged
with it.

### G1 Contract closed

Every behaviour the change introduces is decided in the spec: what triggers it,
what it does in each case the spec names, what it does on error, and every name
or signature other code or users will depend on.

- **Allowed open:** test technique, private helper names, and refactors with no
  behaviour. A spec may offer two ways to write a test.
- **Fails:** a behaviour left as a choice rather than decided: the spec names
  two or more ways to do it and does not say which is built, or hands the
  decision to whoever implements it, or marks it to be settled later. Also an
  option list with no selection, and a degrade or fallback path that does not
  say what is skipped.
- **Also fails, with no choice offered:** a behaviour the spec introduces whose
  trigger, whose effect in a case the spec names, or whose handling of an error
  the change can raise is decided nowhere; or a name, signature or format that
  other code or users will depend on and that the spec does not fix. The spec
  need not present any of these as open. If the change removes or bypasses
  something that existing code relies on to handle a named case, and the spec
  neither says what replaces it nor why the case cannot arise, the case is
  undecided, even though the code would do something when run.
- **Not G1:** a behaviour the spec does decide, but whose safety it does not
  argue, is a D2 finding; one that contradicts another part of the spec or a
  design decision is a D3 finding. A spec can fail G1 and lose D2 or D3 for the
  same change when both are true: the first asks whether the behaviour is
  decided at all, the others whether the decision is sound.

**Finding the D2 or the D3 does not answer G1.** The questions are asked of
different things: D2 and D3 are about the behaviour the spec chose, G1 about the
cases it left without one. A reviewer who has written the contradiction down
still owes G1 the other question, asked of every case the spec names. Expect the
two together, because a change that overturns a decision usually also leaves the
path that decision protected undecided, and the contradiction is the easier of
the two to see.

This list is the gate. The opening sentence says what G1 is for, and every way
of falling short of it is one of the bullets above.

Check: reviewer.

### G2 Citations resolve

Every cited path, symbol, commit, § reference and command exists and is the
thing the spec says it is. A claim the spec credits to a source (a rule, a
document, a note, another program's behaviour) is a citation too: the source is
named precisely enough to open, and it says what the spec says it does. A
source that is not named fails on that alone: "per the repo rule" with no rule
named, or "older notes" with no notes named, fails whether or not a document
saying something similar exists. A reviewer who finds such a document does not
repair the citation; naming it is the author's fix.

- **Script half (lint G2):** a repo path that does not exist at the ref; a path
  or symbol that is a near miss of a real one (`scr/` for `src/`, wrong case, or
  one letter off in a name of 8 or more characters); a commit that does not
  exist (write another repository's commit as `<owner>/<repo>@<sha>`); a `§` with no matching heading in
  `docs/design/*.md`; an `npm run` script that `package.json` does not define.
- **Reviewer half:** lint lists, without failing, every identifier it could not
  find, every path outside the repo, every gitignored local path, and every path
  marked `(new)`. For each one, the spec must either create it (Approach says
  so) or attribute it to a named source, with a version when the source is
  external software. A gitignored local file (an investigation note on the
  author's machine) is acceptable as provenance, but a claim it supports must
  also state the observation in the spec itself, because no other reader can
  open that file.

Check: lint, then reviewer.

### G3 Negative control named

The spec names a check that is run against the code **before** the change,
states that it fails there and why (the mechanism, not just "it fails"), and
states that the same check passes after. For a feature spec, it is the check
that shows the capability is absent today.

- **Fails:** tests that are only described as passing; a run of the check on
  both sides of the change with no stated expectation for the unchanged side; a
  negative control whose stated reason for failing is not the defect; a reason
  that offers two or more alternative mechanisms for one check's failure; a
  control whose own setup supplies the condition its failure is attributed to.

The last two are ways a negative control can read as complete and show nothing.
A reason that names one mechanism **or** another has not settled which, and an
unsettled mechanism is not a stated one: the gate asks why the check fails, and
two candidates answer a different question. And if the check's own setup builds
the thing whose absence before the change is supposed to make it fail, the run
exercises the setup rather than the code as it stands, because the pre-change
state the control exists to demonstrate was cancelled before the check ran.

Check: lint (a `- **Negative control` bullet exists in `## Verification plan`),
then reviewer (it is a real one).

### G4 Observable acceptance criteria

Each acceptance criterion states an observable outcome (exit code, output,
trace event, test assertion, file content, a link to a CI run) and names the
evidence to capture. A **behaviour criterion** (anything a program does) also
needs at least one Verification plan step that produces that evidence.

A **documentation criterion** (one that is met by what a file in the
repository says, such as a CHANGELOG entry, a version field or a doc section)
is governed by this paragraph alone, not by the step requirement above. It
passes when it names the file precisely enough to open and says what the file
must contain. Its evidence is that file, so it needs no Verification plan step;
a step that inspects the file is allowed, and its absence is not a finding. A
criterion that mixes the two is a behaviour criterion for its behaviour part.

- **Fails:** "works", "is robust", "no regressions" without the suite named; a
  behaviour criterion no Verification plan step would produce evidence for; a
  documentation criterion that does not say which file, or does not say what it
  must contain.

Check: reviewer.

### G5 Scope fenced

`### In scope` and `### Out of scope` are both present, and each out-of-scope
item says where it goes: a named spec, issue or owner, which needs no reason
beside it, or that it is dropped or unchanged with no follow-up, with the
reason. Each of the words dropped, unchanged and "no follow-up" is on its own
the statement that nothing follows, so an item needs one of them, not all
three. A word that describes the item instead of deciding about it (that it is
not affected, not needed or not relevant) is a reason, not a disposition: it
passes beside one of the dispositions above, a bare "no follow-up" included,
and fails on its own. A reason alone is not a disposition: saying why the item
is out of scope does not say whether anything follows it, and an item that
gives only a reason fails.

G5 judges the sentence, not the citation. An item that names a spec, issue or
owner has a disposition whether or not that target resolves from this
checkout; a named target that does not exist is a G2 finding, not a G5 one.
Failing both gates on one citation is one claim counted twice.

An owner may be a person, a role or a team. The gate asks that the item name
where it goes, not that the destination be an individual, so a role is a
disposition and how specific it is is not G5's question. What fails is an item
that names no destination of any kind and does not say it is dropped or
unchanged.

Check: reviewer.

## Dimensions

Scored 1 to 4, **reported separately and never summed**. A sum hides which
dimension moved. Any dimension at 2 or below makes the outcome `revise`, and
needs at least one finding tagged with it.

**A dimension's score is never higher than the lowest row its own findings
describe.** The tables are read downward, so a finding tagged `D3` that states
what row 2 states puts D3 at 2 or below, however well the rest of that section
reads. A score one row above the findings is the commonest way a dimension is
read wrong: the defect is found, written up accurately, and then given the next
number up, which leaves one verdict asserting a row and the row above it at
once. Where the two disagree the number is the half that is wrong, because the
finding is the part with the spec's own text attached to it.

### D1 Diagnosis (defect) / Grounding (feature)

| | Defect | Feature |
| --- | --- | --- |
| **4** | The cause is a mechanism traced to code (file and symbol), with provenance (the change that introduced it, by commit), consistent with every observation in Observed failure, and it explains why the failure is visible now. Control observations rule out the alternatives. | Current behaviour is measured (commands, outputs or numbers, with the ref), and each gap is tied to the code or config that produces it. |
| **3** | Mechanism traced to code, but provenance or the alternative-ruling evidence is missing. | Measured, but not every gap is tied to its cause. |
| **2** | A plausible cause named at file level without a mechanism; or a cause hedged rather than settled, offered as what the author expects is happening, where the evidence to settle it was present in the spec; or an observation the cause does not account for. | Current behaviour asserted, not measured. |
| **1** | No cause, or one contradicted by the spec's own evidence. | No problem statement beyond the goal. |

**For a feature spec, measurement is a precondition, not one of several
credits.** Rows 4 and 3 both open with it, so a 3 or a 4 needs the spec itself to
show how the current behaviour was observed: a command that was run, an output or
a number it produced, and the ref it was taken at, present in the spec where a
reader can see them. Tying each gap to the code that produces it is the rest of
row 4 and carries no score on its own, so a Problem that names the right code and
states its findings as claims is a 2, however precise those claims are and
however well they hold up.

**Score the evidence the spec presents, not whether its conclusions are true.** A
reviewer who checks the claims against the checkout and finds them right has
learned that the author was right, which is not the same as the spec having
measured anything. Row 2 is where a Problem that turns out to be correct but is
not measured belongs, and raising it because it turned out to be correct is the
most likely way to read this column wrong.

### D2 Safety argument

| | |
| --- | --- |
| **4** | Names the invariants the change could break, argues for each context the changed code runs in (each transport, host, mode or caller) why each still holds, lists explicit don'ts, and ties each invariant to a test that would catch its breakage. |
| **3** | Invariants named and argued, but one is not tied to a test, or one reachable context is not argued. |
| **2** | Safety asserted ("safe", "no impact", "nothing leaks") without an argument, or a context the change obviously reaches is not considered. |
| **1** | No safety discussion for a change that touches shared state, process lifetime or a public surface. |

### D3 Consistency

| | |
| --- | --- |
| **4** | Consistent with every design-doc section and sibling spec it touches, and cites them by `§` or path. No part of the spec contradicts another (Approach against Goal, Acceptance criteria, Out of scope or Risks). |
| **3** | Consistent, but a relevant design section or sibling spec is not cited. |
| **2** | One contradiction left unaddressed, internal or with a design doc or sibling spec. |
| **1** | Several contradictions, or overturns a documented decision without saying so. |

### D4 Verification realism

| | |
| --- | --- |
| **4** | Tests exercise the real mechanism (a real process, event loop or subprocess, not only mocks); live tests are gated (`PI_KIRO_LIVE=1`) and say what environment they need, including what to strip; thresholds are tied to the property (for example a bound well under the timeout that would mask the bug); regression suites are named. |
| **3** | One of those missing. |
| **2** | Mock-level only for a mechanism that mocks cannot show, or thresholds with no stated relation to the property. |
| **1** | "Run the tests." |

### D5 Operability

| | |
| --- | --- |
| **4** | Target version chosen per the table in `docs/releasing.md`, with the reason; the CHANGELOG section and subsection named, and a `### Fixed` bullet that will cite its test or carry a waiver per `docs/releasing.md`; a workaround for users on affected released versions; rollback or migration where state persists. For a change to nothing shipped: says so, names the CHANGELOG line, and says why there is no bump. |
| **3** | One missing. |
| **2** | Two missing. |
| **1** | None. |

### D6 Size

| | |
| --- | --- |
| **4** | One PR, one concern. A fix plus labelled, separable hygiene counts as one concern. |
| **3** | One PR, but two concerns interleaved so they cannot be reviewed apart. |
| **2** | Needs splitting into more than one PR. |
| **1** | A programme of work, not a spec. |

## Outcome

| Outcome | When |
| --- | --- |
| `pass` | Lint passes, every gate passes, every dimension is 3 or 4. |
| `revise` | Lint fails, any gate fails, or any dimension is 2 or below. |
| `reject` | The spec should not be built as framed: D1 is 1, or it duplicates or contradicts an accepted spec or design decision without proposing to supersede it. Needs a finding saying what a new spec would have to change. |

The `revise` and `reject` rows overlap: a spec that contradicts an accepted
decision usually also fails a gate or scores a 2. **`reject` outranks
`revise`**, so a spec meeting any `reject` condition is `reject` however many
gates it failed. `pass` requires that neither of the others applies. A verdict
is not invalid for answering `reject` on a spec with a failed gate.

**The outcome is never softer than the findings either.** Before writing
`revise`, test the `reject` row against the findings already written, not only
the `revise` row: `revise` fits almost every spec that is not ready and is
reached first, so the `reject` row tends to go unasked. A finding saying the
spec overturns, duplicates or contradicts an accepted spec or a documented
decision without proposing to supersede it is the `reject` condition written out
in words, and the outcome follows the finding.

Re-review happens on the author's next commit to the spec: that changes the
spec's blob, which makes the old verdict stale.

## Findings

One claim per finding. A finding that covers two problems can lose one and
still read as addressed. Format:

```
- [G1] "<exact text from the spec>": <the one claim>. Fix: <what would satisfy the gate or raise the score>.
```

- The tag is one of `G1`..`G5`, `D1`..`D6`.
- The quote is copied verbatim from the spec, so a reader can find it. A finding
  about something missing quotes the nearest heading, for example `"## Verification plan"`.
- No finding without a tag, and no tag without a quote.

## Verdict file

`spec-review/verdicts/<slug>.verdict.md`, one per spec, overwritten by each
review. Git history is the review log. The first line binds the verdict to the
exact spec text it judged:

```
spec-review verdict for docs/specs/<slug>.md blob <40-hex git blob sha>
Rubric: 4
Reviewer: <harness>, <model>
Outcome: pass

## Gates
- G1 pass
- G2 pass
- G3 pass
- G4 pass
- G5 pass

## Dimensions
- D1 4
- D2 3
- D3 4
- D4 3
- D5 3
- D6 4

## Findings
- [D2] "<quote>": <claim>. Fix: <fix>.
```

- The blob is `git rev-parse HEAD:docs/specs/<slug>.md` at the commit reviewed.
  Any edit to the spec changes it, so the verdict goes stale by itself, and
  committing a verdict never changes a spec's blob, so it cannot re-trigger a review.
- Every line above `## Findings` is machine-read: ASCII only, exact spelling,
  one gate or dimension per line, all eleven present.
- The `Reviewer:` line comes from whoever ran the review, never from the
  reviewing model's idea of itself ("Reviewer independence").
- A verdict is invalid, and counts as no verdict, if the header does not parse,
  a gate or dimension line is missing, the outcome does not follow from the
  gates and dimensions by the table above, or a failed gate or a dimension at 2
  or below has no finding tagged with it.

## Reviewer independence

- The session that wrote or last edited a spec never reviews it. A different
  session of the same harness and model is allowed; it must not have the
  authoring transcript in its context.
- The verdict's `Reviewer:` line records harness and model. The queue flags,
  without blocking, a verdict whose reviewer matches the spec's
  `## Attribution` harness and model.
- **The `Reviewer:` line is written by whoever runs the review, not by the
  reviewing model.** A model cannot see its own model id, so a line it fills in
  is a guess. The person or script that starts the session knows which harness
  and model it launched: it either gives the reviewer the exact line to copy,
  or writes the line into the verdict after the session ends. A reviewer that
  was not given the line writes `Reviewer: unknown, unknown`, which is valid
  and which the independence flag cannot match. The line is a record made by
  the runner, so it is as trustworthy as the runner, and no more.
- **The spec's `## Attribution` line has the same limit.** The authoring model
  cannot see its own model id either, so whoever started the authoring session
  writes or checks that line, and writes `unknown` for a model it does not
  know. The flag compares two records; it is only as good as the less careful
  of the two runners.

## Review procedure

1. Run lint at the ref under review. Stop at `lint-fail`.
2. Read the spec in full, then every file and `§` it cites that its Root cause
   (or Problem) and Approach depend on.
3. Work through every item lint listed under notes (G2 reviewer half).
4. **List the cases the spec names**, in its Goal, its Scope and its Approach,
   and beside each the sentence that says what the change does in that case.
   This list is what G1 is decided from. A case with no such sentence fails G1,
   and a contradiction or an unargued risk found elsewhere does not settle it.
5. **List what the spec offers as evidence for its own starting point**: each
   command run, each output or number it produced, and the ref. That is the
   Problem for a feature spec, Observed failure for a defect spec. Make the list
   even when it comes out empty, because an empty one caps D1 at 2 whatever else
   that section does well, and the cap is easy to miss once the rest of the spec
   reads well.
6. Decide each gate, then score each dimension against its anchors. Score what
   is written, not what the author probably meant.
7. Write findings.
8. **Read the findings back against the tables, and correct step 6's numbers
   where the two disagree.** For each dimension, name the lowest anchor row any
   of its findings describes: the score is not above that row. Then take the
   outcome from the table, testing the `reject` row against the findings and not
   only the `revise` row. Do not soften the outcome to match the findings' tone,
   or the findings to match the outcome.

## Changing this rubric

- Bump `Rubric:` when the meaning of a gate, an anchor or the outcome table
  changes. Wording fixes that keep the meaning do not bump it. The rule applies
  from the first merge of this file: before then there is no published meaning
  to bump away from, so Rubric 1 is whatever text merges, however many times it
  changed on the way.
- Every edit, bumped or not, re-runs the calibration set
  (`spec-review/calibration/README.md`) and must meet its ship bar before it
  merges. The runs record the blobs they were scored against, so the number is
  not what ties a run to a rubric (`spec-review/calibration/README.md`, ship bar
  rule 5).
- Verdicts on an older rubric still count. The queue reports them as
  `stale-rubric`, so they can be re-reviewed when convenient.
