# Pass 8 score (rubric 1) - WITHDRAWN

**The 30/30 below is not evidence about the rubric.** The answer key was
relabelled (c1 G1) because both of these runs failed that gate, and then these
same two runs were scored against the new key with nothing re-run. The ship bar's
rule 4 forbids resolving a miss by choosing a run, and it had no clause covering
a relabel; it now does (`../README.md`, ship bar rule 4, and `expected.json`
`shipBar.relabelling`). The arithmetic below is correct and reproduces exactly;
what it measures is two runs against a key fitted to them. Both runs are kept as
history, with `countsTowardsShipBar: false` in their `RUN.json`.

Produced by `node spec-review/calibration/score.mjs runs/2026-10-17-r1-other-claude-opus-5-5 runs/2026-10-17-r1-other-gpt-6-astra` against `expected.json` (run A is the Claude run, run B the GPT run). The scorer was committed after the fact; it reproduces every case line and both totals below, and names each run by its directory where the original said run A and run B.

```
=== run A (2026-10-17-r1-other-claude-opus-5-5)
  c1: reject  gates FPPPP D14 D22 D31 D43 D53 D63  OK
  c2: revise  gates FFFFF D13 D22 D33 D42 D51 D64  OK
  c3: revise  gates PPFPP D14 D23 D33 D43 D53 D64  OK
  c4: pass    gates PPPPP D14 D23 D33 D43 D53 D64  OK
  c5: revise  gates PFPPP D14 D23 D33 D43 D53 D64  OK
  c6: revise  gates PPPPP D12 D23 D33 D43 D53 D64  OK
=== run B (2026-10-17-r1-other-gpt-6-astra)
  c1: reject  gates FPPPP D14 D22 D31 D43 D53 D64  OK
  c2: revise  gates FFFFF D13 D22 D32 D43 D51 D64  OK
  c3: revise  gates PPFPP D14 D23 D34 D43 D53 D64  OK
  c4: pass    gates PPPPP D14 D23 D34 D43 D53 D64  OK
  c5: revise  gates PFPPP D14 D23 D34 D43 D53 D64  OK
  c6: revise  gates PPPPP D12 D23 D34 D43 D53 D64  OK
gate agreement: 30/30 
cases with a miss: 0
```

# Held-out run (rubric 1, unchanged)

A third run by a harness and model that took no part in passes 1 to 8:
kiro-cli 2.32.0, `claude-sonnet-5`. It is the honest measurement of Rubric 1 as
pass 8 left it, because nothing was changed before or after it and it ran from a
clone that could not reach the key. Protocol and the reasons for each miss:
`2026-10-17-r1-kiro-cli-claude-sonnet-5/NOTES.md`.

```
=== 2026-10-17-r1-kiro-cli-claude-sonnet-5
  c1: revise  gates FPPPP D14 D21 D31 D44 D54 D64  MISS: outcome revise (want reject)
  c2: revise  gates FFPPF D14 D23 D33 D43 D51 D64  MISS: G3 pass (want fail); G4 pass (want fail)
  c3: revise  gates PPFPP D14 D23 D33 D44 D53 D64  OK
  c4: pass    gates PPPPP D14 D24 D34 D44 D53 D64  OK
  c5: revise  gates PFPPF D14 D24 D32 D44 D54 D64  MISS: G5 fail (want pass)
  c6: revise  gates PPPPP D12 D24 D34 D44 D54 D64  OK
gate agreement with run A: 27/30  (disagree: c2 G3, c2 G4, c5 G5)
gate agreement with run B: 27/30  (disagree: c2 G3, c2 G4, c5 G5)
cases with a miss: 3
```

Pass 8's 30/30 does not hold for a reviewer the set was not tuned on.

Two of the three misses were wording defects and are now fixed in the rubric:
`reject` outranks `revise` (c1), and G5 judges an out-of-scope item's sentence
rather than whether its named target resolves (c5). The third, c2 G3 and G4, is a
pair of judgement labels awaiting the maintainer's ratification and was left
alone (`expected.json` `labelledBy`).

# Where Rubric 1 stands

**No run counts.** All three run directories record pre-review blobs in
`RUN.json`, and ship bar rule 5 counts a run only when its recorded blobs match
the committed ones, so the wording fixes above staled every run on purpose. That
is the mechanism working: a stale run is now visible rather than plausible.

The bar needs two fresh passes, at a comparable capability level, by models that
took part in no pass and no wording fix (rules 6 and 7). Four models are spent:
`claude-opus-5-5` and `gpt-6-astra` (passes 1 to 8), `claude-sonnet-5` (the
held-out run, whose misses drove two of the fixes), and `claude-opus-4.8` (it
reviewed the bus spec from a worktree sharing this branch's object database, so
it could read the key). Until those two passes are committed, the spec's
criterion 12 is unmet and the README says so.
