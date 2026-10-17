import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMeteringDiagnostic } from "../src/metering.js";
import { _resetSessions, planTurn, recordKnownSession } from "../src/session-manager.js";
import { _resetChatFormatFallback, FINAL_CLOSE, FINAL_OPEN, makeStreamViaKiro, supportsStreamJson } from "../src/stream-adapter.js";
import { resetTraceTarget } from "../src/trace.js";

const { spawnMock, execFileMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock, execFile: execFileMock }));

const MODEL = {
	id: "auto",
	name: "auto [kiro]",
	api: "anthropic-messages",
	provider: "kiro",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as Model<any>;

const PROBES = join(__dirname, "..", "probes", "stream-json-2.32");
const probe = (name: string) => readFileSync(join(PROBES, name), "utf8");
const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const STARTED = line({ type: "runStarted", data: { payloadSchema: "acp", acpProtocolVersion: 1, engine: "v2" } });
const chunk = (text: string) =>
	line({ type: "sessionUpdate", data: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const FINISHED = (finalText: string) =>
	line({ type: "runFinished", data: { sessionId: "s1", status: "success", stopReason: "end_turn", finalText, finalTextTruncated: false } });

class FakeChild extends EventEmitter {
	pid = 4242;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn(() => this.emit("exit", 130));
}

/** One scripted attempt: stdout bytes (split every `chunkBytes`), exit code, optional "never exits". */
type Attempt = { stdout: string; exitCode?: number; chunkBytes?: number; hang?: boolean };

function scriptAttempts(...attempts: Attempt[]): FakeChild[] {
	const children: FakeChild[] = [];
	spawnMock.mockImplementation(() => {
		const attempt = attempts.shift() ?? { stdout: "" };
		const child = new FakeChild();
		children.push(child);
		const bytes = Buffer.from(attempt.stdout, "utf8");
		const size = attempt.chunkBytes ?? bytes.length;
		queueMicrotask(() => {
			for (let i = 0; i < bytes.length; i += size) child.stdout.emit("data", bytes.subarray(i, i + size));
			if (attempt.hang) return;
			child.stdout.emit("end");
			queueMicrotask(() => child.emit("exit", attempt.exitCode ?? 0));
		});
		return child;
	});
	return children;
}

const USER: Message = { role: "user", content: "go", timestamp: 0 };

async function collect(context: Context = { systemPrompt: "", messages: [USER] }, getBridge?: () => Promise<never>) {
	const stream = makeStreamViaKiro({ binaryPath: "kiro-cli", getBridge })(MODEL, context);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function doneOf(events: AssistantMessageEvent[]) {
	const done = events.find((e) => e.type === "done");
	if (done?.type !== "done") throw new Error(`expected done, got ${JSON.stringify(events.find((e) => e.type === "error"))}`);
	return done.message;
}
const answerOf = (events: AssistantMessageEvent[]) => {
	const text = doneOf(events).content.find((b) => b.type === "text");
	return text && "text" in text ? text.text : "";
};
const thinkingOf = (events: AssistantMessageEvent[]) =>
	events
		.filter((e) => e.type === "thinking_delta")
		.map((e) => (e as { delta: string }).delta)
		.join("");
function errorOf(events: AssistantMessageEvent[]): string {
	expect(events.some((e) => e.type === "done")).toBe(false);
	const error = events.find((e) => e.type === "error");
	if (error?.type !== "error") throw new Error("expected error");
	return error.error.errorMessage ?? "";
}
/** Rows as drawn mid-turn: the last partial that carried any toolCall block. */
function rowsOf(events: AssistantMessageEvent[]) {
	const rows = new Map<string, { id: string; name: string; arguments: Record<string, unknown> }>();
	for (const e of events) {
		const partial = (e as { partial?: { content: Array<{ type: string; id?: string }> } }).partial;
		for (const b of partial?.content ?? []) {
			if (b.type === "toolCall") rows.set(String(b.id), structuredClone(b) as never);
		}
	}
	return [...rows.values()];
}

let savedHome: string | undefined;
beforeEach(() => {
	spawnMock.mockReset();
	execFileMock.mockReset();
	// The text path lists sessions via execFile; fail fast like a missing kiro.
	execFileMock.mockImplementation((...args: unknown[]) => (args.at(-1) as (e: Error) => void)(new Error("no kiro")));
	_resetSessions();
	process.env.PI_KIRO_CHAT_FORMAT = "stream-json";
	savedHome = process.env.HOME;
	process.env.HOME = mkdtempSync(join(tmpdir(), "pi-kiro-sj-home-"));
});
afterEach(() => {
	delete process.env.PI_KIRO_CHAT_FORMAT;
	process.env.HOME = savedHome;
});

describe("format selection", () => {
	it("passes --output-format stream-json on top of the text path's arguments, keeping the sentinel prompt", async () => {
		scriptAttempts({ stdout: probe("p2-resume.jsonl") });
		await collect();
		const args = spawnMock.mock.calls[0]?.[1] as string[];
		expect(args.slice(0, 7)).toEqual(["chat", "--no-interactive", "--trust-all-tools", "--agent-engine", "v2", "--output-format", "stream-json"]);
		expect(args.at(-1)).toContain(FINAL_OPEN);
	});

	it("text (and unset) does not pass the flag", async () => {
		for (const value of ["text", " ", undefined]) {
			spawnMock.mockReset();
			if (value === undefined) delete process.env.PI_KIRO_CHAT_FORMAT;
			else process.env.PI_KIRO_CHAT_FORMAT = value;
			scriptAttempts({ stdout: `> ${FINAL_OPEN}ok${FINAL_CLOSE}\n` });
			await collect();
			expect(spawnMock.mock.calls[0]?.[1]).not.toContain("--output-format");
		}
	});

	it("an unknown value fails the turn without spawning kiro", async () => {
		process.env.PI_KIRO_CHAT_FORMAT = "json";
		const events = await collect();
		expect(errorOf(events)).toBe('unknown PI_KIRO_CHAT_FORMAT "json" (expected text or stream-json)');
		expect(spawnMock).not.toHaveBeenCalled();
	});
});

describe("probe replays", () => {
	it("p1: one kiro_read row with full rawInput; no sentinel in the capture, so the answer is all message text", async () => {
		scriptAttempts({ stdout: probe("p1-builtin.jsonl"), chunkBytes: 7 });
		const events = await collect();
		const rows = rowsOf(events);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: "kiro_read", id: "kiro-live-tooluse_hZWyHXuzY0mAGUa4LGYFX5" });
		expect(rows[0]?.arguments.operations).toEqual([{ mode: "Line", path: "note.txt" }]);
		expect(answerOf(events)).toBe("STARTING\n\nLet me read the file:PELICAN");
		// The row announces itself as a toolCall, once, instead of as a
		// "⚙ <tool>" line in the thinking feed on top of the row (announceToolRow).
		expect(events.filter((e) => e.type === "toolcall_end").map((e) => (e as { toolCall: { name: string }}).toolCall.name)).toEqual(["kiro_read"]);
		expect(thinkingOf(events)).not.toContain("⚙ kiro_read");
		expect(thinkingOf(events)).not.toContain('{"type"');
		// Display-only: pi never sees the rows.
		expect(doneOf(events).content.filter((b) => b.type === "toolCall")).toHaveLength(0);
	});

	it("p1 with the sentinel: the answer is the <pi_final> span", async () => {
		scriptAttempts({
			stdout: STARTED + chunk("Let me read the file:") + chunk(`${FINAL_OPEN}PELI`) + chunk(`CAN${FINAL_CLOSE}`) + FINISHED("x"),
		});
		expect(answerOf(await collect())).toBe("PELICAN");
	});

	it("p3: a row for the update-only failed read with one failed marker; the non-zero shell is not marked", async () => {
		scriptAttempts({ stdout: probe("p3-toolerr.jsonl"), chunkBytes: 13 });
		const events = await collect();
		expect(rowsOf(events).map((r) => r.name)).toEqual(["kiro_read", "kiro_shell"]);
		const thinking = thinkingOf(events);
		expect(thinking.match(/⚙ kiro_read — failed/g)).toHaveLength(1);
		expect(thinking).not.toContain("kiro_shell — failed");
		expect(answerOf(events)).toBe("I'll execute both steps as requested.DONE");
	});

	it("p4 (trimmed) and p5 complete; credits are priced from the last meteringUsage", async () => {
		process.env.PI_KIRO_CREDIT_USD = "1";
		scriptAttempts({ stdout: probe("p4-long.trimmed.jsonl"), chunkBytes: 64 });
		const p4 = await collect();
		expect(answerOf(p4).startsWith("1 2 3 4 5")).toBe(true);
		scriptAttempts({ stdout: probe("p5-thought.jsonl") });
		const p5 = await collect();
		expect(answerOf(p5)).toContain("The ball costs $0.05.");
		const p5Credits = doneOf(p5).usage.cost.total;
		expect(p5Credits).toBeGreaterThan(0);
		delete process.env.PI_KIRO_CREDIT_USD;
	});

	it("records the exact credit sum, the LAST context percent and the turn duration", async () => {
		scriptAttempts({ stdout: probe("p5-thought.jsonl") });
		const metering = readMeteringDiagnostic(doneOf(await collect()).diagnostics);
		expect(metering).toMatchObject({ source: "chat-stream-json", precision: "exact", turnDurationMs: 1746 });
		// Full wire precision, not the footer's two decimals.
		expect(metering?.credits).toBeCloseTo(0.016001363051, 10);
		// p5 carries five metadata events: 1.1368, 5.684, 5.684, 8.7425, 8.7425.
		// The turn ends at 8.7425, so a first-wins read would be wrong by 7.6 points.
		expect(metering?.contextPercent).toBeCloseTo(8.7425, 4);
	});

	it("reassembles a UTF-8 sequence split across stdout chunks", async () => {
		scriptAttempts({ stdout: STARTED + chunk("naïve ⚙ café") + FINISHED("naïve ⚙ café"), chunkBytes: 3 });
		expect(answerOf(await collect())).toBe("naïve ⚙ café");
	});

	it("thought chunks stream to the thinking feed but are not the answer", async () => {
		const thought = line({ type: "sessionUpdate", data: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } } } });
		scriptAttempts({ stdout: STARTED + thought + chunk("answer") + FINISHED("answer") });
		const events = await collect();
		expect(thinkingOf(events)).toContain("pondering");
		expect(answerOf(events)).toBe("answer");
	});

	it("ignores unknown event types and sessionUpdate subtypes", async () => {
		const odd = line({ type: "somethingNew", data: {} }) + line({ type: "sessionUpdate", data: { update: { sessionUpdate: "plan", entries: [] } } });
		scriptAttempts({ stdout: STARTED + odd + chunk("ok") + FINISHED("ok") });
		expect(answerOf(await collect())).toBe("ok");
	});

	it("an update that brings rawInput to an empty row fills it under the same id", async () => {
		const call = line({ type: "sessionUpdate", data: { update: { sessionUpdate: "tool_call", toolCallId: "t1", _meta: { kiro: { toolName: "doctor", mcpServerName: "gsdworkflow" } } } } });
		const update = line({ type: "sessionUpdate", data: { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { scope: "all" } } } });
		scriptAttempts({ stdout: STARTED + call + update + chunk("ok") + FINISHED("ok") });
		const events = await collect();
		expect(rowsOf(events)).toEqual([{ type: "toolCall", id: "kiro-live-t1", name: "gsd_doctor", arguments: { scope: "all" } }]);
		expect(events.some((e) => e.type === "toolcall_delta")).toBe(true);
	});
});

