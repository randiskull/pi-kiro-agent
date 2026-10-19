/**
 * Route conformance: an answer is painted exactly once, on every route.
 *
 * The property is route-wide, so it is tested route-wide. When it lived in one
 * suite per transport, the chat/stream-json suite never asserted it and shipped
 * an answer printed twice while the other two routes passed. Here the matrix is
 * keyed by KIRO_ROUTES, which identity.ts derives from its transport and format
 * lists: a new route fails the coverage check below until it gets a driver, so
 * it cannot pass by omission.
 *
 * There are two observers, and each is asserted separately:
 *
 * - The TUI draws the message SNAPSHOT (interactive mode re-renders
 *   `event.message` on every message_update), so the final message must carry
 *   the answer once, in the text block, with no copy in thinking.
 * - json/RPC consumers concatenate the DELTAS, so the text_delta payloads must
 *   add up to the answer once, with no sentinel tag and no credits footer.
 *
 * The fixtures use the ugly shapes on purpose, because the simple ones hid
 * every bug this suite was written for: a span padded with newlines (extractFinal
 * trims it; a streamed "\nanswer\n" did not), tags split across chunk
 * boundaries, and a retry whose abandoned attempt died INSIDE its span.
 */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAcpSessions } from "../src/acp-session.js";
import { _resetAcpChildren, makeStreamViaAcp } from "../src/acp-transport.js";
import { KIRO_ROUTES } from "../src/identity.js";
import { _resetSessions } from "../src/session-manager.js";
import { FINAL_CLOSE, FINAL_OPEN, makeStreamViaKiro } from "../src/stream-adapter.js";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
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
const CONTEXT: Context = { systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] };

// Internal whitespace must survive the edge trim; only the span's edges go.
const ANSWER = "line one\n\n  line two";
const NARRATION = "Reading the file first.";
const SPAN = `${FINAL_OPEN}\n${ANSWER}\n${FINAL_CLOSE}`;
const ABANDONED = "HALF-WRITTEN";

/** Split `text` at the given offsets, so tags straddle chunk boundaries. */
function splitAt(text: string, offsets: number[]): string[] {
	const cuts = [0, ...offsets.filter((o) => o > 0 && o < text.length).sort((a, b) => a - b), text.length];
	return cuts.slice(1).map((end, i) => text.slice(cuts[i], end));
}
/** Cut mid-way through each tag and once inside the answer. */
const uglyChunks = (text: string): string[] => {
	const open = text.indexOf(FINAL_OPEN);
	const close = text.indexOf(FINAL_CLOSE);
	return splitAt(text, [open + 4, open + FINAL_OPEN.length + 6, close + 5]);
};

class FakeChatChild extends EventEmitter {
	pid = 4242;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn(() => this.emit("exit", 130));
}

/** One chat attempt per entry: stdout chunks, then an exit code. */
function scriptChat(...attempts: Array<{ chunks: string[]; exitCode?: number }>): void {
	spawnMock.mockImplementation(() => {
		const attempt = attempts.shift() ?? { chunks: [] };
		const child = new FakeChatChild();
		queueMicrotask(() => {
			for (const chunk of attempt.chunks) child.stdout.emit("data", Buffer.from(chunk, "utf8"));
			child.stdout.emit("end");
			queueMicrotask(() => child.emit("exit", attempt.exitCode ?? 0));
		});
		return child;
	});
}

/** A bridge whose only job is to make the chat transport write a profile, which arms the exit-3 retry. */
const bridgeDeps = () => ({
	getBridge: async () =>
		({
			url: "http://127.0.0.1:6666/mcp",
			urlWithToken: "http://127.0.0.1:6666/mcp/tok",
			token: "tok",
			toolNames: ["rpiv_todo"],
			toolAliases: { rpiv_todo: "todo" },
			close: vi.fn(async () => undefined),
		}) as never,
});

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

// ─── stream-json wire ─────────────────────────────────────────────────────────

