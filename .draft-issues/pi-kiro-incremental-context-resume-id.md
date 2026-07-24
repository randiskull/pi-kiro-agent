<!--
=========================== DRAFT-PARK-FILE PREAMBLE ===========================
Status: Drafted, NOT filed. Enhancement spec / fix-brief to feed a Claude session working
        IN the pi-kiro repo. This is your product → intended path is FIX, not FILE a GH issue.
Repo/product: randiskull/pi-kiro  (Pi provider extension for the local Kiro CLI)
Observed at:  pi-kiro v0.1.0  ·  kiro-cli 2.14.0  ·  @opengsd/gsd-pi host
Type: PERFORMANCE / SCALABILITY enhancement (not a correctness bug). Ships AFTER the
      authMode:externalCli fix (already applied). Lower-priority than that fix, and larger.
Filing trigger (if you ever want it as a GH issue instead of a direct fix): only if someone
      other than you maintains pi-kiro. Otherwise: implement directly.
PREREQUISITE — ✅ VERIFIED 2026-07-24 (kiro-cli 2.14.0), approach IS viable (details in "Open Questions"):
  1. ✅ `kiro-cli chat --no-interactive` persists a resumable session; list via
     `kiro-cli chat --list-sessions --format json` (subcommand flag). Session id NOT printed by the
     run — capture the newest-updatedAt session for the cwd.
  2. ✅ `--resume-id <ID> "<new turn only>"` retains prior context AND appends (messageCount 2→4).
  Both PASS → build it. (Had either failed, the fallback was config-only: GSD compaction + /clear.)
Everything BELOW this comment is the paste-ready brief.
================================================================================
-->

# Enhancement: incremental context via `kiro-cli --resume-id` (stop re-sending the full conversation every turn)

> **✅ IMPLEMENTED (2026-07-24).** Freshness audit + both prereqs re-confirmed live
> (kiro-cli 2.14.0): `--list-sessions --format json`, `--resume-id` recall+append
> (messageCount 2→4), and `--resume-id`+`--agent` coexistence. New `session-manager.ts`
> + `stream-adapter.ts` delta mode; 16 new tests (52 total, tsc clean). See the
> **Resolution** section at the end for design choices and the one live-test caveat.

## Metadata
| | |
|---|---|
| **Product** | pi-kiro — Pi provider extension for the local Kiro CLI |
| **Component** | `stream-adapter.ts` — `buildPromptFromContext` + `kiro-cli chat` spawn |
| **Version observed** | pi-kiro `0.1.0`; kiro-cli `2.14.0`; host `@opengsd/gsd-pi` |
| **Severity** | Medium (perf/scalability) — makes long GSD auto-mode sessions unusable on kiro |
| **Type** | Enhancement (no incorrect output today; the issue is latency/throughput) |
| **Relationship** | Independent of, and lower-priority than, the shipped `authMode:externalCli` fix |

## Summary
pi-kiro re-serializes the **entire Pi conversation** into a single prompt and spawns a **fresh, stateless `kiro-cli chat --no-interactive`** on **every turn**. kiro-cli has **no prompt caching**, so each turn re-processes the full accumulated context from scratch. On long GSD auto-mode sessions the conversation grows to ~1M tokens, and each call takes **~15 minutes and effectively hangs** — while the *same* GSD session runs fine on Anthropic because Anthropic **prompt-caches** the prefix. kiro-cli exposes a session-continuity API (`--resume-id`, `--list-sessions`) that pi-kiro does not use. Adopting it — send only the **delta** each turn, let kiro-cli retain prior context — would give kiro the nearest equivalent to caching and remove the hang.

## Impact (observed)
- GSD auto-mode on kiro **stalls ~15 min per call** once a session's context is large; multiple stalls end in a stuck-loop stop. The workaround today is a manual **`/clear`** at boundaries (resets Pi's conversation) plus lowering GSD's `compactionThresholdOverride`. Both are user-driven mitigations, not a fix in the provider.
- Root asymmetry with Anthropic: **caching**, not model quality. M016–M025 completed on Anthropic; M026 hung on kiro purely because kiro reprocesses the uncached full context every turn.

