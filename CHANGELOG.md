# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-11

First versioned release. `0.1.0` was never tagged or published — it was the
initial git-installable state, so everything below is what changed for anyone
who installed from `git:github.com/randiskull/pi-kiro` before now.

### Changed

- **Renamed the package to `pi-kiro-agent`** (repo `randiskull/pi-kiro-agent`) ahead of the
  first npm publish. The name states what the extension does — it delegates turns to the Kiro
  agent — and keeps it distinct from the several direct-API `pi-*-kiro` model providers already
  on npm. No user-visible contract changed: the provider id is still `kiro`, the environment
  variables are still `PI_KIRO_*`, and bridge agent profiles are still named
  `pi-kiro-bridge-<pid>-<n>` (the orphan reaper matches that prefix, so renaming it would
  leak profiles written by earlier versions).
- `publishConfig` pins the publish registry to npmjs.org, so a bare `npm publish` cannot
  accidentally target a CodeArtifact default registry.

### Added

- **ACP transport** (`PI_KIRO_TRANSPORT=acp`). A persistent `kiro-cli acp` child
  speaking NDJSON JSON-RPC replaces TUI output scraping: turn completion is a
  protocol response rather than an exit code, tool calls are event-sourced
  instead of reconstructed from log lines, and credits come from the protocol's
  `meteringUsage` rather than a parsed footer. Sessions are reused across turns
  and re-created on a diverged prefix. **The default remains `chat`**; see
  `docs/design/acp-transport.md` for the rollout gate.
- **GSD workflow-MCP transport** (`PI_KIRO_WORKFLOW_MCP`). Mounts the
  `gsd-workflow` MCP server inside delegated kiro runs so `gsd_*` tools are
  callable there, and surfaces those calls as tool-call events.
- **Zero-config workflow-MCP discovery.** When a GSD project has no `.mcp.json`,
  the `gsd-workflow` entry is now synthesized from the environment, mirroring
  GSD's own `detectWorkflowMcpLaunchConfig` semantics (worktree-suffix
  stripping, `.gsd/` root walk, PATH resolution of the `gsd` CLI,
  `GSD_CODING_AGENT_DIR` → `$GSD_HOME/agent` → `~/.gsd/agent`). An explicit
  `.mcp.json` entry still wins; a malformed one now falls through to synthesis
  instead of yielding nothing.
- **Live tool-activity streaming.** Mid-turn `toolCall` blocks and `⚙` markers,
  so a long delegated turn shows progress instead of going silent.
- **Incremental context via `--resume-id`** (`PI_KIRO_RESUME`). Later turns send
  a delta rather than resending the whole conversation.
- **Orphan reaper.** Leaked `kiro-cli` children are reaped at activation, and
  the child is tethered to parent exit so an abandoned host does not strand a
  process group.
- **Hard turn ceilings.** `PI_KIRO_CHAT_TIMEOUT_MS` for the chat transport,
  `PI_KIRO_TURN_TIMEOUT_MS` and `PI_KIRO_IDLE_TIMEOUT_MS` for ACP.
- **`authMode: externalCli`** on the provider, so GSD takes its external-CLI
  path instead of expecting an API key.
- **Security bar in CI.** Full-tree secret scan, a blocking `npm audit` gate
  with a GHSA allowlist for upstream shrinkwrap-frozen findings, Dependabot,
  a pre-push hook (`npm run hooks:install`), and Kiro-powered review workflows.

### Fixed

- **The host process could not exit after a one-shot ACP turn.** `pi -p` printed
  its answer and then hung for ~10 minutes until the idle reaper killed the
  child. The detached child handle *and* all three stdio pipes hold event-loop
  references; all four are now unreferenced whenever no request is in flight and
  re-referenced for the duration of each turn. Verified live with a matched
  control arm: 15.5s clean exit with the fix, still running at 90s without it.
- **The idle timeout killed busy children.** A 10-minute turn was reaped
  mid-work. The idle clock is now silence-based (any inbound message resets it)
  and a pending turn extends to the turn ceiling before being treated as wedged.
- **`pi_final` sentinel leakage under ACP.** The sentinel instruction is omitted
  from ACP prompts, and any leaked tags are stripped from output.
- **Nonzero `kiro-cli` exits discarded completed work.** A turn that had already
  landed its result is now salvaged rather than thrown away.
- **Provider registration was lost on `/new`.** Registration no longer gates on
  module-local state.
- **A cold-start readiness probe timeout latched as "not found."** Transient
  `--version` timeouts are retried and never cached as a missing binary.
- **Bridge trust and resolution.** Project-scope packages are never treated as
  trusted bridge sources, and sibling extensions resolve through pi's package
  registry.
- **Session-key hygiene.** The `hashMessages` inter-message separator is now
  visible (with a collision test), raw NUL bytes in `messageKey` are written as
  `\x00` escapes so the source stays pure text, and `$MODEL` is quoted in
  `scripts/scan-kiro.sh`.

### Changed

- Bumped `@modelcontextprotocol/sdk`, which clears the transitive `hono`
  advisory chain; safe top-level duplicates pinned via `overrides`.
- Dev toolchain: TypeScript 5.9 → 7.0, `@types/node` 22 → 26, Vitest 4.
- CI matrix on Node 22 and 24; `engines.node` is `>=22`.

## [0.1.0]

Initial state, never tagged or published to npm.

- `kiro` provider for the Pi coding agent, delegating turns to a local
  authenticated `kiro-cli` (seat/credit-billed, official client).
- Loopback MCP bridge exposing the calling Pi session's tools inside the
  delegated run.
