# pi-kiro-agent: kiro-cli v3 engine support

Status: **design, not implemented.** Measured against kiro-cli 2.32.0 / KAS 0.66.43 and
pi 1.3.0 on 2026-10-17. None of the code it proposes has been written. A second probe
pass the same day (a tool-using turn and a `--resume-id` turn, section 3.7) settled S2
and S4 and found the tool-naming break behind R12.

## 1. Where we are

The engine is a compile-time constant in two places, deliberately pinned so that a
kiro-cli upgrade cannot switch engines under us and make the identity line lie:

```ts
// src/identity.ts
export type KiroEngine = "v2" | "v3";
export const CHAT_ENGINE: KiroEngine = "v2";   // stream-adapter.ts argv
export const ACP_ENGINE: KiroEngine = "v2";    // acp-transport.ts argv
```

Both transports pass `--agent-engine v2` explicitly. `v2` also happens to be the CLI's
own default, so the pin is belt and braces.

## 2. Two claims in our own docs are wrong

Both predate the measurements in section 3 and should be corrected regardless of whether
v3 support is built.

| claim | where | status |
|---|---|---|
| "v3 currently has no working headless mode" | `README.md` | **FALSE.** `chat --no-interactive --agent-engine v3` answers correctly. |
| "v3 floods stdout with `[INFO] kas.*` lines - poison for the text scrape" | working notes | **Half true.** Under `--output-format stream-json` the flood is entirely on **stderr**; stdout is 100% valid JSON Lines. It is only poison for the `text` format. |

The second is the finding that makes this worth doing now: v3's noise does not touch the
stream-json channel at all.

## 3. Measured: v2 vs v3 on `chat --output-format stream-json`

Same prompt ("reply with the single word OK"), same binary, engine flag the only variable.
`chat` accepts the transport's full argv on v3, `--trust-all-tools` included: only `acp`
rejects that flag (3.6).

```
v2:  7 stdout lines  {runStarted:1, metadata:3, sessionUpdate:2, runFinished:1}
v3: 35 stdout lines  {runStarted:1, sessionUpdate:33, runFinished:1}
```

Both stdout streams parsed 100% as JSON. v3's stderr carried 12 non-JSON lines
(`[INFO] kas.server.starting`, `[INFO] Auth: --auth=acp-callback ...`, an
`ExperimentalWarning` about SQLite) and v2's carried none.

### 3.1 The envelope is unchanged

```json
v2  {"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v2"}}
v3  {"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v3"}}
```

`runFinished` is the same shape on both, including `finalText` and `finalTextTruncated`.
So the strict envelope check, the answer source and the terminal classification in
`src/stream-json-reader.ts` need no change. **This is the whole reason v3 is cheap on
this route.**

### 3.2 v3 emits no `metadata` event. Everything it carried moved

v2's three `metadata` events are the sole source of credits, context usage and turn
duration. v3 sends none. The same figures exist, inside
`sessionUpdate / session_info_update / _meta.kiro`:

| datum | v2 | v3 |
|---|---|---|
| credits | `metadata.meteringUsage[].value`, `unit`, `unitPlural` | `_meta.kiro.promptTurnSummaries[].usage`, `unit`, `unitPlural` |
| context % | `metadata.contextUsagePercentage` | `_meta.kiro.contextUsage.usagePercentage` |
| turn duration | `metadata.turnDurationMs` | `_meta.kiro.elapsedTime` |
| stop reason | `runFinished.stopReason` | same, plus `_meta.kiro.turnEnd.stopReason` |
| reasoning support | `metadata.reasoning` | `config_option_update.configOptions` (a `select` named `mode`) |

Receipts from the probe turn:

```json
promptTurnSummaries = [{"unit":"credit","unitPlural":"credits","usage":0.5294822775456054}]
elapsedTime = 2239
turnEnd = {"stopReason":"end_turn"}
```

Two traps in that table:

- **The credits field is `usage`, not `value`.** A reader that assumes v2's key name
  reads `undefined` and prices the turn at zero, silently.
- **The context percentage is mostly null.** Across 22 `session_info_update` events the
  values were `[4.49 x10, null x6, 4.49, 7.62, 7.62, null x3]`. "Last wins", which is
  what the v2 path does, yields **null**. v3 needs **last non-null**.

### 3.3 v3 sends four update kinds we have never seen

