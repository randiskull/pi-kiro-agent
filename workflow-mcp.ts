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
 *  - discoverWorkflowMcpServers(cwd): read the project's `.mcp.json`
 *    (written/maintained by GSD's own mcp-project-config machinery) and
 *    translate the `gsd-workflow` stdio entry into kiro's agent-profile
 *    mcpServers schema. kiro has no `cwd` field, so a `cwd` is honored by
 *    wrapping in `/bin/sh -c "cd … && exec …"`.
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function workflowMcpEnabled(): boolean {
	return process.env.PI_KIRO_WORKFLOW_MCP !== "off";
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

/**
 * Discover the project's `gsd-workflow` MCP server and translate it for a
 * kiro agent profile. Returns undefined when disabled, absent, or malformed —
 * a plain non-GSD kiro turn must never be blocked by discovery.
 */
export function discoverWorkflowMcpServers(cwd: string): Record<string, KiroStdioMcpServer> | undefined {
	if (!workflowMcpEnabled()) return undefined;
	try {
		const configPath = findMcpConfig(cwd);
		if (!configPath) return undefined;
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
			mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string }>;
		};
		const entry = parsed.mcpServers?.[WORKFLOW_MCP_CONFIG_NAME];
		if (!entry || typeof entry.command !== "string" || entry.command.length === 0) return undefined;
		const args = Array.isArray(entry.args) ? entry.args : [];
		const server: KiroStdioMcpServer = entry.cwd
			? {
					// kiro's mcp schema has no cwd — wrap so the server starts in its
					// project root (GSD's server resolves the DB/artifacts from there).
					command: "/bin/sh",
					args: ["-c", `cd ${shellQuote(entry.cwd)} && exec ${[entry.command, ...args].map(shellQuote).join(" ")}`],
				}
			: { command: entry.command, args };
		if (entry.env && Object.keys(entry.env).length > 0) server.env = entry.env;
		server.timeout = 30_000;
		return { [WORKFLOW_MCP_SERVER_KEY]: server };
	} catch {
		return undefined;
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
 */
export function synthesizeToolCallBlocks(body: string): ToolCall[] {
	return parseKiroToolUses(body).map((use, index) => ({
		type: "toolCall",
		id: `kiro-mcp-${index}-${use.name}`,
		name: use.name,
		arguments: use.arguments,
	}));
}
