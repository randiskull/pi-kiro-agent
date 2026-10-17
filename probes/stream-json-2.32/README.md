# `kiro-cli chat --output-format stream-json` probes — kiro-cli 2.32.0

Recorded 2026-10-16 to close the three unknowns in
[`docs/design/acp-transport.md` §5c](../../docs/design/acp-transport.md) before the
stream-json reader is specced. Every capture is stdout only (stderr was separate and is noted
where non-empty). Command shape for all of them:

```
kiro-cli chat --output-format stream-json --trust-all-tools --agent-engine v2 \
  --model claude-haiku-4.5 [extra] "<prompt>"
```

The probe project held one file, `note.txt` ("The secret word is PELICAN."). Its absolute path is
redacted to `<probe-proj>`.

| File | Extra args | What it shows |
|---|---|---|
| `p1-builtin.jsonl` | — | built-in `read` call; interim narration lands in `finalText` |
| `p2-resume.jsonl` | `--resume-id <p1 session>` | resume works under stream-json |
| `p2b-badresume.jsonl` | `--resume-id 0000…` | a bad resume is a structured `runError`, exit 1 |
| `p3-toolerr.jsonl` | — | failed built-in read; shell command exiting non-zero |
| `p4-long.trimmed.jsonl` | — | 23,892-char answer, not truncated (1,735 middle chunks elided) |
| `p5-thought.jsonl` | `--effort high` | no `agent_thought_chunk` from haiku even at high effort |

## Findings

**Envelope is unchanged since 2.21.** Every run starts with
`{"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v2"}}`.
Zero unparseable lines across all six runs. stderr was empty on every successful run.

**Event types seen:** `runStarted`, `sessionUpdate` (`agent_message_chunk`, `tool_call`,
`tool_call_update`), `metadata`, `runFinished`, and on failure `runError`. No
`agent_thought_chunk` from haiku (p5); §5c observed it on another model, so a reader must accept
both.

**`finalText` is ALL message text of the turn, not the final answer (p1).** With the prompt
"reply STARTING, read note.txt, reply with the word", `finalText` was
`"STARTING\n\nLet me read the file:PELICAN"`. It equals the concatenated `agent_message_chunk`
texts byte for byte in every run, including the 23,892-char p4. Selecting the answer still needs
a rule (sentinel, after-last-tool, or whole text).

**`finalTextTruncated` did not trip at 23,892 chars (p4).** The boundary is above that. Since the
chunks reassemble to the same string, chunk reassembly is a complete source on its own;
`finalText` is a cross-check.

**`--resume-id` works under stream-json (p2).** Same `sessionId` in `metadata` and `runFinished`,
context retained ("What was the secret word you found earlier?" → `PELICAN`).

**A bad resume id is structured (p2b):** `runStarted` then
`{"type":"runError","data":{"sessionId":null,"stage":"init","message":"Internal error: \"Failed to start session: Session not found: …\""}}`,
exit 1, stderr `error: ACP load_session failed`. The existing "resume failed → retry with full
context" fallback still has a clean signal.

**Session id is available from the first `metadata` event**, before any tool runs, and again on
`runFinished.data.sessionId`. The pre/post `list-sessions` snapshot diff is unnecessary on this
path.

**Credits:** the last `metadata` before `runFinished` carries `meteringUsage` (one entry per model
call; p1 had two) plus `turnDurationMs`. Earlier `metadata` events have `meteringUsage: null` and
only update `contextUsagePercentage`. `runFinished` has `status: "success"` and
`stopReason: "end_turn"`.

**Tool calls (p1, p3):**

- Built-ins carry their name: `_meta.kiro.toolName` `read` / `shell`, `kind` `read` / `execute`,
  `title` is the prose line the text scrape saw (`Reading note.txt:1`,
  `Running: ls /definitely-not-here`). `rawInput` is complete and includes kiro's own
  `__tool_use_purpose` key.
- **A failed call can arrive with NO preceding `tool_call`** (p3, read of a missing file): only a
  `tool_call_update` with `status: "failed"`, carrying `toolName`, `kind`, `rawInput` and the error
  text in its `content`. A reader keyed on `tool_call` alone would drop it.
- **A shell command that exits non-zero is `status: "completed"`**, with
  `rawOutput.items[0].Json.exit_status: "exit status: 1"`. As §5c found for an MCP `isError`, the
  failure is inside the payload, not the status.
- Some `tool_call_update` events are bare progress pings with every field null except
  `toolCallId`.
- Ids are the model's own (`tooluse_…`), unique per call.
