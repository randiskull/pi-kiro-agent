/**
 * Child-process leak prevention for kiro-cli delegations.
 *
 * Both transports spawn kiro-cli `detached` (own process group — aborts must
 * be able to kill kiro's helper grandchildren, not just the child). The cost:
 * when the parent pi process dies uncleanly (SIGKILL, crash, OOM, machine
 * sleep-wake weirdness), nothing kills the group and the delegation lives on —
 * chat children have been found alive 9 and 23 DAYS after their parent died.
 * Two of the three defense layers live here:
 *
 *  1. Parent-exit tether: a registry of live children plus one process "exit"
 *     hook that SIGTERMs them on any orderly shutdown. Only the "exit" hook is
 *     used — it is synchronous-safe (plain process.kill, no timers, no async)
 *     and installing SIGINT/SIGTERM handlers of our own would change whether
 *     the host process dies on those signals.
 *  2. Orphan reaper: the exit hook cannot run on SIGKILL/crash, so activation
 *     scans the process table for kiro-cli processes that are provably OURS
 *     and provably ORPHANED, and kills their groups. Anything that doesn't
 *     match one of the two ownership signatures (a user's interactive
 *     `kiro-cli chat`, some other tool's delegation) is never touched.
 *
 * Layer 3 — a hard per-turn ceiling so a wedged child with a live parent is
 * bounded too — lives in the transports (PI_KIRO_CHAT_TIMEOUT_MS in
 * stream-adapter.ts, PI_KIRO_TURN_TIMEOUT_MS in acp-transport.ts).
 */

import { execFileSync } from "node:child_process";

// ─── Orphan reaper ────────────────────────────────────────────────────────────

export interface PsEntry {
	pid: number;
	ppid: number;
	command: string;
}

/**
 * Ownership signature 1: the chat transport passes `--agent
 * pi-kiro-bridge-<pid>-<n>` (kiro-bridge.ts), so the child's command line
 * embeds the PID of the pi process that spawned it. A dead embedded PID proves
 * the parent is gone.
 */
const BRIDGE_AGENT_PATTERN = /--agent[= ]pi-kiro-bridge-(\d+)-/;
/**
 * Ownership signature 2: the persistent ACP child (`kiro-cli acp …`). It has
 * no PID marker, so orphanhood is proven by reparenting: PPID 1 means the
 * spawning process is dead and init/launchd adopted the child. Anchored to the
 * start of the command so e.g. `grep kiro-cli acp` never matches.
 */
const ACP_COMMAND_PATTERN = /^(?:\S*\/)?kiro-cli(?:\.\w+)?\s+acp\b/;
/** Any kiro-cli invocation (anchored: argv[0] is kiro-cli, not a mention of it). */
const KIRO_COMMAND_PATTERN = /^(?:\S*\/)?kiro-cli(?:\.\w+)?\b/;

/** Parse `ps -eo pid,ppid,command` output (header and non-matching lines skipped). */
export function parsePsTable(text: string): PsEntry[] {
	const entries: PsEntry[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
		if (match) entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
	}
	return entries;
}

/** Signal-0 liveness probe. EPERM means "exists but not ours" — that is alive. */
function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Select the entries that are provably ours AND provably orphaned. Everything
 * else — interactive kiro-cli sessions, bridge children whose parent pi is
 * still alive, acp children still attached to a live parent — is spared.
 */
export function selectOrphans(entries: PsEntry[], isAlive: (pid: number) => boolean = pidIsAlive): PsEntry[] {
	const orphans: PsEntry[] = [];
	for (const entry of entries) {
		if (entry.pid === process.pid) continue;
		if (!KIRO_COMMAND_PATTERN.test(entry.command)) continue;
		const bridge = entry.command.match(BRIDGE_AGENT_PATTERN);
		if (bridge) {
			if (!isAlive(Number(bridge[1]))) orphans.push(entry);
			continue;
		}
		if (ACP_COMMAND_PATTERN.test(entry.command) && entry.ppid === 1) {
			orphans.push(entry);
		}
	}
	return orphans;
}

/** Group kill with single-process fallback (the group may already be gone). */
function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

/**
 * Scan the process table and kill orphaned kiro-cli delegations. Called once
 * at extension activation; every failure is swallowed per-orphan so one
 * unkillable PID never aborts the sweep. No-op on win32 (no `ps`, and children
 * there are not spawned detached).
 *
 * `psText` is a test seam: production callers omit it and the real table is read.
 */
export function reapOrphanedKiroChildren(psText?: string): { scanned: number; reaped: number } {
	if (process.platform === "win32") return { scanned: 0, reaped: 0 };
	const text = psText ?? execFileSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	const entries = parsePsTable(text);
	const orphans = selectOrphans(entries);
	for (const orphan of orphans) {
		killGroup(orphan.pid, "SIGTERM");
		// kiro-cli's graceful shutdown can be slow or wedged — escalate, unref'd
		// so the sweep never keeps the host process alive.
		const escalation = setTimeout(() => killGroup(orphan.pid, "SIGKILL"), 1_500);
		escalation.unref?.();
	}
	if (orphans.length > 0) {
		console.error(
			`pi-kiro: reaped ${orphans.length} orphaned kiro-cli process(es) (pids ${orphans.map((o) => o.pid).join(", ")})`,
		);
	}
	return { scanned: entries.length, reaped: orphans.length };
}

// ─── Parent-exit tether ───────────────────────────────────────────────────────

/** Structural subset of ChildProcess — lets tests register plain fakes. */
export interface CleanupChild {
	pid?: number;
	kill: (signal?: NodeJS.Signals) => boolean;
}

// child → whether it was spawned detached (own process group).
const trackedChildren = new Map<CleanupChild, boolean>();
let exitHookInstalled = false;

/** Exit-hook body — must stay synchronous ("exit" allows no async work, no timers). */
function killTrackedChildren(): void {
	for (const [child, detached] of trackedChildren) {
		try {
			if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
			else child.kill("SIGTERM");
		} catch {
			// already gone
		}
	}
	trackedChildren.clear();
}

/** Test hook: run the exit-hook body without exiting the process. */
export function _runExitCleanup(): void {
	killTrackedChildren();
}

/**
 * Track a spawned kiro-cli child so an orderly parent exit takes it (and, when
 * detached, its whole group) down. The hook is installed lazily on first
 * registration so merely importing this module has no process-level side effect.
 */
export function registerChildForCleanup(child: CleanupChild, detached: boolean): void {
	trackedChildren.set(child, detached);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.on("exit", killTrackedChildren);
	}
}

/** Untrack a child that exited (or was killed) through a normal cleanup path. */
export function unregisterChildForCleanup(child: CleanupChild): void {
	trackedChildren.delete(child);
}