const jsonLine = (event: unknown) => `${JSON.stringify(event)}\n`;
const SJ_STARTED = jsonLine({ type: "runStarted", data: { payloadSchema: "acp", acpProtocolVersion: 1, engine: "v2" } });
const sjMessage = (text: string) =>
	jsonLine({ type: "sessionUpdate", data: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const SJ_METADATA = jsonLine({ type: "metadata", data: { sessionId: "s1", contextUsagePercentage: 2, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 10 } });
const SJ_FINISHED = jsonLine({ type: "runFinished", data: { sessionId: "s1", status: "success", stopReason: "end_turn", finalText: "x", finalTextTruncated: false } });

// ─── ACP wire ─────────────────────────────────────────────────────────────────

/** A kiro-cli acp child that answers the handshake by method and plays `turn` on session/prompt. */
class FakeAcpChild extends EventEmitter {
	pid = 9999;
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin: Writable;
	kill = vi.fn(() => this.end(130));

	constructor(turn: (sessionId: string) => object[]) {
		super();
		let buffer = "";
		const sessionId = "conformance-session";
		this.stdin = new Writable({
			write: (chunk, _encoding, callback) => {
				buffer += chunk.toString();
				for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (line) this.answer(JSON.parse(line), sessionId, turn);
				}
				callback();
			},
		});
		for (const handle of [this, this.stdin, this.stdout, this.stderr] as Array<{ ref?: () => void; unref?: () => void }>) {
			handle.ref = () => undefined;
			handle.unref = () => undefined;
		}
	}

	private send(message: object): void {
		this.stdout.push(`${JSON.stringify(message)}\n`);
	}

	private answer(msg: { id?: number; method?: string }, sessionId: string, turn: (sessionId: string) => object[]): void {
		if (msg.id === undefined) return;
		const reply = (result: object) => this.send({ jsonrpc: "2.0", id: msg.id, result });
		switch (msg.method) {
			case "initialize":
				reply({
					protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} },
					authMethods: [],
					agentInfo: { name: "Kiro CLI Agent", version: "test" },
				});
				return;
			case "session/new":
				reply({
					sessionId,
					modes: { currentModeId: "kiro_default", availableModes: [] },
					models: { currentModelId: "claude-sonnet-4.5", availableModels: [{ modelId: "auto", name: "auto", description: "" }] },
				});
				this.send({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId, commands: [] } });
				return;
			case "session/prompt":
				for (const notification of turn(sessionId)) this.send(notification);
				reply({ stopReason: "end_turn" });
				return;
			default:
				reply({});
		}
	}

	end(code = 0): void {
		this.stdout.push(null);
		queueMicrotask(() => this.emit("exit", code));
	}
}

const acpUpdate = (sessionId: string, sessionUpdate: string, text: string) => ({
	jsonrpc: "2.0",
	method: "session/update",
	params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } },
});

// ─── The matrix ───────────────────────────────────────────────────────────────

interface RouteDriver {
	/** A turn whose narration is NARRATION and whose answer is SPAN, in ugly chunks. */
	answer(): Promise<AssistantMessageEvent[]>;
	/**
	 * A first attempt that dies inside its span after streaming ABANDONED, then a
	 * clean retry. A route with no whole-turn retry names why instead.
	 */
	retry: (() => Promise<AssistantMessageEvent[]>) | { unsupported: string };
}

const TEXT_FOOTER = "\n ▸ Credits: 0.01 • Time: 1s\n";

const DRIVERS: Record<string, RouteDriver> = {
	acp: {
		// ACP has no sentinel protocol: the answer is the message channel and the
		// narration is the thought channel. Tags are still sent, because a model
		// carried over from a chat session may emit them and they must be stripped.
		async answer() {
			spawnMock.mockImplementationOnce(
				() =>
					new FakeAcpChild((sessionId) => [
						acpUpdate(sessionId, "agent_thought_chunk", NARRATION),
						...uglyChunks(SPAN).map((chunk) => acpUpdate(sessionId, "agent_message_chunk", chunk)),
						{
							jsonrpc: "2.0",
							method: "_kiro.dev/metadata",
							params: { sessionId, contextUsagePercentage: 2, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 10 },
						},
					]),
			);
			return drain(makeStreamViaAcp({ binaryPath: "kiro-cli" })(MODEL, CONTEXT));
		},
		retry: { unsupported: "ACP holds one session per child and never re-sends a turn" },
	},
	"chat/text": {
		async answer() {
			process.env.PI_KIRO_CHAT_FORMAT = "text";
			scriptChat({ chunks: [...uglyChunks(`> ${NARRATION}${SPAN}`), TEXT_FOOTER] });
			return drain(makeStreamViaKiro({ binaryPath: "kiro-cli" })(MODEL, CONTEXT));
		},
		async retry() {
			process.env.PI_KIRO_CHAT_FORMAT = "text";
			scriptChat(
				{ chunks: [`> ${NARRATION}${FINAL_OPEN}\n${ABANDONED}`], exitCode: 3 },
				{ chunks: [...uglyChunks(`> ${NARRATION}${SPAN}`), TEXT_FOOTER] },
			);
			return drain(makeStreamViaKiro({ binaryPath: "kiro-cli", ...bridgeDeps() })(MODEL, CONTEXT));
		},
	},
	"chat/stream-json": {
		async answer() {
			process.env.PI_KIRO_CHAT_FORMAT = "stream-json";
			scriptChat({ chunks: [SJ_STARTED, ...uglyChunks(`${NARRATION}${SPAN}`).map(sjMessage), SJ_METADATA, SJ_FINISHED] });
			return drain(makeStreamViaKiro({ binaryPath: "kiro-cli" })(MODEL, CONTEXT));
		},
		async retry() {
			process.env.PI_KIRO_CHAT_FORMAT = "stream-json";
			scriptChat(
				// No runFinished: the attempt died, so the exit-3 retry applies.
				{ chunks: [SJ_STARTED, sjMessage(`${NARRATION}${FINAL_OPEN}\n${ABANDONED}`)], exitCode: 3 },
				{ chunks: [SJ_STARTED, ...uglyChunks(`${NARRATION}${SPAN}`).map(sjMessage), SJ_METADATA, SJ_FINISHED] },
			);
			return drain(makeStreamViaKiro({ binaryPath: "kiro-cli", ...bridgeDeps() })(MODEL, CONTEXT));
		},
	},
};

