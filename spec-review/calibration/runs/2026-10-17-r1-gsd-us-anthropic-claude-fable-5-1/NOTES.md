# Held-out pair, run 1 of 2: gsd 1.22.0, claude-fable-5-1, Rubric 1

The first of two runs made after the review-item fixes landed, by a harness and
model that took no part in passes 1 to 8, in the `claude-sonnet-5` held-out run,
or in any wording written in response to them. The rubric, the cases and
`expected.json` are exactly as commit `f64d2eb` left them, and **nothing was
changed after these verdicts were collected**: the blobs the run was scored
against are recorded in `RUN.json`.

- Harness: `gsd` (`@opengsd/gsd-pi` 1.22.0, public on npm, MIT),
  `gsd -p --no-session`.
- Model: `amazon-bedrock/us.anthropic.claude-fable-5-1`, us-west-2. The bare
  `anthropic.claude-fable-5-1` is refused for on-demand invocation ("Retry with
  the ID or ARN of an inference profile"), so the US cross-region inference
  profile is what was called and what is recorded. The same weights are
  reachable through `kiro-cli` as `claude-fable-5.1`, which that CLI flags as
  internal and development-only; the public Bedrock identifier is used here on
  purpose, because this file is public.

## Result

Two of six cases miss. **The ship bar is not met.** See `../SCORE.md` for the
paired score and what the misses mean; the short version:

| case | miss | what the verdict says |
| --- | --- | --- |
| c1 | `G1 pass`, key `fail` | It found c1's defect, and filed it as five `D3` findings (the Approach contradicts Goal 3, criterion 4 and the out-of-scope line) plus two `D2` findings (the safety argument never reaches a second bridged turn). It read the spec as having *decided* a wrong behaviour rather than having *left one open*, so G1 passed. G1's opening sentence covers the key's reading ("what it does in each case the spec names" - the spec never says what a per-turn session reset does to the delta prompt `useResume` already computed). G1's **Fails** list does not: every bullet there describes a spec that offers a choice, and c1 offers none. |
| c2 | `G5 pass`, key `fail` | It raised no out-of-scope finding at all. It failed the other four gates with eleven findings and simply did not examine the three `### Out of scope` dispositions. Run 2 of the pair, under the same rubric text, did fail G5 on the transport item, so the rubric wording is not implicated; this is reviewer variance. |

It got c1's `outcome: reject` right, which the `claude-sonnet-5` run did not.
That confirms the item-8 precedence fix (`reject` outranks `revise`, now stated
in both the Gates preamble and the Outcome table).

## A defect in the verdict format, found by this run

The rubric asks for `Reviewer: <harness>, <model>`. **This run's sessions could
not see their own model id and guessed, wrongly, six different ways**:
`gsd-pi, Claude` twice, `pi, Claude`, `pi, Claude Opus`,
`pi (GSD), Claude Opus 4.5`, and `pi, Claude (model id not exposed to session)`.
Only the last is honest. The model was `us.anthropic.claude-fable-5-1` in all
six. A field the reviewer cannot know should be written by the harness, not
asked of the model; `RUN.json` is the record to trust, and the `Reviewer:` line
should either be filled in by whatever invokes the review or dropped. This is
not one of the 22 review items and is filed as a follow-up.

## Protocol, and where it differs from the README

Followed: one fresh non-interactive session per case (six separate processes),
the README's prompt word for word except for the paths, the rubric and `c2.md`
given with each case, no lint output, `git hash-object` for the header blob.
All six header blobs match the case files, and every session exited 0.

Carried over from the `claude-sonnet-5` run, for the same reasons it gives:

- **A clone, not a worktree.** `git worktree add` shares the object database
  and refs, so the answer key on this branch would be one `git show` away from
  the reviewer. Both runs used `git clone --no-local` at `61bb96f`, with every
  ref deleted and unreachable objects pruned.
- **One input directory per case, under a neutral name** (`in-XXXXXX`, outside
  the repository and this project's directories).
- **The verdict path was given explicitly** so parallel sessions could not
  overwrite each other.
- The two passes ran at the same time, and the six sessions within each pass
  ran at the same time. Nothing is shared between sessions but the read-only
  clone.

## Isolation

Audited after the fact across all twelve sessions of both passes, by searching
every session's stdout, stderr and verdict file for: the names `expected.json` and
`calibration`; each of nine strings that appear only in the key
(`mustQuoteOneOf`, `labelledBy`, `shipBar`, `countsTowardsShipBar`, `reject by
construction`, `the false-fail control`, `D1 is exactly 2, not 1`, `frozen from
the maintainer`, and `originals/dual-host-pi-gsd.md`'s sha256); any case file
other than the session's own; and any input directory other than the session's
own. **No session obtained any answer-key content, named another case, or
touched another session's directory.**

The rubric blob (`c3caeb28`), `expected.json`'s blob (`dfd81da8`) and all six
case blobs were verified absent from the clone by `git cat-file -e` both before
the first session and after the last.
