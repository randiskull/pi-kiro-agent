# Rubric 3, pair 1 of 1, run B: pi 1.3.0, us.anthropic.claude-opus-4-6-v1

The partner of `../2026-10-20-r3-kiro-cli-claude-opus-4-7`; the paired score is
in `../SCORE.md`. Nothing in the rubric, the cases or `expected.json` was
touched after these verdicts were collected; the blobs scored against are in
`RUN.json` and `score.mjs` reports them as matching.

- Harness: `pi` (`@earendil-works/pi-coding-agent` 1.3.0),
  `pi -p --no-session -nc -ne -ns -np --no-mcp --provider amazon-bedrock`.
- Model: `us.anthropic.claude-opus-4-6-v1`, a US cross-region inference profile
  on Amazon Bedrock in `us-west-2`. A public Bedrock identifier.
- Eight sessions, one per case, all exited 0, 288s to 641s each.
- Isolation audit clean for all eight. Zero `Reviewer:` line corrections.

## Result

**Five of eight cases miss, so the ship bar is not met.** Eleven run-case
misses against run A's seven. But nine of the eleven are one defect, and the
defect is in the harness.

### Rubric 3's fixes landed here too

| fix | case | result |
| --- | --- | --- |
| D1's feature-column precondition | c7, c8 | **`D1 4` and `D1 2`. `shipBar.featureColumn` is met by this run.** |
| G1's "finding the D2 or the D3 does not answer G1" | c1 | **`G1 fail`** |
| G5's person-or-role-or-team clause | c6 | `G5 pass` |
| `mustQuoteOneOf` punctuation | c1, c6, c8 | every quote matched, including the c6 string that cost Rubric 2's run B a correct finding on one full stop |

So both runs of this pair met `featureColumn`, both failed c1's G1, both passed
c6's G5, and no quote missed. All four of Rubric 3's changes did what they were
written to do, in both runs, which is the pair's primary result.

### What misses

| case | miss | what the verdict says |
| --- | --- | --- |
| c1 | `G2 fail` (key `pass`); `outcome revise` (key `reject`); `D2 3` (key `<=2`); `D3 2` (key `1`) | The G2 fail is the alias defect below. The D3 finding is accurate and a row high, the same shape run A showed: it quotes §5e.3's "the bridge URL is a property of the child, fixed when the child first learns it", says the Approach "explicitly breaks" it, and then scores 2 and answers `revise`. |
| c2 | `G2 pass` (key `fail`); `G3 pass` (key `fail`) | Ten findings (`G1` x3, `G4`, `G5`, `D1` to `D5`) and not one on a source. The key fails c2's G2 on three claims credited to sources the spec never names. Rubric 2's run A missed c2's G2 the same way, so two of four models have now reviewed c2 without auditing a citation. |
| c3 | `G2 fail` (key `pass`) | The alias defect. **Its `G3 fail` is correct**, and run A missed it: see below. |
| c4 | `outcome revise` (key `pass`); `G2 fail` (key `pass`) | **The only false fail in the pair, and it has exactly one finding.** c4's verdict contains a single `[G2]` item, on the alias path. Remove that one finding and c4 is clean and passes. `shipBar.mustCatch` calls a revise on c4 a false fail and counts it as a miss, correctly. |
| c6 | `G2 fail` (key `pass`); `D1 3` (key `2`) | The alias defect, plus the same anchor-row slip run A made on c6: the finding says "probably" hedges a cause the `getActiveResourcesInfo()` snapshot "already settles", then scores 3. |

## The one defect behind nine of the eleven misses

**Four of this run's five `G2 fail` misses, and run A's two `G3` misses, have a
single cause: the calibration prompt tells the reviewer to skip lint and then
asks it to consume lint's output.**

The prompt says "following its Review procedure, skipping step 1 (lint)" and
supplies no lint output. The rubric's Review procedure step 3 is "Work through
every item lint listed under notes (G2 reviewer half)". G2 itself splits the
work explicitly: the script half owns "a repo path that does not exist at the
ref", and the reviewer half begins "lint lists, without failing, every
identifier it could not find, every path outside the repo, every gitignored
local path, and every path marked `(new)`. For each one, the spec must either
create it or attribute it to a named source."

So G2's reviewer half is defined as a function of a list that calibration never
hands over, and a reviewer has to guess where the line falls. The two runs
guessed differently:

- **This run did lint's job itself.** It checked the filesystem, found that
  `docs/specs/dual-host-pi-gsd.md` is absent at `61bb96f` (`docs/specs/` is not
  a directory in the clone), and failed G2 on it in c1, c3, c4 and c6, every
  case that cites the path except c5, where it had two real G2 defects to report
  instead. The reading is defensible: the prompt says the repository is checked
  out at the commit the spec was written against, the path is not there, and G2
  is called "Citations resolve".
- **Run A treated the path as resolving** and never raised it, and silently
  skipped step 3 as well. On c3, where the `- **Negative control` bullet is
  deleted and `lint.fail` is `["G3"]`, run A read the absence as lint's business
  and passed the gate. This run read it as its own and failed it, correctly.

`expected.json` `aliases` maps `docs/specs/dual-host-pi-gsd.md` to
`cases/c2.md`, and the deterministic half is given it on the command line
(`spec-lint.mjs --alias ...`), so **lint resolves the path and the reviewer is
not told that it does**. The two halves of the same gate are given
contradictory inputs. Lint's notes for c4 list nine unresolved symbols, five
local paths, four external names and one placeholder, and do not mention the
aliased path at all: that is the list the reviewer should have been working
through, and the evidence that the path was never a G2 question.

The prompt's one alias sentence ("Where the spec cites `X`, read `<file>`") says
where to read the content. It does not say the citation resolves, and a
reviewer that reads the filesystem is contradicted by it rather than informed.

This is a defect in the measuring instrument, so none of the four `G2 fail`
misses here is evidence about the rubric's wording, and `shipBar.agreement`'s
rule 4 ("any disagreement means the rubric wording is ambiguous: fix the
wording") must not be applied to them. The fix and its cost are in
`../SCORE.md`.

## Protocol

`node scripts/calibrate.mjs run --harness pi --model us.anthropic.claude-opus-4-6-v1`.
Per case: a ref-stripped clone with `origin` removed, copied per session; MCP
off at the harness (`--no-mcp`); the `Reviewer:` line written into the prompt
and verified; the header blob checked against `git hash-object` and never
rewritten; and an isolation audit over the session's own output.

## Effort, against rule 6

288s to 641s per case, against run A's 209s to 266s. A ratio of roughly 1.6 on
the medians, and both runs produced findings on every case that has any, so
`shipBar.capabilityMatched` is satisfied on the evidence available. The 4-to-5
effort gap that had to be disclosed for Rubric 2's pair does not recur.
