# Spec: kiro-review ACP bridge hardening

## Context

A Kiro code review of the ACP transport surfaced two issues it flagged as
"warrant attention before the next release". Everything else in that review was
explicitly non-blocking. Both issues are pre-existing in mainline (present at
`7f1266a`, not regressions introduced by a recent PR).

### F1 — bridge lifetime is wired to the per-turn signal, `sessionAbort` is a dead field

`acp-transport.ts` documents the loopback MCP bridge as **per-session** in three
places (module header, `AcpDeps.getBridge`, `AcpChild.bridge`), but both
`getBridge` call sites pass `turnSignal`:

```ts
const turnSignal = options?.signal ?? new AbortController().signal;
...
const bridge = await deps.getBridge?.(turnSignal);
```

`serveBridgeHttp` (bridge.ts) consumes that signal twice — it closes the HTTP
server on abort, and it hands the same signal to every bridged `tool.execute`
call as the cancellation signal.

Meanwhile `AcpChild.sessionAbort` is documented as governing "the current
session's bridge and startup signals", but a repo-wide grep shows its `.signal`
is **never read anywhere**. The controller is only `.abort()`-ed, at three sites:
`killChild`, the child `exit` handler, and the divergence reset. So the field's
name and comment describe a wiring that does not exist.

Consequences of the mismatch:

* A host that aborts its per-request `AbortController` **after** a turn completes
  (a common cleanup pattern) tears down the bridge HTTP server while the ACP
  session lives on. The turn's own abort listener is detached in the `finally`
  block (`7f1266a`), so the child survives — and the next turn resumes a session
  whose `pi` MCP endpoint is dead.
* A host that reuses one long-lived `AbortSignal` across turns accumulates one
  never-removed `"abort"` listener per bridge on that signal — the same
  listener-leak class that `7f1266a` fixed for the transport's own `onAbort`.
* Latent double close: on abort, `killChild` closes the bridge explicitly *and*
  the turn signal's own listener fires a redundant `httpServer.close()`.

### F2 — a startup timeout leaves an orphaned `acpSessionId`

In `startSession`, `entry.acpSessionId` is assigned as soon as `session/new`
returns. The MCP-startup gate then runs:

```ts
await Promise.race([Promise.all([serversReadyPromise, cmdAvailablePromise]), timeout]);
entry.ready = true;
```

When the race resolves via `timeout`, `entry.ready = true` is never reached, but
`entry.acpSessionId` stays set. The `finally` block detaches both notification
listeners (correct) and stops there.

The child stays alive in the registry holding a session id that was never
recorded via `recordAcpSession`. The next turn therefore reads a truthy
`acpEntry.acpSessionId`, calls `planAcpTurn(cwd, <orphan id>, …)` which finds no
tracked session and returns `{ mode: "fresh" }` — so `useResume` is false and
control falls into the **divergence** branch rather than the clean new-session
branch. That path needlessly drops a session that was never tracked, aborts and
recycles the session `AbortController`, and tears down + rebuilds the bridge.

`entry.ready` is, before this change, written in four places and read in none.

## Scope

In scope:

* `acp-transport.ts` — bridge signal wiring, `sessionAbort` documentation,
  `startSession` failure cleanup, startup-timeout test seam.
* `bridge.ts` — make `HttpBridgeHandle.close()` idempotent (closes the F1
  double-close race at its source rather than at each call site).
* `acp-transport.test.ts` — tests for both findings.

Out of scope:

* Splitting `serveBridgeHttp`'s single `signal` parameter into separate
  server-lifetime and tool-cancellation signals. See the Decision Log — the
  chosen posture keeps both meanings correct without an API change, so the split
  is unnecessary today.
* The chat transport (`stream-adapter.ts`), whose bridge genuinely *is* per-turn
  and correctly passes `options?.signal`.
* Every other item in the Kiro review (all explicitly non-blocking).

## Approach

### F1 — Option A: couple bridge lifetime to session lifetime

1. Pass `acpEntry.sessionAbort.signal` to `deps.getBridge` at both call sites,
   replacing `turnSignal`. `sessionAbort` becomes what its name and comment
   always claimed.
2. In the new-session branch, close any bridge left over from a previous failed
   `startSession` attempt before mounting a fresh one — otherwise F2's fix
   (clearing `acpSessionId`) would route the next turn through a branch that
   overwrites `entry.bridge` and orphans a listening HTTP server for the child's
   lifetime.
3. `bridge.ts`: memoize the close promise so repeated `close()` calls await one
   shutdown instead of issuing a second `httpServer.close()` that resolves off an
   `ERR_SERVER_NOT_RUNNING` callback.
4. Correct the comments on `AcpDeps.getBridge`, `AcpChild.sessionAbort` and the
   module header to describe the actual wiring.

Abort propagation to in-flight bridged tool calls is preserved: a mid-turn abort
still runs `onAbort → killChild → sessionAbort.abort()`, which aborts the very
signal the bridge handed to `tool.execute`.

