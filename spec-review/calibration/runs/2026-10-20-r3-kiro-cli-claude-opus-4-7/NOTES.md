# Rubric 3, pair 1 of 1, run A: kiro-cli 2.32.0, claude-opus-4.7

The first run ever made against Rubric 3. Its partner is
`../2026-10-20-r3-pi-us-anthropic-claude-opus-4-6-v1`, and the paired score is
in `../SCORE.md`. Nothing in the rubric, the cases or `expected.json` was
touched after these verdicts were collected; the blobs scored against are in
`RUN.json` and `score.mjs` reports them as matching.

- Harness: `kiro-cli` 2.32.0,
  `kiro-cli chat --no-interactive --trust-all-tools --agent reviewer`.
- Model: `claude-opus-4.7`, a kiro-cli model id. Seat billed through the
  official client; no model endpoint was called directly.
- Eight sessions, one per case, all exited 0, 209s to 266s each.
- Isolation audit clean for all eight. Zero `Reviewer:` line corrections.

## Result

**Four of eight cases miss, so the ship bar is not met.** Rubric 2's run A
missed five. The count barely moved; what moved is which things miss.

### All three of Rubric 3's reviewer-facing fixes landed here

| fix | case | result |
| --- | --- | --- |
| D1's feature-column precondition | c7, c8 | **`D1 4` and `D1 2`. `shipBar.featureColumn` is met by this run.** |
| G1's "finding the D2 or the D3 does not answer G1" | c1 | **`G1 fail`**, on the key's mechanism |
| G5's person-or-role-or-team clause | c6 | `G5 pass` |
| `mustQuoteOneOf` punctuation | c1, c6, c8 | every quote matched |

c8's D1 finding reaches the new paragraph almost in its own words: the spec
"names the current behaviour as a claim derived from the code ... but nothing in
the spec itself shows how that behaviour was observed - no command run, no row
the current reader produced, no trace, and no ref. Per the D1 anchor,
measurement for a feature spec must be present in the spec where a reader can
see it, and a Problem that names the right code and states its findings as
claims is a 2 however well those claims hold up." The fix was not merely
followed, it was followed for the stated reason.

`featureColumn` had been the one rule in `expected.json` that no reviewing model
had ever satisfied. Four models had seen c7 and c8 and all four scored them the
same on D1. This run separates them, and so does its partner.

### What misses

| case | miss | what the verdict says |
| --- | --- | --- |
| c1 | `outcome revise` (key `reject`); `D3 2` (key `1`) | **The finding is right and the row is wrong.** Its D3 finding says the Approach "overturns the 'one bridge URL per child across a session reset' decision in `docs/design/acp-transport.md` §5e.3 ... while claiming to preserve the opposite", and its fix says "promote this to a supersede of §5e.3 with its own argument". That is D3 anchor 1 and the reject row, described in prose and then scored as anchor 2 and answered `revise`. |
| c6 | `D1 3` (key `2`); `outcome pass` (key `revise`) | Same shape. The finding says hedging the cause "with 'probably' and 'likely' understates the spec's own evidence and reads as a cause offered rather than settled", which is D1 anchor 2 verbatim in meaning, then scores 3. |
| c3 | `G3 pass` (key `fail`); `outcome pass` (key `revise`) | c3 is c4 with the `- **Negative control` bullet deleted, and `lint.fail` is `["G3"]`. See below: this is the harness defect, not a reading of G3. |
| c2 | `G3 pass` (key `fail`) | c2's negative control exists but "gives two outcomes and no mechanism", and the GSD-home test it names builds the wiring itself. The partner missed this one too, so it is a both-miss and the second one in the set's history. |

Four cases are right, including c5's `G2 fail` on both the wrong commit sha and
the `serveBridgeHTTP` casing, and c4 clean with no false fail.

## The shape the misses share

Three of the four missing cases miss in one way: **a finding that describes
anchor N, scored as anchor N+1.** c1's D3, c1's outcome and c6's D1 are all of
that kind, and so is c6's outcome. The reviewer did the reading, wrote the
defect down accurately, and then placed it one row high.

Rubric 3 added a listing step for the cases a spec names (step 4) and a listing
step for the evidence behind its starting point (step 5). Neither binds a
written finding back to the anchor row it came from, and that is where these
misses live. It is a candidate for Rubric 4 and it is not acted on here,
because the pair's other result makes a wording change premature: see
`../SCORE.md`.

## The harness defect this run exposes, with its partner

`c2` and `c3` G3, and all five of the partner's G2 disagreements, come from one
cause. The calibration prompt says "following its Review procedure, skipping
step 1 (lint)" and supplies no lint output. **The rubric's step 3 is "Work
through every item lint listed under notes (G2 reviewer half)", so step 3 has no
input, and G2's reviewer half is defined as a function of a list the reviewer is
never given.** This run silently skipped step 3; the partner reconstructed it by
hand and did lint's script-half job, failing G2 on a path lint resolves.

That is a defect in the measuring instrument, not in the rubric. It is written
up once, in `../SCORE.md`, because it is the pair's finding and not this run's.

## Protocol

`node scripts/calibrate.mjs run --harness kiro-cli --model claude-opus-4.7`.
The runner is documented in `../README.md` ("The runner") and tested in
`test/calibrate.test.ts`. Per case: a ref-stripped clone with `origin` removed,
copied per session; a per-session `reviewer` agent with `mcpServers: {}`, because
`--trust-tools` does not block MCP tools; the `Reviewer:` line written into the
prompt and verified; the header blob checked against `git hash-object` and never
rewritten; and an isolation audit over every session's own output.

## Effort, against rule 6

`shipBar.capabilityMatched` asks the two runs to be at a comparable level. This
run spent 209s to 266s per case and the partner 288s to 641s, a ratio of roughly
1.6, against the 4-to-5 ratio that had to be disclosed for Rubric 2's pair. No
verdict in this run has an empty `## Findings`. The concern that was recorded
and left open for Rubric 2's pair does not arise here.
