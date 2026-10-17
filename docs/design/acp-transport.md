# pi-kiro-agent v2 transport: ACP (Agent Client Protocol)

**Status:** implemented and **the default**; `PI_KIRO_TRANSPORT=chat` selects the chat
transport as a fallback. Sections 5b onward are field evidence from running it. Section 5c
demoted ACP to a contingency in favour of `chat --output-format stream-json`; that call was
reversed once ACP had carried structured tool arguments and the credit metadata in the field,
and the sentinel scrape remained the only way the chat transport could recover an answer below
the stream-json floor.
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

Superseded as the roadmap by section 5c, which keeps steps 1-5 valid as an ACP plan only.

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

**Shipped (2026-10-16, #46-#48).** The three unknowns were probed on kiro-cli 2.32.0 (captures and
findings: `probes/stream-json-2.32/`), the reader landed behind `PI_KIRO_CHAT_FORMAT=stream-json` (#47),
and stream-json is now the chat transport's default on kiro-cli 2.21.4 or newer (#48), compared
numerically against the version readiness parses. Older or unparseable versions fall back to the text
parser, with one `chat.format.fallback` trace per process; an explicit `PI_KIRO_CHAT_FORMAT` wins on
any version. The text parser stays until support for pre-2.21.4 kiro-cli is dropped.

## 5d. Field evidence, 2026-09-20: surfaced tool calls were being executed a second time

The single worst defect found in this transport so far, and it had been mistaken for four
different bugs. **Every ACP `tool_call` notification was pushed onto the assistant message as a
real, executable pi `toolCall` block.** kiro had already run the tool; pi ran it again.

### The four symptoms, all one cause

1. **Duplicate `ask_user_question` cards.** A bridged questionnaire appeared, was answered, and a
   second identical card appeared. The second one never touched the MCP bridge, which is why the
   single-flight guard in `bridge.ts` never fired and looked useless: there was nothing in flight
   to collide with.
2. **`Tool shell not found`.** kiro runs `shell`, `read`, `glob` natively. Surfaced as pi tool
   calls, pi looked them up in its own registry, found nothing, and produced an error tool result.
3. **kiro apparently restarting the delegated task.** The error results from (2) were serialised
   into kiro's next prompt, which then consisted of nothing but tool-result noise. kiro read that
   as a stray turn with no instruction ("It looks like a stray artifact — there's no actual
   instruction or task from the user") and re-ran the task from the top.
4. **"Five kiro sessions in five minutes."** Not restarts at all. Five *pi conversations* (one
   main, the rest pi-subagents children), each opening its own ACP session. Three of the five
   match their pi session file to the millisecond.

### Mechanism

pi dispatches tool calls off the **presence** of `toolCall` blocks on an assistant message, not off
`stopReason`:

```ts
// pi packages/agent/src/agent-loop.ts
const toolCalls = message.content.filter((c) => c.type === "toolCall");   // :228
if (toolCalls.length > 0) { ... }                                        // :232
```

and an unknown name short-circuits to an error result rather than being ignored:

```ts
// pi packages/agent/src/agent-loop.ts, prepareToolCall
const tool = currentContext.tools?.find((t) => t.name === toolCall.name); // :669
if (!tool) return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
```

So any block this transport left on the final message was a *fresh instruction to pi*, not a record
of something already done.

### Receipts

A live turn on 2026-09-20 asked for exactly one `ask_user_question` and nothing else. The trace
recorded **one** bridge call:

```
08:11:12.611 bridge.call   ask_user_question ccbridge-1
08:13:12.610 bridge.abort  ask_user_question ccbridge-1 ms=119999 byCaller=true
08:13:12.611 bridge.result ask_user_question ccbridge-1 ms=120000
```

...and a second questionnaire card was on screen anyway, with no second `bridge.call` anywhere in
the trace. That card was pi executing the surfaced block.

pi's own session transcript for the earlier five-session run shows the same thing from the other
side: one assistant message carrying 15 `toolCall` blocks (the entire smoke-test sequence), each
with kiro's upstream Bedrock id, each dispatched by pi, with results including

```
RESULT name=shell    id=toolu_bdrk_014phGyvevDRowjDtdzVP1of ERROR :: Tool shell not found
RESULT name=gsd_exec id=toolu_bdrk_0139uYgt7xsBSFqzqEEgJer7 ERROR :: Tool gsd_exec not found
RESULT name=glob     id=toolu_bdrk_01Qgyw7zu2tBfXzcxLq5Rrqy ERROR :: Tool glob not found
```

The ids are conclusive on two points. They are kiro's own `toolCallId` values passed straight
through by `id: u.toolCallId ?? ...`, so these blocks provably originate in this handler. And the
*same* ids reappear in a **subagent's** pi session, where `steer_subagent` and `get_subagent_result`
are not registered — the child inherited the parent's unresolved blocks verbatim and dispatched them
too.

### Fix

The chat transport already had the answer and the ACP path had simply never adopted it. Progress
blocks are tagged with `LIVE_TOOL_ID_PREFIX` and stripped at end of turn, so they drive the
mid-turn display via `partial` but never reach pi as work to do. `LIVE_TOOL_ID_PREFIX` and
`stripLivePlaceholders` are now exported from `stream-adapter.ts` and used by the ACP
`session/update` handler, with the strip applied **before** the final text block is appended so
`textIndex` still refers to the final content array. kiro's real id is kept as the suffix of the
placeholder id so traces stay correlatable, and a new `acp.toolcall.surfaced` trace event records
each one.

### Ruled out along the way

Recorded so the same ground is not re-walked: multi-question questionnaires (the args carried
exactly one question); `rpiv-todo` and the `pi-subagents` widget (both use `setWidget` into
`widgetContainerAbove`, not the overlay stack); arg-hash dedupe in the bridge (run 8's two calls
were an original plus a *reworded* retry, so no hash would have matched); and the toolCall-replay
defect fixed in `82c591e`, which is a different path (history serialisation) and remains fixed.

Two genuine upstream bugs were found while chasing this and are **not** the cause of the duplicate
cards, though the first is a real hang and the second makes teardown unpredictable once two
overlays do stack:

- `rpiv-ask-user-question` ignored its `AbortSignal`, so an abandoned turn left the questionnaire
  blocking forever. Patched locally; verified by the `bridge.result` at ms=120000 above, which
  previously never arrived.
- pi's `showExtensionCustom` tears down with the untargeted `this.ui.hideOverlay()`
  (`interactive-mode.ts:2841`), which pops the top of the overlay stack rather than its own entry,
  while already holding a precisely-targeted handle from `showOverlay` (`tui.ts:703-716`). Patched
  locally.

## 5e. Field evidence, 2026-09-20: the test suite was coupled to `.gsd`, and a session reset strands kiro on a dead bridge port

Two findings from the same debugging session, both made cheap by the trace events
added alongside them.

### 5e.1 29 of 43 `acp-transport.test.ts` tests were failing on the developer's machine

Symptom: 29 failures, every one a 5000ms timeout inside the `AcpScriptChild`
harness, including tests nobody had touched. The file accounted for 146 of the
suite's 149 seconds. Two wrong theories were ruled out first: CPU starvation from
concurrent live load (the machine was idle and the failures were identical), and
the `node:child_process` mock exporting only `spawn` while `acp-transport.ts` also
imports `execSync` (patching the mock to spread the real module changed nothing).

Instrumenting `spawnAcpChild` and `sendRaw` showed the transport getting *further*
than assumed: `initialize` was written, answered, and `session/new` was written
too. The stall was after that, in `startSession`'s MCP startup gate.

Root cause: `discoverWorkflowMcpServers()` walks up from `process.cwd()` looking
for a GSD project, and pi-kiro's own repo root has a `.gsd` directory. So every
test turn synthesized a `gsdworkflow` server, `startSession` added it to
`expectedServers`, and each test script -- which answers `initialize` and
`session/new` but never sends `_kiro.dev/mcp/server_initialized` for a server it
does not know exists -- waited on the gate until the test timeout. One command
proved it: `PI_KIRO_WORKFLOW_MCP=off npx vitest run test/acp-transport.test.ts`
went green instantly.

The suite was therefore silently coupled to whether the checkout happened to be a
GSD project: correct in CI, broken the day someone ran `gsd init` here. The fix
belongs in `test/test-setup.ts`, which already exists to stop tests reading the
developer's real environment (it redirects `$HOME`), and now pins
`PI_KIRO_WORKFLOW_MCP=off`.

Generalisable: the production code is fine. A workflow MCP server that never
initializes does stall a turn, but only until the startup timeout, which is
deliberately longer than 5s. What broke was a **test asserting against ambient
filesystem state**, and the tell was that untouched tests failed.

### 5e.2 A partial carries `partial: output` by reference, so an in-place strip rewrites history

The §5d fix stripped the display-only blocks with `output.content = strip(output.content)`
before pushing `done`. Two tests then failed claiming no `toolCall` block ever
reached a partial -- even though the live TUI visibly rendered them.

Both are right. Every streamed event carries `partial: output`, the same object,
so reassigning `output.content` retroactively empties the mid-turn view for any
consumer that reads a partial *after* the turn ends. With an async generator that
is any consumer the producer outruns; pi's TUI renders promptly and so sees the
blocks, which is why this never showed up in the live pane.

The final `done` (and `error`) message now gets a filtered **copy** and
`output.content` is left alone, which makes the mid-turn display deterministic
instead of dependent on consumer timing. A surfaced block is also now paired with
a `⚙ <tool>` thinking marker, full parity with `stream-adapter.ts:404`: pushing
onto `output.content` emits no event by itself, so previously nothing carried the
update until the next `agent_message_chunk` happened to arrive.

### 5e.3 Fixed: a session reset handed kiro a new bridge port it would never use

Found while re-running the smoke test with the §5d fix in place. `read`, `glob`,
`todo` and `Agent` all now work. `steer_subagent` and `get_subagent_result` fail
with kiro's `error sending request for url (http://127.0.0.1:59808/mcp/...)`.

Before the new trace events this had to be guessed at. Now it reads directly
(run 12, one kiro child, `pid=99684`, one registry key):

```
08:45:27.081 bridge.serve      port=59808
08:45:27.082 acp.session.new   servers=[{name:'pi', url:'http://127.0.0.1:59808/mcp/...'}]
08:45:38.656 bridge.call       tool=Agent  -> bridge.result ms=10          OK
08:45:40.340 bridge.close      port=59808  reason=signal-abort
08:45:40.340 bridge.serve      port=59886
08:45:40.341 acp.session.new   servers=[{name:'pi', url:'http://127.0.0.1:59886/mcp/...'}]
08:45:45.411 acp.prompt.send   mode=fresh
08:45:49.439 acp.toolcall.surfaced tool=steer_subagent            FAILS on 59808
```

Mechanism: the second turn took the divergence branch of `resolveSession`
(`mode=fresh` on a child that already had a session). That branch aborts
`sessionAbort`, which closes the bridge, mints a new one on a **new ephemeral
port**, and calls `session/new` with the new URL. kiro accepts the new session but
keeps the MCP client it already built for the server named `pi`, still pointed at
the closed port. Every bridged call for the rest of the conversation then fails.
Native tools are unaffected, which is exactly the pattern observed.

The bug is a conflation in `serveBridgeHttp(tools, getCtx, signal)`: the single
`signal` is both the server's **lifetime** and the **cancellation signal** handed
to each bridged `tool.execute`. Cancellation is genuinely per-session -- that is
what the divergence branch wants when it retires a controller whose tool calls may
be in flight. Lifetime is not: from kiro's point of view the bridge URL is a
property of the **child**, fixed when the child first learns it.

Fix: separate the two. `serveBridgeHttp` takes the child-scoped
signal for lifetime plus a `getCallSignal: () => AbortSignal` accessor for
per-call cancellation, symmetric with the `getCtx` callback it already takes and
resolved **per request** rather than captured, so a reset mid-turn still cancels
the calls the retired session had in flight. `AcpChild` gains a `childAbort`
controller for the server's lifetime, aborted only by `teardownChild`. The bridge
is mounted once (`acpEntry.bridge ??= ...`) and both the new-session and
divergence branches reuse it; divergence keeps retiring `sessionAbort` and no
longer touches the server.

Consequence worth stating: the bridge no longer discriminates which branch a turn
took, which one test used as its signal. The discriminator is now the session
controller -- the new-session branch reuses it (that path only ever discards a
session that never reached `ready`, so nothing can be in flight), the divergence
branch aborts and replaces it.

Pinned by `keeps one bridge URL across a divergence reset, so kiro never calls a
dead port`. The mock `getBridge` hands out a distinct port per mount, matching
`serveBridgeHttp`'s `listen(0)`, so "both sessions saw the same url" is not
vacuously true. Verified to catch the regression: reverting the source leaves the
test failing on `expected [ { …(2) }, { …(2) } ] to have a length of 1`.

Confirmed live (run 13, the same five-step bridge smoke test that produced the
trace above):

```
08:55:06.855 bridge.serve      port=60696
08:55:06.855 acp.session.new   servers=[{name:'pi', url:'http://127.0.0.1:60696/mcp/...'}]
08:55:22.463 bridge.call       tool=Agent               -> ms=11     isError=False
08:55:24.180 acp.session.new   servers=[{name:'pi', url:'http://127.0.0.1:60696/mcp/...'}]   SAME PORT
08:55:29.247 acp.prompt.send   mode=fresh                                              divergence branch
08:55:34.091 bridge.call       tool=steer_subagent      -> ms=2      isError=False
08:55:37.468 bridge.call       tool=get_subagent_result -> ms=21209  isError=False
08:56:09.940 bridge.call       tool=todo                -> ms=2      isError=False
```

One `bridge.serve` for the whole conversation, no `bridge.close` before teardown,
the second `session/new` carrying the *same* URL, and the two calls that used to
fail on the dead port now returning cleanly across a `mode=fresh` reset.

### 5e.4 A missing bridge tool failed silently at mount

Symptom class rather than a single incident: a name in the allow-list that no
loaded extension provides is dropped from the bridge without comment. kiro is
never told the tool exists, so the failure surfaces much later and somewhere else
-- the delegated model reaching for a different tool, or, for a name pi does not
register either, a bare `Tool <name> not found` from pi's own dispatcher with
nothing in it pointing at the bridge. Debugging starts from the wrong end.

Fix (implemented): `captureBridgeTools` calls `warnOnMissingBridgeTools(allowed,
bridged)` immediately after filtering. It names the missing tools **and** the ones
that were bridged, which is what separates "one extension is stale" from "nothing
loaded at all" (`Bridged: (none).`), and points at the two real causes: an
extension that failed to load, or a typo in `PI_KIRO_BRIDGE_TOOLS`.

Two deliberate properties. It never throws -- a partial bridge is still useful, so
this is advisory. And it dedupes per **tool name**, not per call: every ACP child
mounts its own bridge, so an unguarded warning repeats on each spawn and drowns
the log it exists to draw attention to, while per-name dedupe still reports a
*second, different* tool going missing later. `clearBridgeCache()` resets the set
so test order cannot silence it.

## 5f. Field evidence, 2026-09-20: a bridged tool runs against a SECOND, cold instance of its extension

The largest finding of the session, and the one that changes what the bridge can
promise. `captureBridgeTools` imports each bridgeable package's entry file and
calls its `default(shim)` to harvest tool definitions. Its docstring claimed the
captured definitions are "closures over each package's module-level state, shared
with the live extension instances". They are not. They close over a **second
instance** of that package, and pi's live instance is a different one.

Mechanism, pinned in pi's source: the extension loader builds jiti with
`moduleCache: false`.

```
coding-agent/src/core/extensions/loader.ts:496
    const jiti = createJitiImpl(import.meta.url, {
        moduleCache: false,
        ...resolutionOptions,
    });
```

Every import of an entry file therefore re-evaluates it into a fresh module graph
with its own bindings. That is deliberate on pi's side (it is what lets `/reload`
pick up edits, and pi caches the resulting *factory* separately). It also means no
specifier the bridge could use would reach pi's instance, and `ExtensionAPI` /
`ExtensionContext` expose no way to enumerate or invoke a registered tool by name
(`getAllRegisteredTools` and `getToolDefinition` live on `ExtensionRunner`, which
an extension cannot reach). So the second instance is structural, not a choice.

Proven directly rather than inferred. A globalThis counter plus a per-accessor log
in `rpiv-advisor/advisor/state.ts`, one pid:

```
09:05:25.558 pid=36269 instance=1 module-loaded
09:05:30.053 pid=36269 instance=1 setAdvisorModel(model)     <- /advisor restore
09:05:55.623 pid=36269 instance=1 getAdvisorModel -> SET
09:05:56.422 pid=36269 instance=2 module-loaded              <- bridge mount
09:06:07.326 pid=36269 instance=2 getAdvisorModel -> undefined  <- kiro's call
```

Two victims found, both silent, both by behaviour rather than by error:

1. **`advisor` never worked from kiro.** pi's UI announced
   `Advisor restored: amazon-bedrock/us.xai.grok-4.6, high` while the delegated
   model, on the same turn, got
   `No advisor model is configured. The user can enable one with the /advisor command.`
   The selection lived in a module-level `let`, so instance 2's copy was empty and
   `executeAdvisor`'s `if (!advisor)` guard fired.

2. **`todo` wrote to a store pi could not see.** kiro created and listed
   `#1 cross-instance-check` successfully through the bridge; `/todos` in the same
   process reported `No todos yet. Ask the agent to add some!`. The per-session task
   Map and the foreground render pointer were both module-scoped.

Worth stating plainly: this was invisible for as long as it was because each
instance is internally consistent. Nothing errors, nothing is logged, and a smoke
test driven entirely through the bridge passes. Both were only found by comparing
what the two sides of the process said about the same fact.

Fix (implemented upstream, not here): anchor the state on
`globalThis[Symbol.for(...)]`. This is already the convention in the rpiv monorepo
for exactly this hazard -- `rpiv-i18n`, `rpiv-workflow`'s built-ins and
skill-contracts registries, and `rpiv-advisor`'s own `inventory.ts`, whose docstring
gives the reason ("so the cache survives module re-import on /new, /fork,
/resume"). `advisor/state.ts` and `rpiv-todo`'s store were the two outliers.
Verified live afterwards: the advisor call from kiro returns content, and an item
kiro creates appears in `/todos`.

What this repo owns: the docstring on `captureBridgeTools` is corrected, and the
constraint is now stated where a future reader will hit it. **A bridged tool is only
correct if it is self-contained or keys its cross-instance state globally.** The
bridge cannot enforce that, and cannot detect a violation -- a cold instance looks
exactly like a working one.

The general fix belongs upstream in pi: a supported way for an extension to invoke
a registered tool by name would remove the need to re-import at all. Until then the
per-package discipline is the only mechanism.

## 5g. Field evidence, 2026-09-20: not redispatching and GSD's tool-call ledger are mutually exclusive

§5d's fix is correct and it has a cost that §7's definition of done rules out. Both cannot hold
at once with the block types pi has today. Recording it here rather than discovering it a third
time.

### The conflict

pi decides whether to execute tool calls by looking for `toolCall` blocks on the assistant
message (`agent-loop.ts:228` filter, `:232` dispatch). GSD decides whether a unit did any work by
counting `toolCall` blocks on assistant messages in the persisted session
(`snapshotUnitActivity`, `auto-unit-closeout.ts:56-81`, counting `block?.type === "toolCall"` at
`:71-73`). **It is the same block on the same message.** Removing it satisfies pi and starves GSD;
leaving it satisfies GSD and makes pi re-run work kiro already did.

There is one message, not two. `streamAssistantResponse` returns `await response.result()`
(`agent-loop.ts:401`, `:411`, `:416`, `:424`), `result()` resolves to the `done` event's `message`
or the `error` event's `error` (`ai/src/utils/event-stream.ts:86-88` and the
`AssistantMessageEventStream` selector at `:91-105`), and the returned object is both dispatched
(`agent-loop.ts:228`) and pushed into the persisted `newMessages` (`:219`). So the filtered copy
built at `acp-transport.ts:1088` (done) and `:1107` (error) is exactly what GSD later counts, and
under ACP **every** tool call is tagged `LIVE_TOOL_ID_PREFIX` and stripped. GSD sees zero.

### What zero costs

Two guards read that number and they behave differently:

- `isSuspiciousGhostCompletion` (`auto-unit-closeout.ts:83-94`) requires `toolCalls === 0` **and**
  `assistantMessages === 0`. A delegated turn always produces text, so this one does not fire.
- The zero tool-call guard (`auto/unit-phase.ts:858-948`, GSD issues #1833 and #2653) tests
  `lastUnit.toolCalls === 0` **alone**. It marks the unit failed, retries it in a fresh context,
  and past `MAX_ZERO_TOOL_RETRIES` notifies "context exhaustion" and calls `pauseAuto` with reason
  `zero-tool-calls-exhausted` (`:932-939`).

So GSD auto-mode on `PI_KIRO_TRANSPORT=acp` retries every unit and then stops, attributing it to
context exhaustion, while the units were in fact doing the work. That is the same
false-negative shape as the 2.21 stderr/format regression in §5b, reached by a different route:
the blocks exist mid-turn and are gone from history.

This is not ACP-only any more. `48d2ee5` adopted the same tagging and push-site filtering in
`stream-adapter.ts`, so both transports now have the property.

### Receipts

Measured, not inferred, and with a matched control arm. Every pi session file for this
project under `~/.pi/agent/sessions/`, counting `toolCall` blocks on persisted assistant
messages -- the exact quantity `snapshotUnitActivity` reads:

```
mtime              assistant msgs   toolCall blocks
09-20 00:59:20          4                 3
09-20 01:06:01          5                77
09-20 01:10:18          9                55
09-20 01:11:06         14                74
09-20 01:25:52          8                 3     <- last session before the running pi
                                                   picked up the 5d fix
09-20 01:40:09          1                 0
09-20 01:40:22          2                 0
09-20 01:46:04          1                 0
09-20 01:46:11          1                 0
09-20 01:55:58          2                 0
09-20 02:02:26          2                 0
09-20 02:08:16          2                 0
09-20 02:19:55          2                 0
09-20 02:20:02          2                 0
```

53 of the 78 session files persist at least one `toolCall` block; not one of them is after
the restart, and not one carries a `kiro-live-` id (the strip is working exactly as designed).

The last row is the six-tool bridge verification run. Its trace
(`pikiro-trace-run15.jsonl`) holds 9 `acp.toolcall.surfaced` events over 9 distinct
`kiroToolCallId`s and 7 `bridge.call`/`bridge.result` pairs, all `isError: false`. Its
persisted session holds 2 assistant messages and 0 `toolCall` blocks. So for that unit GSD
would compute `{ toolCalls: 0, assistantMessages: 2 }`: the ghost-completion guard stays
quiet exactly as predicted, and the zero tool-call guard fires.

### This repo's own tests asserted the losing side

Worth recording, because it shows the conflict is not a matter of taste. Two tests in
`test/stream-adapter.test.ts` predate all of this and assert the GSD-ledger property directly
on the `done` message:

- `:397-400` -- exactly one `toolCall` block, named `gsd_task_complete`, with
  `stopReason === "stop"`.
- `:479-482` -- exactly one block, its id `not.toContain("kiro-live-")`, and its `arguments`
  equal to the parsed `{ cmd: "cargo test" }`.

The second one is explicit: the final message must carry a block that is **not** live-tagged.
That is the same requirement GSD's counter has, written as an assertion, and it is
unsatisfiable together with "pi must not redispatch". `48d2ee5` turned both tests red, and
correctly so.

The belief that let the two coexist on paper is in the comment that commit deleted: the synthesized
blocks are "surfaced with stopReason `stop` -- the host counts/renders these but never
redispatches them". The first half is true and the second half is false, for the same reason
§5d gives. It is the chat transport's copy of the mistake §5f found in the bridge docstring:
an assumption about what the host does with what we hand it, never checked against the host.

### Why there is no fix inside this package

Anything countable is dispatchable. pi's `ToolCall` (`ai/src/types.ts:385-393`) carries `type`,
`id`, `name`, `arguments`, `thoughtSignature` and `namespace` -- no way to say "already executed
by the provider". A block that GSD counts is a block pi runs.

Two upstream fixes in pi, both using machinery that already exists:

1. **Gate dispatch on `stopReason`.** `"toolUse"` is already a `StopReason`
   (`ai/src/types.ts:418`), and it is what the enum is for. pi-kiro sets `"stop"` on a completed
   delegated turn, so a `stopReason`-gated loop would leave real blocks on the message, count
   correctly in GSD, and never redispatch. Note `:236-239` already reads `stopReason` -- but only
   to fail a batch on `"length"`, after deciding to dispatch.
2. **Honour `endTurn`.** `AssistantMessage.endTurn?: boolean` exists, and its own docstring says
   it is "preserved for debugging and does not currently affect agent control flow"
   (`ai/src/types.ts:530-534`).

A GSD-side mitigation would be to make the zero tool-call guard provider-aware and skip it for a
provider advertising `authMode: "externalCli"`, since such a provider's tool calls happen outside
pi by construction. That is a weaker fix: it restores auto-mode but leaves the ledger wrong.

Until one of those lands, §7's "tool-call counts matching GSD's ledger" is unreachable, and the
honest reading of the definition of done is that the *no-redispatch* half ships and the *ledger*
half is blocked on pi.

### How this was found, and how it was nearly missed

Not by a failing test: by reading what the consumer counts after changing what the producer
emits. The GSD run in progress when this was written is unaffected, because GSD's own agent
(`~/.gsd/agent/settings.json`) runs a Bedrock model with `packages: []` and so never loads
pi-kiro. A green `gsd headless auto` in this repo therefore says nothing about this defect. The
test that would expose it is the documented pattern in
`docs/integrations/gsd-workflow-mcp.md` -- pi with `/model kiro/auto` inside a GSD project,
driving auto-mode itself.

## 5h. Chat transport carries the same no-redispatch defect (2026-09-20)

### The defect

`reconcileToolCalls` in `stream-adapter.ts` synthesized end-of-turn `toolCall`
blocks and pushed them onto `output.content` with plain `kiro-mcp-<hash>-N-<name>`
IDs. pi's agent loop (`agent-loop.ts:228`) dispatches on the **presence** of
`toolCall` blocks regardless of `stopReason`. A false docstring claimed `"stop"`
prevented redispatch; it did not.

### Mechanism

Identical to §5d. The chat path had the same structural gap as ACP before
`318e6c5`/`4fae29c`: synthesized blocks with non-LIVE IDs survive
`stripLivePlaceholders` and reach pi's dispatch logic.

### Fix

`reconcileToolCalls` now tags every synthesized block with `LIVE_TOOL_ID_PREFIX`
before pushing. The `done` and `error` push sites build filtered spread copies
(`{ ...output, content: stripLivePlaceholders(output.content) }`) instead of
passing `output` directly, preserving mid-turn `partial: output` events from
retroactive mutation (§5e.2 applies identically here). `pushThinking` is called
once per block emitting `⚙ <toolname>` markers, and `trace("chat.toolcall.surfaced",
{ tool, displayOnly: true })` is emitted per block for `PI_KIRO_TRACE` parity
with the ACP path.

## 6. Non-goals

- No change to the trust/billing model (kiro-cli owns auth; seat-billed).
- No change to the tool-mounting design (agent profile + MCP servers).
- No attempt to expose kiro's *own* built-in tools to pi — direction stays pi→kiro.

## 7. Definition of done

- All six probes green with captured fixtures; parity suite green on both transports.
- A full GSD milestone slice completes on `PI_KIRO_TRANSPORT=acp` with **zero** salvage
  events, **zero** synthesized tool calls (all event-sourced), and tool-call counts
  matching GSD's ledger. **Blocked on pi, see §5g:** the ledger clause and §5d's
  no-redispatch fix are mutually exclusive with the block types pi has today, so the
  ledger reads zero and GSD's zero tool-call guard pauses auto-mode. The no-redispatch
  half ships; this half needs pi to gate dispatch on `stopReason` or honour `endTurn`.
- Sentinel, salvage heuristic, and list-sessions snapshot-diff code paths deleted.
