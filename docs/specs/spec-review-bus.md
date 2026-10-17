# Implementation Spec: every spec gets an independent, rubric-scored verdict before it is built

- Status: Draft. On this branch already: the rubric, the calibration set, its
  first run and a held-out run that does not meet the ship bar, an interim
  scorer, the linter and its test. Not built yet: the queue, verdict
  validation and the CI workflow.
- Area: contributor workflow / CI
- Target release: none. No code or behaviour in the published package
  changes (see Approach, step 1); the only new file in the tarball is this
  spec, because `docs/` ships whole. That is documentation, which
  `docs/releasing.md` places at patch level, so nothing here needs a release of
  its own and there is no version bump: it ships with the next release, and the
  CHANGELOG line is under `## Unreleased` in `### Added`.
- Related: `spec-review/rubric.md`, `spec-review/calibration/README.md`,
  `scripts/spec-lint.mjs`, `test/spec-lint.test.ts`,
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
4. The rubric is held to known answers: it merges, and changes, only when two
   independent reviewer runs over the calibration set meet its ship bar.

## Problem

### Measured current behaviour (at `61bb96f`, 2026-10-17)

| Fact | Consequence |
| --- | --- |
| `.github/workflows/kiro-code-review.yml` runs on `pull_request` with `paths-ignore: '**/*.md'`. | A PR that only adds or edits a spec gets no automated review at all. |
| `package.json` `files` includes `docs/`, and `test/package-constraints.test.ts` ("files is an allowlist, with no negated patterns") rejects any `!` pattern. `docs/releasing.md` also makes any change to `files` a minor. | Verdicts or calibration fixtures under `docs/` would ship to npm, and cannot be excluded without breaking that test and forcing a minor. |
| On the maintainer's machine `git config core.hooksPath` points at a managed, machine-wide hooks directory, not `scripts/hooks`. | The repo's own `scripts/hooks/pre-push` does not run there, so a local hook cannot be what enforces review. |
| `git log --format='%(trailers:key=Actor)'` prints nothing on `main`. Merges are squashes, and their messages keep only `Co-authored-by` trailers (for example `61bb96f`, `6577035`). | A per-commit actor trailer written on a branch does not survive to `main`, so nothing durable can key on it. |
| The two existing specs, `acp-print-mode-exit.md` and `dual-host-pi-gsd.md`, were untracked in the maintainer's working copy, and share a section skeleton that nothing checks. | No spec has a review history, and a spec's shape is convention only. |

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

- `spec-review/rubric.md`, Rubric 1. **Done on this branch.**
- `spec-review/calibration/`: six cases, `expected.json`, the run protocol and
  ship bar. **Done on this branch.**
- `scripts/spec-lint.mjs` and `test/spec-lint.test.ts`, and `fetch-depth: 0`
  on the `test` job in `.github/workflows/ci.yml`, which that test needs.
  **Done on this branch.**
- `scripts/spec-review.mjs` (new) with `queue` and `score`, and
  `test/spec-review.test.ts` (new).
- `.github/workflows/spec-review.yml` (new).
- `CODEOWNERS` entries for `spec-review/rubric.md` and `spec-review/calibration/`.
- The first calibration run for Rubric 1, committed under
  `spec-review/calibration/runs/<run-id>/`. **Done on this branch**, scored by
  `spec-review/calibration/score.mjs` (`spec-review/calibration/runs/SCORE.md`);
  `spec-review.mjs score` replaces it and must reproduce that result
  (criterion 7). A held-out run by a harness and model outside passes 1 to 8
  misses three cases (`SCORE.md`), so criterion 7 is not met.
- CHANGELOG `### Added` under `## Unreleased`. **Done on this branch.**

### Out of scope

- **Actor trailers.** They do not survive a squash merge (measured above).
  Authorship is the spec's `## Attribution` line, which lint checks, and the
  reviewer is the verdict's `Reviewer:` line. Dropped, no follow-up.
- **A committed queue file.** The queue is computed, so it cannot drift from
  the specs or conflict between branches. Dropped, no follow-up.
- **CI committing verdicts.** CI posts a draft as a comment and never writes to
  the repo (Approach, step 5). A human or a local agent commits the verdict.
  Unchanged, no follow-up.
- **Reviewing design docs** (`docs/design/`). The rubric is for implementation
  specs. A separate spec if it is ever wanted.
- **Code PRs.** `kiro-code-review.yml` is unchanged.
- **A local hook.** `npm run hooks:install` can run lint before a push where
  `core.hooksPath` is not managed, but CI is the enforcer. Unchanged, no follow-up.

## Approach

### 1. Layout: outside `docs/`, so nothing ships

```
docs/specs/<slug>.md                      the spec; ships with docs/, like the design docs
spec-review/rubric.md                     Rubric: <n>
spec-review/verdicts/<slug>.verdict.md    one per spec, overwritten per review; git log is the history
spec-review/calibration/                  README.md, expected.json, cases/c1.md..c6.md, runs/<run-id>/
scripts/spec-lint.mjs                     the deterministic checks
scripts/spec-review.mjs                   queue and score
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
- `state` is `lint-fail` when lint fails (no verdict is consulted), else
  `pending` when there is no verdict file or its header blob differs, else
  `invalid-verdict` when the verdict breaks a validity rule in the rubric's
  "Verdict file" section, else the verdict's `Outcome`.
- `flags` may hold `stale-rubric`, and `same-author-model` when the verdict's
  `Reviewer:` harness and model equal the spec's `## Attribution` ones. Flags
  never change `state`.
- `--changed-since <base>` limits the output to specs changed in
  `<base>...<ref>`, which is what CI uses.
