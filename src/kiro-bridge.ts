/**
 * Kiro-side glue for the MCP bridge: a per-turn agent profile in
 * ~/.kiro/agents/ whose inline HTTP MCP server points at the loopback
 * bridge endpoint (token in the URL path — kiro v2's http MCP config has
 * no custom-header support). The profile is unique per delegated turn
 * (concurrent subagent fan-out must not collide) and removed afterwards.
 *
 * v3 note: kiro v3 agent configs support header auth + ${VAR} expansion,
 * which would allow one stable profile. v3 DOES run headless (measured: see
 * docs/design/v3-engine.md), so the blocker is no longer the mode. It is
 * whether v3 reads this profile format at all, and how it names a bridged
 * tool (spike S1). A missing profile still exits 4 on v3, but its wording
 * ("agent X not found, using default") reads like a fallback: if v3 ever acts
 * on it, a turn would run with none of pi's tools. v2 stays the target.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HttpBridgeHandle } from "./bridge.js";
import { BRIDGE_MCP_SERVER_KEY } from "./tool-names.js";
import { envMs } from "./transport-utils.js";

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
 * A profile's own file plus the backups kiro writes beside it. A kiro-cli
 * v3-engine start (from anywhere: pi, the IDE, KAS) converts every top-level
 * `~/.kiro/agents/*.json` to the format both engines load and saves the
 * original as `<name>.json.bak`, then `.bak.1`, `.bak.2`, ... on later
 * conversions. The original holds the tokenized bridge URL, so the backups are
 * ours to delete along with the profile.
 */
const PROFILE_FILE = /^pi-kiro-bridge-(\d+)-(\d+)\.json(?:\.bak(?:\.\d+)?)?$/;

function profileFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((entry) => PROFILE_FILE.test(entry));
	} catch {
		return [];
	}
}

/** Remove `<name>.json` and its backups. Exact name: other turns share the dir. */
function removeProfileFiles(dir: string, name: string): void {
	for (const entry of profileFiles(dir)) {
		if (entry !== `${name}.json` && !entry.startsWith(`${name}.json.bak`)) continue;
		try {
			rmSync(join(dir, entry), { force: true });
		} catch {
			// best effort
		}
	}
}

/**
 * Delete profiles, and their backups, left by turns that never reached
 * `remove()`: a pi process that was SIGKILLed or crashed mid-turn. Runs at
 * activation. A file is stale when its pid is this process (a predecessor
 * whose pid was reused: nothing is mid-turn yet at activation), when its pid
 * is dead, or when it is older than any turn can run, since a dead owner's pid
 * can be recycled by an unrelated process. Files of a live pi mid-turn are left
 * alone. Age is judged per file, not per pid: a live pid can own an ancient
 * leftover it inherited and its own current profile at the same time.
 *
 * @remarks Called once at activation, before any turn is registered. The
 * `pid === process.pid` branch assumes no turn is in flight for this process
 * at the moment of the call -- do not call from a mid-session context (e.g.,
 * a periodic cleanup or a post-turn hook) or it will silently delete profiles
 * belonging to concurrently running turns in the same process.
 */
