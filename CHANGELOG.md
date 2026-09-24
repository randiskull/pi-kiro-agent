# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- **Docs accuracy: `PI_KIRO_RESUME` applies to the chat transport only.** The README env table
  previously implied the flag applied to all transports. The ACP transport (`PI_KIRO_TRANSPORT=acp`)
  has its own built-in divergence detection in `acp-session.ts` (`planAcpTurn`) and is not gated on
  `PI_KIRO_RESUME` at all. The README row now says so explicitly and documents the escape hatch for
  users who want to fully disable session continuity under ACP (`PI_KIRO_TRANSPORT=chat` +
  `PI_KIRO_RESUME=off`). A regression test in `acp-session.test.ts` pins this independence.

- **A session reset no longer strands kiro on a closed bridge port.** kiro learns the MCP bridge
  URL once, from the `mcpServers` array in `session/new`, and has no way to be told a new one. The
  divergence branch of `resolveSession` closed the bridge and mounted a replacement on a fresh
  ephemeral port, so kiro accepted the new session but kept the MCP client it had already built for
  the server named `pi` -- still pointed at the closed port. Every bridged tool call for the rest of
  the conversation then failed with `error sending request for url (http://127.0.0.1:PORT/...)`,
  while kiro-native tools kept working. Observed live as `steer_subagent` and `get_subagent_result`
  failing immediately after a successful `Agent` call. The cause was `serveBridgeHttp` conflating two
  different lifetimes in one `AbortSignal`: the server's lifetime and the cancellation signal handed
  to each bridged `tool.execute`. Cancellation really is per-session; lifetime is per-**child**. They
  are now separate -- `AcpChild.childAbort` owns the server, and a `getCallSignal` accessor supplies
  the current session's signal per request -- so the bridge is mounted once per child and reused by
  every session on it, while a reset still cancels in-flight calls.

- **The unit test suite no longer depends on whether the checkout is a GSD project.** 29 of the 43
  `acp-transport.test.ts` tests were failing with 5-second timeouts, and the file took 146 of the
  suite's 149 seconds. Cause: `discoverWorkflowMcpServers()` walks up from `process.cwd()` looking
  for a GSD project, and this repo's own root now has a `.gsd` directory -- so every ACP turn
  synthesized a `gsdworkflow` MCP server, `startSession` added it to the set it waits on, and every
  test script that answers `initialize`/`session/new` but never sends
  `_kiro.dev/mcp/server_initialized` for it hung on the startup gate. `test/test-setup.ts` already
  existed to stop tests reading the developer's real environment (it redirects `$HOME`); it now
  pins `PI_KIRO_WORKFLOW_MCP=off` for the same reason. `test/workflow-mcp.test.ts`, the one suite
  that exercises discovery for real, clears the variable in `beforeEach` as well as `afterEach` --
  clearing it only on the way out left its first test inheriting the run-wide default. The suite went from
  29 failures in 149 seconds to fully green in ~3 seconds.

- **Surfaced tool calls stay visible in the mid-turn display instead of vanishing retroactively.**
  The end-of-turn reconciliation replaced `output.content` in place, but every streamed event
  carries `partial: output` *by reference* -- so the strip retroactively emptied the tool-by-turn
  progress display for any consumer that reads a partial after the turn ends, which with an async
  generator is any consumer the producer outruns. The final `done`/`error` message now gets a
  filtered **copy** and the partials keep their blocks. Each surfaced block is also paired with a
  `⚙ <tool>` thinking marker, exactly as the chat transport does (`stream-adapter.ts:404`): pushing
  onto `output.content` alone emits no event, so nothing carried the update until the next chunk
  happened to arrive.

### Added

- **A mount-time warning when a requested bridge tool is missing.** A name in the bridge allow-list
  that no loaded extension provides used to fail silently at mount and opaquely much later: the tool
  was simply absent from the bridge, kiro never learned it existed, and the only symptom was the
  delegated model reaching for something else, or -- for a tool pi does not register either -- a bare
  `Tool <name> not found` from pi's own dispatcher with nothing pointing at the bridge as the missing
  link. `captureBridgeTools` now names the missing tools on stderr as soon as the bridge is built,
  along with the ones that did make it through (so "one extension is stale" is distinguishable from
  "nothing loaded"), and points at the two real causes: an extension that failed to load, or a typo
  in `PI_KIRO_BRIDGE_TOOLS`. The warning is advisory and deduped per tool name, since every ACP child
  mounts its own bridge and an unguarded warning would repeat on each spawn.

