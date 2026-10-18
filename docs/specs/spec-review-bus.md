# Implementation Spec: every spec gets an independent, rubric-scored verdict before it is built

- Status: Draft. On this branch already: the rubric, the calibration set with
  the two specs it was built from, five runs (none of which counts: see below),
  an interim scorer, the linter and its test, and the anchor-leak test. Not built
  yet: the queue, verdict validation, the two CI jobs and the restricted review
  agent. **Rubric 1 has no measured result.** Pass 8's 30/30 is withdrawn - the
  answer key was relabelled to match those runs and the same runs were then
  scored against it - and the held-out run that was scored against the key
  unchanged missed three of six cases. Rubric 2 fixes the wording the later
  misses found and has no run yet. Criterion 12 and the c2 ratification are
  open, so this spec is not ready to merge on its own terms.
- Area: contributor workflow / CI
- Target release: none. No code or behaviour in the published package
  changes (see Approach, step 1); the only new file in the tarball is this
  spec, because `docs/` ships whole. That is documentation, which
  `docs/releasing.md` places at patch level, so nothing here needs a release of
  its own and there is no version bump: it ships with the next release, and the
  CHANGELOG line is under `## Unreleased` in `### Added`.
- Related: `spec-review/rubric.md`, `spec-review/calibration/README.md`,
  `spec-review/calibration/originals/README.md`, `scripts/spec-lint.mjs`,
  `test/spec-lint.test.ts`, `test/rubric-anchors.test.ts`,
  `.kiro/agents/code-reviewer.json`,
  `.github/workflows/kiro-code-review.yml`, `docs/releasing.md`,
  `test/package-constraints.test.ts`

## Goal

Specs under `docs/specs/` are written in one harness (pi, kiro-cli, the Kiro IDE,
GSD and others) and often built in another. Nothing today says whether a spec is fit
to build, so the first real review is the implementation PR, after the work is
done. After this change:

1. A spec's review state is a pure function of the repository.
   `node scripts/spec-review.mjs queue` prints every spec, its current git blob
   and its state. There is no queue file to drift or conflict.
2. Any harness can take part with nothing but a checkout: read the queue, review
   a pending spec with `spec-review/rubric.md`, commit a verdict file.
3. CI fails a pull request that changes a spec unless that spec's current blob
   has a valid `pass` verdict.
4. The rubric is held to a calibration set with known answers: it merges, and
   changes, only when two independent reviewer runs over that set meet its ship
   bar, and a CI job refuses a rubric or key edit that no current pair of runs
   covers. What that measures is agreement between two reviewers on a six-case
   set built from two real specs, which is weaker than "known answers" and is
   recorded as such under Risks.

## Problem

### Measured current behaviour (at `61bb96f`, 2026-10-17)

| Fact | Consequence |
| --- | --- |
| `.github/workflows/kiro-code-review.yml` runs on `pull_request` with `paths-ignore: '**/*.md'`. | A PR that only adds or edits a spec gets no automated review at all. |
| `package.json` `files` includes `docs/`, and `test/package-constraints.test.ts` ("files is an allowlist, with no negated patterns") rejects any `!` pattern. `docs/releasing.md` also makes any change to `files` a minor. | Verdicts or calibration fixtures under `docs/` would ship to npm, and cannot be excluded without breaking that test and forcing a minor. |
| `core.hooksPath` varies per checkout. On the author's machine it is set only in the system gitconfig, to a managed machine-wide directory, and `scripts/hooks/pre-push` printed nothing on that day's pushes; on the maintainer's checkout it is `scripts/hooks` in `.git/config`, and the repo's pre-push hook ran on every push that day. Both were measured. | Whether the repo's own hook runs is a property of the clone, not of the repo, so a local hook cannot be what enforces review even though it does run for some contributors. |
| `git log --format='%(trailers:key=Actor)'` prints nothing on `main`. The merge method is chosen per PR and nothing enforces one: 4 of the last 12 first-parent commits on `main` are merge commits (`959b9ec`, `5764149`, `dff2aae`, `0b4cf9a`), and the rest are squashes, which keep only `Co-authored-by` (for example `61bb96f`, `6577035`). | A per-commit actor trailer survives a merge commit and is dropped by a squash, so whether it reaches `main` depends on a per-PR choice. Nothing durable can key on it. |
| The two existing specs, `acp-print-mode-exit.md` and `dual-host-pi-gsd.md`, were untracked in the maintainer's working copy: `git log --all -- <both paths>` is empty, so they had never been tracked on any branch. They share a section skeleton that nothing checks. | No spec has a review history, and a spec's shape is convention only. Both are now committed under `spec-review/calibration/originals/`, because two calibration cases are frozen copies of them and nothing a reviewer could obtain backed those copies up. They are not in `docs/specs/`: see Out of scope. |

