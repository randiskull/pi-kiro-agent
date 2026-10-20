# Rubric 4, probe run B: pi 1.3.0, us.anthropic.claude-opus-4-6-v1

**This run is a probe, and it was never eligible to count.**
`us.anthropic.claude-opus-4-6-v1` is in `shipBar.spent`: it ran Rubric 3's first
pair, and Rubric 4's two fixes answer that pair's misses directly, so it is
inside the tuning loop under `shipBar.heldOut`'s narrow reading as well as its
broad one. It is re-run here under `shipBar.capabilityMatched`, which allows a
non-gating probe. Its partner is
`../2026-10-20-r4-kiro-cli-claude-opus-4-7` and the paired score is in
`../SCORE.md`.

Nothing in the rubric, the cases or `expected.json` was touched between these
verdicts being collected and the pair being scored.

- Harness: `pi` 1.3.0,
  `pi -p --no-session -nc -ne -ns -np --no-mcp --provider amazon-bedrock`.
- Model: `us.anthropic.claude-opus-4-6-v1` through Amazon Bedrock in
  `us-west-2`.
- Eight sessions, one per case, all exited 0, 313s to 527s each.
- Isolation audit clean for all eight. Zero `Reviewer:` line corrections.
- Lint's `notes` were handed over per case and lint's result withheld, per
  `shipBar.blind`; the alias file was placed in the clone at the path c1, c3,
  c4, c5 and c6 cite, per `shipBar.aliasResolves`.

## Result

**Three of eight cases miss on a gate, a dimension or the outcome**, which is
the fewest any run has recorded against any rubric; Rubric 3's run B missed five.
`score.mjs` counts four, the fourth being c8, where this run's `D1 2` is correct
and only the `mustQuoteOneOf` quote misses.

### What Rubric 4 was written for

| fix | case | result |
| --- | --- | --- |
| G3's two new Fails entries | c2 | **`G3 fail`.** Correct, and correct in both runs of this probe |
| the dimension ceiling | c1 | **`D3 2`, wanted 1. Did not land here** |
| the outcome read-back | c1 | **`revise`, wanted `reject`. Did not land here** |

**The G3 fix is the result that matters.** c2's G3 had been the set's second
both-miss after the feature column: no reviewing model had failed it. Both runs
of this probe fail it, which makes it the second both-miss a rubric text change
has closed.

**The read-back rule is split**, and that is the honest finding. Run A corrected
c1's `D3` to 1 and its outcome to `reject`; this run repeated Rubric 3's
answers exactly. One rule, one pair, one landing. It is not evidence the rule
works and not evidence it does not.

### What it did not reach

- **c1's `D2` is 3 with a `D2` finding that describes anchor 2.** Run A did the
  same. The ceiling rule did not carry to `D2` in either run, including in run
  A's verdict where it did carry to `D3` three lines above.
- **c2's `G2` passes, in both runs.** A new both-miss, and the likeliest cause
  is the harness fix this branch shipped two commits ago: c2's G2 fails on
  three claims credited to sources the spec never names, which lint's notes
  cannot list. Handing a reviewer the notes and naming them step 3's input gives
  it a route to reading G2's reviewer half as the notes and nothing more. That
  is the cost side of a fix whose benefit was six gate disagreements, and it is
  recorded rather than acted on.
- **c6's `D1` is 3 and its outcome `pass`**, matching run A. Not an off-by-one:
  the `D1` finding is about missing provenance, anchor 3's second half, and not
  about the hedged cause anchor 2 is written for. Both runs identified a
  different defect, which is also why both miss c6's `mustQuoteOneOf` string -
  that string is the hedge.
- **c8's `mustQuoteOneOf` miss, with `D1 2` correct.** The finding is correct in
  tag, score and reasoning and quotes a verbatim sentence from the spec's
  Problem section that was not one of the three listed. Run A's miss on the same
  case is the key's fault and is fixed in the same commit; **this one is left as
  a judgement call for the maintainer**, because widening the list to any
  sentence in the section would make the rule vacuous, and widening it to this
  sentence is tuning the key to a run. See `../SCORE.md`.

### Better than run A

**c3 is clean.** `G3 fail` and `revise`, on a case built by deleting the
negative-control bullet outright, with lint's verdict withheld. Run A read the
section as satisfied. This is the only case in the pair where one run reaches a
lint-half failure the other does not.

`shipBar.featureColumn` is met: c7 `D1 4`, c8 `D1 2`. c4 and c5 are clean, and
c5's `G2 fail` names the real unresolved symbol rather than the aliased path.

## Why this run does not count

`countsTowardsShipBar: false`, by `calibrate.mjs finalize`, for the reason at
the top of this file: a probe is not one of the two runs, and this model was
spent before it started.
