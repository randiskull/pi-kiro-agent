/**
 * Orphan reaper + parent-exit tether tests.
 *
 * The reaper must be conservative: it may only kill processes matching one of
 * the two ownership signatures (dead-parent bridge child, ppid-1 acp child).
 * These tests pin both the positive matches and — more importantly — the
 * processes that must be SPARED (interactive kiro-cli, live-parent children,
 * lookalike command lines).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetExitHookForTest,
	_runExitCleanup,
	parsePsTable,
	reapOrphanedKiroChildren,
	registerChildForCleanup,
	selectOrphans,
	unregisterChildForCleanup,
} from "../src/orphan-reaper.js";

const DEAD_PARENT = 11111;
const LIVE_PARENT = 22222;
const EPERM_PARENT = 33333;

/**
 * Fixture process table. Expected orphans: 400 (bridge child of a dead pi) and
 * 420 (acp child reparented to init). Everything else must be spared.
 */
const PS_FIXTURE = [
	"  PID  PPID COMMAND",
	"    1     0 /sbin/launchd",
	// Signature 1 hit: bridge child, embedded parent PID is dead.
	`  400   399 /usr/local/bin/kiro-cli chat --no-interactive --trust-all-tools --agent pi-kiro-bridge-${DEAD_PARENT}-1 --require-mcp-startup prompt`,
	// Spared: bridge child whose embedded parent PID is alive.
	`  410   399 /usr/local/bin/kiro-cli chat --no-interactive --trust-all-tools --agent pi-kiro-bridge-${LIVE_PARENT}-3 --require-mcp-startup prompt`,
	// Spared: EPERM on the liveness probe means the parent exists (other user).
	`  415   399 /usr/local/bin/kiro-cli chat --no-interactive --agent pi-kiro-bridge-${EPERM_PARENT}-2 prompt`,
	// Signature 2 hit: acp child reparented to init.
	"  420     1 /usr/local/bin/kiro-cli acp --trust-all-tools --agent-engine v2",
	// Spared: acp child still attached to a live parent.
	"  430   500 /usr/local/bin/kiro-cli acp --trust-all-tools --agent-engine v2",
	// Spared: a user's interactive chat carries neither signature, even at ppid 1.
	"  440     1 kiro-cli chat",
	// Spared: mentions kiro-cli acp but argv[0] is not kiro-cli.
	"  450     1 grep kiro-cli acp",
	// Spared: bridge-lookalike args on a non-kiro-cli command.
	`  460     1 grep --agent pi-kiro-bridge-${DEAD_PARENT}-9`,
].join("\n");