A first prototype of the citation check, run over those two specs at
`61bb96f`, resolved every repo path, symbol and commit in the first except a
gitignored investigation note and the untracked sibling spec. In the second,
the shipped `scripts/spec-lint.mjs` lists 21 paths outside the repo, 13
placeholders and 4 identifiers it cannot find, every one of them a host install
path or a name from the external GSD build that spec is about. A strict "every
citation must exist" rule would therefore fail a good spec, which is why
citations are classified (Approach, step 3) instead.

## Scope

### In scope

- `spec-review/rubric.md`, Rubric 2. **Done on this branch.**
- `spec-review/calibration/`: six cases, `expected.json`, the run protocol and
  ship bar, and `originals/` (the two real specs two cases were frozen from, with
  the one local path in them scrubbed). **Done on this branch.**
- `test/rubric-anchors.test.ts` (new): every quoted example of three or more
  words in `rubric.md` is grepped against the cases, and a match fails, so an
  anchor cannot be sharpened by copying the text of the case it must catch.
  **Done on this branch.**
- `.kiro/agents/spec-reviewer.json`: the restricted agent `draft-review` runs
  under, mirroring `.kiro/agents/code-reviewer.json`. **Done on this branch**,
  ahead of the workflow that uses it, because it is the fix for a safety rail the
  review found missing rather than a part of the unbuilt half.
- `scripts/spec-lint.mjs` and `test/spec-lint.test.ts`, and `fetch-depth: 0`
  on the `test` job in `.github/workflows/ci.yml`, which that test needs.
  **Done on this branch.**
- `scripts/spec-review.mjs` (new) with `queue` and `score`, and
  `test/spec-review.test.ts` (new).
- `.github/workflows/spec-review.yml` (new).
- `CODEOWNERS` entries for `spec-review/rubric.md` and `spec-review/calibration/`.
- The calibration runs for Rubric 1, committed under
  `spec-review/calibration/runs/<run-id>/`, each with a `RUN.json` recording the
  rubric, key and case blobs it was scored against. Three runs are on this
  branch and **none of them counts.** The two pass-8 runs are withdrawn: the key
  was relabelled to match them and they were then scored against it with nothing
  re-run, which the ship bar's rule 4 now explicitly forbids. The held-out run
  was scored against the key unchanged and missed three cases, two of which were
  wording defects now fixed in the rubric - which stales its own blobs by
  design. Criterion 7 needs two fresh passes, at a comparable capability level,
  by models in neither the passes nor the wording fixes
  (`spec-review/calibration/README.md`, ship bar rules 4 to 7). Interim scoring
  is `spec-review/calibration/score.mjs` (`runs/SCORE.md`); `spec-review.mjs
  score` replaces it and must reproduce it.
- CHANGELOG `### Added` under `## Unreleased`. **Done on this branch.**

### Out of scope

- **Actor trailers.** Dropped, no follow-up. They survive a merge commit and a
  squash drops them (measured above), and the merge method is chosen per PR with
  nothing enforcing it, so a trailer is unreliable rather than impossible - and
  something that is present for some PRs and absent for others is worse to key on
  than something that is never there. Authorship is the spec's `## Attribution`
  line, which lint checks, and the reviewer is the verdict's `Reviewer:` line.
- **A committed queue file.** The queue is computed, so it cannot drift from
  the specs or conflict between branches. Dropped, no follow-up.
- **CI committing verdicts.** CI posts a draft as a comment and never writes to
  the repo (Approach, step 5). A human or a local agent commits the verdict.
  Unchanged, no follow-up.
- **Reviewing design docs** (`docs/design/`). Dropped, no follow-up. The rubric
  grades a plan to change code - G3 wants a check that fails before the change,
  G4 wants evidence a plan step produces - and a design doc has neither, so the
  gates would not apply rather than apply leniently. If design docs are ever
  reviewed it needs its own rubric, and nobody has asked for one; no spec or
  issue is opened for it here.
