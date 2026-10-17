# Held-out run: kiro-cli 2.32.0, claude-sonnet-5, Rubric 1

A third run, made after pass 8 was scored, by a harness and model that took no
part in passes 1 to 8. The rubric, the cases and `expected.json` are exactly as
pass 8 left them: nothing was changed before or after this run, so it measures
whether pass 8's result holds for a reviewer the set was not tuned on.

## Result

`node spec-review/calibration/score.mjs runs/2026-10-17-r1-kiro-cli-claude-sonnet-5`:
three of six cases miss, and gate agreement with either pass-8 run is 27/30
(`c2 G3`, `c2 G4`, `c5 G5`). **The ship bar is not met with this run.**

| case | miss | what the verdict says |
| --- | --- | --- |
| c1 | outcome `revise`, key `reject` | "That's G1 fail, D2=1, D3=1 -- forcing outcome `revise`." The reviewer applied rubric.md's "Any failed gate makes the outcome `revise`" literally. The key's `reject` comes from the outcome table's `reject` row, which overlaps the `revise` row with no precedence rule. |
| c2 | G3 and G4 `pass`, key `fail` | G3 is one of the c2 labels awaiting maintainer ratification. This run's findings are on D2, D3 and D5 instead. |
| c5 | G5 `fail`, key `pass` | The reviewer could not resolve `docs/specs/dual-host-pi-gsd.md` (it is not in the repository at any ref), raised that under G2, and failed G5 on the same citation because the "named spec" in an out-of-scope disposition did not exist. It did not use `c2.md` for that citation, although the prompt names it. c4 has the same line and passed G5 in this run. |

## Protocol, and where it differs from the README

Followed: one fresh `kiro-cli chat --no-interactive` session per case (six
separate processes), the README's prompt word for word except for the paths,
the rubric and `c2.md` given with each case, no lint output, `git hash-object`
for the header blob. All six header blobs match the case files.

Changed, to make the run blinder or to let the six sessions run side by side:

- **A clone, not a worktree.** `git worktree add` shares the object database and
  refs, so the answer key on this branch was one `git show` away from the
  reviewer. This run used `git clone --no-local` at `61bb96f`, with every ref
  deleted and unreachable objects pruned: `expected.json`'s blob and this
  branch's commits were absent from it.
- **One input directory per case, under a neutral name** (`in-XXXXXX`, outside
  the repository and this project's directories), instead of one shared
  `pk-cal-input`.
- **The verdict path was given explicitly** (`<input>/verdict.md`) so parallel
  sessions could not overwrite each other.
- Engine `v2` (the default), `--trust-all-tools`.

Audit: no session's output mentions `expected.json`, the calibration directory
or another case, and the only absolute paths any session wrote to were its own
`verdict.md`. Raw session output is not committed.
