<!-- ===================== DRAFT PREAMBLE — STRIP BEFORE FILING ===================== -->
# DRAFT: GSD auto-mode pauses instead of failing over on Anthropic `400 "extra usage"`

**Status:** `Drafted, NOT filed` (2026-07-23)

**Target repo:** `open-gsd/gsd-pi` (bugs → https://github.com/open-gsd/gsd-pi/issues)
**Observed on version:** `1.11.0`

## ⏱ Freshness audit — RUN 2026-07-23 · terminal outcome: **FILE**
A full audit was completed against current upstream HEAD (`origin/main`):
- **Still present on HEAD (NOT superseded).** `error-classifier.ts` `RATE_LIMIT_RE` still lacks
  `from your extra usage`; the new `AFFORDABILITY_RE`
  (`requires more credits|can only afford|insufficient credits|not enough credits|fewer max_tokens`)
  is OpenRouter-credit wording and does not match; the `unsupported-model` entitlement path in
  `agent-end-recovery.ts` fires only on a provider *model rejection* (`cls.kind === "unsupported-model"`),
  not a usage/billing wall. The `400 "…from your extra usage…"` message still classifies `unknown`
  → indefinite pause.
- **Not a duplicate.** No **open** issue covers 400/usage classification. Closest prior art is
  **#1364** *"Model fallback not triggered for 'abort' / 'unknown' provider errors"* — the **same**
  `unknown` → no-fallback → indefinite-pause root cause — but it is **CLOSED**, fixed *narrowly* by
  **PR #1365** (classified only the `"abort"` stop-reason as a transient connection failure; it did
  **not** touch the usage-wall wording and did **not** make `unknown` generally fallback-eligible).
  Our case is the un-covered sibling of the same class the maintainers just fixed for `"abort"`.
- **Recommendation: FILE now.** Confirmed-present, non-dupe, one-line fix, and upstream is actively
  patching this exact seam (#1364/#1365, plus the recently-added `AFFORDABILITY_RE` and entitlement
  path) → they are receptive and fast on "string-X → unknown → pause" gaps.
- **⚠ The filing trigger below is circular.** It waits for "you want Anthropic-primary AND upstream
  hasn't fixed" — but you can't safely go Anthropic-primary *until* this is fixed, so the trigger may
  never fire on its own. Treat the trigger as satisfied; the only open question is your go/no-go.

## Filing trigger
File when BOTH hold:
1. You still want an Anthropic-primary phase layout with a kiro (or other) `fallbacks:`
   entry — i.e. the temporary kiro-primary inversion in `~/.gsd/PREFERENCES.md` is
   something you want to undo; AND
2. current upstream `error-classifier.ts` still does not route the `"…draw from your
   extra usage… claude.ai/settings/usage…"` message to a fallback-eligible class.

If you're content staying kiro-primary indefinitely, this can stay parked.

## Decision check (re-verify the trigger — copy/paste)
```sh
# Bug still present if this prints the RATE_LIMIT_RE line WITHOUT "from your extra usage"
# or "settings/usage" in it (only the old "out of extra usage" alternative):
git -C ~/GITHUB/gsd-pi grep -nE "extra usage|settings/usage" -- \
  src/resources/extensions/gsd/error-classifier.ts
```

## Filing command (after freshness audit + stripping this preamble)
```sh
gh issue create --repo open-gsd/gsd-pi \
  --title "auto-mode pauses instead of failing over on Anthropic 400 \"extra usage\" error" \
  --body-file .draft-issues/gsd-400-extra-usage-not-fallback-eligible.md
```
(`blank_issues_enabled: false` — the body below is structured to match
`bug_report.yml`. If `gh issue create --body-file` is rejected for not using the
form, paste the sections into the web form fields of the same name.)

## Filing checklist — the freshness audit (run in order)
1. **Re-verify the trigger** — run the Decision check above.
2. **Refresh evidence** — confirm `gsd --version` (was 1.11.0), and re-read the
   line numbers cited below against current `error-classifier.ts` /
   `agent-end-recovery.ts` (they drift).
3. **Re-run the repro against current upstream HEAD:**
   ```sh
   git -C ~/GITHUB/gsd-pi fetch origin && git -C ~/GITHUB/gsd-pi log -1 --oneline origin/main
   git -C ~/GITHUB/gsd-pi grep -nE "from your extra usage|claude\\.ai/settings/usage" -- \
     src/resources/extensions/gsd/error-classifier.ts
   ```
   If the grep now MATCHES, the pattern was added upstream → mark **SUPERSEDED-BY-UPGRADE**, do not file.
4. **Dedup search:**
   ```sh
   gh search issues --repo open-gsd/gsd-pi "extra usage" --state open
   gh search issues --repo open-gsd/gsd-pi "fallback classify error" --state open
   gh search issues --repo open-gsd/gsd-pi "auto-mode paused provider error" --state all
   ```
   Related error-handling issues to cross-check (from source comments): #2577
   (classifier consolidation), #4373 (rate-limit → fallback), #4513, #4528, #4558, #813.
   **CLOSEST PRIOR ART (found in the 2026-07-23 audit): #1364 / PR #1365** — same
   `unknown` → no-fallback → pause root cause, CLOSED, fixed narrowly for the `"abort"`
   stop-reason only. Reference it in the filed issue as the sibling case. **Audit dedup
   result: no OPEN issue covers 400/usage classification → FILE (not comment).** Re-run the
   `gh search` lines to reconfirm at filing time; if a *new* open issue appeared covering
   400/usage → **COMMENT-ON-EXISTING** instead.