describe("strict envelope", () => {
	const hint = "; set PI_KIRO_CHAT_FORMAT=text to use the text transport.";
	it.each([
		[
			"a wrong payloadSchema",
			line({ type: "runStarted", data: { payloadSchema: "acp2", acpProtocolVersion: 1, engine: "v2" } }),
			"kiro-cli stream-json envelope not recognized (payloadSchema=acp2, acpProtocolVersion=1, engine=v2; expected acp, 1, v2)",
		],
		[
			"a wrong engine",
			line({ type: "runStarted", data: { payloadSchema: "acp", acpProtocolVersion: 1, engine: "v3" } }),
			"kiro-cli stream-json envelope not recognized (payloadSchema=acp, acpProtocolVersion=1, engine=v3; expected acp, 1, v2)",
		],
		["a missing runStarted", line({ type: "metadata", data: {} }), 'kiro-cli stream-json did not open with runStarted (line 1: {"type":"metadata","data":{}})'],
		["a garbage line", `${STARTED}not json at all\n`, "kiro-cli stream-json line 2 is not JSON: not json at all"],
	])("fails on %s, naming what was seen", async (_label, stdout, message) => {
		scriptAttempts({ stdout: stdout + chunk("ignored") + FINISHED("ignored") });
		expect(errorOf(await collect())).toBe(message + hint);
	});

	it("kills a child that keeps running after a violation", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const children = scriptAttempts({ stdout: "garbage\n", hang: true });
		const pending = collect();
		await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());
		children[0]?.emit("exit", 143);
		expect(errorOf(await pending)).toContain("kiro-cli stream-json line 1 is not JSON: garbage");
		killSpy.mockRestore();
	});

	it("fails when stdout ends with neither runFinished nor runError", async () => {
		scriptAttempts({ stdout: STARTED + chunk("half") });
		expect(errorOf(await collect())).toBe(`kiro-cli stream-json ended without runFinished or runError (exit 0)${hint}`);
	});
});

