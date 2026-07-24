<!--
=========================== DRAFT-PARK-FILE PREAMBLE ===========================
Status: Drafted, NOT filed. Defect report / fix-brief for a Claude session working IN the
        pi-kiro repo. Your product → path is FIX, not FILE a GH issue.
Repo/product: randiskull/pi-kiro
Observed at:  pi-kiro v0.1.0 · kiro-cli 2.14.0 · @opengsd/gsd-pi host
Type: DEFECT (reliability). Highest day-to-day value of the three pi-kiro drafts — this is
      what wedges the provider on a cold launch ("kiro key missing") until manual /kiro.
Freshness audit before acting: re-confirm readiness.ts still (a) uses a 5s VERSION_TIMEOUT_MS,
      (b) collapses all exec errors to `ok:false` in run(), (c) caches failures at line ~89,
      and that index.ts still calls ensureRegistered ONCE at activation with no retry.
Everything BELOW this comment is the paste-ready report.
================================================================================
-->

# Defect: readiness caches a transient cold-start probe failure → provider wedged ("kiro key missing") until manual `/kiro`

> **✅ RESOLVED (2026-07-24).** Fixed in this repo. Freshness audit re-confirmed all
> four premises (5s `VERSION_TIMEOUT_MS`, `run()` error collapse, failure caching,
> one-shot activation) still held before the fix. Fix layers applied: **1** (error-kind
> distinction in `run()`), **2** (retry `--version` on timeout with backoff), **3** (do
> not cache transient results **and** lazy self-healing re-registration in `index.ts`),
> and **4** (cold-start `detail` message). Real-`execFile` behavior verified: a timeout
> yields `killed:true`/`signal:"SIGTERM"`, ENOENT yields `code:"ENOENT"`. Acceptance
> criteria all met; 4 new vitest cases added. See the **Resolution** section at the end.

## Metadata
| | |
|---|---|
| **Product** | pi-kiro — Pi provider extension for the local Kiro CLI |
| **Component** | `readiness.ts` (`checkKiroReadiness`) + `index.ts` (`ensureRegistered` at activation) |
| **Version observed** | pi-kiro `0.1.0`; kiro-cli `2.14.0`; host `@opengsd/gsd-pi` |
| **Severity** | High (reliability) — a cold kiro-cli at launch silently disables the provider; recovery requires the user to notice and run `/kiro` |
| **Type** | Defect |
| **Fix owner** | pi-kiro |

## Summary
When kiro-cli is **cold at host launch** (bun runtime spin-up / config load / update check), the `kiro-cli --version` probe can exceed its **5s timeout**. `run()` collapses that timeout into `ok:false` — **indistinguishable from ENOENT (binary genuinely absent)** — so `checkKiroReadiness()` returns `ready:false` with the misleading detail *"Kiro CLI not found on PATH."* The provider is not registered; GSD then treats `kiro` as an unregistered/api-key provider and reports **"kiro key missing."** The failed result is **cached**, and `ensureRegistered` runs **only once at activation with no retry**, so the provider stays wedged until the user manually runs `/kiro` (which force-clears the cache). Meanwhile kiro-cli is perfectly healthy seconds later (`--version` and `whoami` both succeed).

## Impact
- A cold launch **silently disables the kiro provider**. The user sees "kiro key missing" and has no obvious signal that the cause was a transient probe timeout, not an actual credential problem.
- Recovery is **manual and non-obvious** (`/kiro`). Observed directly: launch failed with "kiro key missing" while `kiro-cli --version` → `2.14.0` and `kiro-cli whoami` → exit 0 (valid SSO) at the same moment.
- The misleading `detail` ("not found on PATH… run `kiro-cli login`") sends users down the wrong remediation path.

## Environment
- macOS; host loads pi-kiro via `packages`. kiro-cli 2.14.0 on PATH, IdC SSO valid.
- Reproduces most reliably on the **first** launch after boot / after kiro-cli has been idle (cold binary).

## Steps to Reproduce
1. Ensure kiro-cli is cold (fresh boot, or not invoked recently).
2. Launch the host with `defaultProvider: kiro`.
3. If the initial `--version` probe exceeds 5s, the provider fails to register → "kiro key missing."
4. Immediately run `kiro-cli --version` / `whoami` manually — both succeed (proving the failure was transient).
5. Run `/kiro` — provider registers; error clears.

