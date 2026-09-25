import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetTraceTarget, trace, traceEnabled } from "../src/trace.js";

describe("env-gated trace", () => {
	let dir: string;
	const saved = process.env.PI_KIRO_TRACE;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-kiro-trace-"));
		resetTraceTarget();
	});

	afterEach(() => {
		if (saved === undefined) delete process.env.PI_KIRO_TRACE;
		else process.env.PI_KIRO_TRACE = saved;
		resetTraceTarget();
	});

	it("is off and writes nothing when PI_KIRO_TRACE is unset", () => {
		// Configure a target FIRST, then clear it: the earlier version of this test
		// asserted on a path the module had never been told about, so a target()
		// that fell back to a default -- or one that kept writing to a stale
		// memoized target -- passed it. Both now fail.
		const path = join(dir, "should-not-exist.jsonl");
		process.env.PI_KIRO_TRACE = path;
		resetTraceTarget();
		expect(traceEnabled()).toBe(true);

		delete process.env.PI_KIRO_TRACE;
		resetTraceTarget();
		expect(traceEnabled()).toBe(false);
		trace("bridge.call", { tool: "ask_user_question" });
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("appends one JSON object per event when enabled", () => {
		const path = join(dir, "nested", "trace.jsonl");
		process.env.PI_KIRO_TRACE = path;
		resetTraceTarget();
		expect(traceEnabled()).toBe(true);
		trace("bridge.call", { callId: "ccbridge-1", tool: "ask_user_question" });
		trace("bridge.result", { callId: "ccbridge-1", tool: "ask_user_question", isError: false });
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]);
		expect(first.event).toBe("bridge.call");
		expect(first.tool).toBe("ask_user_question");
		expect(typeof first.ts).toBe("string");
		expect(first.pid).toBe(process.pid);
		expect(JSON.parse(lines[1]).event).toBe("bridge.result");
	});

	// A trace carries the full prompt and every bridged tool call's raw arguments,
	// so a default-mode create (0666 & ~umask, normally 0644) leaves it readable by
	// any other local user.
	it.skipIf(process.platform === "win32")("creates the trace 0600 inside a 0700 directory", () => {
		const path = join(dir, "nested", "trace.jsonl");
		process.env.PI_KIRO_TRACE = path;
		resetTraceTarget();
		trace("acp.prompt.send", { prompt: "a prompt that could contain anything" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
	});

	// Kiro's review of PR #18 claimed mkdirSync's `mode` applies only to the LEAF
	// and leaves intermediate ancestors at 0666 & ~umask, i.e. world-readable. That
	// is not what node does: MKDirpSync in node_file.cc re-invokes uv_fs_mkdir with
	// the SAME mode for every missing component. Verified by hand at v24 on macOS
	// and v22 on Linux (umask 022, all four levels 0700) before rejecting the
	// finding; this pins it so the claim cannot be re-raised from reading alone.
	// Deliberately MULTI-level: the test above only creates one new component.
	it.skipIf(process.platform === "win32")("creates every new ancestor 0700, not just the leaf", () => {
		const path = join(dir, "a", "b", "c", "trace.jsonl");
		process.env.PI_KIRO_TRACE = path;
		resetTraceTarget();
		trace("acp.prompt.send", { prompt: "a prompt that could contain anything" });
		for (const created of [join(dir, "a"), join(dir, "a", "b"), join(dir, "a", "b", "c")]) {
			expect(statSync(created).mode & 0o777).toBe(0o700);
		}
	});

	it("swallows an unwritable target instead of throwing", () => {
		// Parent is an existing FILE, so mkdirSync fails with ENOTDIR on every
		// platform. The previous version used a path under /proc, which does not
		// exist on macOS at all -- it passed there for the wrong reason.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "");
		process.env.PI_KIRO_TRACE = join(blocker, "trace.jsonl");
		resetTraceTarget();
		expect(traceEnabled()).toBe(false);
		expect(() => trace("bridge.call", { tool: "todo" })).not.toThrow();
	});
});
