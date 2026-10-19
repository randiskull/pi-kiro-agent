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

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
			"Throwaway pi-kiro delegation profile (auto-generated per turn; safe to delete). Exposes the calling Pi session's tools over a loopback MCP bridge and/or the project's gsd-workflow MCP server.",
		mcpServers: {
			...(extraMcpServers ?? {}),
			...(handle ? { pi: { type: "http", url: handle.urlWithToken } } : {}),
		},
		tools: ["*"],
		allowedTools: ["*"],
	};
	// Clear any pre-existing file at this path (stale from a crash, or a recycled
	// pid) so we never inherit wrong permissions from an old 0644 file.
	rmSync(path, { force: true });
	writeFileSync(path, `${JSON.stringify(profile, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	return {
		name,
		path,
		remove: () => {
			// Delete the profile and any .bak / .bak.<n> files that kiro-cli v3 engine
			// start creates alongside the original when it converts the profile format.
			// Only the EXACT profile name is targeted — never a prefix match.
			for (const suffix of bakSuffixes()) {
				try {
					rmSync(`${path}${suffix}`, { force: true });
				} catch {
					// best effort
				}
			}
		},
	};
}

/**
 * Suffixes for the profile file itself plus kiro-cli v3's backup variants.
 *
 * kiro-cli v3 engine start creates `.bak`, `.bak.1`, `.bak.2`, … alongside
 * the original profile when it converts the format. In observed v3 behaviour
 * the count is at most a small handful; the cap at `.bak.9` is a conservative
 * upper bound that covers all known cases without an unbounded loop.
 */
function bakSuffixes(): string[] {
	const suffixes = [""];
	suffixes.push(".bak");
	for (let n = 1; n <= 9; n++) {
		suffixes.push(`.bak.${n}`);
	}
	return suffixes;
}

/**
 * Scan agentProfilesDir() for stale pi-kiro agent profile files and remove
 * them. A profile is considered stale when:
 *   (a) its embedded pid equals process.pid — activation means no turn is in
 *       flight for this process, so any profile from a prior run is dead, OR
 *   (b) kill(pid, 0) throws ESRCH — the pid is dead, OR
 *   (c) the file's mtime is older than 3 hours — no real turn runs that long.
 *
 * Only files matching /^pi-kiro-bridge-(\d+)-\d+\.json$/ are inspected; all
 * other agent profiles (code-reviewer.json etc.) are never touched.
 *
 * Returns { scanned, swept } for observability. Never throws.
 *
 * @remarks Called once at activation. The `pid === process.pid` branch assumes
 * no turn is in flight for this process — do not call from a mid-session context.
 */
export function sweepStaleAgentProfiles(): { scanned: number; swept: number } {
	const PROFILE_PATTERN = /^pi-kiro-bridge-(\d+)-\d+\.json$/;
	const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
	let scanned = 0;
	let swept = 0;
	let entries: string[];
	try {
		entries = readdirSync(agentProfilesDir());
	} catch {
		// directory may not exist yet — nothing to sweep
		return { scanned, swept };
	}
	for (const entry of entries) {
		const match = entry.match(PROFILE_PATTERN);
		if (!match) continue;
		scanned++;
		const pid = Number(match[1]);
		try {
			let stale = false;
			if (pid === process.pid) {
				// Our own process — no turn is in flight at activation time.
				stale = true;
			} else {
				try {
					process.kill(pid, 0);
					// pid is alive; check age as a last resort
					const filePath = join(agentProfilesDir(), entry);
					const st = statSync(filePath);
					stale = Date.now() - st.mtimeMs > THREE_HOURS_MS;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ESRCH") {
						stale = true; // pid is dead
					}
					// EPERM means the process exists but we don't own it — not ours; skip
				}
			}
			if (!stale) continue;
			const filePath = join(agentProfilesDir(), entry);
			for (const suffix of bakSuffixes()) {
				try {
					rmSync(`${filePath}${suffix}`, { force: true });
				} catch {
					// best effort per file
				}
			}
			swept++;
		} catch {
			// never let one file's error abort the whole sweep
		}
	}
	return { scanned, swept };
}