export function sweepStaleAgentProfiles(dir: string = agentProfilesDir()): number {
	let removed = 0;
	for (const entry of profileFiles(dir)) {
		const pid = Number(PROFILE_FILE.exec(entry)?.[1]);
		const path = join(dir, entry);
		let stale = pid === process.pid || !pidAlive(pid);
		if (!stale) {
			try {
				stale = Date.now() - statSync(path).mtimeMs > sentinelMaxAgeMs();
			} catch {
				continue;
			}
		}
		if (!stale) continue;
		try {
			rmSync(path, { force: true });
			removed += 1;
		} catch {
			// best effort
		}
	}
	return removed;
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
			...(handle ? { [BRIDGE_MCP_SERVER_KEY]: { type: "http", url: handle.urlWithToken } } : {}),
		},
		tools: ["*"],
		allowedTools: ["*"],
		// Declared intent, not a working opt-out on 2.32.0 -- see the doc
		// comment. `disableInheritedResources()` is what actually saves the ~30k.
		resources: [] as string[],
	};
	// Clear anything already under this name first: `mode` only applies when the
	// file is created, and the profile carries the bridge token, so it must be
	// owner-only (kiro keeps the mode when it converts the file, so its backups
	// inherit 0600 too).
	removeProfileFiles(dir, name);
	writeFileSync(path, `${JSON.stringify(profile, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	return {
		name,
		path,
		remove: () => removeProfileFiles(dir, name),
	};
}

const INHERIT_KEY = "chat.disableInheritingDefaultResources";
const RESTORE_SENTINEL = ".pi-kiro-settings-restore.json";

/**
 * What the sentinel records: who changed the file, when, what it held before
 * (null = absent) and exactly what was written. `pid: null` marks a change whose
 * own restore failed, which any later turn may retry.
 */
interface RestoreRecord {
	pid?: number | null;
	ts?: number;
	original?: string | null;
	written?: string;
}

/** Settings dirs this process changed and has not restored yet: their sentinels are live. */
const activeDirs = new Set<string>();

/**
 * Age past which a sentinel (or a leftover agent profile) is stale even if its
 * pid is alive, because pids are reused: a dead owner's pid recycled by an
 * unrelated process would otherwise keep the setting stranded indefinitely. Comfortably above the longest turn
 * the chat transport allows (PI_KIRO_CHAT_TIMEOUT_MS, 45 min by default).
 */
function sentinelMaxAgeMs(): number {
	return Math.max(3 * 60 * 60 * 1000, 2 * envMs("PI_KIRO_CHAT_TIMEOUT_MS", 45 * 60 * 1000));
}

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

function writeSentinel(dir: string, record: RestoreRecord): void {
	writeFileSync(join(dir, RESTORE_SENTINEL), `${JSON.stringify(record)}\n`, "utf8");
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
 * Undo our change to `settingsPath`. When the file is exactly what we wrote, put
 * the original back (bytes, or absence). When it changed under us -- the user or
 * another tool edited it mid-turn -- keep their edit and take back only our key,
 * and only while it still holds the value we set. Throws on a filesystem error.
 */
function undoChange(settingsPath: string, original: string | null, written: string | undefined): void {
	const current = readIfPresent(settingsPath);
	if (written === undefined || current === written) {
		restoreFrom(settingsPath, original);
		return;
	}
	if (current === undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(current);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
	const record = parsed as Record<string, unknown>;
	if (record[INHERIT_KEY] !== true) return;
	const { [INHERIT_KEY]: _ours, ...theirs } = record;
	if (original === null && Object.keys(theirs).length === 0) {
		restoreFrom(settingsPath, null);
		return;
	}
	writeFileSync(settingsPath, `${JSON.stringify(theirs, null, "\t")}\n`, "utf8");
}

/**
 * Restore and clear the sentinel. The sentinel goes FIRST because restoreFrom()
 * tidies away an empty settings dir and a sentinel still in it makes that rmdir
 * fail. If the restore itself fails, the sentinel is written back as orphaned
 * (`pid: null`) so the next delegated turn here retries, and the failure is
 * reported: left silent, the user's interactive kiro loses all steering and
 * skills with nothing pointing at pi.
 */
function finishRestore(dir: string, record: RestoreRecord): void {
	const settingsPath = join(dir, "cli.json");
	rmSync(join(dir, RESTORE_SENTINEL), { force: true });
	try {
		undoChange(settingsPath, record.original ?? null, record.written);
	} catch (error) {
		try {
			mkdirSync(dir, { recursive: true });
			writeSentinel(dir, { ...record, pid: null, ts: Date.now() });
		} catch {
			// the warning below is the remaining signal
		}
		console.error(
			`[pi-kiro] could not restore ${settingsPath} (${error instanceof Error ? error.message : String(error)}); the next delegated turn in this directory retries. To fix it now, remove "${INHERIT_KEY}" from that file. Set PI_KIRO_WORKSPACE_SETTINGS=off to stop pi-kiro writing it.`,
		);
	}
}

/**
 * Undo a setting left behind by a pi process that was SIGKILLed before its
 * `finally` ran. Without this, a crash leaves
 * `chat.disableInheritingDefaultResources: true` in the user's own project and
 * their interactive kiro sessions silently lose all steering and skills --
 * exactly the kind of quiet, misattributed breakage the orphan reaper exists to
 * prevent for processes. Runs on the next delegated turn in that cwd.
 *
 * A sentinel is live, and left alone, while its owner is mid-turn: for this
 * process that means the dir is still in `activeDirs` (concurrent turns in one
 * cwd share a pid); for another process, a live pid on a sentinel younger than
 * sentinelMaxAgeMs().
 */
function reapStaleRestore(dir: string): void {
	const sentinelPath = join(dir, RESTORE_SENTINEL);
	const raw = readIfPresent(sentinelPath);
	if (raw === undefined) return;
	let parsed: RestoreRecord;
	try {
		parsed = JSON.parse(raw) as RestoreRecord;
	} catch {
		rmSync(sentinelPath, { force: true });
		return;
	}
	if (typeof parsed.pid === "number") {
		if (parsed.pid === process.pid) {
			if (activeDirs.has(dir)) return;
		} else {
			const fresh = typeof parsed.ts !== "number" || Date.now() - parsed.ts < sentinelMaxAgeMs();
			if (fresh && pidAlive(parsed.pid)) return;
		}
	}
	finishRestore(dir, parsed);
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

	const written = `${JSON.stringify({ ...parsed, [INHERIT_KEY]: true }, null, "\t")}\n`;
	const record: RestoreRecord = { pid: process.pid, ts: Date.now(), original: original ?? null, written };
	mkdirSync(dir, { recursive: true });
	writeSentinel(dir, record);
	writeFileSync(path, written, "utf8");
	activeDirs.add(dir);

	let done = false;
	return {
		path,
		restore: () => {
			if (done) return;
			done = true;
			activeDirs.delete(dir);
			finishRestore(dir, record);
		},
	};
}