- Exit 0 always for `queue`. Deciding is CI's job, so the queue stays usable as
  a read-only feed by any harness.

`score <run-dir> [<run-dir>]` parses calibration verdicts against
`expected.json` and prints, per case, every expectation missed and, given two
runs, every gate on which they disagree. Exit 0 only when the ship bar is met.

### 5. CI: `.github/workflows/spec-review.yml` (new)

Its own workflow, because `kiro-code-review.yml` ignores `*.md`. On
`pull_request` with `paths` `docs/specs/**`, `spec-review/**`,
`scripts/spec-lint.mjs` and `scripts/spec-review.mjs`;
`permissions: contents: read, pull-requests: write`.

- **`gate`** (required check, no secrets): checkout with `fetch-depth: 0`, then
  `node scripts/spec-review.mjs queue --changed-since "$BASE_SHA"` with the SHAs
  passed as env vars, as `kiro-code-review.yml` does. The job fails if any entry
  is not `pass`, and writes the table to `$GITHUB_STEP_SUMMARY`.
- **`draft-review`** (runs only when `KIRO_API_KEY` is set, never required):
  the `kiro-code-review.yml` rails, unchanged in kind. `persist-credentials:
  false`, the key check, `kiro-cli chat --no-interactive --trust-all-tools` with
  the default agent and a prompt that points at the rubric and the spec by file
  path, the `<REVIEW>` block extraction, the raw-output artifact, and one sticky
  comment per PR under the marker `<!-- spec-review -->`. It adds no tracked
  `.kiro/agents/*.json`, because kiro-cli rewrites tracked agent files. The
  draft is a starting point for a reviewer, and CI never commits it.

### 6. Reviewer independence

The rubric's "Reviewer independence" section is the contract: the session that
wrote a spec never reviews it, and the verdict records harness and model. The
queue's `same-author-model` flag makes the weak case visible without blocking it.

### 7. Calibration holds the rubric

`spec-review/calibration/README.md` has the cases, the blind run protocol and
the ship bar. In short: two runs, each case in a fresh session, every
expectation met in both, and agreement on all 30 gate decisions. A miss or a
disagreement is fixed in the rubric's wording, never by choosing a run. The
lint half runs in CI on every push (`test/spec-lint.test.ts`).

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
   failed gate with no `[Gn]` finding each give `invalid-verdict`. Evidence:
   `test/spec-review.test.ts`, one case each.
5. **CI gates on it.** A PR whose first push edits a spec with no verdict fails
   `spec-review / gate`; after a passing verdict for the new blob is committed,
   the check passes. Evidence: links to both runs in the PR.
6. **The draft review is sticky.** With `KIRO_API_KEY` set, a spec PR has one
   `<!-- spec-review -->` comment after two pushes, not two. Evidence: the PR's
   comment.
7. **Rubric 1 meets its ship bar.** Two runs as the calibration README
   specifies, scored by `spec-review.mjs score` with exit 0. Evidence: the run
   directories and the score output, committed.
8. **Only specs are added to the tarball.** `npm pack --dry-run` lists no
   path under `spec-review/` or `scripts/`, and differs from `main`'s list only
   by `docs/specs/*.md`. Evidence: both listings, diffed, in the PR. On this
   branch: 32 files, the one addition `docs/specs/spec-review-bus.md`.
9. `npm run verify` passes.

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
  - CI: the PR's first push is the failing case of criterion 5. It must go red
    before the verdict commit makes it green.
  - Calibration: c1, c3, c5 and c6 are the rubric's negative controls, built so
    one edit breaks one gate or dimension. c4 is the false-fail control. Before
    the first run counts, confirm `score` reports misses when handed the c4
    verdict under every other case's name.
- **Packaging:** `npm pack --dry-run` on `main` and on the branch, diffed.
- **Live:** the two calibration runs need a model and are manual. Run one in
  kiro-cli and one in another harness or model.

## Risks and notes

- **Lint presence is not substance.** An author can write a
  `- **Negative control` bullet that is not one. Lint only stops the omission;
  the reviewer judges the content, and c3 tests that the reviewer does.
- **Six cases from two real specs, five of them from one, all defect-typed.** The feature column of D1
  is uncalibrated, and the set can over-fit one exemplar's shape. This spec is
  the first feature spec. Rubric 2 should add a feature case and a mutant of it.
- **The c2 labels are judgement.** The maintainer ratifies them before
  criterion 7 counts as met.
- **Prompt injection.** A spec in a PR is untrusted input to `draft-review`. It
  gets the same rails as `kiro-code-review.yml`: no write-scoped token in
  `.git/config`, read-only contents, output only through the extracted block.
- **Blob identity is strict.** A whitespace-only edit stales a verdict.
  Accepted: re-review is cheap, and normalising the text first would let a real
  edit hide inside a "formatting" change.
- **Calibration pins `61bb96f`.** CI needs full history for it (the `fetch-depth`
  change), and a clone that rewrites that history breaks the set. It is
  reachable from `main`, so ordinary clones are fine.
- **Public repository.** Verdicts and calibration runs are public. Nothing in
  them may quote private material, and the existing secret scan covers them
  because they are tracked.
- ASCII only in every machine-read line: verdict headers, gate and dimension
  lines, `Outcome:`, queue states.

## Attribution

Design: Randy James proposed the commit-driven, harness-agnostic review bus;
this revision replaces the committed queue with a computed one, moves verdicts
out of the shipped `docs/`, drops actor trailers, and adds the rubric and its
calibration. Spec: other, Claude Opus 5.5.
