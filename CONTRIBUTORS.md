# Contributors

72 commits, 2026-07-14 to 2026-09-15.

## Maintainer

**Randy James** — author, and reviewer of record for every change that reached
`main`. Commits appear under two GitHub accounts,
[@randiskull](https://github.com/randiskull) and
[@rndjams](https://github.com/rndjams); both are the same person.

## Automated contributors

This extension exists to delegate work to a coding agent, so it would be odd to
hide that agents did some of the work on it. The git history credits them
directly rather than laundering their commits through a human author.

- **Kiro Agent** — 12 commits authored, 10 more co-authored. Kiro reviewed pull
  requests through `.kiro/agents/code-reviewer.json` and ran the scheduled
  security and dependency automations in `.kiro/automations/`.
- **Dependabot** — 11 dependency-update commits, configured in
  `.github/dependabot.yml`.

Attribution is not a transfer of accountability. Every agent-authored commit
passed the same gates as a human's: `tsc --noEmit`, the full test suite on Node
22 and 24, the full-tree secret scan, a blocking `npm audit`, and the
`CODEOWNERS` review requirement on the publish path. The maintainer is
answerable for all of it, including the parts an agent wrote.

## Built on

- [Pi coding agent](https://github.com/earendil-works/pi) — the host this
  extension registers a provider with.
- [Kiro CLI](https://kiro.dev/docs/cli/) — the local, authenticated client every
  delegated turn runs through.
- [Agent Client Protocol](https://agentclientprotocol.com/) — the JSON-RPC
  protocol behind `PI_KIRO_TRANSPORT=acp`.
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
  — the loopback tool bridge and the `gsd-workflow` mount.

## Contributing

Pull requests are welcome. The short version:

```bash
npm ci
npm run verify     # tsc --noEmit, vitest, secret scan
npm run scan       # the above plus npm audit --omit=dev
npm run test:e2e   # packs the tarball and loads it in a real pi host
```

`npm run verify` is offline and needs no Kiro seat, including the end-to-end
load test. The live suite does need one, and is skipped everywhere -- CI
included -- until you ask for it:

```bash
PI_KIRO_LIVE=1 npm run test:live
```

That spawns your authenticated kiro-cli against the real thing:

| File | Covers | Model turns |
| --- | --- | --- |
| `command-coverage-live.test.ts` | `/kiro` and `/kiro-subagents` through the registered handlers, against a real readiness and model-list probe | 0 |
| `acp-transport-live.test.ts` | the ACP transport: one persistent child, one reused ACP session across turns | 2 |
| `bridge-live.test.ts` | the MCP bridge: your installed rpiv/pi-subagents packages found through pi's registry, authenticated loopback MCP listed and called by a real MCP client, and a delegated turn calling a bridged tool back into the process | 1 |
| `workflow-mcp-live.test.ts` | GSD's workflow MCP: `.mcp.json` discovery, a real `gsd-workflow` server, and its calls recovered as pi `ToolCall` blocks | 1 |
| `stream-adapter-live.test.ts` | the default chat transport: session resume across turns | 2 |

Six real turns, billed to your seat, with real session history written under your
home directory. Two of them assert that the model *chose* to call a tool, so an
occasional flake there is model behaviour, not a broken bridge; the plumbing
assertions in the same files are deterministic and should never flake.

Run the live suite before a release. It is the only thing that checks a delegated
turn completes at all, and until it existed the ACP transport -- the one GSD
requires, because only it passes MCP servers through -- was covered exclusively
by a `spawn` mock.

The bridge and workflow tests need `@juicesharp/rpiv-*`, `@tintinweb/pi-subagents`
and `@opengsd/gsd-pi` installed; they skip themselves when those are absent.

One asymmetry in `bridge-live.test.ts` is worth knowing before you "fix" it.
`captureBridgeTools` imports each sibling's TypeScript entry, and those entries
import `@earendil-works/pi-tui` and friends as bare specifiers resolved against
the *ambient* host's module tree. Inside a running pi process that tree is there;
under vitest it is not, so capture degrades to `[]` -- which is the shipped
contract ("sibling failed to initialize -- bridge without it"). The test asserts
that degradation rather than asserting tools appear, and drives the round trip
with a synthetic `CapturedTool` instead. `serveBridgeHttp` does not care where a
tool came from, so this is stronger proof, not weaker: it exercises the whole
mount-invoke-return path without a fake host in it.
`--pool=forks` is not optional (one test changes the working directory) and
neither is `--no-file-parallelism` (concurrent kiro children collide).

The live suite runs against your REAL `$HOME`, unlike every other test here: a
kiro-cli child resolves its own helper binary under it, and the bridge imports
the packages pi installed there. `/kiro-subagents` is the exception and is
pinned to a throwaway home on purpose -- its `off` is global and deletes the
`model:` frontmatter line rather than restoring what preceded it, so running it
against a real `~/.pi/agent/agents` strips kiro routing from every agent at once
with nothing to revert to. One test asserts your real agents directory came out
unmodified.

That throwaway home has the kiro-cli credential stores symlinked into it
(`Library/Keychains` and `Library/Application Support/kiro-cli`). Leave them
there. Without them, a real kiro-cli spawned under that home sees no seat,
registers a new device with Identity Center, and opens a browser mid-test, while
every assertion still passes. One test compares the device registration's
keychain creation date across the run so that cannot go quiet again. The
teardown's `rmSync` unlinks symlinks rather than deleting through them, so your
real stores are not at risk.

Every other test runs with `HOME` redirected into a throwaway directory under
`$TMPDIR`, which is what keeps a test from reading or writing your real `~/.pi`
and `~/.kiro`. Those directories are removed by the `globalSetup` teardown in
`test/global-setup.ts`: setup makes one run-scoped parent and each file's home
goes inside it. Do not move that cleanup into an `afterAll` or a
`process.on("exit")` handler. Neither one fires here, for two different reasons
that the header of that file spells out, and both failures are silent.

Node 22 or newer. Open an issue before starting anything that changes the
provider contract, the transport protocol, or the trust boundary around the MCP
bridge, so the design discussion happens before the code.

Paths under `CODEOWNERS` (workflows, both manifests, `scripts/`) gate a release
and need the maintainer's review specifically. Everything else needs one
approval. Please do not add install-time lifecycle scripts: a constraint test
asserts the package has none, and that test is deliberate.

To be listed here, land a commit. The list is generated from `git log`, not
curated.
