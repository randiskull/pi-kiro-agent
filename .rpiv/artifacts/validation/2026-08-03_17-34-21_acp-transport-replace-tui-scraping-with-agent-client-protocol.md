---
date: 2026-08-03T17:34:21-0700
author: Randy James
commit: 802a6a1
branch: main
repository: pi-kiro
topic: "Validation of ACP transport — replace TUI scraping with Agent Client Protocol"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-08-03_14-50-21_acp-transport.md"
tags: [validation, acp, transport, kiro-cli, protocol, ndjson, jsonrpc]
last_updated: 2026-08-03T17:34:21-0700
---

## Validation Report: ACP transport — replace TUI scraping with Agent Client Protocol

### Implementation Status

- ✓ Phase 1: acp-session.ts — ACP session state + NDJSON client — Fully implemented
- ✓ Phase 2: acp-transport.ts — makeStreamViaAcp factory — Fully implemented
- ✓ Phase 3: parity test suite — Fully implemented (25 ACP tests, 3 additional sentinel-leakage tests beyond the 22 planned)
- ✓ Phase 4: wiring + dead code deletion — Fully implemented

### Automated Verification Results

- ✓ Type check: `npm run check` — Clean, no errors
- ✓ ACP test suite: `npx vitest run acp-transport.test.ts` — 25 passed (plan specified 22; 3 extra added for sentinel-leakage fix)
- ✓ Full suite: `npm test` — 99 passed | 1 skipped (plan baseline specified 91+; count is higher due to in-scope sentinel fix adding 8 tests)
- ✓ Phase 4 gate: `grep -r "PI_KIRO_TRANSPORT" index.ts` — shows gate at index.ts:91
- ✓ DoD assertions: FINAL_OPEN/FINAL_CLOSE, parseKiroToolUses, synthesizeToolCallBlocks, snapshotSessions, recordFreshSession, makeListSessions, cleanBody, extractFinal — none present in acp-transport.ts
- ✓ VN2 (crash recovery): `child_crash_drops_sessions_and_next_turn_respawns_full_resend` — passes
- ✓ VN3 (listener race): `startSession_registers_listener_before_session_new` — passes
- ✓ VN4 (abort mid-spawn): `spawnAcpChild_abort_during_initialize_kills_child_no_hang` — passes
- ✓ VN5 (no session/cancel): abort test asserts no session/cancel JSON-RPC sent — passes
- ✓ No regressions detected (stream-adapter, bridge, readiness, index, session-manager tests all green)

### Code Review Findings

#### Matches Plan:

- `acp-session.ts` — hashMessages uses SHA-256 with SOH (`\x01`) inter-message separator; verbatim port from session-manager.ts as specified
- `acp-session.ts` — MAX_SESSIONS = 64, array registry with LRU eviction via `upsert()`, all 6 public exports present
- `acp-transport.ts:280` — `registry.set(cwd, entry)` called synchronously before `initialize` await (abort-mid-spawn fix, VN4)
- `acp-transport.ts:191-210` — `_kiro.dev/commands/available` listener registered via `onNotification` before `session/new` request is sent (race fix, VN3)
- `acp-transport.ts` — session lifecycle (create/reuse/diverge) entirely in the `makeStreamViaAcp` IIFE; `getOrCreateChild` is lifecycle-free (spurious-divergence fix)
- `acp-transport.ts:228-246` — `buildMcpServersConfig` converts `env Record<string,string>` → `Array<{name,value}>` (wire format, VN7)
- `acp-transport.ts:255` — spawn args: `["acp", "--trust-all-tools", "--agent-engine", "v2"]` — no `--agent-profile`
- `acp-transport.ts` — no `session/load` calls anywhere
- `acp-transport.ts` — bridge closed in all three paths: `killChild()`, divergence reset branch, `child.on("exit")` handler
- `stream-adapter.ts` — `PromptBuildOpts` interface exported; `buildPromptFromContext` and `buildDeltaPrompt` accept `opts?: PromptBuildOpts` as 4th param; `sentinel: false` omits the instruction line; chat transport callers pass no 4th arg (sentinel defaults to true)
- `acp-transport.ts` — both prompt call sites pass `{ sentinel: false }` (spec §3.4)
- `acp-transport.ts` — defensive `textAccum.replace(/<pi_final>/g, "").replace(/<\/pi_final>/g, "").trim()` strip before text block assembly
- `index.ts:91` — `const useAcp = process.env.PI_KIRO_TRANSPORT === "acp"` gate present; `makeStreamViaAcp` imported; `makeStreamViaKiro` default unchanged

