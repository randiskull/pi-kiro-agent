# Pass 8 score (rubric 1)

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
kiro-cli 2.32.0, `claude-sonnet-5`. Protocol and the reasons for each miss:
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

Pass 8's 30/30 does not hold for a reviewer the set was not tuned on. Per the
README's ship bar, each miss is a wording problem to fix in the rubric (c1: the
outcome table's precedence; c5: whether G5's "named spec" must exist), or a
label to revisit (c2 G3 and G4), followed by a re-run of both passes.
