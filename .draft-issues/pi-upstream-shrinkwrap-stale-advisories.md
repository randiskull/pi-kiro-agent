<!-- ===================== DRAFT PREAMBLE — STRIP BEFORE FILING ===================== -->
# DRAFT: npm-shrinkwrap freezes known-vulnerable transitive deps in published packages

**Status:** `Drafted, NOT filed` (2026-07-31)
**Target repo:** upstream pi monorepo (`badlogic/pi-mono` — publisher of the `@earendil-works/*` packages; confirm the maintained publishing repo at filing time)
**Observed on:** `@earendil-works/pi-coding-agent@0.80.10`

## Filing trigger
File on the next pi-kiro dependency-refresh cycle IF a then-current `@earendil-works/pi-coding-agent`
still ships an `npm-shrinkwrap.json` pinning advisories the consumer cannot override. Low urgency:
both current findings are DoS-class, dev-tree-only for consumers who declare the package as a
devDependency, and unreachable in pi-kiro's usage.

## Decision check (copy/paste)
```sh
npm pack @earendil-works/pi-coding-agent@latest --silent | xargs -I{} tar -xzf {} package/npm-shrinkwrap.json -O 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('packages',{}); \
print('brace-expansion:', next((v.get('version') for k,v in p.items() if k.endswith('node_modules/brace-expansion')), 'absent')); \
print('protobufjs:', next((v.get('version') for k,v in p.items() if k.endswith('node_modules/protobufjs')), 'absent'))"
# vulnerable if brace-expansion <5.0.8 (3.0.0–5.0.7) or protobufjs 7.5.0–7.6.4
```

## Filing checklist
1. Run the Decision check against the latest published version; if both are patched → **SUPERSEDED-BY-UPGRADE**.
2. Dedup: search the upstream repo issues for "shrinkwrap", "audit", each GHSA id.
3. Strip preamble; file.
<!-- === BODY === -->

## Summary
`@earendil-works/pi-coding-agent` publishes with an `npm-shrinkwrap.json`, which freezes its
entire transitive dependency tree for every consumer. Shrinkwrap subtrees are exempt from
consumer `overrides` and `npm audit fix` **by npm design** — so when an advisory lands on a
pinned transitive dep, consumers can neither patch nor override it; `npm audit` reports
"fix available" indefinitely while nothing can move. Only a republish with a refreshed
shrinkwrap fixes it.

Currently frozen at vulnerable versions in `0.80.10`:
- `brace-expansion@5.0.6` (via `minimatch@10.2.5`) — GHSA-3jxr-9vmj-r5cp + GHSA-mh99-v99m-4gvg (DoS), patched in 5.0.8
- `protobufjs@7.6.4` (via `@google/genai`) — GHSA-j3f2-48v5-ccww (DoS), patched in 7.6.5

Both patches are semver-patch bumps inside the already-declared ranges — a shrinkwrap refresh
(`npm update brace-expansion protobufjs && npm shrinkwrap`) and republish resolves them with
no API surface change.

## Suggested longer-term option
If the shrinkwrap exists for reproducibility, consider whether `package-lock.json` (not shipped
in the tarball) plus CI-enforced lockfile installs achieves the goal without freezing consumers
out of security patching — or add a scheduled shrinkwrap-refresh job so pinned advisories age out
automatically.

## Consumer-side context
Found while resolving `npm audit` in pi-kiro (a provider extension consuming
`pi-coding-agent`): 7 of 9 findings were consumer-fixable; these 2 were not, and are documented
as accepted findings with this issue as the fix path.
