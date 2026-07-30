<!-- ===================== DRAFT PREAMBLE — STRIP BEFORE FILING ===================== -->
# DRAFT: doctor/status-bar shows "key missing" for dynamically registered externalCli providers

**Status:** `Drafted, NOT filed` (2026-07-30)

**Target repo:** `open-gsd/gsd-pi` (bugs → https://github.com/open-gsd/gsd-pi/issues)
**Observed on version:** `1.11.0`

## Filing trigger
File as part of the **pi-kiro public-release batch** — when pi-kiro is published and the
kiro-drives-GSD retrial has passed (workflow-MCP transport proven on a full milestone).
Batch siblings, file together with cross-references:
1. `gsd-400-extra-usage-not-fallback-eligible.md` (fallback classifier — audited FILE-ready)
2. this draft (doctor externalCli cosmetics)
Framing for both: "we built a third-party externalCli provider (pi-kiro) against your
provider API; here is what worked and the two host-side gaps we hit."

## Decision check (copy/paste)
```sh
# Bug still present if CLI_AUTH_PROVIDERS is a hardcoded set that omits dynamic providers:
grep -n "CLI_AUTH_PROVIDERS = new Set" \
  "$(npm root -g)/@opengsd/gsd-pi/dist/resources/extensions/gsd/doctor-providers.js"
# and the widget renders every provider error as "key missing":
grep -n "key missing" \
  "$(npm root -g)/@opengsd/gsd-pi/dist/resources/extensions/gsd/doctor-providers.js"
```

## Filing command (after freshness audit + stripping this preamble)
```sh
gh issue create --repo open-gsd/gsd-pi \
  --title "doctor/status-bar: dynamically registered externalCli providers falsely show \"key missing\"" \
  --body-file .draft-issues/gsd-doctor-externalcli-key-missing-false-positive.md
```

## Filing checklist — freshness audit
1. Re-run the Decision check against current upstream HEAD
   (`src/resources/extensions/gsd/doctor-providers.js`). If the check now consults
   `getProviderAuthMode()` / registered-provider `authMode`, mark **SUPERSEDED-BY-UPGRADE**.
2. Refresh line numbers + `gsd --version`.
3. Dedup: `gh search issues --repo open-gsd/gsd-pi "key missing" --state all` and
   `gh search issues --repo open-gsd/gsd-pi "externalCli doctor" --state all`.
4. Strip this preamble; file with a cross-link to the pi-kiro release notes and the
   fallback-classifier sibling issue.
<!-- ===================== BODY (bug_report.yml) — this is what gets filed ===================== -->
<!-- === BODY === -->

## Summary
A provider registered dynamically by an extension with `authMode: "externalCli"`
(per `ProviderConfigInput.authMode` / `ProviderAuthMode` in core) works fully — models
selectable, requests dispatch, `isProviderRequestReady()` returns true — but the doctor
widget permanently shows **`✗ <label> key missing`** in the status bar. The doctor's
provider check never consults the auth-mode API; it classifies CLI-auth providers from a
**hardcoded set** and treats everything else as an API-key provider.

Observed with **pi-kiro** (a third-party provider extension delegating to the local
`kiro-cli` under the user's own AWS/Kiro subscription — seat-billed, no API key by
design). The false badge persists across entire auto-mode milestones that are actively
executing on that provider.

## Steps to reproduce
1. Install a provider extension that calls
   `pi.registerProvider("kiro", { authMode: "externalCli", baseUrl: "local://…", streamSimple, models, … })`.
2. Set it as the default provider; run any unit (works).
3. Observe the status bar: `✗ kiro key missing`.

## Expected behavior
The doctor recognizes any provider whose resolved auth mode is `externalCli` (or `none`)
as CLI/session-authenticated — same treatment as the built-in `claude-code` /
`google-gemini-cli` entries — and checks binary/session readiness instead of key
presence. No "key missing" for a provider that cannot have a key.

## Actual behavior
`dist/resources/extensions/gsd/doctor-providers.js` (1.11.0):
- ~line 27: `const CLI_AUTH_PROVIDERS = new Set(["claude-code", "google-gemini-cli", "google-antigravity", "cursor-agent"])`
  — hardcoded; dynamically registered externalCli providers are absent.
- `checkLlmProviders()` (~line 333): providers outside the set fall through to the
  API-key presence check (auth.json / env / models.json), which necessarily fails for a
  keyless provider → `status: "error"`.
- `summariseProviderIssues()` (~line 590) renders **every** required-provider error as
  `✗ <label> key missing` — so even the error *label* is wrong for this class.

Meanwhile the request path is correct: `getProviderAuthMode()` resolves the registered
`authMode` first, and `isProviderRequestReady()` short-circuits `externalCli | none` to
ready. The doctor and the dispatcher disagree because only one of them uses the API.

## Suggested fix
In `checkLlmProviders()`, replace (or augment) the hardcoded set with the model
registry's own resolution:

```js
const authMode = modelRegistry.getProviderAuthMode(providerId);
if (authMode === "externalCli" || authMode === "none" || CLI_AUTH_PROVIDERS.has(providerId)) {
    // CLI/session-authenticated: check readiness (binary present / provider isReady), not keys
}
```

Optionally: `summariseProviderIssues()` should label errors by their actual kind
(`key missing` vs `CLI not ready`) rather than hardcoding the key wording.

## Impact
Cosmetic but corrosive: a permanently red "key missing" badge on a fully working
provider trains users to ignore the status bar (and cost real debugging time here —
it reads as "provider broken" during incident triage). Any third-party externalCli
provider built on the documented `authMode` API hits this on day one.

## GSD version
1.11.0

## OS / install
macOS (Darwin) · npm global (`@opengsd/gsd-pi`)

## Context
Found while building **pi-kiro** (external-CLI provider for kiro-cli) — the same
integration that surfaced the fallback-classifier issue filed alongside this one. The
provider-side `authMode: "externalCli"` contract otherwise worked as documented
(flat-rate routing detection, workflow-MCP transport, request readiness).