### F2 — clear the session id when the session never went ready

1. In `startSession`'s `finally`, add `if (!entry.ready) entry.acpSessionId = undefined;`.
   This gives `entry.ready` its first read and makes "has a session id" mean
   "has a *usable* session id", which is exactly the predicate the new-session
   branch tests.
2. Make the 30s startup timeout env-overridable
   (`PI_KIRO_MCP_STARTUP_TIMEOUT_MS`) through the existing `envMs` helper, in the
   same style as `PI_KIRO_IDLE_TIMEOUT_MS` / `PI_KIRO_TURN_TIMEOUT_MS`. Without a
   seam the timeout path is untestable in under 30 s of wall clock; the knob is
   also independently useful on slow machines mounting many MCP servers.
3. Widen the `_getAcpChildRegistry()` test hook's return type to expose
   `acpSessionId` and `ready` so the assertion is typed rather than cast.

## Acceptance Criteria

1. `deps.getBridge` is never called with the caller's per-turn `AbortSignal` in
   the ACP transport; both call sites pass the session-scoped signal.
2. After a turn completes successfully, aborting the caller's signal does **not**
   close the bridge and does **not** abort the signal the bridge holds.
3. Aborting a turn **while it is in flight** still closes the bridge and aborts
   the signal handed to bridged tool executions.
4. Calling `HttpBridgeHandle.close()` twice closes the server exactly once and
   both calls resolve.
5. A `startSession` that fails the MCP-startup gate by timeout leaves
   `entry.acpSessionId === undefined` and `entry.ready === false`.
6. The turn following such a timeout takes the new-session branch (predicate:
   `!acpEntry.acpSessionId`) and completes normally against a fresh session id.
7. A startup timeout leaves the CHILD alive: `entry.alive` stays true, the
   session controller is not aborted, and its bridge is not closed. Only the
   half-started session is discarded.
8. No new test failures versus clean `main`. The two known
   `workflow-mcp.test.ts` failures (a local GSD-home discovery artifact; green on
   CI) remain the only failures.
9. `tsc --noEmit` clean.

## Harness Selection

Implemented by **Claude Code (Opus 5)** dispatched through Kiro Crew, in a
dedicated scratch clone on `fix/kiro-review-acp-bridge-hardening`.

Reasoning:

* The work is small in diff size but requires whole-file reasoning about
  lifetimes across `acp-transport.ts`, `bridge.ts` and `index.ts`, plus a
  posture decision (F1 A-vs-B) that has to be justified from how the code
  actually behaves rather than from what its comments claim. That is a
  read-heavy, judgement-heavy task, which is where a frontier model in an agentic
  harness beats a scripted codemod or a narrow single-file edit.
* The findings came from Kiro's own review, so implementing them in Kiro would
  put reviewer and implementer in the same head. A different model closes the
  loop with independent judgement — and in fact reached the opposite conclusion
  from the review's leading suggestion on F1 (see Decision Log).
* The repo has a dense, fast vitest suite with protocol-level NDJSON fakes, so an
  agentic harness can verify its own change end to end.
* Isolation: scratch clone, local commits only. Push and PR are the
  orchestrator's step, so a bad run is discarded by deleting a directory.

## Decision Log

### 2026-09-09T19:59Z — F1: chose Option A (behavior fix), not Option B (rename/docs)

The brief offered two postures and said to prefer B if A risked closing the
bridge too early — specifically "the session signal aborts on a normal successful
turn in some host contexts". That risk does not exist, because `sessionAbort` is
not host-controlled. A grep confirms exactly three `sessionAbort.abort()` call
sites, all module-internal and all genuine session terminations:

| site | when |
| --- | --- |
| `killChild` | abort, idle timeout, turn ceiling, stale child, failed initialize |
| child `exit` handler | kiro-cli died |
| divergence reset | prefix mismatch → new session on the same child |

None of these fire on a normal successful turn, and no host can reach the
controller. So Option A cannot close the bridge early.

The risk runs the *other* way. Today's `turnSignal` wiring is what fires on host
timing the module does not control:

* Post-turn cleanup abort → bridge dies under a live session (dead `pi` MCP
  endpoint on the next turn). Under A: no effect, bridge survives with its
  session. ✅
* Long-lived shared host signal → one permanently attached `"abort"` listener per
  bridge, never removed. Under A the listener lives on an internal per-session
  controller instead. ✅
* Mid-turn abort → identical behavior under both postures, since `onAbort` calls
  `killChild`, which aborts `sessionAbort`. ⟳

The one genuine argument for B was that `serveBridgeHttp`'s `signal` is
dual-purpose: it is also the cancellation signal passed into every bridged
`tool.execute`, where turn scope is the semantically right scope. Making it
session-scoped looked like it would weaken abort propagation — a user pressing
ESC would no longer cancel an in-flight `ask_user_question` or `Agent` call.
Tracing the abort path shows it does not: `onAbort` is registered on the caller's
signal for the whole turn and calls `killChild`, which calls
`sessionAbort.abort()`. Every mid-turn abort still reaches the tool signal, one
hop later. The dual-purpose parameter therefore stays correct under A, and the
Out-of-scope split is unnecessary.

