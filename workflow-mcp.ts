/**
 * GSD workflow-MCP transport for kiro delegation.
 *
 * GSD auto-mode units (plan-slice, execute-task, complete-slice, run-uat…)
 * require the model to call the `gsd_*` workflow tools. For API providers pi
 * sends tool schemas with the request; for external-CLI providers the CLI owns
 * the agentic loop, so GSD's supported pattern (see claude-code-cli /
 * google-cli in @opengsd/gsd-pi) is to mount GSD's own `gsd-workflow` stdio
 * MCP server INSIDE the CLI, giving the CLI-side model the real tools.
 *
 * Without this, every GSD unit on kiro ends with zero tool calls: the model
 * has no gsd_* tools in any form, writes a prose plan instead, and GSD's
 * zero-tool-call guard fails the unit (historically mislabeled "context
 * exhaustion").
 *
 * Three pieces, all pure and independently testable:
 *  - discoverWorkflowMcpServers(cwd): resolve the `gsd-workflow` stdio entry
 *    and translate it into kiro's agent-profile mcpServers schema. The
 *    project's `.mcp.json` (written/maintained by GSD's own mcp-project-config
 *    machinery) wins; a GSD project without one gets a synthesized entry so
 *    zero-config projects still get real `gsd_*` tools. kiro has no `cwd`
 *    field, so a `cwd` is honored by wrapping in `/bin/sh -c "cd … && exec …"`.
 *  - parseKiroToolUses(body): extract MCP tool invocations from kiro's
 *    non-interactive output ("Running tool X with the param (from mcp
 *    server: Y)" followed by ⋮-prefixed JSON param lines).
 *  - synthesizeToolCallBlocks(body): map those uses onto pi `ToolCall`
 *    content blocks. Surfaced on the final AssistantMessage (with
 *    stopReason "stop", so the host renders/counts but never redispatches —
 *    the claude-code-cli pattern), which is exactly what GSD's
 *    snapshotUnitActivity counts for the zero-tool-call guard.
 *
 * Opt-out: PI_KIRO_WORKFLOW_MCP=off.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import type { ToolCall } from "@earendil-works/pi-ai";

/** Kiro agent-profile MCP server entry (stdio). */
export interface KiroStdioMcpServer {
	command: string;
	args: string[];
	env?: Record<string, string>;
	timeout?: number;
}

/** One MCP tool invocation parsed from kiro's non-interactive output. */
export interface KiroToolUse {
	name: string;
	server: string;
	arguments: Record<string, unknown>;
}

/** Profile key for the workflow server — matches [a-z]+ to sidestep any
 * server-name charset quirks in kiro's agent schema. */
export const WORKFLOW_MCP_SERVER_KEY = "gsdworkflow";

/** The `.mcp.json` server name GSD maintains for its workflow MCP server. */
export const WORKFLOW_MCP_CONFIG_NAME = "gsd-workflow";