- **Code PRs.** Unchanged, no follow-up. `kiro-code-review.yml` already reviews
  them and runs on a different trigger: it has `paths-ignore: '**/*.md'`, so it
  skips the specs this spec is about, and this spec's gate runs only on the
  paths in Approach step 5. Merging the two would mean one workflow with two
  triggers and two prompts, so they stay separate.
- **A local hook.** `npm run hooks:install` can run lint before a push where
  `core.hooksPath` is not managed, but CI is the enforcer. Unchanged, no follow-up.
- **The two original specs as live specs.** They are committed under
  `spec-review/calibration/originals/`, not `docs/specs/`. Dropped, no
  follow-up: a spec under `docs/specs/` enters the queue, is subject to the
  gate, and ships in the tarball because `docs/` ships whole, and these two are a
  known-defective pair (one carries the three defects calibration found, the
  other is labelled as failing every gate). Neither will be built as written, so
  neither should be queued. If either is ever revived it is a new spec and gets
  its own verdict.

## Approach

### 1. Layout: outside `docs/`, so nothing ships

```
docs/specs/<slug>.md                      the spec; ships with docs/, like the design docs
spec-review/rubric.md                     Rubric: <n>
spec-review/verdicts/<slug>.verdict.md    one per spec, overwritten per review; git log is the history
spec-review/calibration/                  README.md, expected.json, cases/c1.md..c6.md, runs/<run-id>/
spec-review/calibration/originals/        the two real specs two cases were frozen from; not live specs
scripts/spec-lint.mjs                     the deterministic checks
scripts/spec-review.mjs                   queue and score
.kiro/agents/spec-reviewer.json           the restricted agent draft-review runs under
```

`spec-review/` and `scripts/` are not in the `files` allowlist, so `files`
does not change. The tarball gains `docs/specs/*.md` and nothing else, the same
way it carries `docs/design/`.

### 2. Verdict file

Format, outcome table and finding format: `spec-review/rubric.md`. The first
line binds a verdict to the exact text it judged:

```
spec-review verdict for docs/specs/<slug>.md blob <40-hex git blob sha>
```

- Any edit to the spec changes its blob, so its verdict goes stale with no
  bookkeeping.
- Committing a verdict never changes a spec's blob, so it cannot re-trigger a
  review.
- A verdict on an older rubric still counts and is reported `stale-rubric`. A
  rubric edit is held to the calibration set instead of forcing every spec back
  through review.

### 3. Lint: `scripts/spec-lint.mjs`

Built. Checks `structure`, `type`, `attribution`, `G2` and `G3` (presence only),
resolving citations at `--ref` (default `HEAD`) from the repository root, whatever
directory it runs in. Fenced blocks (backtick or tilde, any length) and HTML
comments are not prose. Symbols resolve in `src/`, `test/` and `scripts/`, except
the linter and its test, which spell typos on purpose. Each inline-code token
and markdown link target is classified, and only the classes a script can judge
without being wrong fail:

