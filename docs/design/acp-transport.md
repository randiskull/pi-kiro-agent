# pi-kiro v2 transport: ACP (Agent Client Protocol)

**Status:** DRAFT — architecture spec, not yet scheduled
**Author:** drafted 2026-07-30, from the GSD M026/M027 integration campaign
**Refs:** https://kiro.dev/docs/cli/acp/ · https://agentclientprotocol.com · `kiro-cli acp --help` (2.15.2)

---

## 1. Why

The current transport spawns `kiro-cli chat --no-interactive` **per turn** and reconstructs
everything from scraped TUI text. It works — it shipped a full GSD milestone slice — but every
hard bug in pi-kiro's history is a symptom of driving an interactive TUI as if it were an API:

| Incident (real, from the field) | Text-scrape root cause | Under ACP |
|---|---|---|
| ~15-min hangs on large GSD sessions | full-context re-send per spawn (no session reuse) | one persistent session; deltas are just the next `prompt` |
| `--resume-id` machinery (session-manager.ts): snapshot-diff capture, prefix hashing, divergence resets | process-per-turn forces external session bookkeeping | native session owned by the protocol |
| zero-tool-calls: gsd_* tools invisible to the host | tool calls happen inside kiro; host must regex-scrape `Running tool …` lines and synthesize `toolCall` blocks | tool calls are **first-class protocol events** (`session/update` tool-call notifications) |
| exit 1 *after* `gsd_task_complete` landed → turn discarded, GSD paused (fixed by the `32df5c3` salvage heuristic) | process exit code is the only turn-completion signal | turn completion is a protocol response; process lifetime ≠ turn lifetime |
| sentinel protocol (`<pi_final>…</pi_final>`) and models refusing/echoing it | no structured message channel | assistant text arrives as typed streamed updates |
| headless SSO "Opening browser…" hangs mid-run | no auth channel in a text pipe | ACP has an auth-callback surface (kiro logs: `Wired ACP callback auth provider`) |
| credits parsed from a `▸ Credits: N` footer line | no metadata channel | usage/metadata fields on protocol messages (verify in probe) |
| error detail = sliced stdout | no structured errors | JSON-RPC error objects |

**Design principle carried over from v1:** all model traffic stays inside the user's own
authenticated kiro-cli (seat-billed, no credential handling). ACP doesn't change the trust
model — it changes the *wire* between pi and the same CLI.

## 2. What kiro-cli offers

`kiro-cli acp [--agent <name>] [--model <id>] [--effort <level>] [--trust-all-tools |
--trust-tools <names>] [--agent-engine v1|v2|v3]` — an ACP **agent** speaking JSON-RPC over
stdio. Per the ACP spec, the client (us) drives:

- `initialize` — capability/version negotiation
- `session/new` (and `session/load` where supported) — session lifecycle
- `session/prompt` — send a user turn; streamed `session/update` notifications carry
  assistant message chunks, **tool-call start/finish events** (with names + inputs), plan/
  status updates; the prompt request resolves with a stop reason
