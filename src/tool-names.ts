/**
 * Origin-prefixed tool names.
 *
 * A tool row in a delegated turn must say which implementation ran: kiro's
 * built-in `read` and pi's `read` are different tools, and so are pi's native
 * `todo` and rpiv's `todo` reached through the bridge. Two rules live here so
 * every transport names tools the same way:
 *
 * - bridgedToolName: the name the BRIDGE exposes to kiro, prefixed by the
 *   package that registered the tool (rpiv_todo, subagents_Agent).
 * - displayToolName: the name pi-kiro DRAWS for any tool kiro ran, prefixed by
 *   its origin (kiro_read, gsd_doctor). Bridged tools arrive already prefixed.
 */

import { WORKFLOW_MCP_SERVER_KEY } from "./workflow-mcp-discovery.js";

/** MCP server key the bridge is mounted under in kiro (agent profile / ACP session). */
export const BRIDGE_MCP_SERVER_KEY = "pi";

function sanitize(raw: string): string {
	return raw.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

function withPrefix(prefix: string, name: string): string {
	return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

/**
 * Prefix for tools registered by `source` (a package name): `rpiv_` for any
 * `rpiv-*` package, otherwise the unscoped name minus a leading `pi-`,
 * sanitized, plus `_` (`@tintinweb/pi-subagents` -> `subagents_`).
 */
export function bridgePrefixFor(source: string): string {
	const unscoped = source.replace(/^@[^/]+\//, "");
	if (unscoped.startsWith("rpiv-")) return "rpiv_";
	return `${sanitize(unscoped.replace(/^pi-/, ""))}_`;
}

/** The name the bridge exposes for tool `name` registered by package `source`. */
export function bridgedToolName(source: string, name: string): string {
	return withPrefix(bridgePrefixFor(source), name);
}

/**
 * The name drawn for a tool kiro ran, from kiro's tool name and the MCP server
 * it came from (absent for kiro built-ins).
 */
export function displayToolName(toolName: string, mcpServerName: string | undefined): string {
	if (!mcpServerName) return withPrefix("kiro_", toolName);
	if (mcpServerName === BRIDGE_MCP_SERVER_KEY) return toolName;
	if (mcpServerName === WORKFLOW_MCP_SERVER_KEY) return withPrefix("gsd_", toolName);
	return withPrefix(`${sanitize(mcpServerName)}_`, toolName);
}