| Class | Example | Result |
| --- | --- | --- |
| repo path, under a top-level entry the repo has | `src/bridge.ts` | must exist at the ref |
| sibling spec | `docs/specs/<slug>.md` | `--alias`, then the working tree |
| near miss of a repo path or symbol | a top-level directory in the wrong case (`SRC/`) or one edit off (`scr/`); a symbol (camelCase, PascalCase, snake or screaming case, or a call's callee) in the wrong case with the same initial, or (8+ characters) one edit off | fail, naming the real one |
| commit (7 to 40 hex, either case, with a digit and a letter; digits-only or letters-only only in backticks; both ends of `a..b`) | `6ea0510` | must be an ancestor of `--ref`; exit 2 in a shallow clone |
| another repository's commit, written `<owner>/<repo>@<sha>` or as a `.../commit/<sha>` URL | | listed for the reviewer |
| `§` reference | `§5e.3` | must be a section number naming a heading in `docs/design/*.md` (`§5e` is not `5e.3`) |
| `npm run <x>`, `npm run-script <x>`, `npm test`/`start`/`stop`/`restart` | `npm run verify` | `package.json` must define it; other `npm` commands are npm's own |
| path marked `(new)` | | listed as proposed |
| gitignored local path, path outside the repo, unknown identifier, placeholder | | listed for the reviewer, never failed |

A wholly invented identifier with no near miss passes lint. The rubric's
reviewer half of G2 covers it, and the script header says so.

Exit 1 means a finding and nothing else. An unreadable or oversized (over
512 KiB) spec, an unknown option, an unresolvable ref and any internal error
exit 2, so the queue never reads a crash as `lint-fail`.

### 4. Queue and verdict validation: `scripts/spec-review.mjs` (new)

`queue [--ref <commit>]` prints a JSON array, one entry per `docs/specs/*.md`
tracked at the ref:

```json
[{ "spec": "docs/specs/<slug>.md", "blob": "<sha>", "state": "pending", "verdict": null, "rubric": null, "flags": [] }]
```

- `blob` is `git rev-parse <ref>:<path>`.
- `state` is `lint-error` when lint exits 2 (it could not verify: an unreadable
  or oversized spec, an unresolvable ref, a shallow clone, an internal error),
  else `lint-fail` when lint exits 1 (no verdict is consulted), else `pending`
  when there is no verdict file or its header blob differs, else
  `invalid-verdict` when the verdict breaks a validity rule in the rubric's
  "Verdict file" section, else the verdict's `Outcome`.
- `lint-error` is a distinct state, never folded into `lint-fail`, because the
  two mean opposite things: `lint-fail` is a finding about the spec and the
  author fixes it, `lint-error` is the checker failing and nobody has learned
  anything about the spec. The gate fails on `lint-error` and says which, so a
  crash can never read as a verdict either way.
- `flags` may hold `stale-rubric`, and `same-author-model` when the verdict's
  `Reviewer:` harness and model equal the spec's `## Attribution` ones **after
  normalising both sides** (lower-case, every run of non-alphanumerics to a
  single `-`, trimmed). Without that, `Claude Opus 5.5` in an attribution and
  `claude-opus-5-5` in a verdict compare unequal, which is the exact case the
  flag exists for. Flags never change `state`.
- `--changed-since <base>` limits the output to the **union** of the specs
  changed in `<base>...<ref>` and the specs whose verdict file changed in
  `<base>...<ref>`. A PR that edits or adds only a verdict would otherwise list
  nothing and pass the gate unchecked, however invalid that verdict is. A
  changed verdict is always revalidated.
- A spec **deleted** at `<ref>` is dropped from `--changed-since`: it has no
  blob, so there is nothing to gate, and a verdict left behind for it is inert.
  A **rename** is a new spec at a new path, needing its own verdict; the old
  path's verdict does not carry over, because the blob binding is to a path and
  a blob together.
- Exit 0 always for `queue`. Deciding is CI's job, so the queue stays usable as
  a read-only feed by any harness.

**`reject` is reviewer-only.** The validator checks that the outcome follows the
rubric's Outcome table under its precedence rule (`reject` outranks `revise`, so
a `reject` on a spec with a failed gate is valid), and that the required finding
is present and tagged. It never judges whether a reject's *reason* is a good one:
"duplicates or contradicts an accepted decision" is not decidable from the spec
text alone. A reject therefore blocks the gate on a human's judgement with no
machine check behind it, which is stated under Risks rather than hidden.

`score <run-dir> [<run-dir>]` parses calibration verdicts against
`expected.json` and prints, per case, every expectation missed and, given two
runs, every gate on which they disagree. It reads each run's `RUN.json` and
reports a run whose recorded blobs differ from the committed ones as **stale**,
scoring it but never counting it. Exit 0 only when the ship bar is met by two
non-stale runs.

### 5. CI: `.github/workflows/spec-review.yml` (new)

Its own workflow, because `kiro-code-review.yml` ignores `*.md`. On
`pull_request` with `paths` `docs/specs/**`, `spec-review/**`,
`scripts/spec-lint.mjs` and `scripts/spec-review.mjs`;
`permissions: contents: read, pull-requests: write`.

- **`gate`** (required check, no secrets): checkout with `fetch-depth: 0`, then
  `node scripts/spec-review.mjs queue --changed-since "$BASE_SHA"` with the SHAs
  passed as env vars, as `kiro-code-review.yml` does. The job fails if any entry
  is not `pass`, and writes the table to `$GITHUB_STEP_SUMMARY`.
- **`calibration`** (required check, no secrets): runs when
  `spec-review/rubric.md` or `spec-review/calibration/**` changes, which is what
  makes Goal 4 enforced rather than stated. It runs `node
  scripts/spec-review.mjs score` over the committed run directories and fails
  unless two runs meet the ship bar **and** each of those two records, in its
  `RUN.json`, blobs equal to the committed blobs of `rubric.md`,
  `expected.json` and every case at the merge commit.

  The key is the blob, not the `Rubric:` number. A wording fix that keeps a
  gate's meaning does not bump the number, while "Changing this rubric" re-runs
  the set for every edit, so a check on the number would pass a rubric edited
  under stale runs. A blob check cannot: any edit to the rubric or the key moves
  a blob and invalidates every run recorded against the old one. The three runs
  on this branch all record pre-review blobs and so all three fail this job,
  which is the intended behaviour and the reason criterion 12 is open.