## Current Behavior (root cause)
In `stream-adapter.ts`:
- `buildPromptFromContext(context)` (≈ line 119) serializes **all** of `context.messages` into one XML-tagged prompt: `<prior_system_context>`, `<conversation_history>…</conversation_history>`, etc.
- The spawn (≈ line 238–249):
  ```ts
  const args = ["chat", "--no-interactive", "--trust-all-tools"];
  if (profile) args.push("--agent", profile.name, "--require-mcp-startup");
  if (model.id !== "auto") args.push("--model", model.id);
  if (effort) args.push("--effort", effort);
  args.push(buildPromptFromContext(context, bridge?.toolNames)); // <-- full history, every call
  const child = spawn(deps.binaryPath ?? "kiro-cli", args, { … });
  ```
- **No `--resume` / `--resume-id`.** Each spawn is independent; kiro-cli retains nothing between turns; the full history is re-sent and reprocessed every time.

kiro-cli supports continuity (`kiro-cli chat --help`):
```
-r, --resume                Resume the most recent conversation from this directory
    --resume-id <SESSION_ID> Resume a specific conversation by session ID
-l, --list-sessions         List all saved chat sessions for the current directory
```

## Proposed Enhancement
Maintain a **persistent kiro-cli session per Pi conversation** and send only the **new turn(s)** via `--resume-id`, so kiro-cli keeps the prior context instead of pi-kiro re-serializing it each call.

### Sketch of the algorithm (in `stream-adapter.ts` / a small session-manager module)
Track, per logical Pi conversation, a `{ sessionId, sentPrefixHash, sentMessageCount }`.
1. **First turn:** spawn as today (full prompt), but capture the resulting kiro-cli **session id** (via output or `--list-sessions` diff). Record `sentPrefixHash = hash(context.messages)` and `sentMessageCount = context.messages.length`.
2. **Subsequent turn:** compare `context.messages` to what was last sent:
   - **Pure append** (prefix `0..sentMessageCount` unchanged, hash matches): send only `context.messages.slice(sentMessageCount)` as the new prompt with `--resume-id <sessionId>`. Update counters/hash. *(This is the fast path — no full re-send.)*
   - **Prefix changed** (Pi compacted / edited / truncated — hash mismatch): the kiro-cli session is now divergent. **Reset**: start a fresh session with the full (compacted) context, capture a new session id. *(Correctness-first: never resume onto a diverged session.)*
3. **Session lifecycle:** key sessions by a stable conversation identifier; clean up stale sessions (`--list-sessions`); handle the working-directory scoping (kiro-cli sessions are per-directory).

### Why prefix-hash + reset-on-divergence is mandatory
Pi's `Context` is **authoritative and mutable, not append-only**: GSD/Pi **compacts** (replaces N messages with a summary), and can edit/truncate. kiro-cli sessions are append-only. If pi-kiro blindly `--resume`d after a compaction, kiro-cli would still hold the *old, uncompacted* history → **the model sees a different context than Pi believes it does** → wrong/inconsistent output. So any prefix change must force a full reset. This makes the optimization *safe but opportunistic*: it saves re-processing **between** compactions, and pays a full re-send **at** each compaction.

## Honest caveats / where the benefit is bounded
- **Frequent compaction erodes the win.** With `compactionThresholdOverride` low (we just set 0.3 for kiro), Pi compacts often → more resets → fewer pure-append fast paths. The config lever (compaction + `/clear`) and this enhancement are partly **substitutes**: aggressive compaction keeps prompts small *without* resume; resume keeps *large* contexts cheap *without* compaction. Best combo depends on measured turn latency.
- **Prompt-format change.** Today the prompt embeds history inside XML tags. On the resume fast path, pi-kiro must send **only the new turn's content** (not re-embed `<conversation_history>`), or kiro-cli would double-count history. The XML-tagged sentinel/tool-context scaffolding needs a "delta mode."
- **Tool-call turns & the MCP bridge.** pi-kiro bridges tools (workflow-MCP transport). Tool-call/tool-result turns must map cleanly onto resumed turns; verify kiro-cli replays/represents them correctly under `--resume-id`.
- **Session capture reliability.** Need a robust way to obtain the session id after a `--no-interactive` run (stdout field? `--list-sessions` newest-in-dir diff?), and to guard against concurrent GSD units racing on the same directory's session list.
- **`--no-interactive` persistence unknown.** If headless runs don't persist a session at all, the whole approach needs a different session-creation path — this is the #1 prerequisite to verify.