export function workflowMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_KIRO_WORKFLOW_MCP !== "off";
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Walk up from `start` looking for `.mcp.json` (stop at a `.git` boundary or fs root). */
function findMcpConfig(start: string): string | undefined {
	let dir = start;
	for (;;) {
		const candidate = join(dir, ".mcp.json");
		if (existsSync(candidate)) return candidate;
		// A .git dir marks the project root — don't search above it.
		if (existsSync(join(dir, ".git"))) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** A `gsd-workflow` stdio entry — read from `.mcp.json` or synthesized. */
export interface WorkflowMcpEntry {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

/** Read the `gsd-workflow` entry out of the nearest `.mcp.json`, if any. */
function readWorkflowMcpEntry(cwd: string): WorkflowMcpEntry | undefined {
	const configPath = findMcpConfig(cwd);
	if (!configPath) return undefined;
	const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
		mcpServers?: Record<string, WorkflowMcpEntry>;
	};
	const entry = parsed.mcpServers?.[WORKFLOW_MCP_CONFIG_NAME];
	if (!entry || typeof entry.command !== "string" || entry.command.length === 0) return undefined;
	return entry;
}

/**
 * Translate one stdio entry into kiro's agent-profile mcpServers schema. Single
 * code path for both sources (file and synthesized) so they cannot diverge.
 * kiro's schema has no `cwd` field, so a `cwd` is honored by wrapping the
 * command in `/bin/sh -c "cd … && exec …"`.
 */
function translateEntry(entry: WorkflowMcpEntry): Record<string, KiroStdioMcpServer> | undefined {
	if (typeof entry.command !== "string" || entry.command.length === 0) return undefined;
	const args = Array.isArray(entry.args) ? entry.args : [];
	const server: KiroStdioMcpServer = entry.cwd
		? {
				command: "/bin/sh",
				args: ["-c", `cd ${shellQuote(entry.cwd)} && exec ${[entry.command, ...args].map(shellQuote).join(" ")}`],
			}
		: { command: entry.command, args };
	if (entry.env && Object.keys(entry.env).length > 0) server.env = entry.env;
	server.timeout = 30_000;
	return { [WORKFLOW_MCP_SERVER_KEY]: server };
}

/** Path of the workflow MCP server entrypoint inside a gsd-pi install/checkout. */
const MCP_SERVER_RELATIVE_PATH = join("packages", "mcp-server", "dist", "cli.js");

/** A GSD milestone worktree lives under `<projectRoot>/.gsd/worktrees/…`; the
 * workflow server must still start at the real project root (that is where the
 * DB and artifacts live). Mirrors GSD's own resolveWorkflowMcpProjectRoot. */
function stripWorktreeSuffix(cwd: string): string {
	const resolved = resolve(cwd);
	const marker = `${sep}.gsd${sep}worktrees${sep}`;
	const index = resolved.indexOf(marker);
	return index > 0 ? resolved.slice(0, index) : resolved;
}

/** Walk up from `start` looking for a `.gsd/` project marker (same walk and
 * `.git` boundary rules as findMcpConfig). */
function findGsdProjectRoot(start: string): string | undefined {
	let dir = stripWorktreeSuffix(start);
	for (;;) {
		if (existsSync(join(dir, ".gsd"))) return dir;
		if (existsSync(join(dir, ".git"))) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Resolve an executable by scanning PATH. Pure — no subprocess, unlike GSD's
 * own `which` shell-out, which we deliberately avoid on a hot turn path. */
function lookupOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, command);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** The `gsd` CLI: GSD's own env anchors first, then PATH. */
function resolveGsdCliPath(env: NodeJS.ProcessEnv): string | undefined {
	const explicit = env.GSD_CLI_PATH?.trim() || env.GSD_BIN_PATH?.trim();
	if (explicit && existsSync(explicit)) return explicit;
	return lookupOnPath("gsd", env);
}

/**
 * Find the gsd-pi install (or dev checkout) root by walking up from `anchor`
 * looking for `packages/mcp-server/dist/cli.js`. `anchor` is normally the `gsd`
 * binary, which is a symlink into the install, so realpath first — this is the
 * same semantic anchor GSD's findGsdPiRepoRoot uses, rather than a fixed depth
 * that would silently break on a layout change.
 */
function findGsdInstallRoot(anchor: string): string | undefined {
	let dir: string;
	try {
		dir = realpathSync(resolve(anchor));
	} catch {
		dir = resolve(anchor);
	}
	for (;;) {
		if (existsSync(join(dir, MCP_SERVER_RELATIVE_PATH))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** GSD's agent dir: `$GSD_CODING_AGENT_DIR`, else `$GSD_HOME`/agent, else `~/.gsd/agent`. */
function resolveGsdAgentDir(env: NodeJS.ProcessEnv): string {
	const explicit = env.GSD_CODING_AGENT_DIR?.trim();
	if (explicit) return explicit;
	return join(env.GSD_HOME?.trim() || join(homedir(), ".gsd"), "agent");
}

/**
 * Resolve one gsd extension module (workflow executors / write gate). The LIVE
 * copy under the agent dir wins: GSD copies its extensions there at install and
 * loads them from there, so the install-tree copy can be stale. Best-effort by
 * design — GSD's own buildWorkflowLaunchEnv also spreads these conditionally,
 * and the MCP server has its own resolution fallback that fails loudly rather
 * than silently, which beats mounting no server at all.
 */
function resolveGsdExtensionModule(
	env: NodeJS.ProcessEnv,
	explicit: string | undefined,
	installRoot: string | undefined,
	relative: string[],
): string | undefined {
	const fromEnv = explicit?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const candidates = [
		join(resolveGsdAgentDir(env), "extensions", "gsd", ...relative),
		...(installRoot ? [join(installRoot, "dist", "resources", "extensions", "gsd", ...relative)] : []),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** The node that will run the MCP server: prefer the node already running pi. */
function resolveNodeBinary(env: NodeJS.ProcessEnv): string | undefined {
	const execPath = process.execPath;
	if (execPath && basename(execPath).startsWith("node")) return execPath;
	return lookupOnPath("node", env);
}

/**
 * Build a `gsd-workflow` entry programmatically for a GSD project that has no
 * `.mcp.json` (never touched by GSD's mcp-project-config machinery, or started
 * on the kiro provider). Without this the delegated kiro turn gets no `gsd_*`
 * tools at all, so a GSD unit can write files but can never call
 * `gsd_task_complete` — the task row stays `pending` and the operator has to
 * reconcile the DB by hand.
 *
 * Every unresolved path bails (returns undefined): a wrong synthesized server
 * is worse than none, and a plain non-GSD kiro turn must never be blocked.
 */
export function synthesizeWorkflowMcpEntry(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): WorkflowMcpEntry | undefined {
	const projectRoot = findGsdProjectRoot(cwd);
	if (!projectRoot) return undefined;

	// A GSD dev checkout ships the server in-tree; otherwise resolve the install
	// from the `gsd` binary. Checked at the project root only (no walk up) —
	// mirrors GSD's own detectWorkflowMcpLaunchConfig.
	const gsdCliPath = resolveGsdCliPath(env);
	const installRoot = existsSync(join(projectRoot, MCP_SERVER_RELATIVE_PATH))
		? projectRoot
		: gsdCliPath
			? findGsdInstallRoot(gsdCliPath)
			: undefined;
	if (!installRoot) return undefined;

	const nodeBinary = resolveNodeBinary(env);
	if (!nodeBinary) return undefined;

	const executorsModule = resolveGsdExtensionModule(env, env.GSD_WORKFLOW_EXECUTORS_MODULE, installRoot, [
		"tools",
		"workflow-tool-executors.js",
	]);
	const writeGateModule = resolveGsdExtensionModule(env, env.GSD_WORKFLOW_WRITE_GATE_MODULE, installRoot, [
		"bootstrap",
		"write-gate.js",
	]);

	return {
		command: nodeBinary,
		args: [join(installRoot, MCP_SERVER_RELATIVE_PATH)],
		cwd: projectRoot,
		env: {
			...(gsdCliPath ? { GSD_CLI_PATH: gsdCliPath, GSD_BIN_PATH: gsdCliPath } : {}),
			...(executorsModule ? { GSD_WORKFLOW_EXECUTORS_MODULE: executorsModule } : {}),
			...(writeGateModule ? { GSD_WORKFLOW_WRITE_GATE_MODULE: writeGateModule } : {}),
			GSD_PERSIST_WRITE_GATE_STATE: "1",
			GSD_WORKFLOW_PROJECT_ROOT: projectRoot,
		},
	};
}

/**
 * Discover the project's `gsd-workflow` MCP server and translate it for a kiro
 * agent profile. An explicit `.mcp.json` entry always wins; a GSD project
 * without one gets a synthesized entry (see synthesizeWorkflowMcpEntry).
 * Returns undefined when disabled or unresolvable — a plain non-GSD kiro turn
 * must never be blocked by discovery.
 */
export function discoverWorkflowMcpServers(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, KiroStdioMcpServer> | undefined {
	if (!workflowMcpEnabled(env)) return undefined;
	try {
		const entry = readWorkflowMcpEntry(cwd) ?? synthesizeWorkflowMcpEntry(cwd, env);
		if (!entry) return undefined;
		return translateEntry(entry);
	} catch {
		// A malformed .mcp.json still gets the synthesis path — but never throw.
		try {
			const synthesized = synthesizeWorkflowMcpEntry(cwd, env);
			return synthesized ? translateEntry(synthesized) : undefined;
		} catch {
			return undefined;
		}
	}
}

// "Running tool gsd_plan_slice with the param (from mcp server: gsdworkflow)"
// "Running tool fs_read (from mcp server: pi)"           ← no-param variant
const TOOL_USE_LINE = /^\s*Running tool (\S+)(?: with the param)? \(from mcp server: ([^)]+)\)\s*$/;
// Param continuation lines: " ⋮  { …json… }"
const PARAM_LINE = /^\s*⋮\s?(.*)$/;

/**
 * Parse MCP tool invocations out of kiro's cleaned non-interactive output.
 * Param JSON is best-effort: an unparseable block degrades to {} rather than
 * dropping the invocation (the count is what the host needs most).
 */
export function parseKiroToolUses(body: string): KiroToolUse[] {
	const uses: KiroToolUse[] = [];
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]?.match(TOOL_USE_LINE);
		if (!match) continue;
		const paramPieces: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const param = lines[j]?.match(PARAM_LINE);
			if (!param) break;
			paramPieces.push(param[1] ?? "");
		}
		i = j - 1;
		let args: Record<string, unknown> = {};
		if (paramPieces.length > 0) {
			try {
				const parsed: unknown = JSON.parse(paramPieces.join("\n"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					args = parsed as Record<string, unknown>;
				}
			} catch {
				// keep {} — the invocation still counts
			}
		}
		uses.push({ name: match[1] ?? "", server: match[2] ?? "", arguments: args });
	}
	return uses;
}


/**
 * Incremental tool-use detector for LIVE progress feedback: feed raw
 * (ANSI-stripped) stdout chunks as they stream and get back tool-use starts
 * the moment kiro prints them — so the host can surface "⚙ gsd_plan_slice"
 * mid-turn instead of a bare spinner. Arguments are NOT parsed here (the ⋮
 * param block may still be streaming); the end-of-turn
 * `synthesizeToolCallBlocks` pass remains the authoritative reconciliation
 * and replaces live placeholder blocks with fully-parsed ones.
 */
export function createToolUseStreamParser(): { feed(text: string): Array<Pick<KiroToolUse, "name" | "server">> } {
	let pending = "";
	return {
		feed(text: string) {
			pending += text;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			const uses: Array<Pick<KiroToolUse, "name" | "server">> = [];
			for (const line of lines) {
				const match = line.match(TOOL_USE_LINE);
				if (match) uses.push({ name: match[1] ?? "", server: match[2] ?? "" });
			}
			return uses;
		},
	};
}

/**
 * Map parsed tool uses onto pi ToolCall content blocks for the final
 * AssistantMessage. Emitted alongside stopReason "stop": the host counts and
 * renders them (GSD's zero-tool-call guard reads exactly these blocks) but
 * never redispatches — execution already happened inside kiro via MCP.
 *
 * The id must be GLOBALLY unique, not merely unique within one response.
 * GSD derives a workflow idempotency key from it
 * (`pi:gsd_task_complete:<id>`) and rejects a completion whose key already
 * belongs to another canonical operation. A bare positional `kiro-mcp-<index>`
 * restarts at 0 on every response, so the low ordinals are consumed almost
 * immediately and every later `gsd_task_complete` throws
 * "Task completion idempotency identity belongs to a different canonical
 * operation" — the task's work succeeds but can never be recorded. The
 * claude-code provider avoids this by emitting random `tooluse_*` ids.
 *
 * The digest of the response body is mixed in so ids stay REPLAY-STABLE:
 * parsing the same body twice yields the same ids (so a genuine replay is
 * still recognized as one), while different bodies — and therefore different
 * sessions — never collide.
 */
export function synthesizeToolCallBlocks(body: string): ToolCall[] {
	const bodyDigest = createHash("sha256").update(body).digest("hex").slice(0, 16);
	return parseKiroToolUses(body).map((use, index) => ({
		type: "toolCall",
		id: `kiro-mcp-${bodyDigest}-${index}-${use.name}`,
		name: use.name,
		arguments: use.arguments,
	}));
}