- **`draft-review`** (runs only when `KIRO_API_KEY` is set, never required):
  the `kiro-code-review.yml` rails, unchanged in kind. `persist-credentials:
  false`, the key check, the `<REVIEW>` block extraction, the raw-output
  artifact, and one sticky comment per PR under the marker `<!-- spec-review -->`.
  The draft is a starting point for a reviewer, and CI never commits it.

  **The agent is restricted to reading.** `kiro-cli chat --no-interactive` runs
  under a tracked `.kiro/agents/spec-reviewer.json` limited to `read`, `grep` and
  `glob`, exactly as `.kiro/agents/code-reviewer.json` limits the code review.
  The spec in a PR is untrusted text, the job has `KIRO_API_KEY` in its
  environment, and the default agent under `--trust-all-tools` would give that
  text shell, file writes and network. `--trust-tools=fs_read,grep,glob` (present
  on kiro-cli 2.32.0) is the equivalent if a tracked agent file ever becomes
  unworkable. An earlier draft of this spec justified using the default agent on
  the grounds that kiro-cli rewrites tracked agent files; that is false here.
  `.kiro/agents/code-reviewer.json` is tracked, restricts tools to
  `glob`/`grep`/`read`, and carries `kiroUpgrade.revision: 2` - the migration
  accepted in #62 - so the repository already contains the counter-example. Only
  the v3 engine rewrites them, and CI runs v2.

### 6. Reviewer independence: recorded, not enforced

The rubric's "Reviewer independence" section is the contract: the session that
wrote a spec never reviews it, and the verdict records harness and model. Both
records are written by whoever started the session, never by the model, which
cannot see its own model id: the runner writes the verdict's `Reviewer:` line,
and the author's `## Attribution` line. The queue's `same-author-model` flag
makes the obvious case visible, with both sides normalised so it actually fires
(step 4), and it is only as good as those two records (criterion 7).

**The gate cannot prove independence, and this spec does not claim it does.** A
spec's author can write a passing verdict with any `Reviewer:` line they like,
and nothing in the repository can contradict it. Three ways to close that were
considered and rejected, each because it breaks something real here:

| Candidate | Why not |
| --- | --- |
| make `same-author-model` block instead of flag | the rubric deliberately allows a different session of the same harness and model, which is the main way a solo maintainer gets a second opinion |
| require the verdict commit's author to differ from the spec commit's | rules out the design's own main flow, a local agent committing a verdict under the maintainer's git identity; every commit on `main` has one author |
| `CODEOWNERS` over `spec-review/verdicts/**` | GitHub cannot ask the only code owner to review their own PR, so it would block every merge |

Together they would mean nothing merges without a second human, which this
repository does not have. So `CODEOWNERS` covers `spec-review/rubric.md` and
`spec-review/calibration/` - where a self-approved change would corrupt the
measuring instrument rather than one verdict - and independence is a recorded
claim that a reader can audit in git history, not a property the gate proves.
Risks says so in those words.

### 7. Calibration holds the rubric

`spec-review/calibration/README.md` has the cases, the blind run protocol and
the ship bar. In short: two runs at a comparable capability level, by models that
took part in no earlier pass and in no wording fix, each case in a fresh session
from a clone that cannot reach the answer key, every expectation met in both, and
agreement on all 30 gate decisions (6 cases x 5 gates). A miss or a
disagreement is fixed in the rubric's wording, never by choosing a run; the key
may be relabelled only when the new label follows from how the case was built,
and a relabel re-runs both passes. The lint half runs in CI on every push
(`test/spec-lint.test.ts`), and `test/rubric-anchors.test.ts` holds that no
anchor quotes a case.

A clone, not a worktree: `git worktree add` shares the object database, so a
reviewer in a worktree of this branch can read `expected.json` with one `git
show`. That is not hypothetical - a review session on this branch did read it -
so the protocol says clone, strip the refs, and assert the key's blob is absent.

## Acceptance criteria

1. **Lint matches the answer key.** `npm test` passes `test/spec-lint.test.ts`:
   c3 fails `G3` only, c5 fails `G2` only and names both its nonexistent
   commit and its misspelled symbol, the other four pass, and each citation class fails on its
   own synthetic defect. Evidence: the CI run. **Met on this branch.**
