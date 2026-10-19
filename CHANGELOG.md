# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- **Implementation specs get a rubric and a linter before anyone builds them.**
  `spec-review/rubric.md` (now Rubric 2) defines five pass/fail gates and six separately scored
  dimensions for a spec in `docs/specs/`, and `scripts/spec-lint.mjs` checks the part a script can:
  structure, defect or feature typing, attribution, and that cited paths, commits, `§` sections and
  npm scripts exist, with near-miss detection for misspelled symbols. An eight-case calibration set
  (`spec-review/calibration/`) measures whether two independent reviewers reach the same gate
  decisions on it, with the two real specs two cases were frozen from committed beside them
  (`spec-review/calibration/originals/`); `test/spec-lint.test.ts` pins the linter against the set,
  and `test/rubric-anchors.test.ts` holds that no rubric anchor quotes a case it has to catch.
  **Rubric 1 has no passing calibration result:** the first reported one was scored against an
  answer key that had been relabelled to match those same runs and is withdrawn, and three later
  runs held out from every pass each missed cases, most recently a pair that agreed with each other
  on 28 of 30 gate decisions and missed four of twelve cases. All five committed runs record
  `countsTowardsShipBar: false` (`spec-review/calibration/runs/SCORE.md`). Rubric 2 fixes the
  three gate-wording defects those misses exposed (G1, G2 and G4), clarifies G5, and has the person
  running a review write the verdict's `Reviewer:` line instead of the model, which cannot see its
  own model id (#67). It also adds the set's first feature-typed case and a mutant of it, so D1's
  feature column has an expectation, and the ship bar now requires both runs to separate the two on
  D1, which the gate decisions do not measure: the pair is labelled pass on all five gates. The c2
  and c7 judgement labels are ratified, with none changed. It has no calibration run yet, and the spec's ship-bar
  criterion says `Open`. The queue, verdict validation and the CI gate are specified and not built.
  Contributor tooling only: nothing under `spec-review/` or `scripts/` is in the published package.
  Design: `docs/specs/spec-review-bus.md`.

### Changed

- **A stream-json turn that is priced more than once now traces it.** Credits come from the last
  `metadata` event carrying a `meteringUsage` array, which rests on kiro emitting the priced
  metadata last (the 2.32 probes show exactly one priced metadata per turn). Nothing in a single
  event distinguishes a late summary from a late per-tool-call partial, so a turn that prices twice
  emits a `chat.stream.metering_repriced` trace with both figures instead of being resolved
  silently: keeping the larger value would hide the protocol change rather than report it.

### Fixed

- **A cited path below a symlink was reported as a broken citation.** `scripts/spec-lint.mjs` asks
  `git check-ignore` whether a cited path is a local, gitignored file, and read any non-zero exit as
  "not ignored". git answers a path below a symlink with a fatal ("beyond a symbolic link"), whose
  exit status is non-zero in exactly the same way, so for a developer who links a working directory
  into the repo (`.gsd` -> a project directory elsewhere) real files were noted `external` rather than
  `local`, and the calibration assertion about the exemplar's investigation note failed on that
  machine while CI, which has no such link, stayed green. The linter now settles that case from the
  filesystem before git is asked, rather than from git's message, which is not stable across git
  versions. A cited path that climbs out of the repository (`../x/y.ts`) is not that case and still
  ends at an `external` note, which is why a fatal is not read as unverifiable instead. A component
  the linter cannot look at (a directory it may not search) is neither answer, so it stops the spec as
  unverifiable (exit 2), naming the path; one that cannot exist (a name too long for the filesystem)
  is absent, so an odd citation still gets its ordinary finding. Contributor tooling only: nothing
  under `scripts/` is in the published package.
  Test: `test/spec-lint-symlink.test.ts`, which builds its own throwaway repository because the
  condition cannot exist in this repository's CI checkout: the classification fails with the check
  reverted, its negative control fails if the check is made unconditional, and the unsearchable and
  too-long cases each fail if their error is read the other way.

- **The calibration scorer ignored the blobs the ship bar is keyed to (#67).** `expected.json`
  `shipBar.blobs` says a run "counts towards the ship bar only when both match the committed
  blobs", and criterion 12 of `docs/specs/spec-review-bus.md` is `score.mjs`'s exit code. The
  scorer read `scoredAgainst.cases` as a list of case names and read `scoredAgainst.rubric`,
  `scoredAgainst.expected` and `countsTowardsShipBar` not at all, so rule 5 was enforced nowhere:
  the `spec-review / calibration` job named as its evidence is specified and unbuilt. Scoring the
  two pass-8 runs, which `runs/SCORE.md` declares WITHDRAWN and which both record
  `countsTowardsShipBar: false` over pre-review blobs, printed `gate agreement: 30/30`,
  `cases with a miss: 0` and exited 0. `score.mjs` now hashes `rubric.md`, `expected.json` and
  every case it was scored against, compares each to the blob the run recorded, requires a blob for
  every case in the key, honours `countsTowardsShipBar`, names a `true` claim over stale blobs as a
  contradiction, and exits 1 unless every run counts. Nothing a `RUN.json` can contain makes it
  throw: malformed JSON, an unreadable file and a case name that is not a bare name (a path, which
  would otherwise be resolved against the wrong file) all come back as a non-counting run, because
  the exit code is what criterion 12 reads. Every committed transcript still reproduces
  line for line; only the exit and one line per run change. Contributor tooling only: nothing under
  `spec-review/` is in the published package. Test: `test/spec-review-score.test.ts` (all ten cases
  fail with the check reverted).

- **Bridge profiles left the bridge token on disk (#63).** A kiro-cli v3-engine start, from pi, the
  IDE or KAS, converts every `~/.kiro/agents/*.json` and saves the original as `<name>.json.bak`
  (then `.bak.1`, ...), and that original holds the tokenized loopback URL. `remove()` deleted only
  `<name>.json`, profiles from turns that crashed before `remove()` were never cleaned up, and
  profiles were created `0644`. `remove()` now deletes the profile's own backups, activation sweeps
  profiles whose pi process is dead (or whose file is older than any turn) and ages each file on its
  own rather than the newest in the directory, so a live pid's current profile is not swept because
  an ancient namesake sits beside it, and profiles are written `0600`, which kiro keeps on the
  backup (`test/kiro-bridge.test.ts`, "removes the backups kiro writes beside the profile, and only
  this profile's" and "ages each file on its own, so a live pid's current profile survives its
  ancient namesake"; `src/kiro-bridge.ts`).
- **A chat turn that reached more than one kill path leaked a SIGKILL timer (#58).** Abort, the turn
  ceiling and a stream-json envelope violation each armed the SIGTERM-to-SIGKILL escalation by
  overwriting the timer handle, and only the latest was cleared at exit, so an earlier one fired a
  `SIGKILL` at a process group that had already exited. One `armKill` helper now clears any prior
  timer before arming (`test/stream-adapter.test.ts`, "escalates a child that ignores SIGTERM to
  SIGKILL after the grace window").
- **The stream-json path kept a second full copy of the turn's stdout (#58).** Nothing read it; the
  text path's `cleanBody(raw)` is unreachable under stream-json and its failure messages use a
  static hint plus stderr (no test: a buffer with no reader has no observable behaviour to assert,
  and a test that reached for the private field would pin the implementation, not the property).

  Both were fixed once in #55, which merged into a branch that had already merged to `main`, so the
  fix never shipped.

## 0.4.0 - 2026-10-17

### Added

- **Credits are first-class: a running TUI status line, a projected dollar figure and a structured
  per-turn record (#56).** Kiro bills in credits and reports no token counts, so the credit figure on
  a turn's final metadata is the only per-turn price that exists. Both transports already parsed it
  and then multiplied it by `PI_KIRO_CREDIT_USD`, which defaulted to `0` -- so pi's cost footer read
  `$0.00` forever and the figure was discarded. New `src/metering.ts` is the one place that
  interprets the payload: it **checks the unit** rather than assuming it (a non-credit entry is
  reported separately and never folded into the total, and an array with no credit entry yields no
  figure rather than `0`, so "unknown" stays distinguishable from "free"), sums the per-model-call
  entries **within** one notification, and keeps the **last** `contextUsagePercentage` of a turn
  rather than the first, which was wrong by four points on a single measured turn.
  `PI_KIRO_CREDIT_USD` now defaults to **0.02**, Kiro's published in-plan ratio
  ([kiro.dev/pricing](https://kiro.dev/pricing/)); an explicit `0` is honoured and hides money
  entirely, and a malformed or negative value falls back to the default instead of writing `NaN`
  into the cost. Every dollar figure is marked `~`, because the rate is a plan ratio and not a bill.
  Probed against kiro-cli 2.32.0 with a hand-rolled ACP client, since the design rested on a guess
  about the payload shape.
- **Opt-in stream-json reader for the chat transport (#47): `PI_KIRO_CHAT_FORMAT=stream-json`.** kiro-cli's
  `--output-format stream-json` emits the turn as versioned ACP events, so the reader gets what the text
  scrape cannot: complete arguments for every tool call (gsd_* rows were `{}` since kiro 2.21's compact
  lines), kiro's built-in tools as `kiro_*` rows, failed calls marked `⚙ <tool> — failed`, and the session
  id directly (no `--list-sessions` diff). The answer still comes from the `<pi_final>` sentinel, because
  `finalText` holds all of the turn's message text, narration included. The envelope is strict: an
  unrecognized `runStarted`, a non-JSON line or a stream with no `runFinished`/`runError` fails the turn
  and says how to fall back to text; unknown events are ignored. Text stays the default. Built on the
  kiro-cli 2.32.0 captures in `probes/stream-json-2.32/`.

### Security

- **Removed the `overrides` block, which had become the reason `npm audit` reported three high
  advisories rather than the fix for one.** `brace-expansion` was pinned to 5.0.9 to clear an
  earlier advisory; three later advisories (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7,
  GHSA-6j4f-fj2g-mc7p) cover 4.0.0 - 5.0.11, and `@earendil-works/pi-coding-agent` 1.2.0 already
  depends on the patched 5.0.12 exactly -- so the pin was dragging a dependency upstream had
  already fixed back into the vulnerable range. A fixed version inside `overrides` is a ceiling,
  not a floor: it silently blocks the upstream patches it was added to anticipate.
  `protobufjs@7.6.5` went with it for the same reason (`@google/genai` asks for `^7.5.4`).
  `npm audit` including dev dependencies is now 0, down from 3 high. Production dependencies were
  never affected -- the published package declares only `@modelcontextprotocol/sdk`, so
  `npm audit --omit=dev`, which is what CI gates on, was already clean. That is why this never
  failed a build.
- **`.audit-allowlist.json` is now empty.** pi-coding-agent 1.2.0 no longer publishes an
  `npm-shrinkwrap.json`, so its subtree resolves normally and the three advisories accepted as
  upstream-frozen (GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-j3f2-48v5-ccww) are gone from
  the tree. Findings there are fixable by a dependency bump now, rather than accepted.
- **A gate so the ceiling cannot come back** (`test/package-constraints.test.ts`). An override has
  to be named in an `ALLOWED_OVERRIDES` list in the test, and the range it names has to be a floor
  (`>=x.y.z`) rather than a pinned version. Two assertions instead of one because the exception path
  is where this kind of gate usually dies: a bare "no overrides" check has no way to admit a
  legitimate override, so the first contributor who needs one deletes the test. The floor predicate
  is itself pinned against a known-bad and a known-good range, since it is vacuous while the
  allowlist is empty. Mutation-tested three ways: an unapproved pin fails, an approved name that is
  still an exact pin fails, an approved name with a floor passes.

### Fixed

- **Every answer was printed twice, on both transports (#56).** The ACP transport pushed each
  `agent_message_chunk` into the thinking feed for a live view and *also* accumulated the text,
  re-emitting the whole answer as one `text_delta` at end of turn; the chat transport's text format
  did the same thing with raw stdout, tags included, and then emitted the `<pi_final>` span again as
  the answer, and its stream-json format did it with message chunks. A line pi has painted can never
  be unpainted, so none of these could be corrected at settle time: each byte now goes to exactly
  one feed as it arrives. `createBlockWriter` holds one thinking block and one text block, each with
  its own `contentIndex`; `createTagStripper` removes `<pi_final>` as the text streams; and
  `createSentinelRouter` splits the chat transport's message text -- text-format stdout or
  stream-json message chunks -- on the sentinel pair: narration until the open tag, answer inside
  the span, narration after. The answer is edge-trimmed as it streams, so a span written as
  `<pi_final>\nanswer\n</pi_final>` is not re-sent whole when it is reconciled against
  `extractFinal`'s trimmed span.
  Both are robust to a tag arriving **split across two chunks** (`<pi_` then `final>`), holding back
  any trailing run that could still become a tag. The router is depth-tracked, so an answer that
  quotes the tags keeps them literally, matching `extractFinal`, which strips only the outermost
  pair; a stray closing tag with nothing open stays in the notes rather than being silently eaten.
  `extractFinal` remains the arbiter of the final answer, so a live route that guessed wrong is
  corrected in the message rather than shipped.
- **The ACP transport dropped kiro's reasoning channel entirely.** It had no case for
  `agent_thought_chunk`, so thinking was invisible on the transport that is now the default. The
  stream-json reader always handled it.
- **Every tool call was drawn twice.** A `toolCall` block pushed onto the message is invisible until
  some event carries a `partial`, so each transport announced one by writing a `⚙ <tool>` line into
  the thinking feed -- and the user then saw that line *and* the row pi renders from the block
  underneath it. `announceToolRow` emits the block's own `toolcall_start`/`toolcall_end` pair
  instead, so the row announces itself; measured with a nine-second tool call, the row appears while
  the call is still running, so the narration bought nothing it was there for. The legacy text path
  keeps its `⚙` marker, whose markers pair with placeholders in `reconcileToolCalls`.
- **The missing-bridge-tools advisory stuck above the prompt for the rest of the session.** It was
  written with `console.error`, and pi paints raw stderr into the chrome above the prompt, where
  nothing clears it. `src/bridge.ts` gained a notice channel that `src/index.ts` points at
  `ctx.ui.notify(message, "warning")` when there is a UI, falling back to stderr headless; the
  oversize-body advisory uses the same channel. Both are also traced, so a transient warning is
  still recoverable after the fact.
- **A retried turn no longer concatenates the abandoned attempt's answer onto the next one's.** The
  chat transport retries a whole turn on a bridge-MCP exit 3 and on a resume failure; whatever the
  first attempt had streamed is now discarded before the second starts, and the sentinel router
  starts over too, so an attempt that died inside its answer span does not route the next
  attempt's narration, tags and credits footer into the answer.
- **A non-GSD project no longer loses its `gsd_*` tools silently** (#39). GSD's workflow MCP server
  is mounted into a delegated kiro run only when the project is a GSD project; without a `.gsd/`
  directory nothing is mounted, so a model told to call `gsd_capture_thought` gets an unknown-tool
  error and nothing anywhere says why. `discoverWorkflowMcpServers` now writes a one-time stderr
  line naming the directory and the remedy. Narrow on purpose, in both directions: it fires only
  when `findGsdProjectRoot` finds nothing, so a real GSD project whose *install* is unresolvable is
  never told it is "not a GSD project", and only when a `gsd` is actually resolvable, so users
  without GSD are never told about tools they were never going to get. Mutation-tested three ways
  (each guard removed turns the suite red).

  No behaviour change: the tool surface and the mount decision are exactly as before. Mounting was
  never the blocker, which is why the issue's other two options were rejected. GSD's server does
  start without `.gsd/` and does list all 66 tools including `gsd_capture_thought`, but the call
  then fails `GSD database is not available`, so mounting unconditionally would swap one opaque
  error for another while adding 66 always-failing tools to every non-GSD turn. Auto-initializing
  is not available either: `gsd` has no `init` subcommand, and `gsd headless init` refuses and tells
  you to run `gsd` interactively, so the message names the interactive remedy (`/gsd start`).
  Also worth recording, since the issue said otherwise: `gsd_capture_thought` **is** a planning
  mutation in gsd 1.22.0 and does require `_meta["io.opengsd/idempotency-key"]`; that error is a
  real ordered gate, not a red herring.

- **Chat transport: a bridged tool call shows its real arguments, on one row.** kiro-cli 2.21+ prints
  tool use in a compact form (`[tool] Running: @pi/todo`) with no arguments, so the live toolCall
  placeholder stayed `{}` for the whole turn and a tool's renderer drew it as e.g. `todo undefined`.
  The end-of-turn pass then added a second row (and a second `⚙` marker) under a new id, because pi
  only refreshes a row whose id it already knows. The bridge now reports each call's arguments as it
  arrives (`HttpBridgeHandle.onToolCall`); they fill the oldest empty placeholder of that name and a
  `toolcall_delta` redraws it, and end-of-turn blocks reuse the live placeholder's id. Placeholder ids
  are random rather than a per-turn counter. Tools on other MCP servers (`gsd_*`) still have no
  arguments on this transport until `stream-json`, but no longer get a duplicate row.

### Changed

- **Breaking: the ACP transport is now the default. `PI_KIRO_TRANSPORT=chat` selects the per-turn
  chat transport as a fallback.** ACP holds one kiro-cli child for the session and speaks a
  protocol, so tool arguments and the credit metadata arrive as structured events and kiro keeps
  its own prefix cache warm across turns; it is also the only transport that passes MCP servers
  inline through `session/new`, which is what makes GSD's workflow tools reach a delegated unit at
  all. The chat transport spawns a child per turn and, below the stream-json floor, recovers the
  answer by scraping prose. An **unrecognized** value now keeps ACP and writes one
  `transport.unknown` trace rather than selecting the fallback: a typo silently downgrading a
  session to the scrape path is the failure this default exists to remove. Whitespace around the
  value is trimmed. If you relied on the old default, set `PI_KIRO_TRANSPORT=chat` explicitly.
- **The identity line names the live transport.** It now reads
  `pi 1.3.0 via Kiro (kiro-cli 2.32.0, engine v2, acp) on auto (selected by kiro)`, and on the
  chat path the route carries the wire format -- `chat/stream-json` or `chat/text` -- because the
  format decides what the harness can see at all. Which transport and format were serving a
  session used to be visible only in a trace file, so a session that had quietly fallen back to
  the text scrape looked like a broken harness rather than a degraded one. Shown in the status
  bar, in `/kiro`, in the trace, and in the `<identity>` block sent to the model. A chat turn
  whose format cannot be resolved reads plain `chat` rather than naming one that will not be
  used, and a malformed `PI_KIRO_CHAT_FORMAT` no longer takes the whole status line down with it
  (it still fails the turn, which is where that belongs).
- **The pi SDK devDependency is raised to `^1.3.0`, and the lockfile with it.** The SDK
  devDependency is the only statement of which host version CI exercises, and the 0.3.0 lockfile
  still pinned 1.2.0 while the shipped host had moved to 1.3.0 -- the same drift that let
  `registerToolRenderer` reach the real host undetected before. Raising it is why this release is a
  minor rather than a patch.
- **The chat transport reads stream-json by default on kiro-cli 2.21.4 or newer (#48).** With
  `PI_KIRO_CHAT_FORMAT` unset, the version readiness found decides, compared numerically per component (so
  2.9.0 is below the floor). Older or unparseable versions keep the text scrape and write one
  `chat.format.fallback` trace per process (`{ kiroVersion, floor }`); there is no user-facing notice. An
  explicit `PI_KIRO_CHAT_FORMAT=stream-json` or `text` is honoured on any version.
- **Breaking: tool names carry their origin (#46).** A tool row in a delegated turn did not say which
  implementation ran: `read` could be kiro's built-in or pi's, `todo` pi's native tool or rpiv's
  through the bridge. Every name pi-kiro shows or exposes is now origin-prefixed.
  - The bridge exposes each tool under a prefix derived from the package that registered it: `rpiv_`
    for `@juicesharp/rpiv-*`, otherwise the unscoped package name minus `pi-`, sanitized
    (`@tintinweb/pi-subagents` -> `subagents_`). kiro calls `@pi/rpiv_todo`; a bare `todo` is an unknown
    tool. The delegated prompt maps the caller's names onto the exposed ones.
  - **`PI_KIRO_BRIDGE_TOOLS` takes prefixed names only.** A bare name matches nothing and is reported
    by the existing missing-tool warning. The defaults:

    | Before | After |
    |---|---|
    | `ask_user_question` | `rpiv_ask_user_question` |
    | `todo` | `rpiv_todo` |
    | `advisor` | `rpiv_advisor` |
    | `Agent` | `subagents_Agent` |
    | `get_subagent_result` | `subagents_get_subagent_result` |
    | `steer_subagent` | `subagents_steer_subagent` |

  - Tool rows and `⚙` markers on both transports name kiro built-ins `kiro_<name>` (`kiro_read`),
    gsd-workflow tools `gsd_<name>`, and tools from any other MCP server `<server>_<name>`. Names kiro and
    GSD own are only renamed for display. A prefixed row renders with pi's generic tool renderer.

- **Comment audit across `src/` and `test/`: housekeeping prose out, functional comments only.**
  Removed code history ("used to", "formerly", "previously duplicated here"), internal task and
  gate ids (`[L0-04]`, `M001`, `G9`, probe-gate references), incident anecdotes, measurement
  dates, and justifications of decisions the code already shows. What a reader needs to not break
  the code stays: behavior, external kiro/GSD constraints with their version, invariants and env
  vars. Comment-only, 625 lines removed against 421 added; no executable line changed except two
  test titles that carried task ids.
- **`docs/` audited on the same rule, where the problem was staleness rather than volume.**
  `docs/design/acp-transport.md` said **Status: DRAFT, not yet scheduled** for a transport that
  has been implemented and running for a month, and section 5e.3 was still titled "Open defect"
  below a body that says "Fix (implemented)" and "Confirmed live". Both corrected; section 4 now
  names section 5c as what superseded it as the roadmap; section 5h was appended after sections 6
  and 7 and is moved back into order. `docs/transport-milestones/M001-...md` is deleted: it was a
  work order for shipped work ("Work on a branch off `main`. Do not push. `main` is at
  `9f8aaf9`"), and its durable content is section 5h. Milestone/slice ids (`M001/S01/T01`) give
  way to the commit that did the work.

## 0.3.0 - 2026-10-15

### Added

- **A documented versioning policy, and gates that enforce the parts a test can reach**
  (`docs/releasing.md`). It writes down what counts as a patch versus a minor for a package whose
  real public surface is slash commands, `kiro/*` model ids and `PI_KIRO_*` variables rather than
  exported symbols, and why raising the pi SDK dev dependency is a minor: the peer range is `*` on
  purpose, so npm's resolver enforces nothing about host compatibility and the dev dependency plus the
  drift tests are the entire mechanism. Enforced in CI: the version is a plain `X.Y.Z` and equals the
  newest released CHANGELOG heading (a bump without a cut fails, and a cut without a bump fails), the
  release headings strictly descend, the newest section is not an empty heading, and the pi peer range
  stays unpinned. Enforced at publish: the tag matches `package.json`, the tagged commit is an
  **ancestor of `main`** (a tag on any branch used to publish unreviewed code, since the tag is the
  only trigger), and the CHANGELOG has a section for the version being released.
- **Verified against pi 1.2.0.** The pi SDK dev dependencies move from 1.0.0 to 1.2.0, so CI exercises
  the extension against the host version users actually run. They had been pinned at 1.0.0 in the
  lockfile while the shipped CLI moved on two minor versions, which meant every gate was green against
  an SDK no one had installed. The caret range already allowed 1.2, so only the lockfile was stale.

- **`kiro/router`, an opt-in virtual model (pi >= 1.0).** Selected with `/model kiro/router`, next to
  `kiro/auto` and never the default. The thinking level picks a tier, anchored on kiro's credit
  multipliers: `low` haiku (0.4x), `medium` sonnet (1.3x), `high` opus (2.0x), `xhigh` fable (6.0x),
  each on the newest kiro model the seat exposes (kiro/auto if it exposes none). Tool follow-ups stay
  on the model that handled the turn, and compaction stays with the transcript's model. When kiro
  fails, the turn falls back to the same tier on Amazon Bedrock (`us.anthropic.*` only), Anthropic,
  or an OpenAI subscription (`openai-codex`; nearest multiplier: luna, terra, terra, sol), the first
  that has credentials, and holds there for a cooldown before kiro is tried again. pi does not retry
  quota or auth errors, so a kiro error left in the transcript also triggers the fallback on the next
  user turn. A retry after a context overflow moves to a larger window (haiku 200K to a 1M sonnet).
  `PI_KIRO_ROUTER=off` skips registration; `PI_KIRO_ROUTER_FALLBACK` (comma list) and
  `PI_KIRO_ROUTER_COOLDOWN_MS` (default 15 min) tune it. Not registered on hosts without
  `registerVirtualModel`, or when a seat has a physical model named `router`. With `PI_KIRO_TRACE`
  set, each fallback start (`router.fallback.start`: trigger, destination, deadline, the kiro error)
  and each cooldown expiry (`router.fallback.end`) is traced.

- **An explicit, larger request-body ceiling for the bridge (32 MiB).** MCP SDK 1.30.1 (#22)
  began reading request bodies with a 4 MiB limit and answering 413 past it, before any bridge code
  runs; verified against `serveBridgeHttp`, a 5 MiB `tools/call` that 1.30.0 delivered is refused by
  1.30.1 and the tool is never entered. That default suits a public endpoint, but the bridge is
  loopback-only and token-gated, and a bridged tool that takes a binary loses a third of the budget
  to base64, so 4 MiB is only ~3 MiB of payload. The transport now gets
  `maxRequestBodySize` explicitly (default 32 MiB, override `PI_KIRO_BRIDGE_MAX_BODY_BYTES`), so an
  SDK default change can no longer move it silently. A refusal used to be invisible on our side; it
  is now traced as `bridge.reject.too-large` every time and warned on stderr once per process,
  naming the variable. The limit covers requests only, not tool results; the SDK's 100-message
  batch cap is separate. Pinned by tests that fail if either the option or the 413 hook is removed.
- **Documented: a bridged tool runs against a second, cold instance of its extension.** Not a code
  change here, but the most consequential thing learned about the bridge, and previously documented
  backwards. `captureBridgeTools` imports each package's entry file to harvest tool definitions, and
  its docstring claimed those definitions close over module state "shared with the live extension
  instances". They do not: pi's loader creates jiti with `moduleCache: false`, so every import
  re-evaluates the entry into a fresh module graph, and no specifier would reach pi's own instance
  (nor does `ExtensionAPI` expose a way to invoke a registered tool by name). Proven by counting
  module evaluations against a `globalThis` counter in one pid: instance 1 receives the `/advisor`
  restore, instance 2 is created at bridge-mount time and answers kiro's call. Two silent victims
  were found and fixed upstream in rpiv: `advisor` always reported "No advisor model is configured"
  to the delegated model while pi's UI showed the model restored, and `todo` wrote to a store pi's
  `/todos` could not see. Both are now anchored on `globalThis[Symbol.for(...)]`, which is already
  the rpiv convention for this hazard. The docstring is corrected and the constraint stated: a
  bridged tool is only correct if it is self-contained or keys its cross-instance state globally.
  The bridge cannot enforce that and cannot detect a violation. Write-up:
  `docs/design/acp-transport.md` section 5f.

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
- **Documented: not redispatching kiro's tool calls and GSD's tool-call ledger are mutually
  exclusive.** The §5d fix strips every surfaced `toolCall` block from the final assistant message
  so pi does not re-run work kiro already did. pi decides what to execute by filtering `toolCall`
  blocks off that message (`agent-loop.ts:228`), and GSD decides whether a unit did any work by
  counting `toolCall` blocks on the same persisted message (`snapshotUnitActivity`). There is one
  message, not two: `streamAssistantResponse` returns the `done` event's `message`, and that object
  is both dispatched and persisted. So the strip that fixes pi zeroes GSD's count, and GSD's zero
  tool-call guard (`auto/unit-phase.ts:858-948`) then retries every unit and pauses auto-mode
  blaming context exhaustion. Nothing inside this package can fix it: pi's `ToolCall` has no way to
  say "already executed by the provider", so any block GSD can count is a block pi will run. Two
  small upstream fixes in pi would resolve it, both using machinery that already exists -- gate
  dispatch on `stopReason` (`"toolUse"` is already in the enum) or honour `endTurn`, whose own
  docstring says it does not currently affect control flow. Until then the definition of done's
  "tool-call counts matching GSD's ledger" is unreachable and is marked as such. Write-up:
  `docs/design/acp-transport.md` §5g.

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

- **The bridge capture shim no-ops `registerToolRenderer` (new in pi 1.2.0).** The shim's must-no-op
  set is an explicit allowlist, so a host mutator added by a newer pi reaches the REAL host until it is
  named: a sibling extension re-run inside a delegated turn could register a tool renderer against the
  calling session. `registerTool` is special-cased by an equality check, which is why a method merely
  starting with `registerTool` was not already covered. Caught by the existing drift test, which
  derives the mutator set from the installed pi's own `ExtensionAPI` type rather than a hardcoded list.
- **ACP turns run the model pi selected.** kiro v2 ignores `model` on `session/prompt` and runs the
  user's kiro default, so with `PI_KIRO_TRANSPORT=acp` every turn ran (and was billed as) that
  default whatever `/model` said, while the identity line named the selected one. Measured on
  kiro-cli 2.26.1: haiku requested, opus-4.8 ran. The transport now sends `session/set_model` before
  the prompt whenever the session's model (from `session/new`'s `models.currentModelId`, then the
  last switch) differs from the request's, and drops the ignored field. A failed switch fails the
  turn instead of running on the wrong model; only `kiro/auto` tolerates a kiro-cli that lacks the
  method (-32601), keeping its old behavior. kiro-cli answers OK to `session/set_model` for ANY id
  (a made-up one included, measured 2026-10-07), so the id is first checked against the session's
  `models.availableModels`: one the session does not offer fails the turn before the switch and the
  prompt. A kiro-cli that lists no models skips the check, and `kiro/auto` is never refused by it.
- **Dependency audit clean again.** Lockfile-only bumps of three transitive dependencies of
  `@modelcontextprotocol/sdk`: proxy-addr 2.0.8 (GHSA-jqcg-44mw-7w3h, critical), fast-uri 3.1.8 and
  ip-address 10.7.3 (moderate). The critical one would have failed the blocking Security audit.
- **A resumed kiro turn keeps answers from other providers.** The delta prompt dropped every assistant
  message as kiro's own, so after kiro, then a turn on Bedrock (a `/model` switch or a router
  fallback), then kiro again, kiro got the second question but not the Bedrock answer to it. An
  assistant message from another provider is now kept in the delta as `<assistant_message>`; kiro's
  own are still skipped. Both transports.
- **pi's system prompt reaches kiro again on pi >= 0.86, including 1.0.** pi 0.86.0 changed what
  custom providers receive to a normalized `TranscriptContext`: there is no `systemPrompt` field, and
  the prompt is a leading `role: "system"` message that later system messages extend or patch by
  section. The provider read only `context.systemPrompt`, and the history serializer drops system
  messages, so every turn went to kiro WITHOUT pi's prompt (AGENTS.md, skills, tool guidance); the
  pi-kiro `<identity>` block is built separately, which is why identity evals still passed. Measured
  live on pi 1.0: the same one-line turn sent 2,593 characters with no `<prior_system_context>`
  block before, and 13,828 with an 11,607-character block after, on both chat and ACP. The prompt is
  now replayed with pi-ai's own `getCurrentSystemPrompt` (looked up on the module namespace so an
  older host without it still loads; there `context.systemPrompt` is used). Three follow-on fixes:
  ACP children are keyed on the LEADING system prompt (the always-empty field had hashed every
  conversation in a cwd to one key, collapsing parent and subagent onto one child again); a resume
  whose delta carries a system message (a mid-conversation prompt or tool update) is sent fresh in
  full, since the delta prompt has no slot for it and the resumed kiro session holds the old prompt;
  and `ToolCall.arguments` is typed as pi's `JsonObject`. Pinned by tests that go through pi's
  `normalizeContext()` instead of hand-built contexts, each mutation-checked.
- **The bridge capture shim no-ops every host mutator pi declares.** Re-running a sibling extension
  to harvest its tools must not touch the real session. pi 0.99/1.0 added `registerMcpServer`,
  `unregisterMcpServer`, `registerVirtualModel` and `unregisterVirtualModel`, and three older ones
  (`registerMarkdownTransformer`, `setLabel`, `setSessionName`) were never in the list, so a sibling
  calling `setSessionName` during capture would have renamed the user's session. The test now derives
  the must-no-op set from the installed pi's `ExtensionAPI` type, so a future addition fails it.

- **The chat transport no longer garbles the answer when the reply holds more than one
  `<pi_final>` tag.** `extractFinal` took the span from the FIRST opening tag to the LAST closing
  tag, so a model that wrote an earlier span, or mentioned the tag in its notes, had those notes and
  their raw tags returned as the answer. #23 proposed taking the LAST opening tag instead; that fixes
  those cases but cuts any answer that quotes both tags (routine when kiro works on this repo) down
  to its tail. The opening tag is now the one that balances the last closing tag, which handles all
  of them; unbalanced tags fall back to the old rule. The one shape still misread is an answer
  quoting a lone opening tag. Supersedes #23.

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

- **The bridge's single-flight guard could hold its slot for the rest of the process.** The guard
  released a held slot only when the waiting call's `AbortSignal` fired. A kiro client that drops a
  bridged request without ever aborting it -- a crash, a closed socket, a client that simply never
  sends the cancellation -- left the slot occupied indefinitely, and every later
  `ask_user_question` on that bridge was rejected as already in flight with no way back short of
  restarting pi. The orphan grace window is now backed by an absolute ceiling
  (`DEFAULT_SINGLE_FLIGHT_CEILING_MS`, 15 minutes), so a slot is always reclaimable, and
  `bridge.orphan.release` records `heldForMs` and which of the two reasons fired.

- **A child-scoped bridge no longer answers with the first session's extension context.** The bridge
  is mounted once per ACP child and reused by every session on it (see the closed-bridge-port
  entry in this section), but its context accessor closed over the `ExtensionContext` of whichever session happened
  to mount it. After a reset, a bridged tool therefore ran against the previous session's context --
  the wrong overlay host, the wrong cancellation scope -- while the port kept working, so nothing
  failed loudly and the symptom was an overlay appearing against a session the user had left.
  `serveBridgeHttp` is now handed a rebindable binding, the handle exposes `rebindOrigin()`, and
  both the reuse and the divergence branch of `resolveSession` call it, so the bridge always
  resolves the session that is current now. Bridge creation is also memoised on a promise, so two
  concurrent `session/new` calls cannot each mount one.

- **The trace file is created with restrictive permissions.** `PI_KIRO_TRACE` writes full prompt
  text and the raw arguments of every bridged tool call, and the file was created with whatever the
  process umask allowed -- world-readable on a default box. It is now created `0600` inside a `0700`
  directory, the module header states plainly that the output is sensitive, and `*.jsonl` is
  gitignored, since `scripts/secret-scan.mjs` only scans tracked files and so would never see a
  trace dropped in the worktree.

- **A bridge that finishes mounting after its child died is no longer adopted by the dead child.**
  Mounting a bridge awaits real I/O (the HTTP server has to listen before it can report a port),
  while child teardown is synchronous -- so an abort, a crash or an idle kill could run teardown
  start-to-finish inside that window, and the resolved handle was then written back onto an entry
  teardown had just cleared. The server itself was already closed (it rides the child's
  `AbortSignal`), which is what made this quiet: the damage was downstream, because the caller
  advertises `bridge.urlWithToken` in `session/new.mcpServers`, so kiro would have been handed a
  port nothing was listening on and every bridged tool call on that session would have failed with
  an opaque `error sending request for url`. The mount now re-checks liveness after the await and
  closes the orphaned handle instead. Two supporting changes: the handle type the ACP child holds
  (`ChildScopedHttpBridgeHandle`) requires `rebindOrigin`, so a refactor that drops it from the
  spread in `index.ts` is a type error rather than a silently skipped optional call that would
  restore the stale-context bug above; and a request issued to a dead child now answers with the
  same terminated-child error `teardownChild` uses instead of never settling -- `sendRaw` drops the
  write when the child is gone, and teardown only settles requests that were *already* pending, so
  a `session/new` landing just after teardown left the turn hung with nothing bounding the await.

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
