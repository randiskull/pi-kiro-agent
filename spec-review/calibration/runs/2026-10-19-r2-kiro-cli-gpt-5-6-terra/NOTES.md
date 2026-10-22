# Rubric 2, pair 1 of 1, run A: kiro-cli 2.32.0, gpt-5.6-terra

The first run ever made against Rubric 2, and the first made by
`scripts/calibrate.mjs` rather than by hand. Its partner is
`../2026-10-19-r2-pi-us-anthropic-claude-opus-5`, and the paired score is in
`../SCORE.md`. Nothing in the rubric, the cases or `expected.json` was touched
after these verdicts were collected; the blobs scored against are in `RUN.json`
and `score.mjs` reports them as matching.

- Harness: `kiro-cli` 2.32.0,
  `kiro-cli chat --no-interactive --trust-all-tools --agent reviewer`.
- Model: `gpt-5.6-terra`, from kiro-cli's own `--list-models` output. Seat
  billed through the official client; no model endpoint was called directly.
- Eight sessions, one per case, all exited 0, 63s to 78s each.
- Isolation audit clean for all eight. Zero `Reviewer:` line corrections: the
  runner writes the line into the prompt and checks it, so the guess-your-own-model
  defect from the Rubric 1 pair cannot recur.

## Result

**Four of eight cases miss, so the ship bar is not met.**

| case | miss | what the verdict says |
| --- | --- | --- |
| c1 | `G1 pass`, key `fail` | A third independent reading of c1 as a decided-but-wrong design rather than an open contract. It found the defect and filed it elsewhere: `D3` on the Approach overturning `docs/design/acp-transport.md` §5e.3 against the Goal's "invariant is preserved" claim, and `D2` on the safety argument never reaching a second bridged turn. This is the same place `us.anthropic.claude-fable-5-1` and `gpt-5.6-sol` put it. **Its partner run failed G1, from the key's exact mechanism**, so the label is now defensible and the gate's wording is what does not carry it reliably. |
| c2 | `G2 pass`, key `fail` | It raised ten findings (`G1` x2, `G3`, `G4` x2, `G5`, `D2`, `D3`, `D5` x2) and not one on a source. The key fails G2 on three unnamed sources, any one sufficient. The reviewer simply never audited citations, which is not a reading of G2 at all. Its partner failed all five gates on c2, including G2. |
| c6 | `G5 fail`, key `pass` | **A new wording question, not covered by Rubric 2's G5 fix.** It failed the out-of-scope item "Credit-metering rebuild on `session_start`. Follow-up spec, owner: the maintainer." because the item names no *specific* spec, issue or owner. G5 asks for "a named spec, issue or owner" and then says it "judges the sentence, not the citation", which settles existence and says nothing about specificity. A role ("the maintainer") is a sentence that decides where the item goes while naming no one. The gate does not say whether that counts. |
| c8 | `outcome pass` (key `revise`); `D1 4` (key `<=2`); no finding quotes any `mustQuoteOneOf` string | **It did not read D1's feature column.** Its c7 and c8 verdicts are byte-identical apart from the header blob: all five gates pass, every dimension 4, and `## Findings` empty in both. c8's whole construction is c7 with the Problem's two measured subsections replaced by the same claims asserted, so a reviewer scoring them the same has not looked at the one thing the pair discriminates (`expected.json` `shipBar.featureColumn`). The session logs show it did work (it reports verifying the reader, the design references, the v2 event count and the out-of-scope ACP path) and concluded there was nothing to report. |

Four cases are right, and two of them matter: **c3's `G3 fail` was caught here
and missed by the partner run**, and c5's `G5 pass` holds, confirming the Rubric
1 item-20 rewrite for a third time.

## The feature column, and what it costs this run

`shipBar.featureColumn` is a rule of its own because the 40 gate decisions do not
measure it: c7 and c8 are labelled `pass` on all five gates, so the pair added
ten gate decisions and no fail, and D1 is the only thing it separates. This run
scores both at 4. So does the partner. **Neither run in this pair read the
feature column**, which is the single clearest result of the pair and is
independent of every wording question below it.

## A disclosed concern about capability

`shipBar.capabilityMatched` asks the two runs to be at a comparable level,
because a strong-weak pair cannot distinguish an ambiguous rubric from a
reviewer that could not do the task. Both models here are current flagship ids,
which is the defensible reading. Against it: this run spent 63s to 78s per case
where the partner spent 219s to 431s, and it returned two verdicts with empty
findings. That is a four-to-five-fold difference in effort on the same eight
prompts. It is recorded rather than resolved, because resolving it means
re-running this lane on a third model and spending it under rule 6.

## Protocol

`node scripts/calibrate.mjs run --harness kiro-cli --model gpt-5.6-terra`. The
runner is documented in `../README.md` ("The runner") and tested in
`test/calibrate.test.ts`. What it enforces, per case:

- **A ref-stripped clone, not a worktree, and `origin` removed.** One base clone
  per ref (`61bb96f` for c1-c6, `68ffb40` for c7 and c8) by
  `git clone --no-local --no-checkout`, then `git remote remove origin`, every
  ref deleted, `reflog expire`, `gc --prune=now`. The earlier hand runs kept
  `origin` pointing at a repository that holds the answer key on this branch;
  this one cannot fetch it.
- **One working copy per session.** Each case gets its own copy of the base in
  its own `s-XXXXXX` directory. The Rubric 1 pair ran its sessions against one
  shared checkout, so a session could have written where another was reading.
- **One input directory per case** under a neutral `in-XXXXXX` name outside the
  repository, holding only `rubric.md`, that case's `spec.md` and the alias file
  the case cites. The verdict path is given explicitly.
- **The README's prompt word for word** except for the substituted paths, with
  the `Reviewer: kiro-cli, gpt-5.6-terra` line supplied, step 1 (lint) skipped,
  no lint output given.
- **The header blob is checked** against `git hash-object` of the spec the
  session was given, after the fact, for all eight.

## Deviation from the Rubric 1 runs: the reviewer agent

The Rubric 1 pair's sessions had an MCP workspace-search tool available, which
the protocol does not grant, and that run's `NOTES.md` says the next run should
pass an empty MCP configuration. This run does.

**The first attempt at this pass was voided for exactly that reason.** It ran
under this machine's default kiro-cli agent and an MCP search tool ran inside
reviewer sessions; it was killed and no verdict from it was kept or scored.
`--trust-tools=fs_read,fs_write,execute_bash` does not close the hole, which was
smoke-tested: the MCP tool still runs. What closes it is a per-session agent
written into the session's own copy at `.kiro/agents/reviewer.json`, with
`mcpServers: {}` and `includeMcpJson: false`, selected by `--agent reviewer`. A
smoke test confirms a session under it reports "No MCP tool is available" while
`fs_read`, `fs_write` and `execute_bash` all work. The agent goes in the session
copy because the user-level agent directory is outside the writable boundary,
which is the better place for it anyway: it cannot leak into the next run.

## Isolation

Audited after each session over its stdout, stderr and verdict, for the names
`expected.json` and `calibration`, the key-only strings (`mustQuoteOneOf`,
`labelledBy`, `shipBar`, `countsTowardsShipBar`, `reject by construction`,
`the false-fail control`, `D1 is exactly 2, not 1`, `frozen from the maintainer`),
any case file other than the session's own, and any input directory other than
its own. **Clean for all eight.** The base clones were re-checked for the rubric,
key and case blobs after the last session, as they were before the first.

No session in this pass probed for `spec-review/` or `calibration`, so the one
moment of the Rubric 1 pair that tested the clone's emptiness did not recur here.
