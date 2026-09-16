/**
 * Kiro-side glue for the MCP bridge: a per-turn agent profile in
 * ~/.kiro/agents/ whose inline HTTP MCP server points at the loopback
 * bridge endpoint (token in the URL path — kiro v2's http MCP config has
 * no custom-header support). The profile is unique per delegated turn
 * (concurrent subagent fan-out must not collide) and removed afterwards.
 *
 * v3 note: kiro v3 agent configs support header auth + ${VAR} expansion,
 * which would allow one stable profile — but v3 has no working headless
 * mode yet (the legacy non-TUI path is v2-only), so v2 is the target.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HttpBridgeHandle } from "./bridge.js";

export function bridgeEnabled(): boolean {
	return process.env.PI_KIRO_BRIDGE !== "off";
}

export interface KiroAgentProfile {
	name: string;
	path: string;
	remove: () => void;
}

let profileCounter = 0;

export function agentProfilesDir(): string {
	return join(homedir(), ".kiro", "agents");
}

/**
 * Write a throwaway agent profile exposing the bridge. Tools are wide open
 * (`*` + allowedTools `*`): delegated runs are headless, so any permission
 * prompt would hang the turn — same posture as --trust-all-tools.
 */
export function writeAgentProfile(
	handle?: HttpBridgeHandle,
	extraMcpServers?: Record<string, unknown>,
): KiroAgentProfile {
	const dir = agentProfilesDir();
	mkdirSync(dir, { recursive: true });
	profileCounter += 1;
	const name = `pi-kiro-bridge-${process.pid}-${profileCounter}`;
	const path = join(dir, `${name}.json`);
	const profile = {
		// `name` is required by kiro's agent schema — an invalid profile makes
		// kiro silently fall back to the default agent (no bridge, no error).
		name,
		description:
			"Throwaway pi-kiro-agent delegation profile (auto-generated per turn; safe to delete). Exposes the calling Pi session's tools over a loopback MCP bridge and/or the project's gsd-workflow MCP server.",
		mcpServers: {
			...(extraMcpServers ?? {}),
			...(handle ? { pi: { type: "http", url: handle.urlWithToken } } : {}),
		},
		tools: ["*"],
		allowedTools: ["*"],
	};
	writeFileSync(path, `${JSON.stringify(profile, null, "\t")}\n`, "utf8");
	return {
		name,
		path,
		remove: () => {
			try {
				rmSync(path, { force: true });
			} catch {
				// best effort
			}
		},
	};
}
