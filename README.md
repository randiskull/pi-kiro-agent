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

## The GSD workflow-MCP server

[GSD](https://github.com/open-gsd/gsd-pi) auto-mode units (`plan-slice`, `execute-task`,
`complete-slice`…) require the model to call GSD's `gsd_*` workflow tools. For API providers
Pi sends tool schemas with the request, but for an external-CLI provider the CLI owns the
agentic loop — so the supported pattern (same as GSD's own claude-code-cli backend) is to
mount GSD's `gsd-workflow` stdio MCP server **inside** the delegated kiro run. Without it a
unit can write files but can never call `gsd_task_complete`: the task row stays `pending`,
the runtime unit stays `dispatched`, and the operator has to reconcile GSD's DB by hand.

Discovery is zero-config. In order of precedence:

1. A `gsd-workflow` entry in the project's `.mcp.json` (what `/gsd mcp init .` writes) always wins.
2. Otherwise, if the cwd is inside a GSD project (a `.gsd/` directory at or above it, stopping
   at the `.git` boundary), the entry is **synthesized**: the `gsd` CLI is resolved from
   `GSD_CLI_PATH`/`GSD_BIN_PATH` or `PATH`, the workflow server from
   `packages/mcp-server/dist/cli.js` in that install (or in-tree for a GSD checkout), and
   GSD's live extension modules from `$GSD_CODING_AGENT_DIR` / `$GSD_HOME/agent` / `~/.gsd/agent`.
   Every unresolved path bails out to *no server* rather than a wrong one — a plain non-GSD
   kiro turn is never blocked by discovery. A cwd inside a `.gsd/worktrees/` milestone
   worktree resolves to the real project root.

Because kiro's agent-profile MCP schema has no `cwd` field, an entry with a `cwd` is launched
via `/bin/sh -c "cd … && exec …"`.

**Transport matters here.** Only `PI_KIRO_TRANSPORT=acp` passes MCP servers inline through
`session/new` and returns real, fully-parsed tool-call arguments. The default `chat` transport
has to text-parse kiro's console output, which fabricates tool-call ids (`kiro-mcp-<n>-<name>`)
and best-effort parses arguments from CLI log output (unparseable blocks degrade to `{}`) — enough to satisfy GSD's zero-tool-call guard, not enough to
round-trip a real `gsd_task_complete` payload. **Run GSD on kiro with
`PI_KIRO_TRANSPORT=acp`.** Set `PI_KIRO_WORKFLOW_MCP=off` to opt out of mounting the server
entirely.

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

- **Deterministic bar (GitHub Actions, no API keys).** `ci.yml` runs typecheck, tests, and a secret scan on every push/PR; `security-audit.yml` runs `npm audit` plus a full-tree secret scan weekly, on dependency changes, and on demand (`workflow_dispatch`). The audit is blocking by default — set the repo variable `SECURITY_AUDIT_BLOCKING=false` to make it advisory-only; `NPM_AUDIT_SEVERITY` (default `high`) sets the failure threshold.
- **Automated dependency updates ([Dependabot](https://docs.github.com/en/code-security/dependabot)).** [`.github/dependabot.yml`](.github/dependabot.yml) opens weekly PRs for npm dependencies (dev-dependency minor/patch bumps grouped into one PR) and for GitHub Actions used in the workflows above. Every dependency-bump PR touching `package.json`/`package-lock.json` automatically triggers `security-audit.yml`, so bumps get an `npm audit` pass before merge.
- **AI-judgment layer ([Kiro Automation](https://kiro.dev/blog/introducing-automations/)).** A scheduled cloud automation reviews `main` for security, correctness, docs drift, and release readiness, opening a PR with findings; it also reviews open Dependabot PRs for supply-chain risk (unexpected transitive deps, unreviewed major bumps, advisories the audit alone wouldn't catch). It's configured in the web UI; the canonical prompt lives at [`.kiro/automations/security-scan.md`](.kiro/automations/security-scan.md).

Run the deterministic checks locally with `npm run scan` (typecheck + tests + secret scan + `npm audit`), or just the secret scan with `npm run scan:secrets`. A false-positive secret hit can be waived with a `secret-scan:allow` comment on the offending line.

**Pre-push hook (optional).** `npm run hooks:install` points `core.hooksPath` at `scripts/hooks`, gating every `git push` on the fast deterministic bar (typecheck + tests + secret scan — no network, so offline pushes work). Bypass a push with `git push --no-verify`. Set `PIKIRO_PREPUSH_KIRO_AUDIT=1` to additionally run a local kiro-cli release audit (`scripts/scan-kiro.sh`, also available as `npm run scan:kiro`), which reads the tree through your authenticated kiro-cli and blocks only on a HIGH/security verdict; tune it with `PIKIRO_SCAN_MODEL` (default `auto`) and `PIKIRO_SCAN_TIMEOUT` (default `300`).

## Compliance

Same posture as GSD's claude-code delegation and rpiv's external-runtime providers: the official client performs all model traffic under your own entitlement; headless usage is subject to your plan/org policies (admin governance applies to headless sessions). This extension adds no credentials handling of its own.

MIT © Randy James
