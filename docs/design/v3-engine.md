# pi-kiro-agent: kiro-cli v3 engine support

Status: **design, not implemented.** Measured against kiro-cli 2.32.0 / KAS 0.66.43 and
pi 1.3.0 on 2026-10-17. No code in this document has been written.

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

We handle `tool_call`, so **v3 would paint a "Fetching your cloud config" tool row on
every single turn**, for a tool the user did not ask for and pi did not dispatch.

### 3.4 No thinking channel in the probe

Zero `agent_thought_chunk` events on v3 for a turn that v2 also answered without
thinking. Not evidence either way; see spike S5.

### 3.5 A missing agent profile FAILS SOFT on v3

```
v2  runError stage=init  "failed to set agent 'X': Mode 'X' not found"
v3  runError stage=init  "agent \"X\" not found, using \"default\""
```

Both exit 4, so a missing profile is still detectable. But v3's wording says it
*continued with the default agent*, and the MCP bridge is mounted entirely through that
profile. If v3 ever reports this as a warning rather than a terminal `runError`, a turn
would run with none of pi's tools and look successful. This is the single highest-risk
unknown; see S1.

### 3.6 ACP under v3 is a different project

```
$ kiro-cli acp --agent-engine v3 --trust-all-tools
error: the following arguments are not supported with --agent-engine=v3: --trust-all-tools
```

`src/acp-transport.ts` spawns exactly that. v3 on ACP therefore means implementing
`session/request_permission` and a permission policy, not flipping a flag. v3 also adds
an ACP-only `--auth-method cli|client` (`chat` does not accept it) for host-mediated
token refresh via `_kiro/auth/getAccessToken`.

## 4. Requirements

Numbered so they can be argued with individually. Each one is meant to be testable.

**Scope and selection**

- **R1** The engine is selectable at runtime instead of being a compile-time constant:
  `PI_KIRO_ENGINE=v2|v3`, default **v2**. An unrecognised value keeps v2 and traces once,
  matching how `PI_KIRO_TRANSPORT` handles a typo rather than silently downgrading.
- **R2** `v3` is accepted only on `chat/stream-json`. `v3` + `chat/text` and `v3` + `acp`
  are refused with a message naming the reason (the stderr flood is not the blocker for
  text; the `[INFO]` lines on *stdout* in text mode are, and ACP is blocked by R-ACP
  below). Refusing beats a route that half works.
- **R3** The identity line reports the engine actually spawned, not the requested one.
  The line already carries an engine slot: `pi 1.3.0 via Kiro (kiro-cli 2.32.0, engine
  v3, chat/stream-json) on auto`.

**Parity, because a route that silently stops reporting cost is worse than no route**

- **R4** Credits on v3 come from `session_info_update._meta.kiro.promptTurnSummaries[]`,
  reading `usage` (not `value`) with `unit`/`unitPlural`, and reach the same metering
  record and credits footer as v2. A turn that produces no summary attaches no record,
  rather than a record of zero.
- **R5** Context usage on v3 comes from `_meta.kiro.contextUsage.usagePercentage`, taking
  the **last non-null** value. A test must pin a fixture whose last event carries null,
  because that is what the real stream does and "last wins" returns null for it.
- **R6** Turn duration on v3 comes from `_meta.kiro.elapsedTime`.
- **R7** A turn priced more than once still traces `chat.stream.metering_repriced`, as
  the v2 path does. v3 sends 22 info events, so repricing is likelier here, not less.

**Not making the output worse**

- **R8** v3's internal tool calls do not draw tool rows. The row surface is an
  allow-list of calls pi dispatched, not everything the engine happens to run; a test
  must drive the real `fetch_cloud_config` payload and assert no row appears.
- **R9** `available_commands_update`, `config_option_update` and `session_info_update`
  draw nothing. The reader already ignores unknown kinds, so this is a gate on existing
  behaviour: a mutation that routes them into the narration must fail.
- **R10** The `painted exactly once` conformance suite covers v3. `KIRO_ROUTES` is
  derived from `KIRO_TRANSPORTS` x `KIRO_CHAT_FORMATS`, and its coverage test fails until
  every route has a driver, so adding the engine dimension forces the case rather than
  allowing v3 to pass by omission. See D3 for the shape.

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
  bridged tool, and assert the tool was called. Also confirm whether v3 reads
  `~/.kiro/agents/*.json` at all, or wants a different schema or location: the working
  note that v3 configs support header auth and `${VAR}` expansion implies a different
  file format, which would make R11 a rewrite rather than a flag.
- **S2 Does `--resume-id` work on v3, and is a `sess_`-prefixed id accepted?** v3's
  session ids are `sess_<uuid>`; v2's are bare uuids. The resume path and
  `dropSession` key off that id.
- **S3 Does v3 ever emit a `metadata` event?** One turn is one sample. Re-run with
  `--effort` set and with a tool-using prompt before concluding it never does.
- **S4 Does v3 report `agent_thought_chunk`?** Drive a prompt that forces reasoning. If
  v3 never sends it, the thinking feed is empty on v3 and that is a user-visible
  difference worth stating in the changelog.
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
  rather than by a factor. A separate suite is exactly the "tested once per transport"
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
2.32.0 and a logged-in session:

```
kiro-cli chat --no-interactive --agent-engine v3 --output-format stream-json \
  "reply with the single word OK" > v3.out 2> v3.err
kiro-cli chat --no-interactive --agent-engine v2 --output-format stream-json \
  "reply with the single word OK" > v2.out 2> v2.err
```

Then count line types on each `.out`, and confirm every line of both parses as JSON while
`v3.err` is entirely non-JSON. The engine-flag rejection in 3.6 and the soft failure in
3.5 need no model call:

```
kiro-cli acp --agent-engine v3 --trust-all-tools
kiro-cli chat --no-interactive --agent-engine v3 --agent no-such-agent \
  --require-mcp-startup --output-format stream-json "x"
```