describe("terminal events and precedence", () => {
	const bridge = async () =>
		({ url: "http://127.0.0.1:1/mcp", urlWithToken: "http://127.0.0.1:1/mcp/t", token: "t", toolNames: [], close: async () => undefined }) as never;
	const runError = (stage: string, message: string) => line({ type: "runError", data: { sessionId: null, stage, message } });

	it("runFinished success wins over a non-zero exit code", async () => {
		scriptAttempts({ stdout: STARTED + chunk("ok") + FINISHED("ok"), exitCode: 1 });
		expect(answerOf(await collect())).toBe("ok");
	});

	it("a non-success runFinished fails with its status", async () => {
		scriptAttempts({ stdout: STARTED + line({ type: "runFinished", data: { status: "cancelled", finalText: "" } }) });
		expect(errorOf(await collect())).toBe("kiro-cli run finished with status cancelled");
	});

	it("a runError on a fresh attempt fails with its stage and message", async () => {
		scriptAttempts({ stdout: probe("p2b-badresume.jsonl"), exitCode: 1 });
		expect(errorOf(await collect())).toBe(
			'kiro-cli run failed (init): Internal error: "Failed to start session: Session not found: 00000000-0000-0000-0000-000000000000"',
		);
	});

	it("a runError at init on a resume attempt drops the session and retries with full context", async () => {
		const prior: Message[] = [USER, { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 } as never];
		recordKnownSession("stale-session", process.cwd(), prior);
		const context = { systemPrompt: "", messages: [...prior, { role: "user", content: "again", timestamp: 2 } as Message] };
		scriptAttempts({ stdout: probe("p2b-badresume.jsonl"), exitCode: 1 }, { stdout: STARTED + chunk("ok") + FINISHED("ok") });
		const events = await collect(context);
		expect(answerOf(events)).toBe("ok");
		expect(spawnMock.mock.calls[0]?.[1]).toContain("--resume-id");
		expect(spawnMock.mock.calls[1]?.[1]).not.toContain("--resume-id");
		expect(thinkingOf(events)).toContain("[kiro resume failed -- retrying with full context]");
	});

	it("exit 3 with only runStarted is the MCP-startup retry, not an envelope error", async () => {
		scriptAttempts({ stdout: STARTED, exitCode: 3 }, { stdout: STARTED + chunk("ok") + FINISHED("ok") });
		const events = await collect(undefined, bridge);
		expect(answerOf(events)).toBe("ok");
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});

	it("exit 3 alongside a runError still retries", async () => {
		scriptAttempts({ stdout: STARTED + runError("mcp", "server failed"), exitCode: 3 }, { stdout: STARTED + chunk("ok") + FINISHED("ok") });
		expect(answerOf(await collect(undefined, bridge))).toBe("ok");
	});

	it("exit 3 once the retries are spent is the missing-terminal failure", async () => {
		scriptAttempts({ stdout: STARTED, exitCode: 3 }, { stdout: STARTED, exitCode: 3 }, { stdout: STARTED, exitCode: 3 });
		expect(errorOf(await collect(undefined, bridge))).toContain("kiro-cli stream-json ended without runFinished or runError (exit 3)");
	});
});

