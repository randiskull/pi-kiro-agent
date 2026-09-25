# M001 — Chat transport: stop pi re-executing tool calls kiro already ran

## Goal

Apply to the default `chat` transport the fix already landed for `acp`
(`318e6c5`, design doc §5d): surfaced tool-call blocks must be visible to the host
for counting and rendering without pi's agent loop dispatching them a second time.

## Why this exists

`src/stream-adapter.ts:476` `reconcileToolCalls` pushes the end-of-turn
`synthesizeToolCallBlocks(toolTranscript)` output onto the assistant message as
real pi `toolCall` blocks. Its docstring asserts:

> Surfaced with stopReason "stop" — the host counts/renders these but never
> redispatches them, since execution already happened inside kiro via MCP.

That claim is false, and was proven false for the identical code path in
`acp-transport.ts`. pi's agent loop dispatches off the **presence** of `toolCall`
blocks, never `stopReason`:

```
pi/packages/agent/src/agent-loop.ts:228   const toolCalls = message.content.filter((c) => c.type === "toolCall");
pi/packages/agent/src/agent-loop.ts:232   if (toolCalls.length > 0) {
```

`stopReason` is consulted only at `:237`, and only to decide whether a `"length"`
stop should fail the batch instead of executing it. `"stop"` takes the execute
branch.

On the ACP transport the same defect presented as four unrelated-looking bugs:
duplicate `ask_user_question` cards that never reached the MCP bridge, `Tool shell
not found` for kiro-native tools pi does not register, kiro appearing to "restart" a
delegated task because the error results became its next prompt, and phantom extra
kiro sessions. Nothing in the chat path makes it immune.

## In scope

1. `reconcileToolCalls` tags surfaced blocks so they are recognisable and strips
   them before the message reaches the host as final, reusing the existing
   `LIVE_TOOL_ID_PREFIX` / `stripLivePlaceholders` machinery in
   `src/stream-adapter.ts:61,64` rather than inventing a second mechanism.
2. The same partial-by-reference defect fixed for ACP in `4fae29c` (design doc
   §5e.2): `reconcileToolCalls` reassigns `output.content` on the object that every
   streamed event carries as `partial`, so a consumer the producer outruns sees the
   mid-turn display change retroactively. The final message must be built from a
   filtered **copy**.
3. Correct the false docstring. State what actually holds and cite
   `agent-loop.ts:228`.
4. A trace event for each surfaced block, matching `acp.toolcall.surfaced`, so the
   chat path is as readable as the ACP path from a trace alone.

## Out of scope

- Any change to `synthesizeToolCallBlocks` itself or to kiro's transcript parsing.
  Argument fidelity on the chat transport is a separate, documented limitation
  (`docs/integrations/gsd-workflow-mcp.md`, "Transport matters").
- Promoting `chat` to a supported GSD transport. It stays unsupported for GSD.
- Any change to the ACP transport.

## Dependencies

None outside the repo. The ACP fix it mirrors is already on `main`
(`318e6c5`, `4fae29c`).

## External blockers

None.

## Acceptance criteria

- **R001** — A chat turn whose transcript yields N tool uses produces an assistant
  message the host does **not** dispatch: a test that drives the chat transport with
  a transcript containing a tool pi does not register asserts zero
  `Tool <name> not found` results.
- **R002** — The surfaced blocks are still counted and rendered mid-turn: a
  `pushThinking` line per surfaced tool, matching the ACP path's `⚙ <tool>` output at
  `src/stream-adapter.ts:404`.
- **R003** — `output.content` is not mutated in place. A test holds a reference to
  the `partial` object from a mid-turn event and asserts its content is unchanged
  after `done`.
- **R004** — Each surfaced block emits a trace event naming the tool, asserted by a
  test against a captured trace.
- **R005** — Every new test is shown to catch the defect: reverting the source under
  test leaves it failing. Record the observed failure message in the commit body.
- **R006** — `npm run verify` green (tsc, full suite, secret scan). No skipped tests
  added.
- **R007** — `docs/design/acp-transport.md` gains a section for the chat path's
  version of the defect, and the false docstring on `reconcileToolCalls` is replaced
  with one that cites `agent-loop.ts:228`.

## Execution notes

Work on a branch off `main`. Do not push. `main` is at `9f8aaf9`.
