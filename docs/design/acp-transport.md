# pi-kiro-agent v2 transport: ACP (Agent Client Protocol)

**Status:** DRAFT — architecture spec, not yet scheduled
**Author:** drafted 2026-07-30, from the GSD M026/M027 integration campaign
**Refs:** https://kiro.dev/docs/cli/acp/ · https://agentclientprotocol.com · `kiro-cli acp --help` (2.15.2)

---

## 1. Why

The current transport spawns `kiro-cli chat --no-interactive` **per turn** and reconstructs
everything from scraped TUI text. It works — it shipped a full GSD milestone slice — but every
hard bug in pi-kiro-agent's history is a symptom of driving an interactive TUI as if it were an API:

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
| large shell heredocs hang the turn and corrupt content (killed the S03 design twice 2026-07-27; recurred 2026-07-31 during this spec's own probe campaign — template-literal backticks eaten in transit) | the entire delegated turn travels as ONE argv string through `chat --no-interactive`; huge embedded heredoc/script payloads break the TUI pipe | structured protocol messages carry arbitrary-size content without argv/TTY mangling |

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
  across turns; supervised with idle-timeout shutdown and crash-restart. "Idle" means
  *silence*: any inbound NDJSON traffic resets the clock (default 10 min,
  `PI_KIRO_IDLE_TIMEOUT_MS`). While a request is pending, silence alone never kills the
  child — a mute long-running tool (cold cargo build) is legitimate — but a turn pending
  past the hard ceiling (default 45 min, `PI_KIRO_TURN_TIMEOUT_MS`) is treated as wedged
  and reaped. A turn that merely *runs long* while streaming is never killed.
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
| Long-lived child leaks/hangs (the TUI's `tui.js chat` heritage) | silence-based idle reaper (traffic resets) + pending-aware turn ceiling + crash-restart supervision; hard cap one child per cwd |
| Idle reaper kills a busy child mid-turn (observed 2026-08-04: 10-min turn limit killed an M030 refactor turn; gsd's single retry died identically) | idle clock resets on every inbound message; pending turns extend to `PI_KIRO_TURN_TIMEOUT_MS` before being treated as wedged |
| Host process cannot exit after a one-shot turn (`pi -p` printed its answer then sat for ~10 min under ACP until the idle reaper killed the child) | the persistent child is spawned `detached` with piped stdio, so the ChildProcess handle **and all three pipes** hold event-loop references; `setChildKeepalive` unreferences all four whenever `pending` is empty and re-references them for the duration of each turn (a blanket unref would let the host exit mid-turn, since an awaited promise is not an event-loop reference) |
| Headless permission requests beyond tool-use (e.g. trust prompts) | auto-respond in the client; P1 probe enumerates request types |
| Session count growth server-side | reuse aggressively; `session/cancel`+drop on divergence |
| Concurrent turns (GSD parallel units, same cwd) | one ACP session per pi conversation already isolates; child multiplexes sessions — verify in P3, else per-conversation children |
| ACP mode gaps vs chat mode (feature lag) | parity suite is the gate; `chat` fallback retained |

## 5b. Field evidence, 2026-09-15: the scrape risk fired

The "text-scrape is brittle" argument in section 1 stopped being theoretical. kiro-cli 2.21.4
broke the scrape in two independent ways at once, and a GSD unit that really called `gsd_*`
several times presented to the host as a unit with zero tool calls.

**First: the lines are on stderr now.** stdout holds only the model's answer. Verified by running
the binary with the streams separated, same prompt, same mounted MCP server:

```
$ kiro-cli chat --no-interactive --trust-all-tools --agent <profile> "Run gsd_doctor, then say DONE."
   stdout:  DONE
   stderr:  [tool] Running: @gsdworkflow/gsd_doctor
            [tool] status: Completed
```

No regex over stdout could have recovered that. Worth recording how this was initially
mis-diagnosed: an early probe piped `2>&1`, which made the lines look like stdout and pointed the
whole investigation at the regex.

**Second: the format changed.** From

```
Running tool gsd_doctor (from mcp server: gsdworkflow)
 ⋮  { ... }
```

to

```
[tool] Running: @gsdworkflow/gsd_doctor
[tool] status: Completed
```

Server and tool are fused, the order is reversed, and there is no `⋮` parameter block.

Nothing caught either one: all 36 `workflow-mcp.test.ts` cases were green throughout, against
fixture strings kiro had stopped producing, on a stream it had stopped using. Only a live turn
found it. Both streams are scanned now and both grammars are accepted, which restores the
behaviour but does not remove the class of defect.

Two further findings bear on this design:

- **Built-in kiro tools are not recoverable from text at all** in the new format. They render as
  prose (`[tool] Reading note.txt:1`) with no tool name. Only the `@server/tool` shape is
  machine-readable, so the scrape can never be complete, only adequate.
- **`kiro-cli chat --output-format stream-json` now exists**: "the run's ACP events as JSON Lines
  on stdout, one self-describing event per event; implies `--no-interactive`". That is
  structurally the same event stream this document proposes reaching over ACP, delivered by the
  transport that already works. It would delete the scraping layer outright rather than hardening
  it, and it narrows the gap this document exists to close. That choice is now **settled in favour
  of stream-json**; see section 5c for the probe evidence and what it means for this document.

## 5c. Decision, 2026-09-15: `--output-format stream-json` first, ACP demoted to optional

**Decision: adopt `chat --output-format stream-json` as the structured-event source. ACP stops
being the plan of record and becomes the answer to one specific future need (bidirectionality).**

Decided on evidence, not on the help text. Two real turns were probed with the streams separated,
one calling an MCP tool through an `--agent` profile and one calling a kiro built-in.

Both emitted clean JSON Lines, 55 and 19 lines, zero unparseable, exit 0. The envelope is
self-versioning:

```json
{"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v2"}}
```

Event types observed: `runStarted`, `sessionUpdate` (subtypes `agent_thought_chunk`,
`agent_message_chunk`, `tool_call`, `tool_call_update`), `metadata`, `runFinished`.

What the events carry that the scrape does not, and cannot:

| | text scrape today | `stream-json` |
|---|---|---|
| Tool call id | `kiro-mcp-<sha256(body)[:16]>-<i>-<name>`, synthesized | `toolu_bdrk_01QAnUm...`, the model's own id |
| Tool name | parsed out of prose | `_meta.kiro.toolName` + `_meta.kiro.mcpServerName` |
| Arguments | `{}` for the 2.21 compact form | `rawInput`, complete |
| Tool result | not available at all | `rawOutput` |
| Status | inferred | `status: "completed"`, explicit transition |
| **Built-in tools** | **unrecoverable** (see 5b) | `tool_call` with `_meta.kiro.toolName: "read"`, `kind: "read"`, `locations[]` |
| Final answer | `extractFinal` heuristics over stdout | `runFinished.data.finalText` (+ `finalTextTruncated`) |
| Thinking vs answer | fused in one stream | separate subtypes |
| Credits | parsed footer | `metadata.data.meteringUsage[]` |
| Session id | not exposed | `metadata.data.sessionId` |
| Context pressure | not exposed | `contextUsagePercentage` |
| Stop reason | exit code | `stopReason: "end_turn"` |

The built-in row is the one that settles it. Section 5b concluded the scrape "can never be
complete, only adequate", because `[tool] Reading note.txt:1` carries no tool name. Under
stream-json that same call arrives with `_meta.kiro.toolName: "read"` and the path in
`locations[]`; the prose line turns out to be the `title` field of a fully structured event. The
gap this document was written to close is closed by a flag on the transport already in production.

Two more reasons it wins on cost rather than on capability:

- **Every flag the chat transport already passes coexists with it**: `--agent`,
  `--require-mcp-startup`, `--model`, `--effort`, `--resume-id`, `--no-interactive` are all still
  on `chat`. This is a change of parser, not a change of process model, so none of section 5's open
  risks apply: no persistent child, no idle reaper, no keepalive/unref problem, no server-side
  session growth, no concurrency question.
- **The next break is detectable instead of silent.** That is the real lesson of 5b. The 2.21 break
  was invisible because prose has no version and no schema; 36 green tests proved only that the
  fixtures still matched themselves. `payloadSchema` + `acpProtocolVersion` + `engine` can be
  asserted, so the same class of change fails loudly.

**What ACP still buys, and why it is not needed yet.** ACP is bidirectional; stream-json is
one-shot. That matters only for requests the client must *answer* mid-turn, i.e. permission and
trust prompts, which `--trust-all-tools` already removes from the picture, and for `session/cancel`
as a protocol operation rather than a signal. Session reuse is already covered by `--resume-id`.
So ACP's remaining value is a contingency, not a milestone: keep `acp-transport.ts` and its
`PI_KIRO_TRANSPORT=acp` flag, keep this document, and revisit if kiro starts requiring a mid-turn
response we cannot pre-authorize.

**Not yet verified, and to be probed before implementation:**

- `--output-format stream-json` together with `--resume-id`. The session id is in the output so it
  is plausible, but plausible is what 5b punished.
- The `finalTextTruncated` boundary for a long answer, and whether reassembling
  `agent_message_chunk` is required rather than optional.
- Whether a tool *rejection* or a mid-turn error produces a distinguishable event. The probe's
  `gsd_doctor` call did fail (project-root guard) and surfaced as `status: "completed"` with
  `rawOutput.items[0].Json.isError: true`, so an error is inside the payload rather than in the
  status. Any implementation must read `isError`, not just `status`.

**Consequence for section 4.** Steps 1-5 stay valid as an ACP plan but are no longer the roadmap.
The roadmap is: probe the three unknowns above, add a stream-json reader beside the text parser
behind an env flag, run the live suite against both, then make stream-json the default and keep the
text parser only for kiro-cli versions that lack the flag.

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
