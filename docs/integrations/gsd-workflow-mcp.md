# GSD workflow-MCP server

Reference for the `gsd-workflow` mount. The README covers why it exists and the
security posture of file-sourced discovery; this page is the precedence spec and
the transport requirement.

Requires [`@opengsd/gsd-pi`](https://github.com/open-gsd/gsd-pi).

## Worked setup

Run GSD on kiro with the ACP transport. The `chat` default does not round-trip
tool-call arguments well enough (see [Transport](#transport-matters) below):

```bash
export PI_KIRO_TRANSPORT=acp
cd my-gsd-project          # a directory with .gsd/ at or above it
pi
```

```
/model kiro/auto
```

That is the whole configuration. Discovery is zero-config: nothing else needs
setting, and no `.mcp.json` is required. To confirm the mount fired, look for
`gsd_*` tools inside the delegated run, or for the stderr audit line that names
the config path when rule 1 below is what matched.

To pin the server explicitly instead, `/gsd mcp init .` writes a `gsd-workflow`
entry into the project's `.mcp.json`, which always wins. Read the security
section in the README before doing that in a repo you did not write.

## Discovery precedence

1. A `gsd-workflow` entry in the project's `.mcp.json` (what `/gsd mcp init .`
   writes) always wins.
2. Otherwise, if the cwd is inside a GSD project (a `.gsd/` directory at or
   above it, stopping at the `.git` boundary), the entry is **synthesized**: the
   `gsd` CLI is resolved from `GSD_CLI_PATH`/`GSD_BIN_PATH` or `PATH`, the
   workflow server from `packages/mcp-server/dist/cli.js` in that install (or
   in-tree for a GSD checkout), and GSD's live extension modules from
   `$GSD_CODING_AGENT_DIR` / `$GSD_HOME/agent` / `~/.gsd/agent`.

Every unresolved path bails out to *no server* rather than a wrong one, so a
plain non-GSD kiro turn is never blocked by discovery. A cwd inside a
`.gsd/worktrees/` milestone worktree resolves to the real project root.

Because kiro's agent-profile MCP schema has no `cwd` field, an entry that
carries a `cwd` is launched via `/bin/sh -c "cd … && exec …"`.

Set `PI_KIRO_WORKFLOW_MCP=off` to disable the mount entirely.

## Transport matters

Only `PI_KIRO_TRANSPORT=acp` passes MCP servers inline through `session/new` and
returns real, fully-parsed tool-call arguments.

The default `chat` transport has to text-parse kiro's console output, which
fabricates tool-call ids (`kiro-mcp-<n>-<name>`) and best-effort parses arguments
from CLI log output, with unparseable blocks degrading to `{}`. That is enough to
satisfy GSD's zero-tool-call guard and not enough to round-trip a real
`gsd_task_complete` payload.

The failure mode is quiet, which is the reason for the emphasis: a unit under the
`chat` transport can write files and still never land a completion, so the task
row stays `pending`, the runtime unit stays `dispatched`, and the operator has to
reconcile GSD's database by hand.