## Expected vs Actual
- **Expected:** a slow/cold kiro-cli at launch is tolerated (retry/warm-up); the provider registers once kiro-cli responds, without manual intervention. A genuine "binary absent" or "logged out" state is reported distinctly.
- **Actual:** a cold-start `--version` timeout is treated as "binary not found," cached, and never retried → provider wedged until manual `/kiro`; the error message misattributes the cause.

## Root Cause Analysis (exact)
`readiness.ts`:
```ts
const VERSION_TIMEOUT_MS = 5_000;   // line 16 — tight for a cold binary
const WHOAMI_TIMEOUT_MS  = 15_000;  // line 17
const CACHE_TTL_MS       = 30_000;  // line 18

function run(command, args, timeoutMs) {                 // lines 31–41
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? "" });  // <-- (A) timeout, ENOENT, and non-zero exit ALL collapse to ok:false
    });
  });
}

// version probe — lines 58–74
for (const candidate of candidates()) {
  const result = await run(candidate, ["--version"], VERSION_TIMEOUT_MS);
  if (result.ok && result.stdout.trim().length > 0) { binary = {…}; break; }
}
if (!binary) {
  value = { ready: false, …, detail: "Kiro CLI not found on PATH. …" };   // <-- (B) a TIMEOUT here is reported as "not found"
}

cached = { at: Date.now(), value };   // line 89 — (C) caches FAILURES too
```
And `index.ts` calls `await ensureRegistered(pi)` **once** at activation; `ensureRegistered` only registers `if (!registered)`. The sole cache-clear path is `clearKiroReadinessCache()`, invoked **only** by `/kiro` (force). Net:

1. **(A) Error conflation.** `run()` discards the error *kind*. A `--version` timeout (`error.killed === true` / `signal === "SIGTERM"`) is treated the same as ENOENT (binary truly absent).
2. **(B) Misclassification.** A conflated `--version` failure → `!binary` → `ready:false` with "not found on PATH."
3. **(C) Failure caching + one-shot activation.** The false-negative is cached, and nothing re-attempts registration automatically → wedged until manual `/kiro`.

*(Note: the `whoami` path is NOT the culprit — a `whoami` timeout yields `authed = undefined` → `ready = (undefined !== false) = true`, so it proceeds. The vulnerability is entirely the `--version` probe.)*

## The Fix (layered; do 1+2, and 3 is the durable one)
1. **Distinguish error kinds in `run()`.** Surface `timedOut` (from `error.killed`/`error.signal === "SIGTERM"`) and `notFound` (`error.code === "ENOENT"`) instead of a single `ok`. Only `ENOENT` means "binary absent"; a timeout is transient.
   ```ts
   execFile(cmd, args, { timeout, encoding: "utf8" }, (error, stdout, stderr) => {
     const timedOut = !!error && (error.killed || error.signal === "SIGTERM");
     const notFound = !!error && error.code === "ENOENT";
     resolve({ ok: !error, timedOut, notFound, stdout: stdout ?? "", stderr: stderr ?? "" });
   });
   ```
2. **Retry the `--version` probe on timeout** (e.g., up to 3 attempts, short backoff, or a longer first-probe timeout) before concluding "not found." Treat a persistent ENOENT as the only true "not installed."
3. **Do not cache transient failures / self-heal registration.** Either:
   - cache **only** definitive results (found+authed, or ENOENT/logged-out), and give an indeterminate/timeout result a **very short (or zero) TTL** so the next probe re-runs; **and/or**
   - make registration **self-healing**: if activation's `ensureRegistered` returns not-registered, retry lazily on the next real use (`streamSimple` / `before_provider_request`) so a transient cold-start miss recovers without manual `/kiro`.
4. **Fix the `detail` message** so a timeout says something like *"Kiro CLI did not respond in {N}s (cold start?) — will retry"* rather than *"not found on PATH."*

## Acceptance Criteria
- [ ] A simulated `--version` **timeout** (stubbed `run`) does **not** yield `detail: "…not found on PATH…"` and does **not** permanently mark the provider unregistered.
- [ ] A simulated **ENOENT** still reports "not found on PATH / install it."
- [ ] After a transient cold-start miss, the provider **registers without a manual `/kiro`** (via retry and/or lazy re-registration).
- [ ] A definitive "logged out" (`whoami` → "not logged in") still reports the login remedy and is cached.
- [ ] Existing `/kiro` force-refresh behavior is unchanged.

