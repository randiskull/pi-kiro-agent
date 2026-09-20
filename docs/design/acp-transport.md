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

### 5e.3 Open defect: a session reset hands kiro a new bridge port it will never use

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

Intended fix: separate the two. `serveBridgeHttp` takes the child-scoped signal
for lifetime plus a `getCallSignal: () => AbortSignal` accessor for per-call
cancellation (symmetric with the `getCtx` callback it already takes), the bridge
is created once per child, and the divergence branch keeps retiring
`sessionAbort` without touching the server. Not yet implemented.

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