```
available_commands_update  x5    steering files, offered as slash commands
config_option_update       x3    mode select (vibe | spec | ...), effort levels
session_info_update       x22    the metering/context payload above, plus a token breakdown
tool_call / tool_call_update      an INTERNAL tool, every turn
```

`src/stream-json-reader.ts` documents that unknown `sessionUpdate` subtypes are ignored,
so the first three are dropped harmlessly today. The fourth is not:

```json
{"sessionUpdate":"tool_call","toolCallId":"b70c...","title":"Fetching your cloud config",
 "status":"in_progress","_meta":{"kiro":{"toolId":"fetch_cloud_config"}}}
```

We handle `tool_call`, so **v3 would paint a tool row on every single turn**, for a tool
the user did not ask for. The row would not even say "Fetching your cloud config": the
reader names rows from `_meta.kiro.toolName`, which this payload lacks, so it would read
`kiro_unknown` with empty arguments. See 3.7 for why that naming break is not confined
to the internal call.

### 3.4 The thinking channel exists

The one-word probe sent zero `agent_thought_chunk` events, as v2 does for that prompt.
The tool-using turn in 3.7 sent five, so v3 feeds the thinking block the same way v2
does (S4, settled).

### 3.5 A missing agent profile is worded softly on v3, but still fails hard

```
v2  runError stage=init  "failed to set agent 'X': Mode 'X' not found"
v3  runError stage=init  "agent \"X\" not found, using \"default\""
```

Both exit 4 with no model call, and on v3 that holds **with and without**
`--require-mcp-startup`, so a missing profile is detectable today. Only the wording is
soft: it says v3 *would continue with the default agent*. The MCP bridge is mounted
entirely through that profile, so if a later v3 demotes this to a warning, a turn would
run with none of pi's tools and look successful. A test should pin the exit-4 behaviour
so that change is loud, but the larger open risk in S1 is the other half: whether v3
reads our profile format at all.

### 3.6 ACP under v3 is a different project

```
$ kiro-cli acp --agent-engine v3 --trust-all-tools
error: the following arguments are not supported with --agent-engine=v3: --trust-all-tools
```

`src/acp-transport.ts` spawns exactly that. v3 on ACP therefore means implementing
`session/request_permission` and a permission policy, not flipping a flag. v3 also adds
an ACP-only `--auth-method cli|client` (`chat` does not accept it) for host-mediated
token refresh via `_kiro/auth/getAccessToken`.

### 3.7 Tool calls, resume and per-turn credits

A turn that had to read a file drew one internal call and one real call:

```json
{"sessionUpdate":"tool_call","title":"Fetching your cloud config","status":"in_progress",
 "_meta":{"kiro":{"toolId":"fetch_cloud_config"}}}
{"sessionUpdate":"tool_call","toolCallId":"tooluse_...","title":"Read File","kind":"read",
 "rawInput":{"path":".../note.txt","offset":null,"limit":null},
 "_meta":{"kiro":{"toolOrigin":"default"}}}
```

**v3 tool calls carry no `toolName`.** The reader names every row from
`_meta.kiro.toolName ?? "unknown"` and prefixes it by `mcpServerName`, and drops an
update-only failed call that has no `toolName`. So on v3 every built-in row would read
`kiro_unknown`, update-only failures would vanish, and pi's own bridged tools, which
show their bare names only when `mcpServerName` matches the bridge key, are at risk too
(S1). `rawInput` is complete on v3, so arguments survive; only the name is lost. The
tool's own name does appear once, after the fact: the turn's `promptTurnSummaries` entry
carried `"usedTools":["read_file"]`. That arrives with the credits, too late to name a
row while it is live, but it is the only place the probes show it.

The two calls differ on every field that could tell them apart:

| | `toolId` | `toolOrigin` | `kind` | `rawInput` |
|---|---|---|---|---|
| internal `fetch_cloud_config` | yes | absent | null | null |
| real `Read File` | absent | `default` | `read` | complete |

**Resume works.** `--resume-id sess_<uuid>` resumed the first probe's session, and both
turns' `runFinished.sessionId` carried the same id. The reader takes the session id from
`runFinished` before `metadata`, so v3's missing `metadata` does not cost us the id
(S2, settled).

**Credits are per turn, priced once.** Each of the three turns carried exactly one
`session_info_update` with `promptTurnSummaries`, holding one entry. The resumed turn
read 0.060 after the first turn's 0.106, with no entry for the prior turn, so summing a
turn's entries does not double-charge on resume. Neither the tool turn nor the resumed
turn sent a `metadata` event (S3, two more samples).