5. **Strip this preamble** (everything above the `=== BODY ===` line), then file.
<!-- ===================== BODY (bug_report.yml) — this is what gets filed ===================== -->
<!-- === BODY === -->

## Summary
When an Anthropic-backed model returns `400 invalid_request_error` with the
subscription "extra usage" message, GSD auto-mode pauses indefinitely instead of
failing over to a configured `fallbacks:` model. The error string matches none of
`classifyError()`'s patterns, so it is classed `unknown`, and `unknown` is excluded
from the fallback path — so a per-phase `fallbacks` list that exists specifically to
survive this situation is never consulted.

The exact provider message (Anthropic, `request_id: req_011CdCDkKN7sCthEUiDYQgPs`):

```
400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party
apps now draw from your extra usage, not your plan limits. Add more at
claude.ai/settings/usage and keep going."}}
```

## Steps to reproduce
1. Configure a per-phase model in `~/.gsd/PREFERENCES.md` with an Anthropic primary
   and a non-Anthropic fallback, e.g.:
   ```yaml
   models:
     execution:
       model: anthropic/claude-sonnet-5
       fallbacks:
         - kiro/claude-sonnet-5
   ```
2. Exhaust the Anthropic subscription's third-party "extra usage" allowance (so the
   API returns the 400 above), then run `gsd auto` / `/gsd auto` on any project.
3. When an execution unit dispatches to the Anthropic model, the 400 is returned.

## Expected behavior
GSD classifies the error as a spend/limit condition (the same bucket as
"out of extra usage" / "credits exhausted"), tries `tryProviderModelFallback()`, and
switches to the configured `kiro/claude-sonnet-5` fallback — continuing auto-mode.
If no fallback is configured, it should pause with auto-resume (rate-limit path),
not an indefinite hard pause.

## Actual behavior
Auto-mode pauses indefinitely with:
```
Auto-mode paused due to provider error: 400 {"type":"error","error":{"type":
"invalid_request_error","message":"Third-party apps now draw from your extra usage…"}}
```
The configured fallback is never attempted.

### Root cause (traced in 1.11.0)
- `src/resources/extensions/gsd/error-classifier.ts`
  - `RATE_LIMIT_RE` (line 55) includes `out of extra usage` but NOT the actual
    wording `from your extra usage` nor the `claude.ai/settings/usage` marker.
  - `AFFORDABILITY_RE` (line 58: `requires more credits|can only afford|insufficient
    credits|…`) also does not match.
  - So `isRateLimit` (line 140) is false; `PERMANENT_RE`, `UNSUPPORTED_MODEL_*`, and
    `MODEL_ERROR_RE` (the only 400-aware branch — requires "invalid argument/params")
    also miss → `classifyError()` returns `{ kind: "unknown" }`.
- `src/resources/extensions/gsd/bootstrap/agent-end-recovery.ts`
  - Fallback is attempted only for `rate-limit | network | server | connection |
    stream` (line 863) plus the `model-error` / `unsupported-model` / `tool-schema`
    branches. `unknown` matches none.
  - `unknown` falls to the terminal branch (line ~889, "Permanent / unknown: pause
    indefinitely") → `pauseAutoForProviderError(...)` with no auto-resume.

There is no config knob to make this error fallback-eligible; classification is
hardcoded regexes.

### Suggested fix (one line)
Route the message to the existing `rate-limit` class (semantically consistent with
the "out of extra usage" / spend-limit precedent, which already fails over then
temporarily blocks the exhausted model). In `error-classifier.ts`, broaden
`RATE_LIMIT_RE` (line 55):
```diff
- …|out of extra usage|quota (?:reached|hit)|…
+ …|(?:out of|from your) extra usage|claude\.ai\/settings\/usage|quota (?:reached|hit)|…
```
Verified locally: this matches the target message and a JSON-wrapped
`invalid_request_error` variant; it does not match benign strings like
"extra usage stats" or "usage settings"; and `PERMANENT_RE` does not shadow it, so it
cleanly reaches the rate-limit → fallback branch. (`AFFORDABILITY_RE` on line 58 is an
equally valid home if maintainers prefer to keep "credits/affordability" separate from
"throttle" semantics.)

## Related prior art
Same error-classification gap as **#1364** *"Model fallback not triggered for 'abort' /
'unknown' provider errors"* (closed via **PR #1365**), which classified the `"abort"` stop-reason
as a transient connection failure so fallbacks fire. That fix was string-specific and did **not**
cover the Anthropic subscription "extra usage" `400` — this is the sibling case on the same
`unknown` → no-fallback → indefinite-pause path. A broader structural fix (letting a configured
`fallbacks:` list be tried before an `unknown` error hard-pauses) would subsume both; the
one-line regex change above is the minimal fix for this specific, common wall.

## GSD version
1.11.0

## Node version
(fill from `node -v` at filing time)

## OS
macOS (Darwin)

## Install method
npm global (`@opengsd/gsd-pi`)

## Affected area
auto-mode / provider error handling & model fallback

## Model
Primary `anthropic/claude-sonnet-5`; configured fallback `kiro/claude-sonnet-5`
(fallback provider is irrelevant — the bug is upstream of fallback selection).

## Impact
Any user relying on a per-phase `fallbacks:` list to survive Anthropic
subscription-usage exhaustion loses the safety net: auto-mode halts and must be
manually resumed/re-pointed, defeating the "walk away" premise of auto-mode. Worked
around here by inverting the whole config to a non-Anthropic primary.
