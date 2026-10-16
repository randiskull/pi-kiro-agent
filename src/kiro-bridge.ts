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

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
 * `resources: []` declares intent only -- it does NOT currently opt out.
 * Measured on kiro-cli 2.32.0 (engine v2), a custom agent reports the same
 * context usage to three decimals whether the key is absent or an empty list
 * (6.430% of a 1M window either way). kiro's default-resource loader is
 * ADDITIVE and ignores the per-agent field: declaring resources, empty or not,
 * never subtracts the inherited set (global + workspace steering, every
 * `skill://.kiro/skills/<name>/SKILL.md`, and project marker files like
 * AGENTS.md). The key is kept because it is the documented contract and costs
 * nothing, so this profile stops inheriting for free if that is ever fixed.
 *
 * The lever that DOES work is `chat.disableInheritingDefaultResources`, which
 * `disableInheritedResources()` below sets at workspace scope for the duration
 * of a turn: the same probe drops to 3.409%, i.e. ~30,200 tokens recovered on
 * EVERY delegated turn. That inheritance is pure waste here -- pi already hands
 * us the caller's prompt and context, which we pass through as
 * <prior_system_context> -- and it also dilutes the caller's own AGENTS.md.
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
		// Declared intent, not a working opt-out on 2.32.0 -- see the doc
		// comment. `disableInheritedResources()` is what actually saves the ~30k.
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

const INHERIT_KEY = "chat.disableInheritingDefaultResources";
const RESTORE_SENTINEL = ".pi-kiro-settings-restore.json";

export interface WorkspaceSettingsHandle {
	path: string;
	restore: () => void;
}

/**
 * kiro resolves WORKSPACE settings from the exact cwd it was spawned in and
 * does NOT walk up to a git root: probed from `<repo>/src`, a file at
 * `<repo>/.kiro/settings/cli.json` is invisible. So this must be built from the
 * same cwd the transport passes to kiro-cli, never from a repo root.
 */
export function workspaceSettingsPath(cwd: string): string {
	return join(cwd, ".kiro", "settings", "cli.json");
}

function readIfPresent(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but is not ours to signal: still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function restoreFrom(settingsPath: string, original: string | null): void {
	if (original !== null) {
		writeFileSync(settingsPath, original, "utf8");
		return;
	}
	rmSync(settingsPath, { force: true });
	// Both rmdirs only succeed while empty, so a settings dir (or a .kiro) the
	// user also uses survives. Without the second one, a project that had no
	// .kiro at all is left with an empty one, which is litter in their repo.
	for (const dir of [dirname(settingsPath), dirname(dirname(settingsPath))]) {
		try {
			rmdirSync(dir);
		} catch {
			// non-empty or already gone
		}
	}
}

/**
 * Undo a setting left behind by a pi process that was SIGKILLed before its
 * `finally` ran. Without this, a crash leaves
 * `chat.disableInheritingDefaultResources: true` in the user's own project and
 * their interactive kiro sessions silently lose all steering and skills --
 * exactly the kind of quiet, misattributed breakage the orphan reaper exists to
 * prevent for processes. Runs on the next delegated turn in that cwd.
 */
function reapStaleRestore(dir: string): void {
	const sentinelPath = join(dir, RESTORE_SENTINEL);
	const raw = readIfPresent(sentinelPath);
	if (raw === undefined) return;
	let parsed: { pid?: number; original?: string | null };
	try {
		parsed = JSON.parse(raw) as { pid?: number; original?: string | null };
	} catch {
		rmSync(sentinelPath, { force: true });
		return;
	}
	// A live owner is mid-turn and will restore for itself.
	if (typeof parsed.pid === "number" && parsed.pid !== process.pid && pidAlive(parsed.pid)) return;
	// Remove the sentinel FIRST: restoreFrom() tidies away an empty settings dir,
	// and a sentinel still sitting in it makes that rmdir fail silently, leaving
	// the litter this is supposed to clear.
	rmSync(sentinelPath, { force: true });
	try {
		restoreFrom(join(dir, "cli.json"), parsed.original ?? null);
	} catch {
		// best effort
	}
}

/**
 * Turn off kiro's default-resource inheritance for this turn by setting
 * `chat.disableInheritingDefaultResources` at WORKSPACE scope, recovering
 * ~30,200 tokens per delegated turn (6.430% -> 3.409% of a 1M window, measured
 * on kiro-cli 2.32.0 engine v2).
 *
 * This mutates a file inside the user's project, which is a heavier footprint
 * than the throwaway agent profile, so it is deliberately conservative:
 *
 *  - a user who has ANY explicit value for the key keeps it, even `false`;
 *  - a settings file that does not parse is never rewritten;
 *  - the original bytes (or the file's absence) are restored in the caller's
 *    `finally`, and recovered from a sentinel if that never runs;
 *  - `PI_KIRO_WORKSPACE_SETTINGS=off` disables the whole mechanism.
 *
 * Returns undefined when it changed nothing, so there is nothing to restore.
 */
export function disableInheritedResources(cwd: string): WorkspaceSettingsHandle | undefined {
	if (process.env.PI_KIRO_WORKSPACE_SETTINGS === "off") return undefined;
	const path = workspaceSettingsPath(cwd);
	const dir = dirname(path);
	if (existsSync(dir)) reapStaleRestore(dir);

	const original = readIfPresent(path);
	let parsed: Record<string, unknown> = {};
	if (original !== undefined) {
		try {
			parsed = JSON.parse(original) as Record<string, unknown>;
		} catch {
			return undefined;
		}
		if (INHERIT_KEY in parsed) return undefined;
	}

	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, RESTORE_SENTINEL),
		`${JSON.stringify({ pid: process.pid, original: original ?? null })}\n`,
		"utf8",
	);
	writeFileSync(path, `${JSON.stringify({ ...parsed, [INHERIT_KEY]: true }, null, "\t")}\n`, "utf8");

	let done = false;
	return {
		path,
		restore: () => {
			if (done) return;
			done = true;
			// Before restoreFrom, for the rmdir reason in reapStaleRestore.
			rmSync(join(dir, RESTORE_SENTINEL), { force: true });
			try {
				restoreFrom(path, original ?? null);
			} catch {
				// best effort
			}
		},
	};
}
