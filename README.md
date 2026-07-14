# pi-kiro

A [Kiro CLI](https://kiro.dev/docs/cli/) backend for the [Pi coding agent](https://github.com/badlogic/pi-mono): registers a `kiro` provider that delegates turns to your **local, authenticated kiro-cli** (`chat --no-interactive`). Requests originate from AWS's official client under your own seat/credit entitlement — this extension never reads or replays credentials.

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

## Compliance

Same posture as GSD's claude-code delegation and rpiv's external-runtime providers: the official client performs all model traffic under your own entitlement; headless usage is subject to your plan/org policies (admin governance applies to headless sessions). This extension adds no credentials handling of its own.

MIT © Randy James