## Test Plan
1. **Unit (error kinds):** stub `execFile` to invoke the callback with `{killed:true, signal:"SIGTERM"}` → assert `timedOut`; with `{code:"ENOENT"}` → assert `notFound`.
2. **Unit (retry):** first `--version` call times out, second succeeds → `checkKiroReadiness` returns `ready:true` (no false "not found").
3. **Unit (no-latch):** a timeout result is not served from cache to the next call (short/zero TTL for indeterminate), or lazy re-registration fires on next use.
4. **Unit (definitive still cached):** ENOENT and "logged out" behave as today (cached, correct remedy).
5. **Integration:** artificially delay a fake kiro-cli `--version` beyond the timeout on first call → provider still comes up on retry/next-use without `/kiro`.

## Risks / Non-goals
- Keep `/kiro` as the explicit manual refresh (unchanged).
- Don't over-lengthen the happy-path probe; use retry/backoff rather than a single long timeout so a genuinely-absent binary still fails fast on ENOENT.
- Non-goal: the context-size hang and the auth-label issue (separate drafts).

## References (file:line, as observed)
- `readiness.ts` — `VERSION_TIMEOUT_MS = 5_000` (16), `CACHE_TTL_MS = 30_000` (18); `run()` collapses all errors to `ok:false` (36–40); `--version` loop → `!binary` → `ready:false` "not found on PATH" (59–74); `cached = { at, value }` caches failures (89); `clearKiroReadinessCache` only via `/kiro` (93–95).
- `index.ts` — `await ensureRegistered(pi)` once at activation; `ensureRegistered` registers `if (!registered)`; `/kiro` command calls `ensureRegistered(pi, true)` (force → `clearKiroReadinessCache`).
- Observed contradiction proving transience: "kiro key missing" at launch while `kiro-cli --version` → 2.14.0 and `kiro-cli whoami` → exit 0 seconds later.

## Resolution (2026-07-24)
Fixed in `readiness.ts` + `index.ts`; tests in `readiness.test.ts` (32 → 36 cases).

**`run()` — error-kind distinction (layer 1).** Returns `{ ok, timedOut, notFound, stdout, stderr }`. `timedOut` = `error.killed === true || error.signal === "SIGTERM"`; `notFound` = `error.code === "ENOENT"`. A timeout and an absent binary are no longer conflated.

**`checkKiroReadiness()` — retry + no-latch (layers 2, 3, 4).**
- The `--version` probe retries up to `VERSION_PROBE_ATTEMPTS` (3) with linear backoff (`VERSION_RETRY_BACKOFF_MS` 300ms × attempt) on `timedOut`. `notFound` (ENOENT) breaks immediately — a genuinely-absent binary still fails fast.
- Three terminal branches: binary-found (unchanged whoami logic); `versionTimedOut` → `ready:false`, `transient:true`, detail *"Kiro CLI did not respond within 5s (x3 attempts) — cold start? Will retry."*; else → the existing "not found on PATH" (definitive).
- Caches **only** non-transient results (`if (!value.transient) cached = …`). A cold-start timeout is left uncached, so the next probe re-runs.

**`index.ts` — self-healing registration (layer 3, durable).** A throttled (`SELF_HEAL_INTERVAL_MS` 10s), single-flight `maybeSelfHeal(pi)` runs on `before_provider_request`: if `!registered`, it fires `ensureRegistered(pi)` in the background (never awaited, never blocks the turn). Combined with the uncached transient result, a cold-start miss recovers on the next provider request with no manual `/kiro`. `/kiro` remains the explicit force-refresh (unchanged).

**Acceptance criteria** — all met:
- [x] `--version` timeout → not `"…not found on PATH…"`, not permanently unregistered (transient + self-heal).
- [x] ENOENT → still "not found on PATH / install it", cached, no retry churn.
- [x] Transient miss → registers without manual `/kiro` (uncached re-probe + lazy re-registration).
- [x] Definitive logged-out → login remedy, cached.
- [x] `/kiro` force-refresh unchanged.

**Fix layers chosen:** 1 + 2 + 3 (both no-latch caching *and* self-heal) + 4 — i.e. every layer in the brief. Real-`execFile` timeout/ENOENT shapes verified out-of-band before finalizing.
