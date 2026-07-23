# pi-kiro provider mislabeled `authMode: "apiKey"` instead of `"externalCli"` under GSD

- **Status:** FIXED in pi-kiro (this repo), commit pending. Not an upstream issue —
  GSD behaves correctly once the provider declares the field; the bug was ours.
- **Affected:** pi-kiro `kiro` provider running under GSD (`@opengsd/gsd-pi`) and
  any pi host that keys off `authMode` for external-CLI providers.
- **Fix:** declare `authMode: "externalCli"` in `registerProvider` (index.ts).

## Symptom

Under GSD, the `kiro` provider (which wraps the local `kiro-cli`, seat/credit-billed)
was treated as a normal metered API provider:

1. **Workflow-MCP transport never engaged.** GSD delivers its workflow tools and
   structured questions to external-CLI providers over a dedicated transport gated
   on `authMode === "externalCli" && baseUrl.startsWith("local://")`. kiro has the
   `local://` baseUrl but resolved to `authMode: "apiKey"`, so the gate was false.
   Consequence observed at the `completion` phase: `kiro/claude-sonnet-5` and
   `kiro/claude-sonnet-4.6` were unreliable at emitting the `gsd_slice_complete`
   tool call (zero-tool-call turns, long-call hangs on large context), forcing a
   manual workaround (route `completion` to `kiro/claude-opus-4.8`).
2. **Flat-rate detection wrong.** A local-CLI provider is flat-rate by definition;
   GSD's dynamic router only recognizes that via `authMode === "externalCli"`. kiro
   was scored as a metered provider.

## Root cause

pi-kiro registered the provider without an `authMode`, and passed a dummy
`apiKey: "kiro-local"` (needed so upstream pi doesn't reject a models-defining
provider that has no apiKey/oauth). GSD resolves auth mode with
(`@gsd/pi-coding-agent/dist/core/provider-readiness.js`, `getProviderAuthMode`):

```js
const config = deps.registeredProviders.get(provider);
if (config) {
  if (config.authMode) return config.authMode;   // ← never set → skipped
  if (config.oauth)    return "oauth";
  if (config.apiKey)   return "apiKey";           // ← dummy apiKey → "apiKey"  (MISLABEL)
  return "apiKey";
}
```

The sibling external-CLI providers get this right by declaring the field —
`claude-code-cli/index.ts`: `authMode: "externalCli"`; `google-cli/index.ts`
likewise. pi-kiro simply omitted it.

## Fix (applied)

`index.ts`, in the `registerProvider` config:

```ts
const config: ProviderConfig & { authMode: "externalCli" } = {
  name: "Kiro CLI (local runtime)",
  authMode: "externalCli",
  baseUrl: "local://kiro-cli",
  apiKey: "kiro-local",   // kept: upstream pi requires apiKey/oauth when models are defined
  api: "anthropic-messages",
  models,
  streamSimple: makeStreamViaKiro(deps),
};
pi.registerProvider(KIRO_PROVIDER, config);
```

Notes:
- Upstream pi's `ProviderConfig` type predates `authMode`, so it's added via an
  intersection type; hosts that don't read the field ignore it. `tsc --noEmit`
  passes; 32 unit tests pass.
- The dummy `apiKey` is retained deliberately — plain pi (no `authMode` concept)
  rejects a models-defining provider with neither apiKey nor oauth. GSD ignores it
  because `getProviderAuthMode` returns `config.authMode` before checking apiKey.

## Verification

Exercised against GSD's installed runtime
(`@opengsd/gsd-pi/.../model-registry.js` → `getProviderAuthMode`):

| Registration | `getProviderAuthMode('kiro')` | workflow-MCP transport | flat-rate |
|---|---|---|---|
| before (no `authMode`, dummy apiKey) | `"apiKey"` | ❌ false | ❌ false |
| after (`authMode: "externalCli"`) | `"externalCli"` | ✅ true | ✅ true |

## Scope / non-scope

- Fixes the external-CLI transport and flat-rate classification for kiro under GSD.
- Does **not** address the separate observation that GSD does not treat Anthropic's
  `400 invalid_request_error` ("extra usage") as a fallback-eligible error — that is
  a GSD-side error-classification question, tracked separately.
- After this ships, retest whether `completion` can move back off the
  `kiro/claude-opus-4.8` workaround now that `gsd_slice_complete` is delivered over
  the correct transport.
