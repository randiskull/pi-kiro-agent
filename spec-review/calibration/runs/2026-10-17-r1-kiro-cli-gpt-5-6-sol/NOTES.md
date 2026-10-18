# Held-out pair, run 2 of 2: kiro-cli 2.32.0, gpt-5.6-sol, Rubric 1

The second of two runs made after the review-item fixes landed. Same conditions
as run 1 (`../2026-10-17-r1-gsd-us-anthropic-claude-fable-5-1/NOTES.md`): a
model that took no part in passes 1 to 8 or in any wording written in response
to them, the rubric and cases exactly as `f64d2eb` left them, and nothing
changed after collection. The blobs scored against are in `RUN.json`.

- Harness: `kiro-cli` 2.32.0, engine v2,
  `kiro-cli chat --no-interactive --trust-all-tools`.
- Model: `gpt-5.6-sol` from kiro-cli's own model list, 4.40x credits.

## Result

Two of six cases miss. **The ship bar is not met.** See `../SCORE.md` for the
paired score; the short version:

| case | miss | what the verdict says |
| --- | --- | --- |
| c1 | `G1 pass`, key `fail` | Like run 1, it found the defect and labelled it elsewhere: one `D2` finding naming the exact mechanism the key describes ("kiro retains the MCP client it built for the server named `pi`, so it continues calling the closed old URL") and three `D3` findings on the contradiction. Two models in two harnesses, independently, read c1 as a decided-but-wrong design rather than an open contract. |
| c3 | `G4 fail`, key `pass` | **The same run passed c4's G4 and failed c3's on byte-identical text.** c3 is a mutant of c4 that touches only the negative control and one "before and after" phrase; `diff c4.md c3.md` shows criterion 6 and the "criteria 4 and 5" verification step are identical in both. The finding is that no verification step captures criterion 6's CHANGELOG and `package.json` file-content evidence, which is equally true of c4. G4 says both "at least one Verification plan step produces that evidence" (and fails "a criterion no Verification plan step would produce evidence for") **and** "A documentation criterion's evidence is the named file", without saying which governs a documentation criterion. This run applied the second sentence to c4 and the first to c3. |

It got c1's `outcome: reject` right, as run 1 did, and it got c2's G5 right where
run 1 missed it, citing the transport item alone.

## Deviations specific to this run

- **MCP tools were available to these sessions**, which the README protocol does
  not grant: `@builder-mcp/WorkspaceSearch` appears in the logs. The audit below
  found no key content reached any session, but the reach was wider than
  intended and is disclosed rather than hidden. The next run should pass an
  empty MCP configuration.
- **One session probed for the calibration directory and was refused.** The c2
  session globbed
  `{docs/design/**/*.md,docs/specs/**/*.md,spec-review/**/*...}` inside the
  clone; the tool returned `status: Failed`, because the clone has no
  `spec-review/` entry at all. This is the protocol working, and it is the one
  moment in twelve sessions where it was tested.
- That same c2 session read `docs/releasing.md` - the file that made c2's old G2
  key reason half-wrong - and still failed G2. That is consistent with the
  corrected reason, which now rests on the unnamed-steering-notes half alone.
- The `Reviewer:` headers say `Kiro, gpt-5.6-sol` (and once
  `Kiro, GPT-5.6 Sol`), naming the product rather than the CLI in the run id.
  The scorer does not read that field; see run 1's note on why it should not be
  asked of the model at all.

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
