# P3-gate Probe Results — Option B Tool Mounting (kiro-cli 2.16.0)

Captured: 2026-07-31
CLI version: 2.16.0

## Gate Verdict: PASS — Option B is viable

Both `session/new.mcpServers` server types mount successfully and their tools are
called end-to-end. Option B (inline session/new mcpServers, no agent profile file)
is confirmed as the correct tool-mounting mechanism for the ACP transport.

---

## Evidence

### Both servers initialized
```
_kiro.dev/mcp/server_initialized: { serverName: "pi" }       ← HTTP bridge
_kiro.dev/mcp/server_initialized: { serverName: "gsdworkflow" } ← stdio MCP
```

### Both tools visible in commands/available (count=16 built-in + 2 MCP)
```
ourTools=["gsd_milestone_status","ask_user_question"]
```

### Both tools CALLED end-to-end
```
session/update: tool_call { title: "Running: @gsdworkflow/gsd_milestone_status", rawInput: { milestone: "M001" } }
session/update: tool_call { title: "Running: @pi/ask_user_question", rawInput: { q: "hello" } }
```
HTTP bridge received: `tools/call` → `{ name: "ask_user_question", args: { q: "hello" } }`
Stdio MCP received:  `tools/call` → `gsd_milestone_status` with `{milestone:"M001"}`

### Tool results returned correctly
```
gsd_milestone_status → STDIO_RESULT: milestone_status for {"milestone":"M001"}
ask_user_question    → HTTP_RESULT: {"q":"hello"}
```

### Turn completed cleanly
```
session/prompt response: { stopReason: "end_turn" }
```

---

## MCP Server Config Format (session/new)

HTTP server (loopback bridge):
```json
{ "type": "http", "name": "pi", "url": "http://127.0.0.1:PORT/mcp", "headers": [] }
```

Stdio server (gsd-workflow):
```json
{ "name": "gsdworkflow", "command": "node", "args": ["/path/to/server.mjs"], "env": [] }
```

Note: `env` must be an ARRAY (not object/map). Empty array works.

---

## Protocol findings (additional, for acp-transport.ts)

### _kiro.dev/commands/available fires once per server_initialized
The `_kiro.dev/commands/available` notification arrives ONCE per MCP server init.
For two servers, it fires twice. Each arrival updates the tools list to include
newly initialized server's tools. The SECOND arrival has all tools from both servers.

### Startup gate: wait for ALL server_initialized events
The transport must wait until `server_initialized` has fired for EVERY server passed
in session/new.mcpServers before sending session/prompt. Strategy:
- Count expected servers at session/new time
- Track which servers have initialized
- Send session/prompt only after all servers are ready
- Timeout after session/new if not all servers initialize (configurable, 30s default)

### Tool names appear under @serverName/toolName in titles
```
@gsdworkflow/gsd_milestone_status
@pi/ask_user_question
```
The bare tool name (without server prefix) is in `_meta.kiro.toolName`.
The server name is in `_meta.kiro.mcpServerName`.

---

## Bridge lifetime decision (from user Q3 decision)

One bridge per ACP session (not per turn):
- Created at session start: `getBridge()` called once when creating an ACP child
- Passed in `session/new.mcpServers[].url` for the lifetime of that session
- Closed when the session ends (child killed, divergence reset, idle timeout)

This is the correct lifetime — bridge port+token is stable for the session duration.
Per-turn bridge (chat transport's model) would be stale in the persistent-child model.

---

## Rationale recorded for §3.3/§6 amendment

The original §3.3/§6 "tool mounting unchanged by design" constraint governs:
- Tool SURFACE: unchanged (same tools, same names, same mcpServers format)
- Discovery code: unchanged (discoverWorkflowMcpServers + getBridge)
- The delivery vehicle: moves from agent profile file to session/new.mcpServers

The constraint is preserved in substance. The implementation vehicle changes because:
- Per-turn agent profile + --agent is incompatible with the persistent-child model
  (bridge port+token created per-turn would be stale in a reused child/session)
- Protocol-native session/new.mcpServers is the correct lifetime for ACP

Fixture: probes/p3-gate-option-b.json