- `session/cancel` — clean turn abort (vs today's SIGTERM→SIGKILL process-tree kill)
- permission callbacks — the agent asks the client to approve tool use (we auto-grant,
  mirroring today's `--trust-all-tools` posture)

## 3. Architecture

### 3.1 Process & session model
- **One `kiro-cli acp` child per (cwd, agent-profile) pair**, lazily started, kept alive
  across turns; supervised with idle-timeout shutdown (e.g. 10 min) and crash-restart.
- **One ACP session per pi conversation.** Keyed by the same prefix-hash identity the
  session-manager uses today — but the ledger shrinks to `{acpSessionId, sentMessageCount,
  sentPrefixHash}` with no `--list-sessions` snapshot-diffing (the id comes back from
  `session/new` directly — the entire capture-race problem disappears).
- Prefix divergence (pi compacted/edited) → `session/new` and full re-send, exactly the
  v1 reset rule. Pure-append → send only the delta turn. Same correctness invariants,
  ~200 fewer lines of bookkeeping.

### 3.2 Turn flow (streamSimple mapping)
```
pi streamSimple(model, context, options)
  └─ ensure child (cwd, profile)         — spawn kiro-cli acp --agent <profile> once
  └─ ensure session (conversation)       — session/new | reuse (append) | new (diverged)
  └─ session/prompt(delta or full)
       session/update: agent_message_chunk   → text_delta events (true token streaming —
                                               v1 can only stream raw TUI bytes as "thinking")
       session/update: tool_call             → toolCall block (REAL name+args, no regex)
       session/update: tool_call_update      → attach result/status to the block
       session/update: plan/thought chunks   → thinking deltas
       (permission request)                  → auto-grant, mirroring --trust-all-tools
  └─ prompt response {stopReason}            → done event, stopReason mapped
       "end_turn" → "stop" · "max_tokens" → "length" · "refusal"/error → "error"
       options.signal.abort → session/cancel → "aborted"
```
Synthesized-toolCall code (`parseKiroToolUses`/`synthesizeToolCallBlocks`) survives only as
a fallback parser for the legacy transport; ACP events populate the same block shapes with
authoritative data. GSD's `snapshotUnitActivity` counting works unchanged.

### 3.3 Tool surface (unchanged by design)
The per-turn/per-cwd **agent profile** remains the tool-mounting mechanism:
- `gsdworkflow` stdio MCP server from the project's `.mcp.json` (workflow-mcp.ts, as-is)
- the loopback `pi` HTTP bridge for calling-session tools (bridge.ts, as-is)
`--agent <profile>` is accepted by `kiro-cli acp` identically. What changes: MCP startup
failures surface as protocol errors instead of exit-code 3 archaeology, and tool activity
comes back as events instead of log lines.

### 3.4 Prompting
The XML serialization (`<user_message>`, `<tool_result>`, `<prior_system_context>`) is kept
for context replay fidelity, but the **sentinel wrapper dies**: the final answer is simply
the turn's `agent_message_chunk` accumulation. `<tool_context>` guidance (bridged tools,
gsd_* availability) is kept verbatim.

### 3.5 Usage & cost
Probe whether ACP surfaces usage/credits metadata. If yes → map to `usage.cost` directly;
if not → keep `PI_KIRO_CREDIT_USD` with credits unavailable (0), and note it in `/kiro`.

## 4. Migration plan

1. **Probe phase** (same empiricism as the workflow-MCP build — probes before code):
   P1 initialize/session/new handshake; P2 prompt round-trip + event shapes; P3 `--agent`
   profile with the gsd-workflow MCP server → tool-call events for `gsd_milestone_status`;
   P4 cancel semantics; P5 long-turn survival (the T05 case: >5-min turn with many tool
   calls); P6 auth-expiry behavior mid-session. Capture all raw traffic as test fixtures.
2. **`acp-transport.ts`** implementing §3, behind **`PI_KIRO_TRANSPORT=acp`** (default
   stays `chat`).
3. **Parity suite**: every existing stream-adapter/session-manager test scenario re-run
   against the ACP transport with protocol-level fakes (fixtures from the probes).
4. **Field trial**: one full GSD milestone on `PI_KIRO_TRANSPORT=acp` (the M027 S02/S03
   slices are the natural candidates).
5. **Flip the default**; keep `chat` as fallback for one release; delete sentinel/salvage/
   session-snapshot code when ACP has a clean milestone behind it.

## 5. Risks & open questions

| Risk | Mitigation |
|---|---|
| ACP schema drift between kiro-cli releases (2.13→2.15 in three weeks here) | pin protocol version at `initialize`; probe fixtures re-run in CI (`PI_KIRO_LIVE=1`) |
| `--agent-engine` variance (v2 default vs v3) | pin engine explicitly; v3 note in kiro-bridge.ts already flags config differences |
| Long-lived child leaks/hangs (the TUI's `tui.js chat` heritage) | idle-timeout reaper + crash-restart supervision; hard cap one child per cwd |
| Headless permission requests beyond tool-use (e.g. trust prompts) | auto-respond in the client; P1 probe enumerates request types |
| Session count growth server-side | reuse aggressively; `session/cancel`+drop on divergence |
| Concurrent turns (GSD parallel units, same cwd) | one ACP session per pi conversation already isolates; child multiplexes sessions — verify in P3, else per-conversation children |
| ACP mode gaps vs chat mode (feature lag) | parity suite is the gate; `chat` fallback retained |

## 6. Non-goals

- No change to the trust/billing model (kiro-cli owns auth; seat-billed).
- No change to the tool-mounting design (agent profile + MCP servers).
- No attempt to expose kiro's *own* built-in tools to pi — direction stays pi→kiro.

## 7. Definition of done

- All six probes green with captured fixtures; parity suite green on both transports.
- A full GSD milestone slice completes on `PI_KIRO_TRANSPORT=acp` with **zero** salvage
  events, **zero** synthesized tool calls (all event-sourced), and tool-call counts
  matching GSD's ledger.
- Sentinel, salvage heuristic, and list-sessions snapshot-diff code paths deleted.
