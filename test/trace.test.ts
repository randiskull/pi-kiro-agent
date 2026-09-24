import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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
		delete process.env.PI_KIRO_TRACE;
		resetTraceTarget();
		expect(traceEnabled()).toBe(false);
		const path = join(dir, "should-not-exist.jsonl");
		trace("bridge.call", { tool: "ask_user_question" });
		expect(existsSync(path)).toBe(false);
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

	it("swallows an unwritable target instead of throwing", () => {
		// A path whose parent cannot be created: tracing must degrade to a no-op,
		// never surface as a turn failure.
		process.env.PI_KIRO_TRACE = "/proc/definitely/not/writable/trace.jsonl";
		resetTraceTarget();
		expect(() => trace("bridge.call", { tool: "todo" })).not.toThrow();
	});
});
