# Pass 8 score (rubric 1)

Produced by the calibration scorer against `expected.json`.

```
=== run A
  c1: reject  gates FPPPP D14 D22 D31 D43 D53 D63  OK
  c2: revise  gates FFFFF D13 D22 D33 D42 D51 D64  OK
  c3: revise  gates PPFPP D14 D23 D33 D43 D53 D64  OK
  c4: pass    gates PPPPP D14 D23 D33 D43 D53 D64  OK
  c5: revise  gates PFPPP D14 D23 D33 D43 D53 D64  OK
  c6: revise  gates PPPPP D12 D23 D33 D43 D53 D64  OK
=== run B
  c1: reject  gates FPPPP D14 D22 D31 D43 D53 D64  OK
  c2: revise  gates FFFFF D13 D22 D32 D43 D51 D64  OK
  c3: revise  gates PPFPP D14 D23 D34 D43 D53 D64  OK
  c4: pass    gates PPPPP D14 D23 D34 D43 D53 D64  OK
  c5: revise  gates PFPPP D14 D23 D34 D43 D53 D64  OK
  c6: revise  gates PPPPP D12 D23 D34 D43 D53 D64  OK
gate agreement: 30/30 
cases with a miss: 0
```
