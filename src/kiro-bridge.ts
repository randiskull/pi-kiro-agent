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
 *
 * `resources: []` is load-bearing, not tidiness. This profile is a CUSTOM
 * (user-defined) agent, and kiro's `chat.disableInheritingDefaultResources`
 * setting defaults to false, so a profile that OMITS the key inherits the
 * whole default resource set: global + workspace steering, every
 * `skill://.kiro/skills/<name>/SKILL.md`, and project marker files like AGENTS.md.
 * Verified by `/context show --agent gsd-loop-build`, whose config declares a
 * single resource yet reports that file PLUS the inherited skill globs.
 *
 * That inheritance is pure waste here: pi already hands us the caller's prompt
 * and context, which we pass through as <prior_system_context>. Measured on a
 * developer machine it was 39 files / 3.0% of a 1M window / ~30,000 tokens on
 * EVERY delegated turn, and it also outranks and dilutes the caller's own
 * AGENTS.md. An empty list opts out per-profile without touching the user's
 * global kiro settings.
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
		// See the doc comment: omitting this key inherits ~30k tokens of
		// steering/skills/AGENTS.md on every turn.
		resources: [] as string[],
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