describe("session bookkeeping and traces", () => {
	it("records the session kiro reported, without listing sessions", async () => {
		scriptAttempts({ stdout: probe("p1-builtin.jsonl") });
		await collect();
		expect(execFileMock).not.toHaveBeenCalled();
		const next = [USER, { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1 } as never, { role: "user", content: "more", timestamp: 2 } as Message];
		expect(planTurn(process.cwd(), next)).toMatchObject({ mode: "resume", resumeId: "52b3985c-f47b-46c0-a4c2-ceee5bcf287b" });
	});

	it("traces the format on identity and prompt sends, and a finalText mismatch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-kiro-sj-trace-"));
		process.env.PI_KIRO_TRACE = join(dir, "t.jsonl");
		resetTraceTarget();
		try {
			scriptAttempts({ stdout: STARTED + chunk("ab") + FINISHED("abc") });
			expect(answerOf(await collect())).toBe("ab");
			const lines = readFileSync(join(dir, "t.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(lines.find((e) => e.event === "identity")?.format).toBe("stream-json");
			expect(lines.find((e) => e.event === "chat.prompt.send")?.format).toBe("stream-json");
			expect(lines.find((e) => e.event === "chat.stream.finaltext_mismatch")).toMatchObject({ finalTextChars: 3, messageChars: 2 });
		} finally {
			delete process.env.PI_KIRO_TRACE;
			resetTraceTarget();
		}
	});
});