#### Deviations from Plan:

- **Test count higher than specified**: plan specified "91+ passed | 1 skipped" (Desired End State baseline). Actual: 99 passed | 1 skipped. The delta (8 extra tests) comes from the sentinel-leakage fix (3 sentinel-leakage tests in `acp-transport.test.ts`, 1 `sentinel: false` test in `stream-adapter.test.ts`) and the 4 live-field acceptance tests (VN2/VN3/VN4/VN5) that were added per the plan's own late reviewer findings. The plan's Phase 3 success criterion explicitly called for 22 ACP tests + global 91+; the actual 25 ACP tests and 99 total are strictly additive improvements and count as a positive deviation.
- **Sentinel leakage fix not in original plan**: the fix (PromptBuildOpts sentinel flag + defensive strip) was added after a live smoke test found `<pi_final>` tags leaking into ACP output. This is in-scope — it directly addresses the plan's spec §3.4 requirement ("sentinel wrapper dies under ACP") — but is not reflected in the plan's phase descriptions. Treated as a legitimate in-scope hardening.

#### Pattern Conformance:

- ✓ `acp-session.ts` matches `session-manager.ts` exactly on hash algorithm, registry structure, API shape, and LRU eviction
- ✓ `acp-transport.ts` matches `stream-adapter.ts` on `createAssistantMessageEventStream()`, event push sequence (start→thinking→text→done), error push pattern, and `emptyAssistantMessage` shape
- ✓ `AcpScriptChild` (NDJSON bidirectional fake) extends `FakeChild` (unidirectional EventEmitter) appropriately — the extra machinery (PassThrough streams, `sendLine`/`awaitLine` protocol driver) is proportionate to the ACP bidirectional requirement
- ✓ `collect()`, `beforeEach` reset, and `describe` block structure match `stream-adapter.test.ts` conventions
- ✓ `PromptBuildOpts` follows existing optional-opts additive extension pattern; backward-compatible by design

### Manual Testing Required:

1. Field gate §4.4 (not yet passed — pre-commit):
   - [ ] Set `PI_KIRO_TRANSPORT=acp` and run a full GSD milestone slice on `kiro/auto`
   - [ ] Confirm zero exit-salvage events (no salvage path exists in ACP transport)
   - [ ] Confirm zero synthesized tool calls in the turn output
   - [ ] Confirm `@pi/<tool_name>` resolves inside kiro on an ACP turn (bridge mounted via session/new)

2. Idle timer and lifecycle smoke:
   - [ ] Confirm persistent child is reused across turns (spawn called once for a two-turn conversation)
   - [ ] Confirm idle timeout kills child after 10 min of inactivity
   - [ ] Kill `kiro-cli acp` process mid-idle; confirm next turn respawns cleanly (secondary to VN2 automated test)

3. Spurious `initialized` notification:
   - [ ] Confirm `initialized` notification (→ -32601) does not surface as an error or cause turn failure

### Recommendations:

- Ready to commit — implementation is complete and validated.
- Field gate §4.4 (GSD milestone slice on ACP) can proceed post-commit; it is the gate for flipping the default transport and for deleting sentinel/salvage/snapshot-diff code (plan §4.5 — explicitly deferred).
- The sentinel-leakage fix should be noted in the commit message as a live-smoke defect caught during validation.