2. **This spec passes lint at its own commit.** Evidence: `node
   scripts/spec-lint.mjs docs/specs/spec-review-bus.md` output in the PR.
3. **The queue tracks blobs.** In a temporary git repo, a spec with no verdict
   is `pending`; after a verdict for its blob is committed it is `pass`; after
   the spec is edited it is `pending` again; a commit that changes only the
   verdict changes no spec's state. Evidence: `test/spec-review.test.ts`.
4. **Invalid verdicts never count.** A header blob that does not parse, a
   missing gate or dimension line, `Outcome: pass` with a failed gate, and a
   failed gate with no `[Gn]` finding each give `invalid-verdict`. And the
   precedence case must be the other way: `Outcome: reject` with G1 failed and
   D3 1 - exactly c1's shape - is **valid**, because `reject` outranks `revise`.
   A validator built to the old wording would have called both of c1's verdicts
   invalid. Evidence: `test/spec-review.test.ts`, one case each.
5. **A verdict-only PR is checked.** A PR that changes no spec and adds an
   invalid verdict fails the gate; one that adds a valid verdict for the current
   blob passes. Evidence: `test/spec-review.test.ts`, both directions.
6. **A crash is not a verdict.** With lint exiting 2, the spec's state is
   `lint-error`, not `lint-fail` and not `pass`, and the gate fails naming it.
   Evidence: `test/spec-review.test.ts`, with lint stubbed to exit 2.
7. **The independence flag fires on the case it exists for.** A verdict reading
   `Reviewer: other, claude-opus-5-5` against an attribution reading `Spec:
   other, Claude Opus 5.5` carries `same-author-model`. Evidence:
   `test/spec-review.test.ts`. This is the pair that did not match before
   normalising. The flag compares two lines written by whoever ran each session
   (§6), so it fires on what they recorded, not on what ran.
8. **A rubric edit cannot merge on stale runs.** With `rubric.md` edited and no
   run's `RUN.json` matching the new blob, `spec-review / calibration` fails; it
   passes once two runs recorded against the new blobs are committed. Evidence:
   both CI runs, linked in the PR.
9. **No anchor quotes a case.** `npm test` passes
   `test/rubric-anchors.test.ts`. Evidence: the CI run. **Met on this branch**,
   with the negative control below.
10. **CI gates on it.** A PR whose first push edits a spec with no verdict fails
    `spec-review / gate`; after a passing verdict for the new blob is committed,
    the check passes. Evidence: links to both runs in the PR.
11. **The draft review is sticky, and restricted.** With `KIRO_API_KEY` set, a
    spec PR has one `<!-- spec-review -->` comment after two pushes, not two, and
    the job's command names `.kiro/agents/spec-reviewer.json`, whose tool list is
    `read`, `grep`, `glob` and nothing else. Evidence: the PR's comment and the
    workflow file.
12. **The current rubric meets its ship bar.** Two runs as the calibration README
    specifies - comparable capability, neither model in the tuning loop, each
    from a clone that cannot reach the key, each with a `RUN.json` matching the
    committed blobs - scored by `spec-review.mjs score` with exit 0. Evidence:
    the run directories and the score output, committed. The blob clause and
    `countsTowardsShipBar` are enforced by the scorer itself, so the exit code
    carries the whole criterion and not only the case expectations
    (`test/spec-review-score.test.ts`); `spec-review.mjs score` must keep that.
    **Open, and merged open by maintainer decision; tracked by issue 67.**
    Five runs exist and none counts. Two are withdrawn for being scored against a key fitted to
    them. The `claude-sonnet-5` run was held out and honest, but it missed
    three cases and its misses drove wording fixes, so that model is now in the
    tuning loop. The last pair - `gsd` 1.22.0 on
    `us.anthropic.claude-fable-5-1` and `kiro-cli` 2.32.0 on `gpt-5.6-sol`,
    held out from every pass and every fix - agreed with itself on 28 of 30
    gate decisions and missed four of twelve cases. That pair records the
    current blobs, so it is not stale: it simply misses. The four misses are
    rubric-wording defects, not defects in anything this spec builds; they are
    listed in issue 67 and summarised in the Risks below. The c2 label
    ratification is a precondition and is also open. Rubric 2 fixes the
    wording those misses found and has no run yet, so this criterion now waits
    on two runs against Rubric 2's blobs.
