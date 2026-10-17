# rpiv

Two independent integrations, useful separately:

1. **Tool bridge** — rpiv's interactive tools become callable *inside* a
   delegated kiro turn.
2. **Subagent routing** — rpiv-pi's bundled specialist subagents run *on* kiro
   as their model.

Requires the rpiv packages from npm. Nothing here is required to use this
extension; absent packages are simply not bridged.

## Tool bridge

Install whichever tools you want reachable from inside a delegated turn:

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:@juicesharp/rpiv-todo
pi install npm:@juicesharp/rpiv-advisor
```

They then appear inside kiro as `@pi/rpiv_ask_user_question`, `@pi/rpiv_todo`
and `@pi/rpiv_advisor`. Every bridged tool is exposed under an origin prefix
taken from the package that registered it (`rpiv_` for the rpiv packages,
`subagents_` for pi-subagents), so a transcript always shows which
implementation ran; the delegated prompt tells kiro that the caller's `todo` is
`@pi/rpiv_todo`. No configuration: the bridge captures whatever bridgeable tools
your Pi session actually has at turn start.

`ask_user_question` is the one worth understanding. A delegated turn runs
`kiro-cli` non-interactively, so the model has no terminal of its own. Bridging
this tool means a delegated turn can still ask *you* a question through Pi's UI
and block on the answer, instead of guessing and continuing.

The bridgeable set is a fixed allowlist (`bridge.ts`, `BRIDGE_SOURCES`): the
three rpiv packages above plus `@tintinweb/pi-subagents`. Project-scope packages
are never trusted as bridge sources, so a cloned repo cannot inject a tool.
Override which of the captured tools are exposed with `PI_KIRO_BRIDGE_TOOLS`
(prefixed names, e.g. `rpiv_todo,subagents_Agent`; a bare `todo` matches
nothing and is reported as missing), or
disable the bridge with `PI_KIRO_BRIDGE=off`.

## Subagent routing

```bash
pi install npm:@juicesharp/rpiv-pi
```

```
/kiro-subagents on
```

That rewrites the `model:` frontmatter in every `~/.pi/agent/agents/*.md` to
`kiro/auto`, so rpiv's specialist subagents dispatch onto kiro instead of an API
provider. `kiro/auto` is the default because it is the one model id every seat
exposes; pass an explicit id to override, and a comma-separated list to limit
which agents are touched:

```
/kiro-subagents on kiro/auto planner,reviewer
```

Reverse it with:

```
/kiro-subagents off
```

`off` takes the same optional name list, so you can unroute one agent and leave
the rest on kiro:

```
/kiro-subagents off planner
```

`off` is conservative by design: it acts on the `model:` line only when that line
points at `kiro/`. An agent you routed to some other provider by hand is left
alone, so running `off` never silently reassigns work you did not route here.

Round-tripping is lossless. When `on` displaces an existing non-kiro model it
records the old value in a `pi-kiro-prev-model:` field beside the new one, and
`off` puts that value back and drops the stash. Cycling through several kiro
models does not overwrite the stash, so `off` always returns to the value you
started from. Only when there was no `model:` line at all does `off` remove the
line, which is what restores that agent to its own default.

The command writes to your home directory, not the project. Agents already set to
the requested model, and files with no YAML frontmatter, are reported as skipped
rather than rewritten.

## Nesting

Both integrations together give cross-runtime nesting: a kiro-delegated turn can
dispatch subagents that run on *other* providers, because the `Agent` tool it
calls over the bridge is executed by your Pi session, not by kiro. The kiro turn
is the orchestrator; where each subagent's model lives is Pi's decision.