## Open Questions — PREREQS VERIFIED 2026-07-24 (kiro-cli 2.14.0) ✅ approach is viable
Live-tested against kiro-cli 2.14.0; the two gating prereqs PASS:
1. **✅ `--no-interactive` persists a resumable session.** Each headless run creates a session.
   List them with **`kiro-cli chat --list-sessions --format json`** → `[{cwd, sessions:[{sessionId,
   source, title, updatedAt, messageCount}]}]`. **The run itself does NOT print the sessionId** —
   capture it by taking the newest-`updatedAt` session for the cwd from `--list-sessions` right after
   the spawn (the `--list` / `--list-sessions` flag is a `chat` **subcommand** flag, NOT top-level).
2. **✅ `--resume-id <ID> "<new turn>"` retains context AND appends.** Verified recall of a
   passphrase set one turn earlier; `messageCount` grew 2 → 4 on the same `sessionId` (append, not
   replace/fork). So sending only the delta works.
Still to verify during implementation (do NOT gate the approach, but design for them):
3. How does resume interact with `--agent`/MCP startup (`--require-mcp-startup`) and tool turns?
4. Concurrency: sessions are **per-cwd**; GSD may spawn units from the same worktree. The
   newest-`updatedAt` capture is race-prone under concurrency — key by title/timestamp or serialize
   session creation. Design the session-manager to tolerate a mis-capture by falling back to a full
   re-send (never resume onto a session you're not sure is yours).

## Acceptance Criteria
- [ ] On a multi-turn conversation with an unchanged prefix, turn N sends **only** the messages after the last-sent count (assert via captured spawn args / a fake spawn), using `--resume-id`.
- [ ] A simulated Pi **compaction** (prefix hash change) triggers a **full-context reset** with a new session id — never a resume onto the diverged session.
- [ ] Output parity: a resumed multi-turn exchange yields the same assistant result as the current full-re-send path (golden test).
- [ ] Measured: per-turn wall-clock on a large (>200K-token) context drops materially vs. full re-send (before/after timing).
- [ ] Fallback: if session capture/resume fails at runtime, pi-kiro **degrades to the current full-prompt path** (no hard failure).

## Test Plan
1. **Unit (fake spawn):** inject a spawn stub; drive `streamSimple` with an append-only message sequence → assert `--resume-id` + delta-only args on turns ≥ 2.
2. **Unit (divergence):** mutate the prefix (simulate compaction) between turns → assert a reset (fresh session, full context).
3. **Integration (real kiro-cli):** two-turn exchange; assert turn 2 uses `--resume-id`, retains context (answers a question only answerable from turn 1), and returns `usage.totalTokens === 0` (seat-billed unchanged).
4. **Perf:** time a ~300K-token context turn with vs. without resume; record the delta.
5. **Fallback:** force a bad/missing session id → assert graceful degrade to full-prompt path.

## Alternatives / relationship to the config lever
- **Config-only (shipping now):** lower GSD `compactionThresholdOverride` (→ 0.3) + `/clear` at milestone/slice boundaries. Simple, no code, already mitigates the hang. This enhancement is worth it **only if** measured latency shows compaction alone leaves turns too slow, or if you want large-context sessions without frequent compaction.
- **Do nothing in pi-kiro:** acceptable if the config lever proves sufficient in practice. Re-evaluate after a few kiro milestones with the 0.3 threshold.

## References (file:line, as observed)
- pi-kiro `stream-adapter.ts` — `buildPromptFromContext` (≈119) serializes full history; spawn builds `["chat","--no-interactive","--trust-all-tools", …]` + full prompt (≈238–249); **no `--resume`**.
- `kiro-cli chat --help` — `--resume`, `--resume-id <SESSION_ID>`, `--list-sessions` (session continuity exists).
- Contrast: Anthropic backend relies on **prompt caching** (5-min TTL prefix cache) — the reason identical GSD sessions are fast there and hang on kiro.
- GSD host config lever: `~/.gsd/agent/settings.json` `compactionThresholdOverride` (set to `0.3` for kiro on 2026-07-23).

## Resolution (2026-07-24)
New `session-manager.ts` (state + policy) keeps `stream-adapter.ts` thin.

**Session identity (the hard part).** Pi's `Context` is `{systemPrompt?, messages, tools?}` — **no conversation id**. So identity is anchored on `hashMessages(messages[0..sentMessageCount])`. This one mechanism does three jobs: matches an incoming turn to its kiro session, detects divergence (compaction/edit/truncate → prefix hash changes → no match → fresh reset), and separates concurrent conversations (distinct content → distinct hashes). The hash excludes `thinking` blocks (volatile) so a settled prefix stays stable across turns.

**sessionId capture (concurrency race).** `--no-interactive` does not print the id, so a fresh turn snapshots session ids in the cwd *before* the spawn and, after, records the session **only if exactly one new session appeared** in that cwd. This is race-safe by construction: a concurrent creation in the same worktree makes the diff `!= 1` → we record nothing and the next turn re-sends full. We never mis-capture — we only ever forgo the optimization under contention. (I chose snapshot-diff over title-matching because every turn's prompt shares the same fixed preamble, so kiro session `title`s are not distinguishing.)

**Compaction-reset boundary.** `planTurn` returns `resume` only when the tracked session's `sentMessageCount` prefix hashes identically AND the delta contains ≥1 non-assistant message. Any mismatch (including a context shorter than what was sent) ⇒ `fresh`. We never `--resume` onto a diverged session — correctness over savings.

**Delta prompt.** `buildDeltaPrompt` reuses the same scaffolding (preamble + `@pi` tool-context + sentinel) but emits only the new turn's `<user_message>`/`<tool_result>` blocks — no `<prior_system_context>`, no `<conversation_history>`. It **skips assistant messages**: those are kiro's own prior replies (already in-session); re-sending them would echo the model's output back as user input. *(Minor deviation from the spec's literal "slice(sentMessageCount)" — I slice then drop assistant echoes. Rationale above.)*

**Fallback (never hard-fail).** Layered: capture ambiguous / list fails / persisted-nothing ⇒ record nothing (next turn full). A `--resume-id` spawn that exits nonzero ⇒ drop the session, snapshot, and retry the same turn with full context (added a 3rd attempt slot alongside the MCP-startup retry). `PI_KIRO_RESUME=off` forces the legacy full-send path entirely.

**Seat billing unchanged.** No `usage` changes; `totalTokens` stays 0.

**Overhead.** Two extra `--list-sessions` calls per *session creation* (snapshot + capture); **zero** on the resume fast path (advance is in-memory). So the cost is paid once per conversation (and once per compaction), not per turn.

**Verification.**
- 16 new tests (52 total): session-manager units (hash stability, append→resume, ambiguous/none capture, divergence reset, assistant-echo-only ⇒ fresh, advance, drop, cross-cwd isolation, `PI_KIRO_RESUME=off`); adapter integration with faked spawn+execFile (turn-1 full → turn-2 `--resume-id` + delta-only prompt; compaction ⇒ fresh full send; resume-fail ⇒ full fallback; output parity; off-switch).
- Real kiro-cli (direct): `--resume-id` recalls a codeword set one turn earlier and appends (messageCount 2→4); `--resume-id`+`--agent` parse and run together; `--list-sessions`→`chat` sequence is clean.
- **Live adapter test (`stream-adapter-live.test.ts`, `describe.skipIf(!PI_KIRO_LIVE)`):** could not complete a clean automated run — kiro-cli triggers an interactive **"Opening browser…" SSO-refresh** when spawned by vitest (detached, no TTY) if a token refresh falls due mid-run, and hangs. This is a kiro-cli-under-vitest **environment quirk**, not a defect: the identical commands run clean directly in a shell. Kept in the suite (skipped by default) for on-demand use when auth is freshly warmed.

**Not done / follow-ups.**
- The spec's "measured >200K-token latency drop" (perf acceptance) is not automated — it needs a live large-context session; validate during real GSD use.
- Confirm the fast path holds under GSD's actual dispatch cadence (it bridges every turn, and low `compactionThresholdOverride` means more resets — resume and aggressive compaction are partly substitutes, as the brief notes).