13. **Only specs are added to the tarball.** `npm pack --dry-run` lists no
    path under `spec-review/` (including `originals/`) or `scripts/`, and differs
    from `main`'s tracked list only by `docs/specs/*.md`. Evidence: both
    listings, diffed, in the PR. On this branch: 33 entries, the one addition
    `docs/specs/spec-review-bus.md`. (`main` tracks 32; `npm pack` on a working
    copy that still holds the two untracked originals reports 34, which is the
    working copy and not `main`.)
14. `npm run verify` passes.

## Verification plan

- **Negative control first.** Every check is shown failing on the input built to
  break it before its pass on clean input is trusted.
  - Lint: done. The unmutated synthetic spec is asserted to pass first, so a
    harness that never passes cannot read every mutation as caught. Then one
    defect per citation class must fail `G2` with the token named. The checker
    itself was mutated 34 ways after review, each rule disabled or loosened in
    turn (fence and comment handling, heading matching, header values, the
    ancestor check, every citation form, the exit codes); every mutation fails
    `test/spec-lint.test.ts`, which also lints at `HEAD` so its own fixtures
    cannot whitelist a typo.
  - Queue: in `test/spec-review.test.ts`, assert `pending` before `pass`, so a
    queue that always answers `pass` fails. Then mutate the blob comparison to
    always match and confirm criterion 3 fails; record it in the PR.
  - CI: the PR's first push is the failing case of criterion 10. It must go red
    before the verdict commit makes it green.
  - Calibration: c1, c3, c5 and c6 are the rubric's negative controls, built so
    one edit breaks one gate or dimension. c4 is the false-fail control. Before
    the first run counts, confirm `score` reports misses when handed the c4
    verdict under every other case's name.
  - Anchor leaks: done. `test/rubric-anchors.test.ts` asserts it finds quoted
    examples before asserting none of them match a case, so an extractor that
    returns nothing cannot pass; it plants a phrase copied out of c6 and
    requires the matcher to catch it; and it asserts the structural exemption
    exempts a heading while leaving an ordinary anchor to be checked, so the
    exemption cannot swallow the test. Re-introducing the exact leak review item
    7 found (`"pick the lightest"`, verbatim from c2) was confirmed to fail it.
- **Packaging:** `npm pack --dry-run` on `main` and on the branch, diffed.
- **Live:** the two calibration runs need a model and are manual. Both must be
  at a comparable capability level, because the bar measures agreement between
  them and a strong-plus-weak pair cannot distinguish an ambiguous rubric from a
  reviewer that could not do the task. Run them in different harnesses, from
  clones that cannot reach the answer key, with models in neither the eight
  passes nor the wording fixes those passes and the held-out run produced. A
  deliberately cheap model may be run as a non-gating robustness probe and
  recorded in its `NOTES.md`; it is not one of the two.

## Risks and notes

- **Lint presence is not substance.** An author can write a
  `- **Negative control` bullet that is not one. Lint only stops the omission;
  the reviewer judges the content, and c3 tests that the reviewer does.
- **Eight cases from three specs, six of them from two exemplars.** Rubric 2
  added the first feature-typed pair (c7, c8), so D1's feature column has an
  expectation, on one spec's shape. The set can still over-fit its exemplars.
- **The eligible model pool shrinks with every pass.** A model that took part in
  a pass, or in a wording fix made in response to one, cannot be one of the two
  runs. Six are now spent, and the fixes the last pair calls for will spend the
  next two. That cost is the reason Rubric 2 should widen the set rather than
  keep re-tuning these six: a wider set makes each exclusion cheaper.
- **The c2 and c7 labels are judgement.** The maintainer ratifies them before
  criterion 12 counts as met. The held-out run passed c2 G3 and G4 where the key
  fails them, which puts those two labels specifically in question.
- **Three gate-wording defects were found by the held-out pair**, deferred so
  that this mechanism could land first (issue 67), and fixed in Rubric 2, which
  is not yet measured. They are worth keeping here because each is a way a
  rubric can read as unambiguous and not be:
  - **A gate's preamble can be broader than its `Fails` list, and a grader
    applies the list.** G1 opens with "what it does in each case the spec
    names", which reaches a spec that silently leaves a named case undecided;
    Rubric 1's `Fails` list named only specs that offer a choice. Both runs of
    the pair passed c1's G1 for that reason, having found the defect and filed
    it under D2 and D3.
  - **Two sentences of one gate can govern the same criterion and not say which
    wins.** Rubric 1's G4 required that "at least one Verification plan step
    produces that evidence" and also exempted a documentation criterion, whose
    "evidence is the named file". One run applied the exemption to c4 and the
    requirement to c3, on text that is byte-identical between the two.
  - **A gate's example can condition on the wrong thing.** G2 asks that a source
    be "named precisely enough to open", but Rubric 1 illustrated the failure
    as `"Per the repo rule"` *"with no rule in the repo"*, which tests existence
    rather than naming. Both runs failed c2 on an unnamed rule, one of them
    after reading the file that does state the procedure, and both were right.
