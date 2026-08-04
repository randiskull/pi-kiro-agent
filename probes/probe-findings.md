# ACP Probe Campaign Results — kiro-cli 2.16.0

Captured: 2026-07-31 (pi-kiro repo, branch main, commit 47f49ad)
CLI version: 2.16.0 (third drift: 2.13→2.15→2.16 in ~3 weeks)

---

## Transport layer (discovered by P0 raw sniff)

- **NDJSON** (newline-delimited JSON) — NOT LSP Content-Length framing
- One JSON object per line on both stdin and stdout
- LSP framing triggers: `{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error","data":{"line":"Content-Length: 162"}}}`

---

## P1: initialize / session/new handshake

**Initialize request** (client → server):
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true},
  "clientInfo":{"name":"pi-kiro-probe","version":"0.1.0"}
}}
```
Note: `protocolVersion` is integer `1`, NOT string `"2025-03-26"`.

**Initialize response** (server → client):
```json
{"jsonrpc":"2.0","result":{
  "protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":true,"audio":false,"embeddedContext":false},
    "mcpCapabilities":{"http":true,"sse":false},
    "sessionCapabilities":{},
    "auth":{}
  },
  "authMethods":[],
  "agentInfo":{"name":"Kiro CLI Agent","title":"Kiro CLI Agent","version":"2.16.0"}
},"id":1}
```

**`initialized` notification**: returns `-32601 Method not found` — kiro does NOT implement it. Skip it.

**session/new request** (client → server):
```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{
  "cwd":"/path/to/project",
  "mcpServers":[]
}}
```
Note: `mcpServers` must be an ARRAY (not object/map). Empty array for no MCP servers.

**session/new response**:
```json
{"jsonrpc":"2.0","result":{
  "sessionId":"<uuid>",
  "modes":{"currentModeId":"kiro_default","availableModes":[...]},
  "models":{"currentModelId":"claude-sonnet-4.6","availableModels":[...]}
},"id":2}
```

**Notifications arrive BEFORE session/new response**:
1. `_kiro.dev/subagent/list_update` — `{"subagents":[],"pendingStages":[]}`
2. Then: `session/new` response
3. Then: `_kiro.dev/commands/available` — full slash command + tool list

**CRITICAL**: Must wait for `_kiro.dev/commands/available` before sending `session/prompt`.
Sending prompt immediately after `session/new` causes the process to exit (race condition).

---

## P2: session/prompt round-trip + event shapes

**session/prompt request** (client → server):
```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{
  "sessionId":"<uuid>",
  "prompt":[{"type":"text","text":"Reply with exactly the word: PONG"}]
}}
```
Note: field is `prompt` (NOT `content`). `content` triggers:
`{"error":"missing field 'prompt'","phase":"deserialization"}`

**Streaming updates**: notifications with method `session/update`:
```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"<uuid>",
  "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"PONG"}}
}}
```
Note: method is `session/update` (NOT `session/notification` as the ACP spec says).
Field is `sessionUpdate` (discriminator for update variant).

**Context usage notifications**: `_kiro.dev/metadata`:
```json
{"method":"_kiro.dev/metadata","params":{
  "sessionId":"<uuid>",
  "contextUsagePercentage":0.9138,
  "meteringUsage":[{"value":0.061,"unit":"credit","unitPlural":"credits"}],
  "turnDurationMs":1520
}}
```
Note: `meteringUsage` only appears on the FINAL metadata notification (after turn completes).
Credits are structured data — no need to parse from text footer.

**session/prompt response** (after all updates):
```json
{"jsonrpc":"2.0","result":{"stopReason":"end_turn"},"id":3}
```
Note: `stopReason` is snake_case `"end_turn"` (not camelCase `"end_turn"`).
Turn is complete when the response arrives — no separate TurnEnd event needed.

**Ordering**:
1. `_kiro.dev/metadata` (contextUsage, no metering)
2. N × `session/update` (agent_message_chunk)
3. `_kiro.dev/metadata` (contextUsage only)
4. `_kiro.dev/metadata` (contextUsage + meteringUsage + turnDurationMs)
5. `session/prompt` response `{stopReason: "end_turn"}`

---

## P3: HTTP MCP server + tool-call events

**MCP server config in session/new** (HTTP transport):
```json
{"type":"http","name":"probeMcp","url":"http://127.0.0.1:PORT/mcp","headers":[]}
```
Note: `type` field is required discriminator. `headers` array required (empty is ok).
`name` field required. Array element, not map key.

**MCP server initialization notification**:
```json
{"method":"_kiro.dev/mcp/server_initialized","params":{"sessionId":"<uuid>","serverName":"probeMcp"}}
```
Fires TWICE (both before and after session/new response). Safe to handle multiple times.

**Tool call early notification** (via `_kiro.dev/session/update`, with kiro prefix):
```json
{"method":"_kiro.dev/session/update","params":{
  "sessionId":"<uuid>",
  "update":{"sessionUpdate":"tool_call_chunk","toolCallId":"tooluse_<id>","title":"probe_echo","kind":"other"}
}}
```
Note: different method prefix `_kiro.dev/session/update` vs `session/update`.

**Tool call event** (via standard `session/update`):
```json
{"method":"session/update","params":{"sessionId":"<uuid>","update":{
  "sessionUpdate":"tool_call",
  "toolCallId":"tooluse_<id>",
  "title":"Running: @probeMcp/probe_echo",
  "rawInput":{"msg":"hello from ACP probe","__tool_use_purpose":"..."},
  "_meta":{"kiro":{"toolName":"probe_echo","mcpServerName":"probeMcp",...}}
}}}
```

**Tool call update** (result, via `session/update`):
```json
{"method":"session/update","params":{"sessionId":"<uuid>","update":{
  "sessionUpdate":"tool_call_update",
  "toolCallId":"tooluse_<id>",
  "kind":"other",
  "status":"completed",
  "title":"Running: @probeMcp/probe_echo",
  "rawInput":{...},
  "rawOutput":{...}
}}}
```

**meteringUsage** with tool calls — two credit entries:
```json
"meteringUsage":[
  {"value":0.073,"unit":"credit","unitPlural":"credits"},
  {"value":0.039,"unit":"credit","unitPlural":"credits"}
]
```
Sum for total credits. Tool call billing is separate from model call billing.

---

## P4: Cancel semantics

**session/cancel** returns `-32601 Method not found`:
```json
{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found","data":"session/cancel"},"id":4}
```
**session/cancel is NOT implemented in kiro-cli 2.16.0.**
Cancellation must use SIGTERM on the child process (same as current chat transport).
The `--require-mcp-startup` pattern and process-group kill logic remain unchanged.

---

## P5: Session persistence / cross-process session identity

**Sessions are per-process**: `session/prompt` with a `sessionId` from a different
acp process returns `-32603 Internal error: "No session found with id"`.

Each `kiro-cli acp` child manages its own session registry. Sessions do NOT persist
across process boundaries via `session/prompt`. The correct approach for session
continuation is to keep the same child alive (or use `session/load` which replays history).

**`loadSession: true`** capability is advertised. `session/load` would replay history
as `session/update` notifications. This is the ACP way to resume across restarts.

**Design implication**: The ACP transport must keep the kiro-cli acp child alive for the
duration of a pi conversation. This is exactly what §3.1 of acp-transport.md specifies:
"One kiro-cli acp child per (cwd, agent-profile) pair, lazily started, kept alive."
The session-manager's `--resume-id` / `--list-sessions` pattern becomes unnecessary.

---

## P6: Auth state + error shapes

**authMethods**: `[]` (empty — no auth callback advertised for this seat type)
**agentCapabilities.auth**: `{}` (empty)

Auth expiry behavior: not observable from the protocol during a normal session.
When auth expires mid-session, the process likely exits or the prompt returns an error.
The current "profileArn is required" error message handling in `stream-adapter.ts` should
move to the ACP transport's error handler.

**Unknown method error shape**:
```json
{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found","data":"session/nonexistent_method"},"id":4}
```
Standard JSON-RPC error: `code`, `message`, `data` (method name that wasn't found).

---

## Complete Protocol Summary (kiro-cli 2.16.0)

### Unimplemented methods (return -32601):
- `initialized` notification
- `session/cancel`

### Working methods:
- `initialize` ✓
- `session/new` ✓ (requires `cwd`, `mcpServers: []`)
- `session/prompt` ✓ (requires `prompt` field, NOT `content`)
- `session/load` ✓ (capability advertised; see P5)

### Notification method names:
- `session/update` — streaming updates (agent_message_chunk, tool_call, tool_call_update)
- `_kiro.dev/session/update` — kiro-specific updates (tool_call_chunk)
- `_kiro.dev/metadata` — context usage + credits + turn duration
- `_kiro.dev/commands/available` — slash commands + tool list (fires after session/new)
- `_kiro.dev/subagent/list_update` — subagent state
- `_kiro.dev/mcp/server_initialized` — MCP server ready

### Session lifecycle:
1. `initialize` → wait for response
2. `session/new` → wait for response
3. Wait for `_kiro.dev/commands/available`
4. `session/prompt` → consume `session/update` notifications → wait for response
5. Repeat from 4 for subsequent turns
6. Kill process to terminate (no session/cancel, no session/close)

### Credits/billing:
- Structured: `_kiro.dev/metadata.meteringUsage[].value` (sum all entries for total credits)
- `PI_KIRO_CREDIT_USD` env var still needed for USD conversion
- `turnDurationMs` available on final metadata notification

### Schema deviations from acp-transport.md spec (§3 design doc):
- Notifications use `session/update` not `session/notification` (§3.2 says `session/update`)
  → spec was correct on this; doc comment in design was mislabeled
- Update field is `sessionUpdate` not `type` or `updateType` (undocumented in kiro docs)
- `TurnEnd` event: NOT observed as a separate event; turn completion = prompt response arrival
- `session/cancel` not implemented → process kill remains the abort mechanism
- `initialized` notification not supported
- `protocolVersion` is integer 1, not string

### Version drift risk:
kiro-cli went 2.13→2.15→2.16 in ~3 weeks. Pinning `protocolVersion: 1` at initialize
is the correct mitigation (as specified in §5). CI must re-run probe fixtures when CLI bumps.
