# Rubric 2, pair 1 of 1, run B: pi 1.3.0, us.anthropic.claude-opus-5 on Bedrock

The second of the pair. Same runner, same protocol and same conditions as run A
(`../2026-10-19-r2-kiro-cli-gpt-5-6-terra/NOTES.md`, which carries the full
protocol, the reviewer-agent deviation and the voided first attempt); this file
records only what is specific to this run. The paired score is in `../SCORE.md`.
Nothing in the rubric, the cases or `expected.json` was touched after these
verdicts were collected.

- Harness: `pi` 1.3.0 (`@earendil-works/pi-coding-agent`, public on npm),
  `pi -p --no-session -nc -ne -ns -np --no-mcp --provider amazon-bedrock`.
- Model: `us.anthropic.claude-opus-5`, a US cross-region inference profile on
  Amazon Bedrock in `us-west-2`. Both identifiers are public.
- Eight sessions, one per case, all exited 0, 219s to 431s each.
- Isolation audit clean for all eight. Zero `Reviewer:` line corrections.

A different harness and a different provider route from run A, which satisfies
the README's requirement that the two runs differ in harness or model. They
differ in both.

## Result

**Three of eight cases miss, so the ship bar is not met.**

| case | miss | what the verdict says |
| --- | --- | --- |
| c3 | `outcome pass` and `G3 pass`, key `revise`/`fail` | It missed the mutation. c3 is c4 with the fail-first step removed: the unit test is still described, but nothing says to run it against the unfixed `bridge.ts`, and the manual reproduction runs only after the change. This run passed all five gates and filed two findings on other things (`D3` on `§5` of the design doc not being cited beside `§5e.3`, `D5` on the patch bump not being justified). **Run A caught this one**, so c3 G3 is reviewer variance, not a wording defect. |
| c6 | no finding quotes any `mustQuoteOneOf` string | **A one-character miss, and the defect is in the key rather than in the verdict.** The key's string is `The bridge probably holds the loop open.` with the sentence's full stop. The run's first `D1` finding quotes `The bridge probably holds the loop open` without it, and is otherwise exactly the finding the key is asking for: it names the hedged central link, cites the preload snapshot as proof and scores `D1 2`. `score.mjs` matches by substring, so the period fails it. The rubric does ask for a verbatim quote, so the verdict is technically imperfect; treating that as a calibration miss measures punctuation, not judgement. See the item below. |
| c8 | `D1 4`, key `<=2`; no finding quotes any `mustQuoteOneOf` string | **It did not read D1's feature column either**, which is the same miss run A made and the result that matters most in this pair. It did reach `outcome revise`, but on unrelated grounds: two `D3` findings about `docs/design/v3-engine.md` keeping its "design, not implemented" status line while the same PR marks R8 and R9 built, and about the in-scope list omitting the R11 edit. Both are real. Neither is the Problem being asserted instead of measured, and it scored c7 and c8 at `D1 4` alike. |

Five cases are right, and one of them is the most valuable single verdict in
either run.

## c1: the first run to reach the key's reading of G1

**This run failed c1's G1, and derived it the way the key does.** Three previous
models (`us.anthropic.claude-fable-5-1`, `gpt-5.6-sol`, and run A's
`gpt-5.6-terra`) all passed that gate and filed the defect as `D2` or `D3`,
reading c1 as a decided-but-wrong design rather than an open contract. This one
wrote:

> removing the resume branch bypasses what the turn planner relies on for
> multi-turn conversations, and the spec does not say what replaces it:
> `streamViaAcp` still computes `plan` from `planAcpTurn()` and builds
> `buildDeltaPrompt(context.messages.slice(plan.deltaStart), ...)` whenever
> `plan.mode === "resume"`, so a resumable turn would send only the delta into a
> brand-new kiro session that holds no history. The spec names interactive
> sessions, `/resume`, `fork` and `reload` as cases, so the case is undecided
> rather than impossible.

That is the key's reason, independently, from the code at `61bb96f`. It settles
the open item from the Rubric 1 pair in the key's favour: **c1's `G1 fail` is
re-derivable from how the case is constructed, so `shipBar.relabelling` is
satisfied and the label stays.** What remains is that one reviewer in four
reaches it, which is a question about G1's `Fails` list, not about the label.

## The feature column

`shipBar.featureColumn` requires both runs to separate c7 from c8 on D1, c7 at 3
or more and c8 at 2 or less. This run scores both at 4, and so does run A.
**The pair does not meet that rule**, independently of the 40 gate decisions and
independently of every wording question. The c7/c8 pair was added to the set to
catch exactly this, on its first outing, and it did.

## New item for the next rubric revision: the must-quote match

`expected.json`'s `mustQuoteOneOf` strings are matched as substrings of a
finding's line. c6's single string ends in a full stop because the sentence in
the case does. A finding that quotes the sentence without its terminal
punctuation is not a different claim, and this run's c6 finding is on the exact
text the key names, with the right tag and the right score. Two ways to close
it, both rubric-side work that stales committed runs:

1. Normalise before matching: strip terminal `.`, `,` and `;` from both the key
   string and the finding text. This is a `score.mjs` change plus a note in
   `expected.json`.
2. Keep the strings free of terminal punctuation, so the key never asks for a
   character the reviewer has no reason to carry.

Option 2 is the smaller change and keeps the matcher simple. Neither was applied
here: `score.mjs` was not touched after these verdicts were collected, so the
`MISS` line in `../SCORE.md` is the measurement as taken, with this note beside
it saying what it measures.

## Protocol notes specific to pi

- `--no-mcp` and `-np` (no project context) were passed, so the session had no
  MCP server and did not read a project configuration. Run A needed a
  per-session agent file to get the same property out of kiro-cli.
- `--no-session` and `-nc` keep each case a single stateless turn with no
  conversation carried in, which is what "a fresh session per case" means here.
- `AWS_REGION=us-west-2` was set for the session; no other AWS variable was
  passed, and the credentials in scope are the ambient ones.
- Sessions ran three to seven minutes each. No session hit the 60-minute
  timeout, and none wrote to stderr.
