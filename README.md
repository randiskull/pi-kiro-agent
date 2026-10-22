# pi-kiro-agent

A [Kiro CLI](https://kiro.dev/docs/cli/) backend for the [Pi coding agent](https://github.com/earendil-works/pi): registers a `kiro` provider that delegates turns to your **local, authenticated kiro-cli** (`chat --no-interactive`). Requests originate from AWS's official client under your own seat/credit entitlement — this extension never reads or replays credentials.

Works with plain Pi, and with agent stacks built on it: the bridge below exposes whatever bridgeable tools your Pi session actually has. Worked setups for [rpiv](docs/integrations/rpiv.md) and [GSD](docs/integrations/gsd-workflow-mcp.md).

## Install

```bash
pi install npm:pi-kiro-agent
```

Or straight from source:

```bash
pi install git:github.com/randiskull/pi-kiro-agent
```

Requires kiro-cli on PATH and logged in (`kiro-cli login`; IdC/enterprise seats also need `kiro-cli profile` once — a missing profile surfaces as a `profileArn is required` error with that remedy attached).

## Use

- `/model kiro/<id>` — models fetched live from `kiro-cli chat --list-models` at registration (many seats expose only `auto`, Kiro's internal router).
- `/model kiro/router` (pi >= 1.0, opt-in): a virtual model that picks a kiro model by thinking level: `low` haiku, `medium` sonnet, `high` opus, `xhigh` fable (tiers by kiro credit multiplier). Tool follow-ups and compaction stay on the transcript's model. If kiro fails, the turn falls back to the same tier on Amazon Bedrock (`us.anthropic.*`), Anthropic, or an OpenAI subscription (`openai-codex`), whichever has credentials first, for a cooldown. `kiro/auto` is unchanged.
- `/kiro` — readiness status; re-registers after login.
- `/kiro-subagents on [kiro/<id>] [name1,name2] | off` — route [pi-subagents](https://github.com/tintinweb/pi-subagents) agent profiles through kiro by rewriting the `model:` frontmatter in `~/.pi/agent/agents/*.md`. Wires every discovered agent, or just the named ones; defaults to `kiro/auto`. `off [name1,name2]` reverses it, acting only where the line points at `kiro/`, so agents you routed elsewhere by hand are untouched. If `on` displaced a non-kiro model, that value is stashed in a `pi-kiro-prev-model:` field and `off` puts it back; where there was no `model:` line to begin with, `off` removes the line again. See [docs/integrations/rpiv.md](docs/integrations/rpiv.md).

Pi thinking levels forward to kiro's `--effort` (minimal/low→low, medium→medium, high→high, xhigh→xhigh).

## The MCP bridge

Under the **chat transport** (`PI_KIRO_TRANSPORT=chat`), each delegated turn serves your Pi session's bridgeable tools over a **loopback Streamable-HTTP MCP endpoint** and writes a throwaway kiro agent profile (`~/.kiro/agents/pi-kiro-bridge-*.json`) whose inline `{type: "http"}` server points at the tokenized URL. The spawn adds `--agent <profile> --require-mcp-startup` (exit 3 retries once); profiles are unique per turn, written owner-only (`0600`) because the URL carries the token, and removed afterwards together with any `.bak` copies a kiro-cli v3-engine start saved beside them. Profiles left by a pi process that crashed mid-turn are swept at the next activation. Under the **ACP transport** (the default), the bridge mounts inline via the `session/new` protocol request's `mcpServers` array, so the bridge token never touches disk. kiro offers those servers to the model whatever agent the child runs (see [Which agent a delegated ACP turn runs](#which-agent-a-delegated-acp-turn-runs)). Inside kiro the tools appear as `@pi/<tool>` in either case.

Bridged when installed: pi-subagents' `Agent` / `get_subagent_result` / `steer_subagent`, and rpiv's `ask_user_question` / `todo` / `advisor`. The capture degrades gracefully — absent extensions are simply not bridged. This makes `kiro/*` usable as a primary model for tool-orchestrating agents, including cross-runtime nesting (a kiro-delegated turn dispatching subagents that run on other providers). Setup: [docs/integrations/rpiv.md](docs/integrations/rpiv.md).

## Which agent a delegated ACP turn runs

By default every ACP child runs a lean agent that pi-kiro writes for it: six of kiro's native
tools (`fs_read`, `fs_write`, `execute_bash` (`execute_cmd` on Windows), `grep`, `glob`,
`web_fetch`), no MCP servers of its own and no inherited resources. It is written owner-only to
`~/.kiro/agents/pi-kiro-bridge-<pid>-<n>.json`, the same throwaway naming as the chat transport's
profile, and carries no token. It is removed when the child goes or when pi exits, and one left by
a pi that was killed is swept at the next activation. pi's own tools still arrive through the
bridge, and the GSD workflow server through `session/new`. If the profile cannot be written (a
read-only home directory), the turn runs on your default agent and says so on stderr.

**What a delegated turn no longer has.** kiro's other native tools are not in the lean agent:
`web_search`, `use_aws`, `todo_list`, `knowledge`, `code`, `introspect`, `use_subagent`, `session`
and `report_issue`, 28 KB of schemas on kiro-cli 2.32.0, roughly 7,000 tokens a turn. pi's own
tools, including its todo list and subagents when installed, still reach the delegate through the
bridge. A delegate that should search the web or call AWS needs `PI_KIRO_ACP_AGENT=default`, or an
agent of your own named there.

Without it, `kiro-cli acp` runs whatever agent `chat.defaultAgent` names, and that agent brings its
MCP servers, the global `mcp.json` and every inherited steering file and skill into every turn.
Measured on kiro-cli 2.32.0 with Opus 5.5 and a one-line prompt, from kiro's own
`contextUsagePercentage` and `meteringUsage` (`probes/acp-probe-p7-preamble.mjs`):

| Agent | Context | Credits |
|---|---|---|
| a developer machine's default agent, with its MCP servers and inherited steering | ~101,600 tokens | 1.25 |
| `kiro_default`, inheritance disabled, 8 global MCP servers | ~110,000 tokens | 1.35 |
| the lean agent | ~10,800 tokens | 0.047 |
| a custom agent with no tools at all | ~6,900 tokens | 0.032 |

The last row is the floor, and almost none of it is sent by the client: kiro-cli's own request for
that turn is under 10 KB. It matches the preamble Kiro's service adds for a request whose `origin`
is `KIRO_CLI`, about 6,700 tokens when measured with a direct API call, against about 1,300 for
`KIRO_WEB`. kiro-cli 2.32.0 has no setting that changes its origin, so pi-kiro, which drives the
official client, pays that preamble; a provider that calls Kiro's API directly can choose. Your own figures depend on what your default agent loads, and on the
model: kiro reports context against each model's own window.

`PI_KIRO_ACP_AGENT=default` restores the previous behaviour, and `PI_KIRO_ACP_AGENT=<name>` runs
one of your own agents instead (see [Environment](#environment)).

## How output is parsed

On kiro-cli **2.21.4 or newer** the **chat transport** reads `--output-format stream-json`: kiro's turn as versioned ACP events (complete tool arguments, built-in tools as `kiro_*` rows, the session id, credits), with a strict envelope check that fails loudly if the format changes. On older kiro-cli, or with `PI_KIRO_CHAT_FORMAT=text`, it scrapes kiro's text output instead. Both paths use a sentinel protocol — the model wraps its final answer in `<pi_final>…</pi_final>`, everything else (ANSI-stripped) streams as a live thinking block, and the `Credits:` footer parses into Pi's cost tracking (see [Credits](#credits)). Token counts are not reported by the CLI. The **ACP transport** (the default) uses structured NDJSON protocol events (`session/update` and `_kiro.dev/metadata`) instead of sentinel parsing — no wrapping is required. stream-json is the structured output kirodotdev/Kiro#5423 asked for, but its `runFinished.finalText` is all of the turn's text, narration included, so the chat transport keeps the sentinel to find the answer.

Kiro v3 note (chat transport): v3 does run headless (`chat --no-interactive` answers correctly, and under `--output-format stream-json` its `[INFO] kas.*` logs go to stderr, leaving stdout valid JSON Lines), but it sends no `metadata` event, so credits and context usage move into `session_info_update._meta.kiro`, its tool calls carry no `toolName` (rows would read `kiro_unknown`), and it runs an internal tool call on every turn. The extension targets v2 until that is handled: design and measurements in [docs/design/v3-engine.md](docs/design/v3-engine.md).

## Credits

Kiro bills in credits, and the figure the CLI reports is the only per-turn price available: no
transport reports token counts, so Pi cannot derive a cost from a price list the way it does for
token-billed providers. pi-kiro surfaces that figure three ways.

- **A running status line** in Pi's footer. After a three-tool turn billed at 1.6338 credits it
  reads `▸ 1.63 credits ~$0.03`; after a second turn of 0.4102 credits that used 3.7% of the
  model's context window, `▸ 2.04 credits ~$0.04 (last 0.410) ctx 3.7%`. The `ctx` figure is the
  last turn's, and is left out when that turn reported none (the chat text path). It resets at session start, and the
  dollar part is dropped entirely when `PI_KIRO_CREDIT_USD` is `0`.
- **`usage.cost.total`** on each assistant message, so credits roll into Pi's own cost totals
  after conversion at `PI_KIRO_CREDIT_USD`.
- **A `kiro.metering` diagnostic** on each assistant message, carrying `credits`, `unit`, `source`
  (`acp`, `chat-stream-json` or `chat-text`), `precision`, and — on the structured transports —
  `contextPercent` and kiro's own `turnDurationMs`.

Precision depends on the transport. ACP (`_kiro.dev/metadata`) and chat stream-json (`metadata`)
both deliver `meteringUsage` exactly once per turn, holding **one entry per internal model call**,
which pi-kiro sums: a turn that called three tools reports three entries. Those are marked
`precision: "exact"`. The chat text fallback has no structured channel and can only read the
rendered footer ` ▸ Credits: N.NN`, which is quantised to two decimals and prints `0.00` for any
turn under half a cent of credit, so it is marked `precision: "rendered-2dp"` — a consumer can tell
a real zero from a rounded one. A unit other than `credit` is never folded into the credit total; it
is reported separately under `otherUnits`.

Dollars are always a projection, never a bill: they are marked `~` and computed from one
configurable rate, which does not know your plan, your overage state, or whether the subscription
is already sunk.

## The GSD workflow-MCP server

[GSD](https://github.com/open-gsd/gsd-pi) auto-mode units (`plan-slice`, `execute-task`,
`complete-slice`…) require the model to call GSD's `gsd_*` workflow tools. For API providers
Pi sends tool schemas with the request, but for an external-CLI provider the CLI owns the
agentic loop — so the supported pattern (same as GSD's own claude-code-cli backend) is to
mount GSD's `gsd-workflow` stdio MCP server **inside** the delegated kiro run. Without it a
unit can write files but can never call `gsd_task_complete`: the task row stays `pending`,
the runtime unit stays `dispatched`, and the operator has to reconcile GSD's DB by hand.

Discovery is zero-config: an explicit `gsd-workflow` entry in the project's
`.mcp.json` always wins, and otherwise the entry is synthesized whenever the cwd
sits inside a GSD project. Every unresolved path bails out to *no server* rather
than a wrong one, so a plain non-GSD kiro turn is never blocked by discovery.
Full precedence spec and a worked setup:
[docs/integrations/gsd-workflow-mcp.md](docs/integrations/gsd-workflow-mcp.md).

> **Security — a project's `.mcp.json` is trusted code.** A `gsd-workflow` entry in a project's
> `.mcp.json` is read directly and its `command`/`args`/`env` are executed as-is inside the
> delegated kiro run, which runs `--trust-all-tools` with an `allowedTools: ["*"]` profile.
> Discovery fires before the model does anything, so **merely opening an untrusted cloned repo
> and sending one prompt is enough to run whatever that repo's `.mcp.json` names.** This is a
> deliberately different posture from the MCP bridge, which refuses project-scope packages for
> exactly this reason. Only the `gsd-workflow` key is consumed. For unreviewed repos, set
> `PI_KIRO_WORKFLOW_MCP=off` to disable file-sourced discovery entirely; the synthesized path
> resolves every path from the filesystem and is not project-controlled. When a project-supplied
> entry does get mounted, one audit line naming the `.mcp.json` goes to stderr, so it is never
> mounted silently; the synthesized path stays quiet because nothing project-supplied runs.

**Run GSD on kiro under the default ACP transport.** Only ACP passes MCP
servers inline and returns real, fully-parsed tool-call arguments. Under the
`chat` transport a unit can write files but never land a `gsd_task_complete`, and it
fails quietly — see the transport section of the
[integration doc](docs/integrations/gsd-workflow-mcp.md#transport-matters). Set
`PI_KIRO_WORKFLOW_MCP=off` to opt out of mounting the server entirely.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PI_KIRO_CREDIT_USD` | `0.02` | USD per Kiro credit, used to project a dollar cost for Pi's usage tracking. `0.02` is Kiro's published in-plan ratio (Pro $20/1,000 credits, Pro+ $40/2,000, Power $200/10,000 — [kiro.dev/pricing](https://kiro.dev/pricing/)); on-demand and overage rates differ. Set `0` to show credits only and no dollars. A malformed or negative value falls back to the default instead of poisoning the total |
| `PI_KIRO_BRIDGE` | `on` | Set `off` to disable the MCP tool bridge |
| `PI_KIRO_BRIDGE_TOOLS` | built-in allowlist | Comma-separated override of bridged tools, by their origin-prefixed names (`rpiv_todo`, `subagents_Agent`); a bare name matches nothing |
| `PI_KIRO_BRIDGE_MAX_BODY_BYTES` | `33554432` (32 MiB) | Largest single request kiro may send a bridged tool (its arguments, as JSON). MCP carries binary as base64, so the usable payload is about three quarters of this. A larger request is refused before the tool runs, with a one-time warning on stderr. Read when a bridge mounts. Does not limit tool results. |
| `PI_KIRO_WORKFLOW_MCP` | `on` | Set `off` to disable auto-mounting the GSD workflow-MCP server in delegated turns |
| `PI_KIRO_ACP_AGENT` | `lean` | **ACP transport only.** Which kiro agent each ACP child runs. `lean` (or unset): a pi-owned agent with six of kiro's native tools and nothing inherited, see [Which agent a delegated ACP turn runs](#which-agent-a-delegated-acp-turn-runs). `default`: no `--agent`, so kiro runs your `chat.defaultAgent` with everything it loads. Any other value: `--agent <value>`, one of your own agents, which keeps whatever it inherits. Read when a child starts |
| `PI_KIRO_WORKSPACE_SETTINGS` | `on` | Set `off` to stop delegated turns from disabling kiro's default-resource inheritance. When on, a chat-transport turn behind a generated agent profile, or an ACP child running the lean agent, sets `chat.disableInheritingDefaultResources` in `<cwd>/.kiro/settings/cli.json` and restores the file afterwards (for ACP, as soon as kiro-cli has answered `initialize`, because it reads the setting once at startup, and after `PI_KIRO_ACP_SETTINGS_HOLD_MS`, default 30 s, if it never does; children starting together in one directory share one change, restored when the last has started), which keeps the inherited steering, skills and `AGENTS.md` out of every turn: roughly 30,000 to 47,000 tokens on a developer machine. An explicit value you have already set for that key is never overridden. It is never written when the cwd is your home directory, where that path is kiro's global settings, and a directory it cannot write (read-only, or a `.kiro` that is a file) costs one warning on stderr, not the turn. An edit you make to that file during a turn is kept (only the key is taken back). If pi is killed mid-turn, the next delegated turn in that directory restores the file; if a restore fails, pi-kiro says so on stderr and retries on the next turn. Until then your own interactive kiro sessions in that directory run without inherited steering and skills, so `off` is the safe choice for a project you also use kiro in directly while pi turns run. |
| `PI_KIRO_RESUME` | (enabled) | **Chat transport only.** Set `off` to disable incremental context / session resume (forces full-context re-send every turn). The ACP transport has its own built-in divergence detection: it always creates a fresh session when the context prefix changes and resumes on a pure-append; `PI_KIRO_RESUME` has no effect on it. To fully disable session continuity under ACP, switch to the chat transport (`PI_KIRO_TRANSPORT=chat`) and set `PI_KIRO_RESUME=off`. |
| `PI_KIRO_TRANSPORT` | `acp` | Set `chat` to fall back to the per-turn chat transport. ACP holds one kiro-cli child for the session and speaks a protocol, so tool arguments and the credit metadata arrive as structured events and kiro keeps its prefix cache warm across turns; the chat transport spawns a child per turn and, below the stream-json floor, recovers the answer by scraping prose. An unrecognized value keeps ACP and writes one `transport.unknown` trace, so a typo cannot silently downgrade a session. The live transport is named in the identity line |
| `PI_KIRO_CHAT_FORMAT` | `stream-json` on kiro-cli ≥ 2.21.4, else `text` | **Chat transport only.** `stream-json` reads kiro-cli's structured `--output-format stream-json` events instead of scraping its text: real tool arguments, kiro's built-in tools as `kiro_*` rows, and a loud failure if the event format changes. `text` forces the text scrape. An explicit value is honoured on any kiro-cli version; any other value fails the turn |
| `PI_KIRO_CHAT_TIMEOUT_MS` | `2700000` (45 min) | Hard turn ceiling for the chat transport; child killed if exceeded |
| `PI_KIRO_TURN_TIMEOUT_MS` | `2700000` (45 min) | Hard turn ceiling for the ACP transport pending requests |
| `PI_KIRO_IDLE_TIMEOUT_MS` | `600000` (10 min) | Idle timeout before killing the persistent ACP child |
| `PI_KIRO_ROUTER` | `on` | Set `off` to not register the `kiro/router` virtual model |
| `PI_KIRO_ROUTER_FALLBACK` | `amazon-bedrock,anthropic,openai-codex` | Providers `kiro/router` falls back to, in order, when kiro fails |
| `PI_KIRO_ROUTER_COOLDOWN_MS` | `900000` (15 min) | How long `kiro/router` stays on a fallback before trying kiro again |
| `PI_KIRO_MCP_STARTUP_TIMEOUT_MS` | `30000` (30 s) | ACP transport: how long to wait for all MCP servers to report ready after `session/new` before failing the turn. Override for slow-starting servers or to speed up tests. |

## Security scanning

**Known accepted findings: none** — `.audit-allowlist.json` is empty. Through 1.0.x,
`@earendil-works/pi-coding-agent` published an `npm-shrinkwrap.json` that froze its dependency
subtree, so three DoS-class advisories living there (`brace-expansion` GHSA-3jxr-9vmj-r5cp /
GHSA-mh99-v99m-4gvg via minimatch, `protobufjs` GHSA-j3f2-48v5-ccww via @google/genai) were
unfixable by a consumer and were accepted instead. 1.2.0 ships no shrinkwrap, the subtree resolves
normally, and those findings are gone from the tree.

**No consumer `overrides` either, deliberately.** A fixed version in `overrides` is a ceiling, not
a floor. The `brace-expansion@5.0.9` pin that once cleared an advisory is what later made
`npm audit` report three of them: upstream had moved to the patched 5.0.12 and the pin dragged it
back into the vulnerable range. Version floors belong in `dependencies` — which is where
`@modelcontextprotocol/sdk` is kept at ≥1.30, clearing the @hono/node-server path-traversal
chain.


Three layers, matching the posture upstream projects use:

- **Deterministic bar (GitHub Actions, no API keys).** `ci.yml` runs typecheck, tests, and a secret scan on every push/PR; `security-audit.yml` runs `npm audit` plus a full-tree secret scan weekly, on dependency changes, and on demand (`workflow_dispatch`). The audit is blocking by default — set the repo variable `SECURITY_AUDIT_BLOCKING=false` to make it advisory-only; `NPM_AUDIT_SEVERITY` (default `high`) sets the failure threshold.
- **Automated dependency updates ([Dependabot](https://docs.github.com/en/code-security/dependabot)).** [`.github/dependabot.yml`](.github/dependabot.yml) opens weekly PRs for npm dependencies (dev-dependency minor/patch bumps grouped into one PR) and for GitHub Actions used in the workflows above. Every dependency-bump PR touching `package.json`/`package-lock.json` automatically triggers `security-audit.yml`, so bumps get an `npm audit` pass before merge.
- **AI-judgment layer ([Kiro Automation](https://kiro.dev/blog/introducing-automations/)).** A scheduled cloud automation reviews `main` for security, correctness, docs drift, and release readiness, opening a PR with findings; it also reviews open Dependabot PRs for supply-chain risk (unexpected transitive deps, unreviewed major bumps, advisories the audit alone wouldn't catch). It's configured in the web UI; the canonical prompt lives at [`.kiro/automations/security-scan.md`](.kiro/automations/security-scan.md).

Run the deterministic checks locally with `npm run scan` (typecheck + tests + secret scan + `npm audit`), or just the secret scan with `npm run scan:secrets`. A false-positive secret hit can be waived with a `secret-scan:allow` comment on the offending line.

The test suite includes one end-to-end check that the *published* package loads: it runs `npm pack`, gives the extracted tarball only the runtime dependencies its manifest declares, and hands it to pi's own extension loader, asserting the `kiro` provider and both commands register. A stub `kiro-cli` answers the readiness probes, so it stays offline and needs no Kiro seat. Delegating a real turn does need one, and so does anything that touches the MCP bridge or GSD's workflow server: those live tests (`npm run test:live`) are gated on `PI_KIRO_LIVE=1` and skipped everywhere else, including CI. See CONTRIBUTORS.md for what each one covers and costs.

**Pre-push hook (optional).** `npm run hooks:install` points `core.hooksPath` at `scripts/hooks`, gating every `git push` on the fast deterministic bar (typecheck + tests + secret scan — no network, so offline pushes work). Bypass a push with `git push --no-verify`. Set `PI_KIRO_PREPUSH_KIRO_AUDIT=1` to additionally run a local kiro-cli release audit (`scripts/scan-kiro.sh`, also available as `npm run scan:kiro`), which reads the tree through your authenticated kiro-cli and blocks only on a HIGH/security verdict; tune it with `PI_KIRO_SCAN_MODEL` (default `auto`) and `PI_KIRO_SCAN_TIMEOUT` (default `300`).

## Versioning

Pre-1.0, so breaking changes land in a minor. A **patch** is fixes and internal
change only; a **minor** is any change to what a user types or sets (slash commands,
`kiro/*` model ids, `PI_KIRO_*` variables, the published entry point) and any raised
floor on pi, kiro-cli, Node or the MCP SDK.

The pi SDK is a peer dependency at `*` on purpose, because pi is the host
application the user installs. Nothing in npm's resolver therefore enforces host
compatibility: the dev dependency plus the drift tests are the whole mechanism,
which is why raising the dev dependency is a minor rather than a patch.

Every `### Fixed` entry in the changelog names the test that proves it, or waives it
in writing as `(no test: why)`, and CI fails on an entry that does neither. What
counts as a citation, what counts as a waiver, and how to check one:
[docs/releasing.md](docs/releasing.md#citing-a-test-and-when-a-fix-may-waive-one).

Full policy, and the list of what CI enforces versus what needs judgement:
[docs/releasing.md](docs/releasing.md).

## Compliance

Same posture as GSD's claude-code delegation and rpiv's external-runtime providers: the official client performs all model traffic under your own entitlement; headless usage is subject to your plan/org policies (admin governance applies to headless sessions). This extension adds no credentials handling of its own.

MIT © Randy James
