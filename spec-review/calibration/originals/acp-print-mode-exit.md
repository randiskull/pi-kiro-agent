# Implementation Spec: `pi -p` must exit after a kiro turn on the ACP transport (0.4.1)

- Status: Draft
- Area: ACP transport / process lifetime
- Target release: pi-kiro-agent 0.4.1 (patch)
- Related: `src/bridge.ts`, `src/acp-transport.ts`, `src/index.ts`,
  `docs/design/acp-transport.md` §5e.3,
  `.gsd/workflows/spikes/261017-1-spike/research/ANGLE-5.md` (investigation)

## Goal

A one-shot host (`pi -p`, GSD headless, any print-mode or scripted run) that
completes a kiro turn on the default ACP transport must exit as soon as the
turn ends. It must not stay alive until the ACP idle timer (10 min) kills the
child.

After this change:

1. `pi -p --model kiro/<id> "<prompt>"` exits 0 promptly after printing the
   answer, with the tool bridge enabled (the default).
2. A turn that calls a bridged pi tool still works end to end.
3. Interactive sessions, `/new`, `/resume`, `fork` and `reload` behave as
   before. The per-child bridge URL invariant (§5e.3) is preserved.
4. Quitting pi tears down the ACP children and their bridges, instead of
   leaving them to the idle timer or the orphan reaper.

## Observed failure

0.4.0 made ACP the default transport. With it:

| Run | Result |
|---|---|
| `pi -p --no-session --model kiro/auto "Reply: x"` | answer printed, then hangs; killed by the 240 s `timeout` |
| same, `PI_KIRO_TRANSPORT=chat` | exit 0, 10.5 s |
| same, `PI_KIRO_BRIDGE=off` | exit 0, 9.3 s |
| same session, `amazon-bedrock/...` | exits normally |

A preload snapshot of `process.getActiveResourcesInfo()` in the `pi` process,
30 s after the answer printed:

```
resources: ["TCPServerWrap"]
Server listening {"address":"127.0.0.1","port":65238}   <- matches the bridge.serve trace port
```

The only active handle is the tool bridge's loopback HTTP server.

## Root cause

- `setChildKeepalive()` (`src/acp-transport.ts`) deliberately `unref()`s the
  ACP child and its three stdio pipes whenever no request is in flight, so
  that "a one-shot host must be able to exit".
  `test/acp-transport.test.ts` ("event-loop keepalive") pins this.
- 6ea0510 (v0.3.0) changed the bridge server to live as long as the **child**
  (`childAbort`) rather than the session, because kiro learns the bridge URL
  only once, at `session/new`. The server therefore now outlives every turn,
  but `serveBridgeHttp()` never `unref()`s it (`src/bridge.ts`, after
  `httpServer.listen(0, "127.0.0.1", ...)`). That one reference undoes the
  keepalive design.
- Nothing closes it before the idle timer: `src/index.ts` has no
  `session_shutdown` handler, and `teardownChild()` runs only on abort, idle
  timeout, the turn ceiling, a stale child or child exit.
- The bug was latent in 0.3.0, where ACP was opt-in, and became visible when
  0.4.0 made ACP the default.

## Scope

### In scope
- Unref the bridge's listening server.
- Tear down all ACP children on `session_shutdown` with `reason: "quit"`.
- Unit, regression and live tests (below).
- CHANGELOG entry, version bump to 0.4.1.

### Out of scope
- Credit-metering rebuild on `session_start`. That is the follow-up spec from
  the same spike (`RECOMMENDATION.md`).
- Host scoping for GSD (`docs/specs/dual-host-pi-gsd.md`).
- Changing the idle-timeout default or the bridge URL lifetime model.

## Approach

### 1. Unref the bridge server (the fix)

In `serveBridgeHttp()`, right after `listen()` resolves:

```ts
// The server lives as long as the ACP child (§5e.3), and the child is
// unref'd between turns so a one-shot host can exit (setChildKeepalive). A
// referenced listener would undo that. Unref only drops the event-loop hold:
// the server still accepts connections, and its lifetime is still owned by
// `signal` and close().
httpServer.unref();
```

Why this is safe:
- **During a turn**, `setChildKeepalive(true)` refs the child and its pipes,
  and the turn's awaited request is resolved from stdout, so the loop stays alive.
- **Bridged calls arrive only mid-turn.** Each accepted connection is its own
  referenced socket for its lifetime, so an in-flight tool call keeps the
  process up until it is answered.
- **Chat transport:** the bridge is per turn and closes with the turn, and the
  `kiro-cli chat` child stays referenced while it runs. Unref changes nothing there.
- **Interactive pi** keeps its own references (TTY and stdin), so it is unaffected.

Do not unref per connection, and do not change the ownership of `close()`.

### 2. Clean teardown on quit (hygiene)

Add a module-level, exported `shutdownAcpChildren(reason: string)` to
`src/acp-transport.ts`. It calls the existing `killChild(entry, reason)` (which
is `teardownChild(..., { kill: true })`) for every registry entry, clears the
registry, and is idempotent. This is exactly the body `_resetAcpChildren()`
has today. Wire it in
`src/index.ts`:

