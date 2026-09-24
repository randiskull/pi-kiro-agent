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
