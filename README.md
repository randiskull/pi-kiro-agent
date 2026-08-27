# pi-kiro

A [Kiro CLI](https://kiro.dev/docs/cli/) backend for the [Pi coding agent](https://github.com/earendil-works/pi): registers a `kiro` provider that delegates turns to your **local, authenticated kiro-cli** (`chat --no-interactive`). Requests originate from AWS's official client under your own seat/credit entitlement — this extension never reads or replays credentials.

Works with plain Pi, and with agent stacks built on it (rpiv-pi, GSD-style setups): the bridge below exposes whatever bridgeable tools your Pi session actually has.

## Install

```bash
pi install git:github.com/randiskull/pi-kiro
```

Requires kiro-cli on PATH and logged in (`kiro-cli login`; IdC/enterprise seats also need `kiro-cli profile` once — a missing profile surfaces as a `profileArn is required` error with that remedy attached).

## Use

- `/model kiro/<id>` — models fetched live from `kiro-cli chat --list-models` at registration (many seats expose only `auto`, Kiro's internal router).
- `/kiro` — readiness status; re-registers after login.
- `/kiro-subagents on [kiro/<id>] [name1,name2] | off` — route [pi-subagents](https://github.com/tintinweb/pi-subagents) agent profiles through kiro by rewriting their `model:` frontmatter. Wires every discovered agent, or just the named ones.

Pi thinking levels forward to kiro's `--effort` (minimal/low→low, medium→medium, high→high, xhigh→xhigh).

## The MCP bridge

Each delegated turn serves your Pi session's bridgeable tools over a **loopback Streamable-HTTP MCP endpoint** and writes a throwaway kiro agent profile (`~/.kiro/agents/pi-kiro-bridge-*.json`) whose inline `{type: "http"}` server points at the tokenized URL. The spawn adds `--agent <profile> --require-mcp-startup` (exit 3 retries once); profiles are unique per turn and removed afterwards. Inside kiro the tools appear as `@pi/<tool>`.

Bridged when installed: pi-subagents' `Agent` / `get_subagent_result` / `steer_subagent`, and rpiv's `ask_user_question` / `todo` / `advisor`. The capture degrades gracefully — absent extensions are simply not bridged. This makes `kiro/*` usable as a primary model for tool-orchestrating agents, including cross-runtime nesting (a kiro-delegated turn dispatching subagents that run on other providers).

## How output is parsed

Kiro CLI has no machine-readable output yet ([kirodotdev/Kiro#5423](https://github.com/kirodotdev/Kiro/issues/5423)); the adapter uses a sentinel protocol — the model wraps its final answer in `<pi_final>…</pi_final>`, everything else (ANSI-stripped) streams as a live thinking block, and the `Credits:` footer parses into Pi's cost tracking (`PI_KIRO_CREDIT_USD` scaling, default 0 for seat billing). Token counts are not reported by the CLI. When #5423 ships, the sentinel path swaps for structured parsing.

Kiro v3 note: v3's agent config (env-expanded URLs, header auth) would allow one stable profile, but v3 currently has no working headless mode — the extension targets v2 agent profiles until that changes.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PI_KIRO_CREDIT_USD` | `0` | USD per Kiro credit, for cost tracking in Pi |
| `PI_KIRO_BRIDGE` | `on` | Set `off` to disable the MCP tool bridge |
| `PI_KIRO_BRIDGE_TOOLS` | built-in allowlist | Comma-separated override of bridged tools |
| `PI_KIRO_WORKFLOW_MCP` | `on` | Set `off` to disable auto-mounting the GSD workflow-MCP server in delegated turns |
| `PI_KIRO_RESUME` | (enabled) | Set `off` to disable incremental context / session resume (forces full-context re-send every turn) |
| `PI_KIRO_TRANSPORT` | `chat` | Set `acp` to use the persistent ACP transport instead of the per-turn chat transport |
| `PI_KIRO_CHAT_TIMEOUT_MS` | `2700000` (45 min) | Hard turn ceiling for the chat transport; child killed if exceeded |
| `PI_KIRO_TURN_TIMEOUT_MS` | `2700000` (45 min) | Hard turn ceiling for the ACP transport pending requests |
| `PI_KIRO_IDLE_TIMEOUT_MS` | `600000` (10 min) | Idle timeout before killing the persistent ACP child |

## Security scanning

**Known accepted findings (upstream-frozen):** `@earendil-works/pi-coding-agent` publishes an
`npm-shrinkwrap.json`, freezing its dependency subtree — consumer `overrides`/`npm audit fix`
cannot modify it. Two DoS-class advisories currently live there: `brace-expansion` 5.0.6
(GHSA-3jxr-9vmj-r5cp / GHSA-mh99-v99m-4gvg, via minimatch — glob patterns here are
developer-controlled) and `protobufjs` 7.6.4 (GHSA-j3f2-48v5-ccww, via @google/genai — unused
by this provider). Both are unreachable in pi-kiro's usage; the fix owner is upstream via a
republished shrinkwrap. Top-level instances are pinned safe via `overrides`
(`brace-expansion@5.0.9`, `protobufjs@7.6.5`); `@modelcontextprotocol/sdk` is kept ≥1.30
(clears the @hono/node-server path-traversal chain).


Three layers, matching the posture upstream projects use:

- **Deterministic bar (GitHub Actions, no API keys).** `ci.yml` runs typecheck, tests, and a secret scan on every push/PR; `security-audit.yml` runs `npm audit` plus a full-tree secret scan weekly, on dependency changes, and on demand (`workflow_dispatch`). The audit is advisory by default — set the repo variables `SECURITY_AUDIT_BLOCKING=true` and `NPM_AUDIT_SEVERITY` (default `high`) to make it gate merges.
- **Automated dependency updates ([Dependabot](https://docs.github.com/en/code-security/dependabot)).** [`.github/dependabot.yml`](.github/dependabot.yml) opens weekly PRs for npm dependencies (dev-dependency minor/patch bumps grouped into one PR) and for GitHub Actions used in the workflows above. Every dependency-bump PR touching `package.json`/`package-lock.json` automatically triggers `security-audit.yml`, so bumps get an `npm audit` pass before merge.
- **AI-judgment layer ([Kiro Automation](https://kiro.dev/blog/introducing-automations/)).** A scheduled cloud automation reviews `main` for security, correctness, docs drift, and release readiness, opening a PR with findings; it also reviews open Dependabot PRs for supply-chain risk (unexpected transitive deps, unreviewed major bumps, advisories the audit alone wouldn't catch). It's configured in the web UI; the canonical prompt lives at [`.kiro/automations/security-scan.md`](.kiro/automations/security-scan.md).

Run the deterministic checks locally with `npm run scan` (typecheck + tests + secret scan + `npm audit`), or just the secret scan with `npm run scan:secrets`. A false-positive secret hit can be waived with a `secret-scan:allow` comment on the offending line.

**Pre-push hook (optional).** `npm run hooks:install` points `core.hooksPath` at `scripts/hooks`, gating every `git push` on the fast deterministic bar (typecheck + tests + secret scan — no network, so offline pushes work). Bypass a push with `git push --no-verify`. Set `PIKIRO_PREPUSH_KIRO_AUDIT=1` to additionally run a local kiro-cli release audit (`scripts/scan-kiro.sh`, also available as `npm run scan:kiro`), which reads the tree through your authenticated kiro-cli and blocks only on a HIGH/security verdict; tune it with `PIKIRO_SCAN_MODEL` (default `auto`) and `PIKIRO_SCAN_TIMEOUT` (default `300`).

## Compliance

Same posture as GSD's claude-code delegation and rpiv's external-runtime providers: the official client performs all model traffic under your own entitlement; headless usage is subject to your plan/org policies (admin governance applies to headless sessions). This extension adds no credentials handling of its own.

MIT © Randy James