```ts
pi.on("session_shutdown", (event) => {
	// Only on quit. new/resume/fork/reload replace the session while this module,
	// and the per-cwd children it caches, live on and are reused.
	if (event.reason !== "quit") return;
	try { shutdownAcpChildren("host-quit"); } catch { /* never block exit */ }
});
```

- It must be synchronous and must never throw out of the handler.
- `teardownChild` already aborts `childAbort`, which closes the bridge, and
  settles pending requests.
- `_resetAcpChildren()` (the test hook) becomes `shutdownAcpChildren("test reset")`,
  so there is one teardown path.
- Do not tear down on non-quit reasons. That would kill a child the next
  session reuses and would break the §5e.3 single-URL invariant within a process.

Step 1 alone fixes the hang. Step 2 makes quit deterministic: no kiro-cli
child is left behind for the reaper, and a `bridge.close reason=child-teardown`
trace event appears on every exit.

## Acceptance criteria

1. **Hang fixed.** With the default transport (ACP) and bridge enabled,
   `pi -p --no-session --model kiro/auto "Reply with just: ok"` exits 0. On the
   reference machine that took about 11 s; any wall time that is bounded and
   not tied to the idle timeout passes.
   Evidence: captured command, wall time and exit code.
2. **Bridged tool still works.** A `pi -p` turn that calls a bridged tool
   (`rpiv_todo` or any `pi` MCP tool) completes, trace shows `bridge.call` and
   `bridge.result`, exit 0. The spike measured 15.8 s.
3. **Unit: server unref'd.** `serveBridgeHttp()` returns a server whose
   listening handle does not keep the loop alive.
4. **Unit: quit teardown.**
   - `session_shutdown{reason:"quit"}` empties the ACP registry and closes
     every child's bridge.
   - `new`, `resume`, `fork` and `reload` leave the registry and the bridge URL untouched.
   - A throwing teardown does not propagate out of the handler.
5. **No regressions.**
   - The existing "event-loop keepalive" tests pass unchanged.
   - The §5e.3 tests (one URL per child across a session reset) pass unchanged.
   - `test/extension-load.e2e.test.ts` passes.
6. `npm run verify` passes.
7. CHANGELOG `## 0.4.1` → `### Fixed` describes the symptom, the cause and the
   workaround for 0.4.0 users (`PI_KIRO_TRANSPORT=chat` or `PI_KIRO_BRIDGE=off`).
   `package.json` is 0.4.1.

## Verification plan

- **Negative control first.** Write the unit test for criterion 3 and confirm
  it fails on the current `bridge.ts`, for the right reason (the handle is
  referenced). Then apply the fix and confirm it passes.
  - Preferred assertion: start the server inside a child `node` process that
    calls `serveBridgeHttp()` and does nothing else, then assert the child exits
    on its own within a few seconds. This exercises real event-loop semantics
    with no mocks.
  - Cheaper complement: spy on `Server.prototype.unref`, or check
    `process.getActiveResourcesInfo()` before and after.
- **Quit teardown:** extend `test/index.test.ts` or `test/acp-transport.test.ts`
  with fake children, following the existing `refOps` spy pattern. Assert
  `teardownChild` runs once per child on quit and never on the other four reasons.
- **Live regression (gated `PI_KIRO_LIVE=1`, in `test/acp-transport-live.test.ts`):**
  spawn the real `pi -p` with ACP and the bridge enabled. Assert exit 0 within a
  bound well under the idle timeout (for example 120 s), and that stdout
  contains the reply. Second case: a prompt that forces one bridged tool call.
  - Run the subprocess with a clean environment (strip `GSD_*`,
    `PI_PACKAGE_DIR`) so the host resolves pi's own agent home. See
    `dual-host-pi-gsd.md`; the spike tripped on exactly this.
- **Manual reproduction (record in the PR):** run the command from criterion 1
  before and after the change, with `PI_KIRO_TRACE` set, and quote the
  wall time and exit code.

## Risks and notes

- **Exit mid-turn.** If a future change makes a turn wait on something other
  than a referenced handle (for example a timer-only wait with the child
  unref'd), the process could exit mid-turn. The keepalive invariant (ref the
  child while `pending > 0`) is what prevents that; the live test covers it.
- **A bridged tool that spawns detached work** after returning its result is
  already not kept alive in chat mode. Behaviour is unchanged, but worth a line
  in the PR.
- **`session_shutdown` ordering.** Pi awaits extension handlers before
  `session.dispose()`. Keep the handler synchronous so a slow kill can never
  delay exit. `teardownChild` sends SIGTERM to the process group and does not wait.
- **The 0.4.0 workaround** to document until users upgrade:
  `PI_KIRO_TRANSPORT=chat` (stream-json text path) or `PI_KIRO_BRIDGE=off`
  (no pi tools for kiro).
- ASCII-only in trace reasons and machine-read strings (`host-quit`).

## Attribution

Investigation: spike `261017-1-spike` (angles 4 and 5). Spec: Kiro, Claude Opus 5.