describe("default format by kiro-cli version", () => {
	const VERSIONS: Array<[string | undefined, boolean]> = [
		["2.32.0", true],
		["2.100.0", true],
		["2.21.4", true],
		["2.21.4-beta", true],
		["2.21.3", false],
		["2.9.0", false],
		["not-a-version", false],
		[undefined, false],
	];

	it.each(VERSIONS)("supportsStreamJson(%s) is %s (numeric, not lexicographic)", (version, expected) => {
		expect(supportsStreamJson(version)).toBe(expected);
	});

	/** Run one turn with PI_KIRO_CHAT_FORMAT set to `format`, restoring it afterwards. */
	async function flagFor(format: string | undefined, kiroVersion: string | undefined): Promise<boolean> {
		spawnMock.mockReset();
		const previous = process.env.PI_KIRO_CHAT_FORMAT;
		try {
			if (format === undefined) delete process.env.PI_KIRO_CHAT_FORMAT;
			else process.env.PI_KIRO_CHAT_FORMAT = format;
			scriptAttempts({ stdout: STARTED + chunk("ok") + FINISHED("ok") });
			const stream = makeStreamViaKiro({ binaryPath: "kiro-cli", kiroVersion })(MODEL, { systemPrompt: "", messages: [USER] });
			for await (const _event of stream) {
				// drain
			}
			return ((spawnMock.mock.calls[0]?.[1] as string[] | undefined) ?? []).includes("--output-format");
		} finally {
			if (previous === undefined) delete process.env.PI_KIRO_CHAT_FORMAT;
			else process.env.PI_KIRO_CHAT_FORMAT = previous;
		}
	}

	it("unset or empty: stream-json at or above 2.21.4, text below or when unparseable; explicit values win; unknown never spawns", async () => {
		for (const [version, supported] of VERSIONS) {
			for (const unset of [undefined, "", "  "]) expect(await flagFor(unset, version), `${String(unset)} @ ${String(version)}`).toBe(supported);
			expect(await flagFor("stream-json", version), `stream-json @ ${String(version)}`).toBe(true);
			expect(await flagFor("text", version), `text @ ${String(version)}`).toBe(false);
			await flagFor("json", version);
			expect(spawnMock, `json @ ${String(version)}`).not.toHaveBeenCalled();
		}
	});

	it("writes exactly one chat.format.fallback trace per process, with the version (null when unparseable)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-kiro-sj-fallback-"));
		const tracePath = join(dir, "t.jsonl");
		process.env.PI_KIRO_TRACE = tracePath;
		resetTraceTarget();
		const fallbacks = () =>
			readFileSync(tracePath, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
				.filter((e) => e.event === "chat.format.fallback");
		try {
			_resetChatFormatFallback();
			await flagFor(undefined, "2.20.0");
			await flagFor(undefined, "2.20.0");
			await flagFor(undefined, "2.32.0");
			expect(fallbacks()).toEqual([expect.objectContaining({ kiroVersion: "2.20.0", floor: "2.21.4" })]);
			_resetChatFormatFallback();
			await flagFor(undefined, "garbage");
			expect(fallbacks().at(-1)).toMatchObject({ kiroVersion: null, floor: "2.21.4" });
		} finally {
			delete process.env.PI_KIRO_TRACE;
			resetTraceTarget();
			_resetChatFormatFallback();
		}
	});
});