describe("orphan reaper", () => {
	let kills: Array<{ pid: number; signal: string | number }>;
	let killSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		kills = [];
		killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (signal === 0) {
				// Liveness probe: LIVE_PARENT exists, EPERM_PARENT exists but is
				// not ours (EPERM counts as alive), everything else is dead.
				if (pid === LIVE_PARENT) return true;
				const error = new Error(pid === EPERM_PARENT ? "EPERM" : "ESRCH") as NodeJS.ErrnoException;
				error.code = pid === EPERM_PARENT ? "EPERM" : "ESRCH";
				throw error;
			}
			kills.push({ pid, signal: signal ?? "SIGTERM" });
			return true;
		}) as never);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		// Flush the unref'd SIGKILL escalation timers while process.kill is still
		// mocked — a real timer firing after mockRestore would signal real PIDs.
		vi.runAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("parses the ps table, skipping the header", () => {
		const entries = parsePsTable(PS_FIXTURE);
		expect(entries).toHaveLength(9);
		expect(entries[1]).toEqual({
			pid: 400,
			ppid: 399,
			command: `/usr/local/bin/kiro-cli chat --no-interactive --trust-all-tools --agent pi-kiro-bridge-${DEAD_PARENT}-1 --require-mcp-startup prompt`,
		});
	});

	it("selects exactly the dead-parent bridge child and the ppid-1 acp child", () => {
		const orphans = selectOrphans(parsePsTable(PS_FIXTURE));
		expect(orphans.map((o) => o.pid)).toEqual([400, 420]);
	});

	it("SIGTERMs each orphan's process group and escalates to SIGKILL", () => {
		const result = reapOrphanedKiroChildren(PS_FIXTURE);
		expect(result).toEqual({ scanned: 9, reaped: 2 });
		expect(kills).toEqual([
			{ pid: -400, signal: "SIGTERM" },
			{ pid: -420, signal: "SIGTERM" },
		]);
		vi.advanceTimersByTime(1_500);
		expect(kills.slice(2)).toEqual([
			{ pid: -400, signal: "SIGKILL" },
			{ pid: -420, signal: "SIGKILL" },
		]);
		expect(console.error).toHaveBeenCalledTimes(1);
	});

	it("falls back to a single-process kill when the group kill fails", () => {
		killSpy.mockImplementation(((pid: number, signal?: string | number) => {
			if (signal === 0) {
				if (pid === LIVE_PARENT) return true;
				const error = new Error(pid === EPERM_PARENT ? "EPERM" : "ESRCH") as NodeJS.ErrnoException;
				error.code = pid === EPERM_PARENT ? "EPERM" : "ESRCH";
				throw error;
			}
			if (pid < 0) throw new Error("ESRCH");
			kills.push({ pid, signal: signal ?? "SIGTERM" });
			return true;
		}) as never);
		const result = reapOrphanedKiroChildren(PS_FIXTURE);
		expect(result.reaped).toBe(2);
		expect(kills.map((k) => k.pid)).toEqual([400, 420]);
	});

	it("stays silent when nothing is reaped", () => {
		const result = reapOrphanedKiroChildren("  PID  PPID COMMAND\n  440     1 kiro-cli chat");
		expect(result).toEqual({ scanned: 1, reaped: 0 });
		expect(kills).toEqual([]);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("is a no-op on win32", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			expect(reapOrphanedKiroChildren(PS_FIXTURE)).toEqual({ scanned: 0, reaped: 0 });
			expect(kills).toEqual([]);
		} finally {
			Object.defineProperty(process, "platform", original);
		}
	});
});

describe("parent-exit tether", () => {
	let kills: Array<{ pid: number; signal: string | number }>;

	beforeEach(() => {
		kills = [];
		vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			kills.push({ pid, signal: signal ?? "SIGTERM" });
			return true;
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const fakeChild = (pid: number) => ({ pid, kill: vi.fn(() => true) });

	it("kills registered children on the exit hook — group kill when detached, child.kill otherwise", () => {
		const detachedChild = fakeChild(101);
		const plainChild = fakeChild(102);
		registerChildForCleanup(detachedChild, true);
		registerChildForCleanup(plainChild, false);
		_runExitCleanup();
		expect(kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);
		expect(plainChild.kill).toHaveBeenCalledWith("SIGTERM");
		expect(detachedChild.kill).not.toHaveBeenCalled();
	});

	it("does not kill unregistered children, and one kill failure does not stop the sweep", () => {
		const unregistered = fakeChild(103);
		const failing = fakeChild(104);
		failing.kill.mockImplementation(() => {
			throw new Error("already gone");
		});
		const survivor = fakeChild(105);
		registerChildForCleanup(unregistered, true);
		registerChildForCleanup(failing, false);
		registerChildForCleanup(survivor, false);
		unregisterChildForCleanup(unregistered);
		_runExitCleanup();
		expect(kills).toEqual([]);
		expect(unregistered.kill).not.toHaveBeenCalled();
		expect(survivor.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("installs exactly one process exit hook across registrations", () => {
		// Reset to a clean baseline: an earlier test in this file has already
		// installed the hook, which would make this assertion vacuous otherwise.
		_resetExitHookForTest();
		const before = process.listeners("exit").length;
		registerChildForCleanup(fakeChild(106), true);
		registerChildForCleanup(fakeChild(107), false);
		const after = process.listeners("exit").length;
		// Exactly one new listener from the first registration; the second must
		// not stack another.
		expect(after - before).toBe(1);
		_runExitCleanup();
	});
});
