# History-fidelity Scan Results — dropped tool-call arguments (issue #15)

Captured: 2026-10-15
Probe: `node probes/history-fidelity-scan.mjs`
Corpus: 161 transcripts in `~/.pi/agent/sessions`, 68 with tool use, 625 tool calls, 591 tool results

## Verdict: leave it

`serializeMessage` drops assistant `toolCall` blocks and renders only `tool="<name>"` plus the
result, so a full resend shows kiro an answer with no record of the arguments. Measured, that loses
something unrecoverable in 5.9% of calls, all of them idempotent reads, while rendering the
arguments back in costs +75% of all `tool_result` text and re-exposes the arguments of exactly the
tools kiro was observed re-issuing. Issue #15 closed as working as intended.

---

## Evidence

### The arguments are in the transcript, only not in the prompt

```
results joinable to their call by toolCallId: 591 of 591
```

Every result carries a `toolCallId` that joins back to the dropped `toolCall` block, so rendering
arguments needs no invented data. The question is only whether it is worth the bytes.

### The case the issue was filed over does not occur

`ask_user_question`: **23 calls, 0** without sibling assistant text in the same message. The
replayed history always said what was being asked.

```
is the call recoverable from the replayed history?
  text in the same assistant message   568 (90.9%)
  only prose earlier in the turn        20 (3.2%)
  NO assistant prose anywhere           37 (5.9%)
```

### What the unrecoverable 5.9% is

```
read 19, bash 12, Agent 4, todo 1, block 1      (bridged 5, not bridged 32)
```

The loss is "which file, what range" and "which shell probe". Worst outcome when kiro cannot tell
which file a replayed body came from is that it re-reads the file: idempotent and self-correcting.
The failure `82c591e` fixed was asking the user the same question twice and re-firing subagent
dispatches at reaped agent ids: user-visible, and not self-correcting. That asymmetry is the call.

### Rendering arguments on every result is not cheap

```
tool_result bytes as serialized today: 184774
  args on every result:                +139256 (+75.4%)

argument JSON size in bytes:
  p50 144  p90 411  p99 1093  max 13072
```

The tail is the reason: a `write` call's arguments *are* the file body, so this duplicates written
files into the prompt on every resend.

---

## Fallback, if a repro ever lands

Not implemented. Specified and measured so it does not have to be re-derived:

> On a `tool_result`, render the arguments only when the paired `toolCall` carried no assistant
> prose **and** the tool is not in `bridgedTools`.

The second condition is the hazard boundary rather than a hand-written denylist: a tool that is not
bridged has no `@pi/<name>` handle for kiro to re-issue through, and `DEFAULT_BRIDGE_TOOLS` is
precisely the interactive and dispatch set. `serializeMessage` would need `bridgedTools` threaded
in, which `buildScaffolding` already receives.

```
scoped: no prose and not bridged:    +1788 (+1.0%) over 32 results
scoped and capped at 200 bytes:      +1788 (+1.0%)
```

Covers 32 of the 37 unrecoverable calls, leaves the other 5 alone because they are bridged, needs
no truncation cap, and renders zero arguments for any tool kiro could re-issue. It would also
require narrowing the `stream-adapter.test.ts` assertion that arguments "must not survive in any
form" to bridged tools only.

The bar for building it is a concrete delegated-turn mis-step caused by the missing arguments.

---

## Re-running

The verdict rests on the tool mix in the corpus. `node probes/history-fidelity-scan.mjs --selftest`
checks the counting against a synthetic transcript with hand-derived expectations and confirms
`DEFAULT_BRIDGE_TOOLS` still parses out of `src/bridge.ts`. `--json` emits the raw counters,
`--sessions DIR` points at another transcript root, `--bridged a,b` overrides the bridged set.