Option B was rejected because it fixes nothing. It renames a dead field to
advertise that it is dead (`_lifecycleAbort`) while leaving the documented
per-session bridge wired to a per-turn signal — i.e. it resolves a
code/comment contradiction by editing the comment that was right and keeping the
code that was wrong. A resolves it in the direction the design intended, makes
`sessionAbort` honest without a rename, and removes a host-visible listener leak
of the same class as `7f1266a`.

Cost of being wrong is bounded and cheap: if some host turns out to depend on
turn-scoped bridge teardown, reverting is a two-line change back to `turnSignal`.

**F1 lands as a behavior change, so it carries tests** (Acceptance Criteria 2–4).

### 2026-09-09T19:59Z — F2: confirmed as described, applied as prescribed

Read the surrounding logic before applying. It matches the brief exactly:
`entry.acpSessionId` is set at the `session/new` response, `entry.ready = true`
sits *after* the `Promise.race`, and the `finally` only detaches listeners. Fix
applied verbatim as `if (!entry.ready) entry.acpSessionId = undefined;`.

One addition the brief did not specify: the timeout branch also leaves
`entry.bridge` pointing at the failed session's bridge. Before this change that
bridge was closed (eventually, and only incidentally) by the turn signal; under
F1 nothing closes it, and F2 now routes the next turn into the branch that
overwrites `entry.bridge`. So the new-session branch closes any pre-existing
bridge first. F1 and F2 are individually correct but interact here, which is why
this belongs in the F1 commit that changes the ownership.

Second addition: `MCP_STARTUP_TIMEOUT_MS` became `mcpStartupTimeoutMs()` backed
by `envMs`. Purely a test seam plus operator escape hatch, in the file's existing
idiom; the 30 s default is unchanged.

### 2026-09-09T20:16Z — F1/F2 reconciliation: the product was right, the test was wrong

The first full run of the suite failed the new F2 test at
`expect(calls[0].signal.aborted).toBe(false)` — the first bridge's signal (the
child's `sessionAbort.signal`) was already aborted by the time turn 2 finished.
That looked like a contradiction between the two decisions: F1 assumes the
session controller survives a timeout-and-recover sequence, yet something was
aborting it.

Diagnosed by instrumenting the signal with an abort listener that dumps a stack.
Result:

* Immediately after the turn-1 startup timeout: `aborted=false`, bridge
  `close` call count `0`, `entry.alive === true`. **The startup-timeout path
  leaves the child alive and the session controller untouched** — no code on
  that path calls `killChild`.
* The abort came from `acp-transport.ts` line 520, the child `exit` handler,
  dispatched from the *test's own* `child.end()` in the turn-2 driver.

So this is the first of the two branches the reconciliation could take: a startup
timeout discards the half-started session, not the child, `sessionAbort` is
correctly not aborted on that path, and turn 2 legitimately reuses the same
signal. Nothing in the product needed fixing. The test was asserting on session
state *after* simulating kiro-cli exiting, which ends the session by design and
retires the controller. Dropped the `child.end()` (the F1 post-turn-abort test
already leaves its child running for the same reason; `_resetAcpChildren()` in
`beforeEach` reaps it), and added two assertions immediately after turn 1 that
pin the contract directly: the child survives and its bridge is still up.

The episode did surface a genuine asymmetry worth documenting rather than
"fixing": the new-session branch reuses `sessionAbort` while the divergence
branch aborts and replaces it. That tracks the state, not an oversight —
divergence discards a session that reached `ready`, whose bridge may have tool
calls in flight, so the controller must be retired to cancel them; the
new-session branch only ever discards a session that never reached `ready`, so
no prompt was sent and nothing can be in flight. Recycling the controller there
would also be wrong on the common path, where the child is brand new and has no
predecessor session. Recorded as a comment at the call site so a later reader
does not "unify" the two branches and silently break the fresh-child case.

## Performance

* Token usage: TODO (orchestrator to fill)
* Wall time: TODO (orchestrator to fill)
* Model: claude-opus-5
* Commits: 4 (spec, F1, F2, F1/F2 reconciliation)
* Suite at completion: 143 passed, 2 failed (both the known pre-existing
  `workflow-mcp.test.ts` GSD-home discovery failures), 1 skipped;
  `tsc --noEmit` clean.

## Metadata

* **Origin:** Kiro code review of `randiskull/pi-kiro`, the two findings marked
  "warrant attention before the next release".
* **Base:** `origin/main` @ `7f1266a`
* **Branch:** `fix/kiro-review-acp-bridge-hardening`
* **PR:** TODO (orchestrator opens; not pushed from the implementation run)
* **Files touched:** `acp-transport.ts`, `bridge.ts`, `acp-transport.test.ts`,
  `.kiro/specs/kiro-review-acp-bridge-hardening.md`