## 4. Requirements

Numbered so they can be argued with individually. Each one is meant to be testable.

**Scope and selection**

- **R1** The engine is selectable at runtime instead of being a compile-time constant:
  `PI_KIRO_ENGINE=v2|v3`, default **v2**. An unrecognised value keeps v2 and traces once,
  matching how `PI_KIRO_TRANSPORT` handles a typo rather than silently downgrading.
- **R2** `v3` is accepted only on `chat/stream-json`. `v3` + `chat/text` and `v3` + `acp`
  are refused with a message naming the reason: in `text` mode v3's `[INFO]` lines land
  on stdout, which the scrape reads, and ACP is blocked by R-ACP below. Refusing beats a
  route that half works.
- **R3** The identity line reports the engine actually spawned, not the requested one.
  The line already carries an engine slot: `pi 1.3.0 via Kiro (kiro-cli 2.32.0, engine
  v3, chat/stream-json) on auto`. The source of truth is `runStarted.data.engine`, and a
  value that differs from the requested engine is an envelope violation, so a CLI that
  quietly substitutes an engine fails the turn instead of mislabelling it.

**Parity, because a route that silently stops reporting cost is worse than no route**

- **R4** Credits on v3 come from `session_info_update._meta.kiro.promptTurnSummaries[]`,
  reading `usage` (not `value`) with `unit`/`unitPlural`, and reach the same metering
  record and credits footer as v2. A turn that produces no summary attaches no record,
  rather than a record of zero. The probes show one priced event per turn whose entries
  cover that turn only (3.7), so the turn's entries are summed, as v2's are, and a
  second priced event falls under R7.
- **R5** Context usage on v3 comes from `_meta.kiro.contextUsage.usagePercentage`, taking
  the **last non-null** value. A test must pin a fixture whose last event carries null,
  because that is what the real stream does and "last wins" returns null for it.
- **R6** Turn duration on v3 comes from `_meta.kiro.elapsedTime`.
- **R7** A turn priced more than once still traces `chat.stream.metering_repriced`, as
  the v2 path does. v3 sends 22 info events, so repricing is likelier here, not less.

**Not making the output worse**

- **R8** v3's internal tool calls do not draw tool rows, and kiro's built-in tools still
  do. "Calls pi dispatched" is the wrong line to draw: pi never dispatches kiro's
  built-ins either, and their `kiro_*` rows are a feature. A call is internal when it
  carries `_meta.kiro.toolId` and no `toolOrigin` (3.7). Tests drive the real
  `fetch_cloud_config` payload and assert no row, and the real `Read File` payload and
  assert one.
- **R9** `available_commands_update`, `config_option_update` and `session_info_update`
  draw nothing. The reader already ignores unknown kinds, so this is a gate on existing
  behaviour: a mutation that routes them into the narration must fail.
- **R10** The `painted exactly once` conformance suite covers v3. `KIRO_ROUTES` is `acp`
  plus one `chat/<format>` per entry in `KIRO_CHAT_FORMATS`, and its coverage test fails
  until every route has a driver. Route strings are also the identity line's route slot,
  so the engine must not be folded into them: the suite's key becomes (engine, route),
  drawn from a list of the combinations R2 permits, and the coverage test checks that
  list. Adding v3 then forces its driver rather than allowing it to pass by omission.
  See D3 for the shape.
- **R12** Tool rows on v3 carry a real name. v3 sends no `toolName`, so the name comes
  from what it does send, and the choice is pinned against the 3.7 payloads: a built-in
  row is never `kiro_unknown`, an update-only failure still draws its row, and a bridged
  tool still shows its bare name (S1 supplies that payload).

**Bridge**

- **R11** Either the MCP bridge is proven to mount under v3 (S1), or v3 refuses to start
  while `PI_KIRO_BRIDGE` is on. A turn that silently loses pi's tools is the worst
  available outcome and must not be reachable.

**ACP (deferred, stated so it is not forgotten)**

- **R-ACP** v3 on ACP requires `session/request_permission` handling and a permission
  policy. Out of scope here; `ACP_ENGINE` stays `v2` and R1's variable does not move it.

## 5. Spikes that must land before any implementation

Each names the question and the measurement that settles it. None is a code change.

