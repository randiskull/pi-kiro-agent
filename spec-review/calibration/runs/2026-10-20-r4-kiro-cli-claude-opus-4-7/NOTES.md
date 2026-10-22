# Rubric 4, probe run A: kiro-cli 2.32.0, claude-opus-4.7

**This run is a probe, and it was never eligible to count.** `claude-opus-4.7`
is in `shipBar.spent`: it ran Rubric 3's first pair, and Rubric 4's two fixes
answer that pair's misses directly, so it is inside the tuning loop under
`shipBar.heldOut`'s narrow reading as well as its broad one. It is re-run here
under `shipBar.capabilityMatched`, which allows a non-gating probe, because the
tightest available test of a fix is the model that committed the defect, asked
again. Its partner is `../2026-10-20-r4-pi-us-anthropic-claude-opus-4-6-v1` and
the paired score is in `../SCORE.md`.

Nothing in the rubric, the cases or `expected.json` was touched between these
verdicts being collected and the pair being scored.

- Harness: `kiro-cli` 2.32.0,
  `kiro-cli chat --no-interactive --trust-all-tools --agent reviewer`, with a
  per-session agent carrying `mcpServers: {}`.
- Model: `claude-opus-4.7`, a kiro-cli model id. Seat billed through the
  official client; no model endpoint was called directly.
- Eight sessions, one per case, all exited 0, 230s to 374s each.
- Isolation audit clean for all eight. Zero `Reviewer:` line corrections.
- Lint's `notes` were handed over per case and lint's result withheld, per
  `shipBar.blind`; the alias file was placed in the clone at the path c1, c3,
  c4, c5 and c6 cite, per `shipBar.aliasResolves`.

## Result

**Four of eight cases miss.** Rubric 3's run A also missed four. The count did
not move; which things miss moved a great deal.

### What Rubric 4 was written for

| fix | case | result |
| --- | --- | --- |
| G3's two new Fails entries | c2 | **`G3 fail`.** Correct for the first time in this model's history with the case |
| the dimension ceiling | c1 | **`D3 1`.** Correct; it was `D3 2` under Rubric 3 |
| the outcome read-back | c1 | **`reject`.** Correct; it was `revise` under Rubric 3 |

All three landed. c2's G3 had been the set's second both-miss after the feature
column, and c1's `D3`/outcome pair was two of the three sightings of the
anchor-row off-by-one.

### What it did not reach, and the one thing it made worse

- **c1's `G1` now passes, and it failed correctly under Rubric 3.** The verdict
  finds the overturned decision and files it in *four* `D3` findings and one
  `D2` finding, and never asks G1 of it. That is the failure mode Rubric 3's
  `Not G1` bullet and procedure step 4 were written for, and the plainest
  reading of this verdict is that Rubric 4's read-back step made it worse by
  pointing a reviewer's last pass at the dimension tables. One run cannot
  settle that against session variance; run B failed c1's G1 correctly, so the
  pair disagrees here and the disagreement is recorded, not acted on.
- **c1's `D2` is 3 with a `D2` finding that describes anchor 2** ("asserted
  ... but not argued at the mechanism level"). That is the anchor-row off-by-one
  again, on a dimension the set had never seen it on, in a run where the same
  rule corrected `D3` in the same verdict. The ceiling is not carrying across
  dimensions.
- **c2's `G2` now passes, and it is this run's own harness fix that most likely
  did it.** c2's G2 fails on three claims credited to sources the spec never
  names. Lint's notes cannot list those: they are prose attributions, not
  unresolved paths or symbols. A reviewer handed the notes and told they are
  step 3's input has a plausible route to reading G2's reviewer half as the
  notes and nothing more. Both runs of this probe pass c2's G2, which is a new
  both-miss and the first evidence that handing over the notes has a cost.
- **c3's `G3` and outcome still miss**, unchanged from Rubric 3. c3 is built by
  deleting the negative-control bullet outright, so its G3 is lint's half, and
  this run reads the section as satisfied. Run B caught it this time.
- **c6's `D1` is 3 and its outcome `pass`**, and this is not an off-by-one. The
  `D1` finding is about missing provenance, which is anchor 3's second half, not
  about the hedged cause anchor 2 is written for. Both runs of this probe did
  the same thing. They identified a different defect, which is why both also
  miss c6's `mustQuoteOneOf` string: that string is the hedge.
- **c8's `mustQuoteOneOf` miss is the key's, not this run's.** The `D1` finding
  is correct in tag, score and reasoning, and it quotes `"## Problem"` because
  the rubric's Findings section says a finding about something missing quotes
  the nearest heading. `## Problem` was not in c8's list. It is added in the
  same commit, which stales this run; see `../SCORE.md`.

### Unchanged and still right

`shipBar.featureColumn` is met: c7 `D1 4`, c8 `D1 2`. c4 and c5 are clean. c5's
`G2 fail` names the real unresolved symbol rather than the aliased path, which
is `shipBar.aliasResolves` working.

## Two notes on the run itself

**The capability-match concern from Rubric 3's pair is much reduced.** There,
run A spent 63s to 78s per case against run B's 219s to 431s, which was
disclosed as unresolved. Here it is 230s to 374s against 313s to 527s: the same
order, overlapping ranges. Whatever the first pair's asymmetry was, it was not a
fixed property of the two harnesses.

**Two verdicts carry no findings** (c3 and c7). c7 is `pass` on every gate and
dimension, so no finding is required and none is a defect. c3's is: the verdict
answers `pass` and the key says `revise`, so a findings-free verdict is the
shape a wrong answer takes here rather than an extra problem.

## Why this run does not count

`countsTowardsShipBar: false`, by `calibrate.mjs finalize`, for the reason at
the top of this file: a probe is not one of the two runs, and this model was
spent before it started.
