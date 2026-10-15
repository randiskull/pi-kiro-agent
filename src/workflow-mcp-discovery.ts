/**
 * GSD workflow-MCP server discovery for kiro delegation.
 *
 * GSD auto-mode units require the model to call the `gsd_*` workflow tools.
 * For external-CLI providers the CLI owns the agentic loop, so GSD's supported
 * pattern is to mount GSD's own `gsd-workflow` stdio MCP server INSIDE the CLI.
 * Without it every GSD unit on kiro ends with zero tool calls and fails GSD's
 * zero-tool-call guard.
 *
 * discoverWorkflowMcpServers(cwd) resolves that entry and translates it into
 * kiro's agent-profile mcpServers schema: the nearest `.mcp.json` wins, a GSD
 * project without one gets a synthesized entry. kiro's schema has no `cwd`
 * field, so a `cwd` is honored by wrapping in `/bin/sh -c "cd ... && exec ..."`.
 *
 * The sibling output-parsing concern (kiro's tool-use lines -> `ToolCall`
 * blocks) lives in kiro-tooluse-parser.ts.
 *
 * Opt-out: PI_KIRO_WORKFLOW_MCP=off.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

/** Kiro agent-profile MCP server entry (stdio). */
export interface KiroStdioMcpServer {
	command: string;
	args: string[];
	env?: Record<string, string>;
	timeout?: number;
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

/** Returns true only if `dir/.git` exists and is a directory (real repo root); .git files (linked worktrees) return false. */
function isGitDirectory(dir: string): boolean {
	try {
		return lstatSync(join(dir, ".git")).isDirectory();
	} catch {
		return false;
	}
}

/** Walk up from `start` looking for `.mcp.json` (stop at a `.git` boundary or fs root). */
function findMcpConfig(start: string): string | undefined {
	let dir = start;
	for (;;) {
		const candidate = join(dir, ".mcp.json");
		if (existsSync(candidate)) return candidate;
		// A .git dir marks the project root — don't search above it.
		if (isGitDirectory(dir)) return undefined;
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

/**
 * Read the `gsd-workflow` entry out of the nearest `.mcp.json`, if any.
 *
 * TRUST BOUNDARY: a project-supplied `command`/`args`/`env` is handed straight
 * to a kiro-cli run launched `--trust-all-tools`, without passing through pi's
 * project-trust machinery, so a hostile repo's `gsd-workflow` entry executes
 * as-is on the first prompt. The guard for unreviewed repos is
 * PI_KIRO_WORKFLOW_MCP=off; announceFileSourcedEntry names the config path that
 * was mounted. Only the `gsd-workflow` key is consumed.
 */
function readWorkflowMcpEntry(cwd: string): { entry: WorkflowMcpEntry; configPath: string } | undefined {
	const configPath = findMcpConfig(cwd);
	if (!configPath) return undefined;
	let parsed: { mcpServers?: Record<string, WorkflowMcpEntry> };
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
			mcpServers?: Record<string, WorkflowMcpEntry>;
		};
	} catch {
		// Malformed/unreadable .mcp.json: fall back to synthesis rather than throw.
		return undefined;
	}
	const entry = parsed.mcpServers?.[WORKFLOW_MCP_CONFIG_NAME];
	if (!entry || typeof entry.command !== "string" || entry.command.length === 0) return undefined;
	return { entry, configPath };
}

/**
 * Config paths already announced by this process. Discovery runs once per turn,
 * so without this the same line repeats for every turn of a session.
 */
const announcedMcpConfigPaths = new Set<string>();

/**
 * Project dirs already warned about, keyed by the same value findGsdProjectRoot
 * starts its walk from. Discovery runs once per turn, so without this the line
 * repeats every turn.
 */
const announcedMissingProjectDirs = new Set<string>();

/**
 * Audit line for the trust boundary above. Stderr, not stdout, so it never
 * lands in parsed model output. Synthesized entries are not announced: they
 * resolve gsd-pi from this extension's own install, so nothing
 * project-supplied is executed.
 */
function announceFileSourcedEntry(configPath: string): void {
	if (announcedMcpConfigPaths.has(configPath)) return;
	announcedMcpConfigPaths.add(configPath);
	console.error(
		`[pi-kiro] mounting gsd-workflow MCP server from ${configPath}: this runs a project-supplied command inside a --trust-all-tools kiro run (set PI_KIRO_WORKFLOW_MCP=off to disable)`,
	);
}

/** Test hook: forget which config paths and project dirs have been announced. */
export function _resetWorkflowMcpNoticesForTest(): void {
	announcedMcpConfigPaths.clear();
	announcedMissingProjectDirs.clear();
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
		if (isGitDirectory(dir)) return undefined;
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
 * binary, a symlink into the install, so realpath first. Same semantic anchor
 * as GSD's own findGsdPiRepoRoot, rather than a fixed depth.
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
 * loads them from there, so the install-tree copy can be stale. Best-effort --
 * the MCP server has its own fallback, which fails loudly rather than silently.
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
 * Build a `gsd-workflow` entry programmatically for a GSD project with no
 * `.mcp.json`. Without it the delegated kiro turn gets no `gsd_*` tools, so a
 * unit can write files but never call `gsd_task_complete`, leaving the task row
 * `pending`.
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
 * One-time stderr notice when no `gsd_*` tools are mounted because cwd is not a
 * GSD project; the only other symptom is kiro reporting an unknown tool. Silent
 * when a project root exists (an unresolvable GSD install is a different
 * failure) or when no GSD install resolves.
 */
function announceMissingGsdProject(cwd: string, env: NodeJS.ProcessEnv): void {
	if (findGsdProjectRoot(cwd)) return;
	if (!resolveGsdCliPath(env)) return;
	const key = stripWorktreeSuffix(cwd);
	if (announcedMissingProjectDirs.has(key)) return;
	announcedMissingProjectDirs.add(key);
	console.error(
		`[pi-kiro] gsd_* workflow tools are not mounted: no GSD project at ${key} (no .gsd/ directory at or above it, and no gsd-workflow entry in a .mcp.json). GSD has no "init" subcommand: run gsd in this directory, then /gsd start. Set PI_KIRO_WORKFLOW_MCP=off to silence this.`,
	);
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
		const fromFile = readWorkflowMcpEntry(cwd);
		const entry = fromFile?.entry ?? synthesizeWorkflowMcpEntry(cwd, env);
		if (!entry) {
			announceMissingGsdProject(cwd, env);
			return undefined;
		}
		const servers = translateEntry(entry);
		// Announce only once we know a project-supplied command is really mounted.
		if (servers && fromFile) announceFileSourcedEntry(fromFile.configPath);
		return servers;
	} catch {
		// readWorkflowMcpEntry does not throw (a malformed .mcp.json returns
		// undefined and falls through to synthesis above), so reaching here means
		// synthesis or translation threw. Nothing left to retry; never throw.
		return undefined;
	}
}