- **Trace coverage for bridge and child lifetime.** A bridged tool failing with kiro's bare
  `error sending request for url (http://127.0.0.1:PORT/...)` was previously indistinguishable
  between a bridge that never came up, one torn down early, and a kiro client still holding a
  previous session's port. Five new events make the port the join key: `bridge.serve` and
  `bridge.close` (with a reason), `acp.child.spawn` and `acp.child.teardown` (with a reason, the
  registry key, the pid and the pending-request count), and `acp.session.new` (the mcpServers URLs
  actually handed to kiro, which are the only ones it can ever use for that session).

- **The ACP transport no longer makes pi execute tool calls kiro has already run.** Every
  `session/update` `tool_call` notification was pushed onto the assistant message as a real,
  executable `toolCall` block. pi dispatches tool calls off the *presence* of those blocks rather
  than off `stopReason`, so it ran each one a second time. A bridged `ask_user_question` therefore
  raised a **duplicate questionnaire card that never touched the MCP bridge** -- which is why the
  single-flight guard could not see it and appeared to be doing nothing -- and a kiro-native tool
  pi does not register (`shell`, `read`, `glob`, `gsd_exec`) came back as `Tool shell not found`.
  That error result was then serialised into kiro's next prompt, leaving kiro with a turn made
  entirely of tool-result noise and no instruction, which it treated as a stray artifact and
  answered by restarting the whole delegated task. The apparent "five kiro sessions in five
  minutes" was this loop, not kiro restarting itself: the five were five pi conversations, three
  of which match their pi session file to the millisecond. These blocks are now tagged with
  `LIVE_TOOL_ID_PREFIX` and stripped before the final message, the same mechanism the chat
  transport has always used, so they still drive the mid-turn progress display without being
  mistaken for work to do. A new `acp.toolcall.surfaced` trace event records each one.

- **`/kiro-subagents on` no longer destroys an agent's existing model routing.** It used to overwrite
  a pre-existing `model:` value with no record of it, so a later `off` had nothing to restore and
  deleted the line outright -- silently discarding routing the user had set by hand. `on` now stashes
  a displaced non-kiro value in a `pi-kiro-prev-model:` frontmatter field and `off` restores it. A
  second `on` does not overwrite the stash, so cycling through kiro models still returns to the
  original. Where there genuinely was no `model:` line, `off` removes the line as before, which is
  the correct restore in that case.
- **`/kiro-subagents off` accepts a name list.** The handler exact-matched `off`, so
  `/kiro-subagents off locator` fell through to the usage error even though the underlying
  `wireSubagents` had always supported restricting to named agents. `off [name1,name2]` now mirrors
  `on`.

### Added

- **End-to-end load test against the real pi host** (`test/extension-load.e2e.test.ts`). It packs
  the tarball `npm publish` would upload, gives it only the runtime dependencies its own manifest
  declares, and hands the result to pi's own extension loader. It asserts that the declared entry
  point is actually published, that pi loads *that* entry rather than a convention-discovered
  namesake, and that activation registers the `kiro` provider plus both slash commands. A stub
  `kiro-cli` on `PATH` answers the readiness and model-list probes, so the test is offline and needs
  no Kiro seat. Every other test imports the entry module directly, which left the published package
  itself unverified: a wrong `pi.extensions` path or a module missing from `files` used to pass every
  gate and fail first at `pi install`. A real delegated turn still needs a seat and stays in
  the live suite behind `PI_KIRO_LIVE=1`.
