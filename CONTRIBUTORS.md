# Contributors

72 commits, 2026-07-14 to 2026-09-15.

## Maintainer

**Randy James** ([@randiskull](https://github.com/randiskull)) — author, and
reviewer of record for every change that reached `main`.

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
```

Node 22 or newer. Open an issue before starting anything that changes the
provider contract, the transport protocol, or the trust boundary around the MCP
bridge, so the design discussion happens before the code.

Paths under `CODEOWNERS` (workflows, both manifests, `scripts/`) gate a release
and need the maintainer's review specifically. Everything else needs one
approval. Please do not add install-time lifecycle scripts: a constraint test
asserts the package has none, and that test is deliberate.

To be listed here, land a commit. The list is generated from `git log`, not
curated.