- **S1 Does the bridge mount under v3?** Write a real per-turn profile as
  `src/kiro-bridge.ts` does, run a v3 turn whose prompt can only be answered by calling a
  bridged tool, and assert the tool was called. Record the bridged call's `tool_call`
  payload: R12 needs to know what v3 sends in place of `toolName` and `mcpServerName` for
  an MCP tool. Also confirm whether v3 reads
  `~/.kiro/agents/*.json` at all, or wants a different schema or location: the working
  note that v3 configs support header auth and `${VAR}` expansion implies a different
  file format, which would make R11 a rewrite rather than a flag.
- **S2 Does `--resume-id` work on v3, and is a `sess_`-prefixed id accepted?**
  **Settled: yes** (3.7). Still to check in implementation: `dropSession` and the
  prefix-hash bookkeeping with a `sess_` id, which the probe did not exercise.
- **S3 Does v3 ever emit a `metadata` event?** Three turns so far, a plain one, a
  resumed one and a tool-using one, and none did. Re-run with `--effort` set before
  concluding it never does.
- **S4 Does v3 report `agent_thought_chunk`?** **Settled: yes**, five on the tool-using
  turn (3.4).
- **S5 How does v3 behave on the failure paths we already handle?** Specifically the
  envelope violation, the turn ceiling and abort, since `armKill` and the strict envelope
  were only ever exercised against v2.

## 6. Decisions needed

- **D1 Is credits parity (R4) a ship blocker, or may v3 ship opt-in while reporting no
  credits?** Recommendation: **blocker.** The whole credits surface was built in 0.4.0,
  and an engine that silently reports nothing teaches the user to distrust the footer.
  The data is there; it is a field-name change, not a missing feature.
- **D2 Does the default engine stay v2?** Recommendation: **yes**, for this release and
  the next. v3 ships opt-in behind `PI_KIRO_ENGINE=v3` until S1 and S3 are settled.
- **D3 Does the route matrix gain an engine dimension, doubling the conformance cases, or
  does v3 get its own suite?** Recommendation: **add the dimension, but only for the
  combinations R2 permits**, so the matrix grows by one cell (`chat/stream-json` on v3)
  rather than by a factor, keyed as R10 describes. A separate suite is exactly the "tested once per transport"
  shape that let #56 ship a double-draw.
- **D4 Is `--sandbox` (V3/KAS only, sends `_meta.kiro.executionTarget` on `session/new`)
  interesting?** It has no v2 equivalent, so it is the first thing v3 could offer that is
  not parity. Out of scope here, worth a separate issue.

## 7. Non-goals

- v3 on the `text` format. The `[INFO]` flood lands on stdout there and the format is
  already the fallback of a fallback.
- v3 on ACP (see R-ACP).
- Changing the default engine.
- `--auth-method client` and host-mediated token refresh. It is ACP-only and only matters
  once R-ACP is in scope.

## 8. Receipts

Raw probe output is not committed. To reproduce section 3 on any machine with kiro-cli
2.32.0 and a logged-in session, using the chat transport's argv:

```
kiro-cli chat --no-interactive --trust-all-tools --agent-engine v3 --output-format stream-json \
  "reply with the single word OK" > v3.out 2> v3.err
kiro-cli chat --no-interactive --trust-all-tools --agent-engine v2 --output-format stream-json \
  "reply with the single word OK" > v2.out 2> v2.err
```

For 3.7, resume the v3 session, then run a tool-using turn from a directory holding a
`note.txt`:

```
sid=$(jq -r 'select(.type=="runFinished").data.sessionId' v3.out)
kiro-cli chat --no-interactive --trust-all-tools --agent-engine v3 --output-format stream-json \
  --resume-id "$sid" "now reply with the single word YES" > v3-resume.out 2> /dev/null
kiro-cli chat --no-interactive --trust-all-tools --agent-engine v3 --output-format stream-json \
  "Use your file-reading tool to read ./note.txt and reply with only the secret word in it." \
  > v3-tool.out 2> /dev/null
jq -c 'select(.type=="sessionUpdate").data.update | select(.sessionUpdate=="tool_call")' v3-tool.out
```

Then count line types on each `.out`, and confirm every line of both parses as JSON while
`v3.err` is entirely non-JSON. The engine-flag rejection in 3.6 and the missing-profile
failure in 3.5 need no model call; the second exits 4 with or without
`--require-mcp-startup`:

```
kiro-cli acp --agent-engine v3 --trust-all-tools
kiro-cli chat --no-interactive --trust-all-tools --agent-engine v3 --agent no-such-agent \
  --require-mcp-startup --output-format stream-json "x"
```