- **A verdict's `Reviewer:` line is written by whoever ran the review, and
  nothing checks it.** Under Rubric 1 the reviewing model wrote it, and a model
  cannot see its own model id: the six sessions of one run, all on the same
  model, wrote six different answers, one of them naming a model that was not
  used. Rubric 2 moves the line to the runner, which knows what it launched, and
  a reviewer that was not told writes `unknown, unknown`. That makes the line
  honest when the runner is, and no more: the independence check in criterion 7
  is keyed on a field the verdict alone cannot verify, and in calibration
  `RUN.json` is the record to trust.
- **Independence is recorded, not enforced.** The gate asks for a valid `pass`
  verdict for the spec's current blob. A spec's author can write one, under any
  `Reviewer:` line, and the gate cannot tell. What the repository enforces is
  `CODEOWNERS` on the rubric and the calibration set, and what it offers is an
  auditable record: every verdict is a commit, with an author, a date and a
  `Reviewer:` line a reader can weigh. Approach step 6 says why the three
  stronger options were rejected. Anyone relying on this gate as proof that a
  second party read a spec is relying on the wrong thing.
- **A `reject` has no machine check behind it.** The validator checks that the
  outcome follows the table and that the finding is present; whether a spec
  really contradicts an accepted decision is not decidable from its text. A
  reject is one reviewer's judgement, blocking the gate, with nothing to appeal
  to but the finding.
- **The ship bar measures agreement, not correctness.** Two reviewers agreeing
  on 30 gate decisions over six cases built from two real specs is evidence the
  wording is unambiguous, not evidence the rubric asks for the right things. The
  key itself was written by reading the cases, and pass 8 showed how easily a key
  bends towards the runs. Rule 4's relabelling clause and the blob keying make
  that visible rather than impossible.
- **The eligible model pool shrinks with every pass.** A model that graded the
  set, or whose miss drove a wording fix, is in the tuning loop and is spent:
  four are already excluded. A set that only models it has never seen can
  validate gets harder to validate each time it is corrected. Rubric 2 should
  grow the set rather than keep re-tuning these six.
- **Prompt injection.** A spec in a PR is untrusted input to `draft-review`. It
  gets the same rails as `kiro-code-review.yml`: no write-scoped token in
  `.git/config`, read-only contents, output only through the extracted block.
- **Blob identity is strict.** A whitespace-only edit stales a verdict.
  Accepted: re-review is cheap, and normalising the text first would let a real
  edit hide inside a "formatting" change.
- **Calibration pins `61bb96f`.** CI needs full history for it (the `fetch-depth`
  change), and a clone that rewrites that history breaks the set. It is
  reachable from `main`, so ordinary clones are fine.
- **Public repository.** Verdicts, calibration cases, originals and runs are
  public. Nothing in them may quote private material, and the existing secret
  scan covers them because they are tracked. A case frozen from a real spec can
  carry an absolute path out of the author's home directory: one did, inside a
  fenced transcript where lint does not look, and it was rewritten `~/...` in
  both the case and the original. Run ids name a harness and a model, so they
  must use publicly available names, or `other`; where a model is reachable under
  both an internal alias and a public identifier, the public one is recorded.
- ASCII only in every machine-read line: verdict headers, gate and dimension
  lines, `Outcome:`, queue states.

## Attribution

Design: Randy James proposed the commit-driven, harness-agnostic review bus;
this revision replaces the committed queue with a computed one, moves verdicts
out of the shipped `docs/`, drops actor trailers, and adds the rubric and its
calibration. A review on the pull request found that the gate did not enforce
what it claimed, that the 30/30 calibration result was scored against a key
fitted to the runs it was scored on, and that several measured facts were wrong;
this revision withdraws that result, keys runs to blobs, restricts the review
agent, and says plainly what the gate cannot prove. Spec: other, Claude Opus 5.5.