- **A live suite that exercises GSD's and rpiv's integration paths against the real thing**
  (`npm run test:live`, gated on `PI_KIRO_LIVE=1`, skipped in CI). Four new files join the existing
  chat-transport test:
  - `acp-transport-live.test.ts` -- the ACP transport against a real kiro-cli, asserting one
    persistent child and one *reused* ACP session id across two turns. This is the transport GSD
    requires, since only ACP passes MCP servers through, and all 36 of its existing tests drive a
    `spawn` mock: it had no live coverage at all.
  - `bridge-live.test.ts` -- the MCP bridge end to end, in three parts that fail for different
    reasons: every bridge source located through pi's own package registry at user scope with its
    manifest entry present and inside the package (pi-kiro's own logic); capture asserted to degrade
    to `[]` rather than throw, which is the shipped contract, since importing a sibling's TypeScript
    entry resolves its peer imports against the ambient host's module tree and only succeeds inside a
    real pi process; and the round trip driven by a synthetic tool -- served over authenticated
    loopback MCP (including a 401 on an unauthenticated request), listed and called back through a
    real MCP client, then invoked by a delegated kiro turn that lands in this process. Using a
    synthetic tool for the round trip is deliberate: `serveBridgeHttp` does not care where a
    `CapturedTool` came from, so the transport proof stops depending on the host constraint above.
  - `workflow-mcp-live.test.ts` -- GSD's workflow MCP path: a `.mcp.json` entry discovered and
    translated into a kiro agent profile, that translation launched as a real `gsd-workflow` server,
    and a delegated `gsd_doctor` call recovered from kiro's output as a pi `ToolCall` block. Those
    blocks are what GSD counts in `snapshotUnitActivity`, so a unit that called `gsd_*` but produced
    none trips the zero-tool-call guard and gets salvaged.
  - `command-coverage-live.test.ts` -- `/kiro` and `/kiro-subagents` driven through the handlers the
    extension really registers, with nothing mocked: real readiness and model-list probes, the
    `authMode: "externalCli"` and `local://kiro-cli` fields GSD gates flat-rate routing on, and
    `PI_KIRO_TRANSPORT=acp` selecting the ACP transport. Makes no model call.
- `CONTRIBUTORS.md`, and worked integration guides for rpiv and the GSD workflow MCP under
  `docs/integrations/`.

### Changed

- **Source and tests are split into `src/` and `test/`, so the published entry point moves from
  `./index.ts` to `./src/index.ts`.** `pi install` reads that path out of the manifest, so nothing
  changes for users; anyone referencing the file directly needs to update it.
- **`files` is now a pure allowlist** (`src/`, `docs/`, and the four root documents) instead of a
  wildcard with negations. The old form published any new root `*.ts` by default and needed one `!`
  exception per test file, so a new module was published by omission rather than by decision.
  `docs/` now ships with the package. Three constraint tests pin the invariants: every
  `pi.extensions` entry resolves on disk, `files` carries no negated patterns, and `docs/` stays
  included.
- CI installs with `npm ci` rather than `npm install`, so the committed lockfile is authoritative
  and a green run cannot be a different dependency tree than the one that was reviewed.
- `BRIDGE_SOURCES` is exported, so the live suite asserts against the real list instead of a copy.

### Fixed

- **Tool calls made inside a delegated kiro run were being missed, silently, on kiro-cli 2.21 and
  later, which made GSD salvage units that had really done the work.** `synthesizeToolCallBlocks`
  emitted no `ToolCall` blocks, and those blocks are exactly what GSD's `snapshotUnitActivity`
  counts, so a unit that called `gsd_*` several times presented as a unit that had made no tool
  calls at all. Two independent causes, both fixed:
  - **The lines moved to stderr.** kiro-cli 2.21 prints tool activity on stderr and leaves stdout
    holding only the model's answer. The adapter collected stderr solely to quote it in an error
    message and parsed stdout alone, so no regex could have recovered a tool call. Both streams are
    now scanned (`toolUseTranscript`), for the end-of-turn pass and for the live mid-turn progress
    blocks. stderr is still kept out of the answer body: `extractFinal` sees stdout only.
  - **The line format changed**, from `Running tool gsd_doctor (from mcp server: gsdworkflow)` to
    `[tool] Running: @gsdworkflow/gsd_doctor` -- server and tool fused, order reversed, and no `⋮`
    parameter block. Both grammars are now accepted: the legacy one is what every recorded
    transcript in `docs/` and `probes/` contains, and users on an older kiro-cli must keep working.
    Arguments degrade to `{}` for the compact form, which the downstream code already tolerated.
    Note that built-in kiro tools are not recoverable from text in the new format at all: they
    render as prose (`[tool] Reading note.txt:1`) with no tool name.

  Found by the live suite, and only by the live suite. All 36 existing `workflow-mcp.test.ts` cases
  were green throughout, against fixture strings kiro had stopped producing, on a stream it had
  stopped using. `docs/design/acp-transport.md` §5b records the consequence for the transport
  roadmap, including that `kiro-cli chat --output-format stream-json` now exists.
- **The test suite no longer leaks a temporary `$HOME` per test file.** Every file runs with `HOME`
  redirected under `$TMPDIR`, so a test cannot read or write the real `~/.pi` and `~/.kiro`; those
  directories were never removed and had accumulated into the hundreds. Cleanup now runs in a vitest
  `globalSetup` teardown: setup creates one run-scoped parent (`pi-kiro-test-homes-*`), every
  per-file home is created inside it, and teardown removes the parent. The two more obvious
  placements both fail silently, and the header of `test/global-setup.ts` records why: an `afterAll`
  in `setupFiles` never runs for a file whose every test is skipped, which is all five live files
  without `PI_KIRO_LIVE=1`, and a `process.once("exit")` handler never runs at all because vitest
  terminates its workers rather than letting them exit.
- **The live command-coverage test no longer re-registers your Kiro device on every run.**
  `/kiro-subagents` coverage seeds a throwaway `$HOME` so its global `off` cannot reach the real
  agents directory. Registering the extension also probes the model list, which spawns a real
  `kiro-cli` that inherits that `$HOME`, and kiro-cli keeps its seat in two stores that both hang
  off `$HOME`: the login keychain's `kirocli:odic:*` items and
  `Library/Application Support/kiro-cli/data.sqlite3`. It therefore saw itself as logged out on
  every run, minted a fresh Identity Center device registration, failed to persist it (a fake
  `$HOME` leaves `/usr/bin/security` no login keychain to open, which is the "Keychain Not Found"
  dialog), and opened a browser to authenticate the new one. Both stores are symlinked into the
  seeded home now; only `.pi/agent/agents` ever needed isolating, never the seat. Every assertion
  passed throughout, so the only evidence was browser windows and a `SecurityAgent` prompt that
  nobody had connected to a test; the cause was found by walking the pid ancestry of the live
  `security` call. A new test reads the device registration's keychain creation date before and
  after and fails if it changed, so a regression is an assertion rather than a popup. Note for
  anyone auditing this: kiro-cli hands that registration, `client_secret` included, to
  `/usr/bin/security` as a command-line argument, where any process on the machine can read it via
  `ps`. That is an upstream defect this package cannot fix.

## 0.2.1 - 2026-09-15

### Added

- **Release path is gated.** `CODEOWNERS` puts the workflows, both manifests, `scripts/` and
  itself under `@randiskull`, and `.github/workflows/publish.yml` cuts releases from a `v*` tag
  via npm trusted publishing (OIDC, no long-lived token in the repo). New constraint tests assert
  the package declares no install-time lifecycle scripts, that `publishConfig` stays pinned to
  npmjs.org, and that `prepublishOnly` stays wired to `npm run verify`.
- A one-time stderr audit line when the `gsd-workflow` MCP server is mounted from a project's
  `.mcp.json` rather than synthesized. That path deliberately does not go through pi's
  project-trust prompt, so the line names the config path and the opt-out
  (`PI_KIRO_WORKFLOW_MCP=off`). Synthesized entries stay silent: nothing project-supplied runs.

### Changed

- The three dev-only script variables now use the `PI_KIRO_*` prefix the rest of the project uses:
  `PIKIRO_PREPUSH_KIRO_AUDIT` -> `PI_KIRO_PREPUSH_KIRO_AUDIT`, `PIKIRO_SCAN_MODEL` ->
  `PI_KIRO_SCAN_MODEL`, `PIKIRO_SCAN_TIMEOUT` -> `PI_KIRO_SCAN_TIMEOUT`. These are read only by
  `scripts/hooks/pre-push` and `scripts/scan-kiro.sh`, never by the published package, so no
  runtime behaviour changes for anyone installing it.
- Package metadata for catalog listings: the `description` now leads with a complete clause that
  survives truncation in the pi.dev package row (the old one cut mid-word at "delegates turns to
  your l"), and `kiro-cli`, `acp`, `delegation` and `subagents` join the keywords.

### Fixed

- `PI_KIRO_SCAN_MODEL` did nothing for any value other than `auto`. `scripts/scan-kiro.sh` built its
  command as a string containing `--model \"$MODEL\"`, and the unquoted expansion that ran it word-splits
  without re-parsing quotes, so kiro-cli received the literal argument `"sonnet"` (quote characters
  included) and never resolved the model. The script is advisory and exits 0 on failure, so it failed
  silently. The command is now built in the positional parameters.
- `importViaPiRegistry` no longer imports a manifest `pi.extensions` entry that resolves outside
  the package's own install directory. A corrupt user-scope `package.json` naming `../../x.ts`
  was resolved and imported; it is now skipped. Defence in depth behind `isBridgeablePackage`,
  which is what actually keeps project-scope packages out.
- `startSession` initializes its `_kiro.dev/commands/available` detach handle to a no-op instead
  of a definite-assignment assertion, so the `finally` cleanup cannot become a TypeError that
  masks the real startup failure.

## 0.2.0 - 2026-08-11

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
- Bumped `@modelcontextprotocol/sdk`, which clears the transitive `hono`
  advisory chain; safe top-level duplicates pinned via `overrides`.
- Dev toolchain: TypeScript 5.9 → 7.0, `@types/node` 22 → 26, Vitest 4.
- CI matrix on Node 22 and 24; `engines.node` is `>=22`.

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

## 0.1.0

Initial state, never tagged or published to npm.

- `kiro` provider for the Pi coding agent, delegating turns to a local
  authenticated `kiro-cli` (seat/credit-billed, official client).
- Loopback MCP bridge exposing the calling Pi session's tools inside the
  delegated run.