// ─── Observers ────────────────────────────────────────────────────────────────

function finalMessage(events: AssistantMessageEvent[]): AssistantMessage {
	const done = events.find((e) => e.type === "done");
	if (done?.type !== "done") throw new Error(`expected done, got ${JSON.stringify(events.find((e) => e.type === "error"))}`);
	return done.message;
}
const deltas = (events: AssistantMessageEvent[], type: "text_delta" | "thinking_delta") =>
	events.filter((e) => e.type === type).map((e) => (e as { delta: string }).delta);

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** What the TUI draws: the answer once, as the answer, and nowhere else. */
function expectSnapshotPaintedOnce(message: AssistantMessage): void {
	const texts = message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
	expect(texts).toEqual([ANSWER]);
	const thinking = message.content.filter((b) => b.type === "thinking").map((b) => (b as { thinking: string }).thinking).join("");
	expect(thinking).toContain(NARRATION);
	expect(thinking).not.toContain("line two");
	expect(thinking).not.toContain(FINAL_OPEN);
	const drawn = message.content.map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : "")).join("\n");
	expect(occurrences(drawn, "line two")).toBe(1);
}

/** No delta may carry a sentinel tag or the credits footer into the answer. */
function expectCleanTextDeltas(texts: string[]): void {
	for (const delta of texts) {
		expect(delta).not.toContain("<pi_");
		expect(delta).not.toContain("</pi_");
		expect(delta).not.toContain("Credits");
	}
}

describe("route conformance: an answer is painted exactly once", () => {
	let savedFormat: string | undefined;
	let savedWorkspaceSettings: string | undefined;
	beforeEach(() => {
		spawnMock.mockReset();
		execFileMock.mockReset();
		// The text path lists sessions via execFile; fail fast like a missing kiro.
		execFileMock.mockImplementation((...args: unknown[]) => (args.at(-1) as (e: Error) => void)(new Error("no kiro")));
		_resetSessions();
		_resetAcpSessions();
		_resetAcpChildren();
		savedFormat = process.env.PI_KIRO_CHAT_FORMAT;
		// The retry case mounts a bridge profile; keep it out of this checkout's .kiro/.
		savedWorkspaceSettings = process.env.PI_KIRO_WORKSPACE_SETTINGS;
		process.env.PI_KIRO_WORKSPACE_SETTINGS = "off";
	});
	afterEach(() => {
		if (savedFormat === undefined) delete process.env.PI_KIRO_CHAT_FORMAT;
		else process.env.PI_KIRO_CHAT_FORMAT = savedFormat;
		if (savedWorkspaceSettings === undefined) delete process.env.PI_KIRO_WORKSPACE_SETTINGS;
		else process.env.PI_KIRO_WORKSPACE_SETTINGS = savedWorkspaceSettings;
	});

	it("covers every route, so a new one cannot pass by omission", () => {
		expect(Object.keys(DRIVERS).sort()).toEqual([...KIRO_ROUTES].sort());
	});

	describe.each(KIRO_ROUTES.map((route) => [route]))("%s", (route) => {
		const driver: RouteDriver | undefined = DRIVERS[route];
		// The coverage test above names the missing route, but describe.each
		// registers this block first: without the guard, a route with no driver
		// would crash registration on `driver.retry` instead of failing as a test.
		if (!driver) {
			it("has a driver", () => {
				throw new Error(`no driver for route "${route}": add one to DRIVERS in test/painted-once.test.ts`);
			});
			return;
		}

		it("draws the answer once in the snapshot", async () => {
			expectSnapshotPaintedOnce(finalMessage(await driver.answer()));
		});

		it("streams text deltas that add up to the answer exactly once", async () => {
			const events = await driver.answer();
			const texts = deltas(events, "text_delta");
			expectCleanTextDeltas(texts);
			expect(texts.join("")).toBe(ANSWER);
			// ...and the answer never streams through the thinking feed.
			expect(deltas(events, "thinking_delta").join("")).not.toContain("line two");
		});

		const retry = driver.retry;
		if (typeof retry === "function") {
			it("a retry abandoned inside its span leaves no trace in the answer", async () => {
				const events = await retry();
				expect(spawnMock).toHaveBeenCalledTimes(2);
				expectSnapshotPaintedOnce(finalMessage(events));
				const texts = deltas(events, "text_delta");
				expectCleanTextDeltas(texts);
				// A delta already sent cannot be retracted, so the abandoned
				// attempt's text stays in the delta history; text_end carries the
				// authoritative answer. What must hold is that the retry starts
				// clean: everything after the abandoned text is the answer, once.
				const afterAbandoned = texts.join("").split(ABANDONED).at(-1);
				expect(afterAbandoned).toBe(ANSWER);
				const textEnd = events.find((e) => e.type === "text_end") as { content: string } | undefined;
				expect(textEnd?.content).toBe(ANSWER);
			});
		} else {
			it.skip(`a retry abandoned inside its span: not applicable (${retry.unsupported})`, () => undefined);
		}
	});
});
