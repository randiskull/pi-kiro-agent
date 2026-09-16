/**
 * Parity test suite for the ACP transport.
 *
 * Re-runs all stream-adapter.test.ts scenarios against makeStreamViaAcp,
 * using protocol-level NDJSON fakes instead of spawn mocks.
 * Also covers ACP-specific behaviors: session/update event shapes,
 * MCP tool-call events, credits from meteringUsage, session reuse, abort.
 *
 * Mock architecture: instead of mocking spawn(), we intercept the child
 * process stdin/stdout pair using an AcpScriptChild that speaks NDJSON.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Writable } from "node:stream";
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAcpSessions } from "../src/acp-session.js";
import { _getAcpChildRegistry, _resetAcpChildren, makeStreamViaAcp } from "../src/acp-transport.js";

// ─── Spawn mock ───────────────────────────────────────────────────────────────

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// ─── Model fixture ────────────────────────────────────────────────────────────

const MODEL: Model<any> = {
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

// ─── NDJSON fake child ────────────────────────────────────────────────────────

/**
 * Simulates a kiro-cli acp child process.
 * The test script drives it by calling:
 *   - acpChild.sendLine(msg) — emit a NDJSON message on stdout
 *   - acpChild.awaitLine() — await the next NDJSON message written to stdin
 *   - acpChild.end(code?) — emit "exit" event
 */
class AcpScriptChild extends EventEmitter {
	pid = 9999;
	stdin: Writable;
	stdout: PassThrough;
	stderr: PassThrough;

	/**
	 * Event-loop keepalive audit trail: every ref/unref the transport performs,
	 * in order, tagged with the handle it targeted ("child", "stdin", …).
	 * Real ChildProcess handles and piped stdio sockets carry ref/unref; the
	 * stream fakes used here do not, so we attach spies.
	 */
	refOps: string[] = [];

	private _stdinLines: string[] = [];
	private _stdinWaiters: Array<(line: string) => void> = [];
	private _stdinBuf = "";

	constructor() {
		super();
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		// Capture stdin writes and buffer into NDJSON lines
		const self = this;
		this.stdin = new Writable({
			write(chunk, _enc, cb) {
				self._stdinBuf += chunk.toString();
				let nl: number;
				while ((nl = self._stdinBuf.indexOf("\n")) !== -1) {
					const line = self._stdinBuf.slice(0, nl);
					self._stdinBuf = self._stdinBuf.slice(nl + 1);
					if (line.trim()) {
						if (self._stdinWaiters.length > 0) {
							self._stdinWaiters.shift()!(line);
						} else {
							self._stdinLines.push(line);
						}
					}
				}
				cb();
			},
		});
		this.instrumentRef("child", this);
		this.instrumentRef("stdin", this.stdin);
		this.instrumentRef("stdout", this.stdout);
		this.instrumentRef("stderr", this.stderr);
	}

	/** Attach ref/unref spies to a handle so setChildKeepalive calls are observable. */
	private instrumentRef(name: string, handle: object): void {
		const target = handle as { ref?: () => void; unref?: () => void };
		target.ref = () => void this.refOps.push(name + ":ref");
		target.unref = () => void this.refOps.push(name + ":unref");
	}

	/** The last op recorded per handle, e.g. { child: "unref", stdout: "unref" }. */
	lastRefOps(): Record<string, string> {
		const last: Record<string, string> = {};
		for (const op of this.refOps) {
			const [name, verb] = op.split(":");
			last[name] = verb;
		}
		return last;
	}

	/** Emit a NDJSON line on stdout (server → client). */
	sendLine(msg: object): void {
		this.stdout.push(JSON.stringify(msg) + "\n");
	}

	/** Await the next NDJSON line written to stdin (client → server). */
	awaitLine(): Promise<unknown> {
		if (this._stdinLines.length > 0) {
			return Promise.resolve(JSON.parse(this._stdinLines.shift()!));
		}
		return new Promise((resolve) => {
			this._stdinWaiters.push((line) => resolve(JSON.parse(line)));
		});
	}

	/** Terminate the child. */
	end(code = 0): void {
		this.stdout.push(null);
		queueMicrotask(() => this.emit("exit", code));
	}

	kill = vi.fn((signal?: string) => {
		this.end(signal === "SIGKILL" ? 137 : 130);
	});
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;
const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as Message;

type AcpDeps = Parameters<typeof makeStreamViaAcp>[0];

async function collect(
	context: Context,
	options?: { signal?: AbortSignal; reasoning?: string },
	deps: AcpDeps = { binaryPath: "kiro-cli" },
): Promise<AssistantMessageEvent[]> {
	const stream = makeStreamViaAcp(deps)(MODEL, context, options as never);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** The transport does `bridge.close().catch(...)`, so the spy must be thenable. */
const makeCloseSpy = () => vi.fn(() => Promise.resolve());

/** One recorded getBridge() call: the signal it was handed and its close spy. */
interface BridgeCall {
	signal: AbortSignal;
	close: ReturnType<typeof makeCloseSpy>;
}

/**
 * Deps whose getBridge hands back a fake HttpBridgeHandle and records the
 * AbortSignal it was given. The signal is the whole point of the F1 tests:
 * serveBridgeHttp uses it both to shut the HTTP server down and as the
 * cancellation signal for every bridged tool.execute call.
 */
function makeBridgeDeps(): { calls: BridgeCall[]; deps: AcpDeps } {
	const calls: BridgeCall[] = [];
	const getBridge = async (signal: AbortSignal) => {
		const close = makeCloseSpy();
		calls.push({ signal, close });
		return {
			url: "http://127.0.0.1:1/mcp",
			urlWithToken: "http://127.0.0.1:1/mcp/fake-token",
			token: "fake-token",
			toolNames: ["todo"],
			close,
		} as never;
	};
	return { calls, deps: { binaryPath: "kiro-cli", getBridge } };
}

/** Let the transport's post-turn `finally` and any pending microtasks settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Answer initialize + session/new, then report every MCP server named in the
 * session/new params as initialized and emit commands/available — i.e. pass the
 * startup gate for whatever server set the transport actually mounted. Returns
 * the mcpServers array so tests can assert on the bridge mount.
 */
async function passStartupGate(
	child: AcpScriptChild,
	sessionId: string,
	{ handshake = true }: { handshake?: boolean } = {},
): Promise<Array<{ name: string }>> {
	if (handshake) {
		const initReq = (await child.awaitLine()) as { id: number };
		child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: {
			protocolVersion: 1,
			agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} },
			authMethods: [],
			agentInfo: { name: "Kiro CLI Agent", version: "test" },
		}});
	}
	const sessionReq = (await child.awaitLine()) as { id: number; params: { mcpServers: Array<{ name: string }> } };
	child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
	for (const server of sessionReq.params.mcpServers) {
		child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/mcp/server_initialized", params: { sessionId, serverName: server.name }});
	}
	child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId, commands: [] }});
	return sessionReq.params.mcpServers;
}

function doneText(events: AssistantMessageEvent[]): string {
	const done = events.find((e) => e.type === "done");
	if (done?.type !== "done") throw new Error("expected done event");
	const block = done.message.content.find((b) => b.type === "text");
	return block && "text" in block ? block.text : "";
}

/**
 * Drive a complete ACP conversation: wire spawn mock, handle handshake,
 * then deliver a turn. Returns the events from collect().
 *
 * This is the primary test helper — it drives the full conversation
 * concurrently with collect() to avoid timing races.
 */
async function driveConversation(
	context: Context,
	{
		sessionId = "test-session-1",
		text = "ok",
		credits = 0.01,
		options,
		beforePrompt,
	}: {
		sessionId?: string;
		text?: string;
		credits?: number;
		options?: { signal?: AbortSignal; reasoning?: string };
		/** Called just before the session/prompt is answered — use to inspect it */
		beforePrompt?: (req: unknown) => void | Promise<void>;
	} = {},
): Promise<AssistantMessageEvent[]> {
	const child = new AcpScriptChild();
	spawnMock.mockImplementationOnce(() => child);

	// Drive the handshake and turn — started BEFORE collect() so the driver
	// is waiting at awaitLine() when the transport writes its first message.
	void (async () => {		// Handle initialize
		const initReq = (await child.awaitLine()) as { id: number; method: string };
		child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: {
			protocolVersion: 1,
			agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} },
			authMethods: [],
			agentInfo: { name: "Kiro CLI Agent", version: "test" },
		}});
		// Handle session/new
		const sessionReq = (await child.awaitLine()) as { id: number; method: string };
		child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/subagent/list_update", params: { subagents: [] }});
		child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
		child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId, commands: [] }});
		// Handle session/prompt
		const promptReq = (await child.awaitLine()) as { id: number; method: string };
		if (beforePrompt) await beforePrompt(promptReq);
		await deliverTurn(child, sessionId, text, credits);
		child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
		child.end();
	})();

	// Collect events — started AFTER driver is set up
	return collect(context, options);
}

/** Deliver a complete turn response given a sessionId and text — called AFTER the prompt request has been read. */
async function deliverTurn(child: AcpScriptChild, sessionId: string, text: string, credits = 0.01): Promise<void> {
	// Send context metadata
	child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId, contextUsagePercentage: 1.0 }});
	// Send text chunks (split by word, each chunk ends with space for easy reconstruction)
	for (const chunk of text.split(" ").filter(Boolean)) {
		child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk + " " } }}});
	}
	// Final metadata with credits
	child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId, contextUsagePercentage: 1.5, meteringUsage: [{ value: credits, unit: "credit" }], turnDurationMs: 1000 }});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("makeStreamViaAcp", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		_resetAcpSessions();
		_resetAcpChildren();
	});

	describe("protocol compliance (parity with chat transport)", () => {
		it("sends protocolVersion: 1 (integer) at initialize", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			let capturedInitParams: unknown;
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number; params?: unknown };
				capturedInitParams = initReq.params;
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-1", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-1", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-1", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();
			await collect({ messages: [user("hello")] });
			expect((capturedInitParams as { protocolVersion?: unknown })?.protocolVersion).toBe(1);
		});

		it("uses 'prompt' field (not 'content') in session/prompt", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			let capturedPromptParams: unknown;
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-2", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-2", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number; params?: unknown };
				capturedPromptParams = promptReq.params;
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-2", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-2", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();
			await collect({ messages: [user("hello")] });
			expect((capturedPromptParams as { prompt?: unknown; content?: unknown })?.prompt).toBeDefined();
			expect((capturedPromptParams as { prompt?: unknown; content?: unknown })?.content).toBeUndefined();
		});

		it("maps 'end_turn' stopReason to 'stop'", async () => {
			const events = await driveConversation({ messages: [user("hello")] }, { sessionId: "sess-3" });
			const done = events.find((e) => e.type === "done");
			expect(done?.type === "done" && done.message.stopReason).toBe("stop");
		});

		it("accumulates agent_message_chunk text into final text block", async () => {
			const events = await driveConversation({ messages: [user("count")] }, { sessionId: "sess-4", text: "one two three" });
			expect(doneText(events)).toContain("one");
			expect(doneText(events)).toContain("two");
			expect(doneText(events)).toContain("three");
		});

		it("streams agent_message_chunk events as thinking_delta events", async () => {
			const events = await driveConversation({ messages: [user("hi")] }, { sessionId: "sess-5", text: "word1 word2" });
			expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
		});

		it("does NOT use sentinel, cleanBody, or extractFinal", async () => {
			const sentinelText = "This is the final answer without any sentinel wrapper";
			const events = await driveConversation({ messages: [user("hi")] }, { sessionId: "sess-6", text: sentinelText });
			// The transport should NOT strip sentinel markers — the text IS the final answer
			expect(doneText(events).trim()).toContain("This is the final answer");
		});
	});

	describe("credits from meteringUsage (parity: chat transport parsed ▸ Credits footer)", () => {
		it("extracts credits from _kiro.dev/metadata.meteringUsage and scales by PI_KIRO_CREDIT_USD", async () => {
			process.env.PI_KIRO_CREDIT_USD = "2";
			const events = await driveConversation({ messages: [user("hi")] }, { sessionId: "sess-c1", credits: 0.03 });
			delete process.env.PI_KIRO_CREDIT_USD;
			const done = events.find((e) => e.type === "done");
			expect(done?.type === "done" && done.message.usage.cost.total).toBeCloseTo(0.06);
		});

		it("sums multiple meteringUsage entries", async () => {
			process.env.PI_KIRO_CREDIT_USD = "1";
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-c2", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-c2", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-c2", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-c2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" }}}});
				// Final metadata with TWO credit entries (model + tool)
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-c2", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.04, unit: "credit" }, { value: 0.02, unit: "credit" }], turnDurationMs: 1000 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();
			const events = await collect({ messages: [user("hi")] });
			delete process.env.PI_KIRO_CREDIT_USD;
			const done = events.find((e) => e.type === "done");
			expect(done?.type === "done" && done.message.usage.cost.total).toBeCloseTo(0.06);
		});
	});

	describe("tool-call events (parity: chat transport synthesized from log lines)", () => {
		it("surfaces tool_call session/update events as ToolCall content blocks", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-t1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-t1", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-t1", contextUsagePercentage: 1.0 }});
				// Tool call event
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-t1", update: {
					sessionUpdate: "tool_call", toolCallId: "tooluse_abc", title: "Running: @mcp/my_tool",
					rawInput: { arg: "val" }, _meta: { kiro: { toolName: "my_tool", mcpServerName: "mcp" }},
				}}});
				// Tool call update
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-t1", update: {
					sessionUpdate: "tool_call_update", toolCallId: "tooluse_abc", status: "completed", rawOutput: { result: "done" },
				}}});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-t1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Tool called" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-t1", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.05, unit: "credit" }], turnDurationMs: 2000 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();
			const events = await collect({ messages: [user("use a tool")] });
			const done = events.find((e) => e.type === "done");
			expect(done?.type).toBe("done");
			if (done?.type === "done") {
				const toolCalls = done.message.content.filter((b) => b.type === "toolCall");
				expect(toolCalls).toHaveLength(1);
				expect((toolCalls[0] as { name: string }).name).toBe("my_tool");
				expect(done.message.stopReason).toBe("stop");
			}
		});

		it("tool_call events surface in partial message content during the turn (commit 802a6a1 parity)", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);

			void (async () => {
				// Handshake
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-live1",
					modes: { currentModeId: "kiro_default", availableModes: [] },
					models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available",
					params: { sessionId: "sess-live1", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata",
					params: { sessionId: "sess-live1", contextUsagePercentage: 1.0 }});
				// Emit tool_call BEFORE the session/prompt response
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-live1",
					update: { sessionUpdate: "tool_call", toolCallId: "tooluse_live1", title: "Running: @mcp/live_tool",
						rawInput: { q: "test" }, _meta: { kiro: { toolName: "live_tool", mcpServerName: "mcp" } } }}});
				// agent_message_chunk after tool_call triggers a thinking_delta carrying the updated partial
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-live1",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-live1",
					contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 500 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();

			const events: AssistantMessageEvent[] = [];
			const stream = makeStreamViaAcp({ binaryPath: "kiro-cli" })(MODEL, { messages: [user("use live_tool")] }, undefined as never);
			let toolCallAppearedBeforeDone = false;
			let doneReached = false;
			for await (const event of stream) {
				events.push(event);
				if (event.type === "done") {
					doneReached = true;
				} else if (!doneReached && event.type === "thinking_delta") {
					// tool_call blocks are pushed to output.content synchronously in the session/update
					// handler; the next thinking_delta (from the following agent_message_chunk) carries
					// the updated partial — assert that partial contains a toolCall block
					if (event.partial.content.some((b) => b.type === "toolCall")) {
						toolCallAppearedBeforeDone = true;
					}
				}
			}

			// Guard: at least one thinking_delta must have fired — if none fired,
			// toolCallAppearedBeforeDone would be vacuously false and the next
			// assertion gives a misleading failure site
			expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
			// toolCall block must be visible in a partial BEFORE the done event
			expect(toolCallAppearedBeforeDone).toBe(true);
			// And must still be in the final done event
			const done = events.find((e) => e.type === "done");
			expect(done?.type === "done" && done.message.content.some((b) => b.type === "toolCall")).toBe(true);
		});
	});

	describe("abort (parity: chat transport killed the process group)", () => {
		it("abort signal kills the acp child and emits 'aborted' stop reason", async () => {
			const child = new AcpScriptChild();
			const controller = new AbortController();
			// Abort BEFORE handshake completes to test the abort path
			spawnMock.mockImplementationOnce(() => {
				// Abort immediately after spawn
				queueMicrotask(() => {
					queueMicrotask(() => controller.abort());
				});
				return child;
			});
			// Don't drive handshake — the abort should fire before it completes
			const events = await collect({ messages: [user("hi")] }, { signal: controller.signal });
			const error = events.find((e) => e.type === "error");
			expect(error?.type === "error" && error.error.stopReason).toBe("aborted");
			// VN5: abort is SIGTERM-only — no session/cancel JSON-RPC must be sent
			// (session/cancel returns -32601 "not implemented" in kiro-cli 2.16.0).
			// The transport uses process.kill(-pid, "SIGTERM") on macOS, so child.kill()
			// is not the right spy — check stdin instead for absence of session/cancel.
			// Since abort fired before the handshake, stdin lines should be only the
			// initialize request (no session/cancel can have been sent).
			const lines = (child as unknown as { _stdinLines: string[] })._stdinLines;
			const hasCancelRpc = lines.some((l) => {
				try { return (JSON.parse(l) as { method?: string }).method === "session/cancel"; }
				catch { return false; }
			});
			expect(hasCancelRpc).toBe(false);
		});
	});

	describe("error handling", () => {
		it("surfaces 'profileArn is required' with the kiro-cli profile remedy", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: {
					protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" }
				}});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, error: { code: -32603, message: "profileArn is required for this request" }});
				child.end(1);
			})();
			const events = await collect({ messages: [user("hi")] });
			const error = events.find((e) => e.type === "error");
			expect(error?.type === "error" && error.error.errorMessage).toContain("kiro-cli profile");
		});

		it("surfaces session/prompt errors as error events", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-e1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-e1", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-e1", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, error: { code: -32603, message: "Internal error" }});
				child.end();
			})();
			const events = await collect({ messages: [user("hi")] });
			const error = events.find((e) => e.type === "error");
			expect(error?.type === "error").toBe(true);
			expect(error?.type === "error" && error.error.stopReason).toBe("error");
		});
	});

	describe("startSession error cleanup (VN6: listener leak fix)", () => {
		it("session/new error response removes the _kiro.dev/commands/available listener", async () => {
			// Regression test for: startSession() left a dangling _kiro.dev/commands/available
			// listener (offCmd inside the Promise constructor was unreachable from error paths).
			// Fix: capture offCmdRef outside the Promise constructor; call offCmd() on every
			// error path before throwing.
			//
			// Verification strategy: after session/new returns an error, inspect the AcpChild's
			// `listeners` Map directly via the _getAcpChildRegistry() test hook. The child exit
			// handler does NOT clear the listeners Map (it only clears entry.pending), so the
			// Map state from the error path is still readable after child.end(1) fires.
			//
			// If offCmd() was called on the error path, entry.listeners.get(
			// "_kiro.dev/commands/available") will be an empty Set (size 0) — the handler was
			// deleted. If offCmd() was NOT called (the pre-fix bug), the Set would still contain
			// the handler function (size >= 1).
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);

			// Drive the error: session/new returns an error response.
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({
					jsonrpc: "2.0",
					id: initReq.id,
					result: {
						protocolVersion: 1,
						agentCapabilities: {
							loadSession: true,
							mcpCapabilities: { http: true, sse: false },
							sessionCapabilities: {},
							auth: {},
						},
						authMethods: [],
						agentInfo: { name: "Kiro", version: "test" },
					},
				});
				const sessionReq = (await child.awaitLine()) as { id: number };
				// Respond to session/new with an error — this is the path that previously
				// left the _kiro.dev/commands/available listener dangling.
				child.sendLine({
					jsonrpc: "2.0",
					id: sessionReq.id,
					error: { code: -32603, message: "session/new failed for test" },
				});
				child.end(1);
			})();

			const events = await collect({ messages: [user("hi")] });

			// 1. Observable contract: transport emits an error event (not "done").
			const error = events.find((e) => e.type === "error");
			expect(error?.type).toBe("error");
			expect(error?.type === "error" && error.error.errorMessage).toContain("session/new failed");
			expect(events.at(-1)?.type).not.toBe("done");

			// 2. Direct listeners Map inspection via the test hook.
			//    The child exit handler does NOT clear entry.listeners, so the Map state
			//    from the error path is still visible here. The entry may still be in the
			//    registry (exit handler marks alive=false but does not call registry.delete).
			//    _resetAcpChildren() (called in beforeEach) will remove it, so we must
			//    inspect before the next beforeEach runs — which we are, right now.
			const cwd = process.cwd();
			const registry = _getAcpChildRegistry();
			const entry = registry.get(cwd);
			// The entry exists (child exited but registry.delete was not called by the exit handler).
			// If it does exist, the _kiro.dev/commands/available Set must be empty (size 0):
			// offCmd() deleted the handler before throwing. A size >= 1 means offCmd() was skipped.
			if (entry !== undefined) {
				const cmdSet = entry.listeners.get("_kiro.dev/commands/available");
				// Either the key was never added back (undefined) or the Set was emptied by offCmd()
				expect(cmdSet === undefined || cmdSet.size === 0).toBe(true);
			}
			// NOTE: if entry is undefined, the child was dead-and-removed before we reach here.
			// That path also proves cleanup: a removed entry cannot have a dangling handler.
		});

		it("startup timeout cleans up BOTH notification listeners (M1 + A21)", async () => {
			// A21: exercise the MCP_STARTUP_TIMEOUT_MS path, which was previously
			// untested. It also pins M1: on the timeout path, startSession must
			// remove BOTH the server_initialized (`off`) and commands/available
			// (`offCmd`) listeners. Before the try/finally fix, the timeout
			// rejection left both attached to the long-lived child.
			//
			// Drive: initialize OK, session/new returns a valid sessionId, but the
			// server NEVER sends server_initialized or commands/available, so
			// Promise.race resolves via the timeout. A tiny PI_KIRO_MCP_STARTUP_TIMEOUT_MS
			// keeps the test fast.
			const prev = process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS;
			process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS = "20";
			try {
				const child = new AcpScriptChild();
				spawnMock.mockImplementationOnce(() => child);

				void (async () => {
					const initReq = (await child.awaitLine()) as { id: number };
					child.sendLine({
						jsonrpc: "2.0",
						id: initReq.id,
						result: {
							protocolVersion: 1,
							agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} },
							authMethods: [],
							agentInfo: { name: "Kiro", version: "test" },
						},
					});
					const sessionReq = (await child.awaitLine()) as { id: number };
					// Valid session/new response, but deliberately NO server_initialized
					// and NO commands/available → startup race resolves via timeout.
					child.sendLine({
						jsonrpc: "2.0",
						id: sessionReq.id,
						result: { sessionId: "sess-timeout", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } },
					});
					// Give the timeout time to fire, then let the child exit.
					setTimeout(() => child.end(1), 60);
				})();

				const events = await collect({ messages: [user("hi")] });

				// Observable contract: an error event mentioning the startup timeout.
				const error = events.find((e) => e.type === "error");
				expect(error?.type).toBe("error");
				expect(error?.type === "error" && error.error.errorMessage).toContain("startup timed out");
				expect(events.at(-1)?.type).not.toBe("done");

				// M1: both listener Sets must be empty (the finally removed them).
				const entry = _getAcpChildRegistry().get(process.cwd());
				if (entry !== undefined) {
					const initSet = entry.listeners.get("_kiro.dev/mcp/server_initialized");
					const cmdSet = entry.listeners.get("_kiro.dev/commands/available");
					expect(initSet === undefined || initSet.size === 0).toBe(true);
					expect(cmdSet === undefined || cmdSet.size === 0).toBe(true);
				}
			} finally {
				if (prev === undefined) delete process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS;
				else process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS = prev;
			}
		});
	});

	describe("bridge lifetime is session-scoped, not turn-scoped (Kiro review F1)", () => {
		// The module documents the loopback bridge as per-session, but both
		// getBridge call sites used to pass the caller's PER-TURN AbortSignal.
		// serveBridgeHttp consumes that signal twice — it closes the HTTP server on
		// abort, and hands the same signal to every bridged tool.execute call — so
		// the wiring decided both the bridge's lifetime and tool cancellation scope.
		// The fix passes the child's session-scoped sessionAbort.signal instead.

		it("hands getBridge a session signal, so a post-turn abort by the host leaves the bridge up", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			const controller = new AbortController();
			const { calls, deps } = makeBridgeDeps();
			let mounted: string[] = [];

			void (async () => {
				mounted = (await passStartupGate(child, "sess-f1-a")).map((server) => server.name);
				const promptReq = (await child.awaitLine()) as { id: number };
				await deliverTurn(child, "sess-f1-a", "ok");
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				// The child is deliberately left running: this test is about what a
				// post-turn host abort does to a session that is still alive.
			})();

			const events = await collect({ messages: [user("hi")] }, { signal: controller.signal }, deps);
			expect(events.find((e) => e.type === "done")).toBeDefined();
			expect(mounted).toContain("pi");
			expect(calls).toHaveLength(1);
			expect(calls[0].signal).not.toBe(controller.signal);
			expect(calls[0].signal.aborted).toBe(false);

			// A host that aborts its per-request controller as post-turn cleanup must
			// not take a live session's MCP endpoint down with it. The transport's own
			// onAbort is detached in its finally, so the child survives — but before
			// this fix the bridge's own listener was still attached to that same
			// signal, and the next turn resumed the session with a dead `pi` server.
			controller.abort();
			await settle();
			expect(calls[0].signal.aborted).toBe(false);
			expect(calls[0].close).not.toHaveBeenCalled();
		});

		it("still closes the bridge and aborts its signal when the turn is aborted in flight", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			const controller = new AbortController();
			const { calls, deps } = makeBridgeDeps();

			void (async () => {
				await passStartupGate(child, "sess-f1-b");
				await child.awaitLine(); // session/prompt — never answered
				controller.abort(); // user hits ESC mid-turn
			})();

			const events = await collect({ messages: [user("hi")] }, { signal: controller.signal }, deps);
			const error = events.find((e) => e.type === "error");
			expect(error?.type === "error" && error.error.stopReason).toBe("aborted");
			expect(calls).toHaveLength(1);
			// Abort propagation survives the move off the turn signal, one hop later:
			// onAbort → killChild → sessionAbort.abort(). That matters because the same
			// signal is what an in-flight bridged tool call (ask_user_question, Agent)
			// is cancelled through.
			expect(calls[0].signal.aborted).toBe(true);
			expect(calls[0].close).toHaveBeenCalled();
		});
	});

	describe("startSession startup-gate timeout (Kiro review F2)", () => {
		let savedTimeout: string | undefined;
		beforeEach(() => {
			savedTimeout = process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS;
			process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS = "80";
			return () => {
				if (savedTimeout === undefined) delete process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS;
				else process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS = savedTimeout;
			};
		});

		it("clears acpSessionId so the next turn takes the new-session path, not the divergence path", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementation(() => child);
			const { calls, deps } = makeBridgeDeps();

			// Turn 1: session/new succeeds — so entry.acpSessionId is assigned — and
			// then the child never reports its MCP servers initialized, so the startup
			// gate loses the race to the timeout and `ready` is never set.
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: {
					protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} },
					authMethods: [],
					agentInfo: { name: "Kiro CLI Agent", version: "test" },
				}});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-orphan", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				// Silence: no server_initialized, no commands/available.
			})();

			const events1 = await collect({ messages: [user("turn one")] }, undefined, deps);
			const error = events1.find((e) => e.type === "error");
			expect(error?.type === "error" && error.error.errorMessage).toMatch(/startup timed out/);

			// The orphaned id must be gone. recordAcpSession never ran for it, so
			// keeping it would make the next turn plan against a session nothing
			// tracks — the exact condition that routes control into the divergence
			// branch instead of the clean new-session branch.
			const entry = _getAcpChildRegistry().get(process.cwd());
			expect(entry?.ready).toBe(false);
			expect(entry?.acpSessionId).toBeUndefined();

			// A startup timeout discards the half-started SESSION, not the child.
			// Nothing on this path calls killChild, so the session controller is
			// untouched and its bridge is still up — which is precisely what lets
			// turn 2 recover on the same child.
			expect(calls[0].signal.aborted).toBe(false);
			expect(calls[0].close).not.toHaveBeenCalled();

			// Turn 2 on the same, still-live child. The child is deliberately NOT
			// ended here: an exit would abort sessionAbort via the child exit handler
			// and destroy the very state this test asserts on. _resetAcpChildren() in
			// beforeEach reaps it.
			void (async () => {
				await passStartupGate(child, "sess-good", { handshake: false });
				const promptReq = (await child.awaitLine()) as { id: number };
				await deliverTurn(child, "sess-good", "recovered");
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
			})();

			const events2 = await collect({ messages: [user("turn two")] }, undefined, deps);
			expect(doneText(events2)).toContain("recovered");
			expect(spawnMock).toHaveBeenCalledTimes(1); // same child, no respawn

			// Which branch turn 2 took. `!acpEntry.acpSessionId` is the predicate, and
			// the two branches leave different traces on the bridge:
			//  - new-session branch closes the stale bridge and keeps the session
			//    controller, so both getBridge calls share one signal;
			//  - divergence branch calls sessionAbort.abort() and installs a fresh
			//    controller, so calls[0].signal would be aborted and calls[1].signal
			//    would be a different object.
			expect(calls).toHaveLength(2);
			expect(calls[0].close).toHaveBeenCalled();
			expect(calls[0].signal.aborted).toBe(false);
			expect(calls[1].signal).toBe(calls[0].signal);
		});
	});

	describe("session reuse (ACP parity with --resume-id)", () => {
		it("reuses the same child for a second turn (pure append)", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementation(() => child);

			// Shared handshake driver that handles MULTIPLE prompts on the same child
			void (async () => {
				// Handshake
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-r1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-r1", commands: [] }});
				// Turn 1
				const p1 = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-r1", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-r1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply1" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-r1", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: p1.id, result: { stopReason: "end_turn" }});
				// Turn 2 (same session, child reused)
				const p2 = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-r1", contextUsagePercentage: 1.5 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-r1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply2" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-r1", contextUsagePercentage: 2.0, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: p2.id, result: { stopReason: "end_turn" }});
				child.end();
			})();

			const events1 = await collect({ messages: [user("turn one")] });
			expect(doneText(events1)).toContain("reply1");
			const events2 = await collect({ messages: [user("turn one"), assistant("reply1"), user("turn two")] });
			expect(doneText(events2)).toContain("reply2");
			// Spawn called only once (child reused for turn 2)
			expect(spawnMock).toHaveBeenCalledTimes(1);
		});

		it("creates a new session (session/new) on diverged prefix", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementation(() => child);
			let sessionNewCount = 0;

			void (async () => {
				// Handshake (first session)
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq1 = (await child.awaitLine()) as { id: number };
				sessionNewCount++;
				child.sendLine({ jsonrpc: "2.0", id: sessionReq1.id, result: { sessionId: "sess-d1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-d1", commands: [] }});
				// Turn 1
				const p1 = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-d1", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-d1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply1" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-d1", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: p1.id, result: { stopReason: "end_turn" }});
				// Turn 2 — diverged; transport should send session/new
				const req2 = (await child.awaitLine()) as { id: number; method?: string };
				if (req2.method === "session/new") {
					sessionNewCount++;
					child.sendLine({ jsonrpc: "2.0", id: req2.id, result: { sessionId: "sess-d2", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
					child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-d2", commands: [] }});
				}
				const p2 = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-d2", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-d2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply2" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-d2", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: p2.id, result: { stopReason: "end_turn" }});
				child.end();
			})();

			await collect({ messages: [user("original")] });
			await collect({ messages: [user("SUMMARY: replaced"), user("new turn")] });
			expect(sessionNewCount).toBe(2); // initial + diverged
		});
	});

	describe("event-loop keepalive (a one-shot host must be able to exit)", () => {
		// Regression: `pi -p` printed its answer under ACP and then hung until the
		// idle timeout killed the child (~10 min). The detached child handle plus
		// its three pipes each hold an event-loop reference, so the transport must
		// unreference all four whenever no request is in flight.
		it("leaves the idle child fully unreferenced once the turn settles", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-k1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-k1", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				await deliverTurn(child, "sess-k1", "done");
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				// Deliberately NOT calling child.end(): the child stays alive for reuse,
				// which is exactly the state that used to hang the host.
			})();

			const events = await collect({ messages: [user("hi")] });
			expect(doneText(events)).toContain("done");
			// The handshake referenced the child...
			expect(child.refOps).toContain("child:ref");
			// ...and settling the last request released every handle.
			expect(child.lastRefOps()).toEqual({
				child: "unref",
				stdin: "unref",
				stdout: "unref",
				stderr: "unref",
			});
		});

		it("re-references the child for a second turn, then releases it again", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementation(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-k2", modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-k2", commands: [] }});
				for (const text of ["one", "two"]) {
					const promptReq = (await child.awaitLine()) as { id: number };
					await deliverTurn(child, "sess-k2", text);
					child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				}
			})();

			await collect({ messages: [user("turn one")] });
			const afterFirst = child.refOps.length;
			await collect({ messages: [user("turn one"), assistant("one"), user("turn two")] });

			expect(spawnMock).toHaveBeenCalledTimes(1);
			// A dormant child was re-referenced rather than left unreferenced for the
			// whole second turn (which would let the host exit mid-turn).
			expect(child.refOps.slice(afterFirst)).toContain("child:ref");
			expect(child.lastRefOps()).toEqual({
				child: "unref",
				stdin: "unref",
				stdout: "unref",
				stderr: "unref",
			});
		});

		it("releases the handles when the child is killed with a request still pending", async () => {
			const child = new AcpScriptChild();
			const controller = new AbortController();
			spawnMock.mockImplementationOnce(() => {
				queueMicrotask(() => queueMicrotask(() => controller.abort()));
				return child;
			});
			// Handshake is never answered: initialize is still pending when the kill lands.
			const events = await collect({ messages: [user("hi")] }, { signal: controller.signal });
			expect(events.find((e) => e.type === "error")).toBeDefined();
			expect(child.lastRefOps()).toEqual({
				child: "unref",
				stdin: "unref",
				stdout: "unref",
				stderr: "unref",
			});
		});
	});

	describe("crash recovery and child lifecycle (VN2, VN3, VN4)", () => {
		it("child_crash_drops_sessions_and_next_turn_respawns_full_resend", async () => {
			// VN2: simulate unexpected child exit mid-idle; assert registry drops the session;
			// assert next makeStreamViaAcp call respawns a new child and issues session/new
			// with a full context resend (deltaStart === 0, not a delta against the dead session).

			// ── Turn 1: complete turn, record a session ──────────────────────────
			const child1 = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child1);
			void (async () => {
				const initReq = (await child1.awaitLine()) as { id: number };
				child1.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child1.awaitLine()) as { id: number };
				child1.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-crash1",
					modes: { currentModeId: "kiro_default", availableModes: [] },
					models: { currentModelId: "auto", availableModels: [] } }});
				child1.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available",
					params: { sessionId: "sess-crash1", commands: [] }});
				const promptReq = (await child1.awaitLine()) as { id: number };
				child1.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata",
					params: { sessionId: "sess-crash1", contextUsagePercentage: 1.0 }});
				child1.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-crash1",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply1" }}}});
				child1.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-crash1",
					contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child1.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child1.end();
			})();
			const events1 = await collect({ messages: [user("hello")] });
			expect(events1.find((e) => e.type === "done")).toBeDefined();

			// ── Simulate child crash mid-idle (emit exit without going through killChild) ──
			// The child's exit handler in spawnAcpChild sets alive=false and clears the registry
			// entry's state, but the registry key itself is kept until getOrCreateChild's staleness
			// check removes it on the next turn. Emit the exit event to trigger the exit handler.
			child1.emit("exit", 1);
			// Give the microtask queue a tick to process the exit event
			await new Promise<void>((r) => queueMicrotask(r));

			// ── Turn 2: next call must spawn a new child and send session/new (full resend) ──
			const child2 = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child2);

			let capturedPrompt2: unknown;
			let sessionNewCount = 0;

			void (async () => {
				const initReq2 = (await child2.awaitLine()) as { id: number };
				child2.sendLine({ jsonrpc: "2.0", id: initReq2.id, result: { protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const req2 = (await child2.awaitLine()) as { id: number; method?: string };
				if (req2.method === "session/new") {
					sessionNewCount++;
					child2.sendLine({ jsonrpc: "2.0", id: req2.id, result: { sessionId: "sess-crash2",
						modes: { currentModeId: "kiro_default", availableModes: [] },
						models: { currentModelId: "auto", availableModels: [] } }});
					child2.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available",
						params: { sessionId: "sess-crash2", commands: [] }});
				}
				const promptReq2 = (await child2.awaitLine()) as { id: number; params?: unknown };
				capturedPrompt2 = promptReq2.params;
				child2.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata",
					params: { sessionId: "sess-crash2", contextUsagePercentage: 1.0 }});
				child2.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-crash2",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply2" }}}});
				child2.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-crash2",
					contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child2.sendLine({ jsonrpc: "2.0", id: promptReq2.id, result: { stopReason: "end_turn" }});
				child2.end();
			})();

			// Turn 2 sends the full conversation (full context resend, not a delta)
			const msgs = [user("hello"), { role: "assistant", content: [{ type: "text", text: "reply1" }], timestamp: 0 } as unknown as Message, user("follow-up")];
			const events2 = await collect({ messages: msgs });
			expect(events2.find((e) => e.type === "done")).toBeDefined();

			// A new spawn was needed (child1 was dead)
			expect(spawnMock).toHaveBeenCalledTimes(2);
			// The new child received a session/new (not just session/prompt) — full resend
			expect(sessionNewCount).toBe(1);
			// The prompt was sent to the new session (not to the crashed one)
			expect((capturedPrompt2 as { sessionId?: string })?.sessionId).toBe("sess-crash2");
		});

		it("startSession_registers_listener_before_session_new", async () => {
			// VN3: fake child that emits _kiro.dev/commands/available SYNCHRONOUSLY
			// (within the same microtask as session/new response, before any await yields).
			// If the listener is registered BEFORE session/new is written to stdin, the
			// notification is captured and startup resolves without hitting MCP_STARTUP_TIMEOUT_MS.
			// If registered AFTER, it is missed and the test will timeout.
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);

			// Track ordering: record when session/new is written vs when commands/available fires
			const orderLog: string[] = [];

			// Monkey-patch sendLine to record when session/new arrives
			const origWrite = child.stdin.write.bind(child.stdin);
			child.stdin = new (require("node:stream").Writable)({
				write(chunk: Buffer, enc: BufferEncoding, cb: () => void) {
					const line = chunk.toString().trim();
					if (line) {
						try {
							const msg = JSON.parse(line) as { method?: string };
							if (msg.method === "session/new") orderLog.push("session/new-sent");
						} catch { /* skip */ }
					}
					origWrite(chunk, enc, cb);
				},
			}) as unknown as typeof child.stdin;

			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				// Send session/new response + commands/available in the same synchronous burst
				// to simulate the server emitting them back-to-back before any microtask yields
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-vn3",
					modes: { currentModeId: "kiro_default", availableModes: [] },
					models: { currentModelId: "auto", availableModels: [] } }});
				orderLog.push("commands/available-fired");
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available",
					params: { sessionId: "sess-vn3", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata",
					params: { sessionId: "sess-vn3", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-vn3",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-vn3",
					contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();

			// If commands/available listener was registered before session/new was sent,
			// this completes successfully without hitting MCP_STARTUP_TIMEOUT_MS
			const events = await collect({ messages: [user("test listener order")] });
			expect(events.find((e) => e.type === "done")).toBeDefined();

			// Spy-order assertion: commands/available must have been emitted AFTER session/new
			// was sent (not before) — this confirms the driver fired them in the right sequence.
			// Since we push "commands/available-fired" BEFORE sendLine delivers to stdout,
			// and "session/new-sent" is captured when stdin write() fires (which is before
			// the readline event), session/new-sent must precede commands/available-fired.
			expect(orderLog.indexOf("session/new-sent")).toBeLessThan(
				orderLog.indexOf("commands/available-fired"),
			);
		});

		it("spawnAcpChild_abort_during_initialize_kills_child_no_hang", async () => {
			// VN4: fake child that never answers initialize.
			// Fire abort mid-handshake and assert:
			//   1. The turn resolves with stopReason: "aborted" within a bounded time (no hang)
			//   2. The registry is clean (no zombie) after the turn — proven by successful re-spawn
			//
			// Spy-order note: childRegistry.set() is called BEFORE the initialize await in
			// spawnAcpChild. The abort handler in makeStreamViaAcp uses childRegistry.get(cwd)
			// to find and kill the child. If the entry were added AFTER await, the abort handler
			// would not find the child and the pending initialize request would hang. The fact
			// that the turn resolves with "aborted" (not a timeout) proves the entry existed
			// pre-await and the abort handler fired killChild, which resolves the pending request.

			const child = new AcpScriptChild();
			const controller = new AbortController();

			// Override kill to be a no-op (don't emit exit — killChild resolves pending requests
			// directly via the pending Map, so the turn still completes without child exit)
			child.kill = vi.fn((_signal?: string) => { /* intentional no-op */ }) as unknown as typeof child.kill;

			spawnMock.mockImplementationOnce(() => {
				// Abort after spawn but before initialize response — mid-handshake
				queueMicrotask(() => queueMicrotask(() => controller.abort()));
				return child;
			});

			// Collect with a generous timeout — if the transport hangs, vitest's 5s default catches it
			const events = await collect({ messages: [user("abort me")] }, { signal: controller.signal });

			// 1. Turn resolved with aborted (no hang) — proves abort handler fired during handshake
			const error = events.find((e) => e.type === "error");
			expect(error?.type === "error" && error.error.stopReason).toBe("aborted");

			// 2. Registry is clean — next getOrCreateChild won't see a zombie
			// Verify by spawning a fresh turn (should spawn a new child, not reuse dead one)
			const child2 = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child2);
			void (async () => {
				const initReq = (await child2.awaitLine()) as { id: number };
				child2.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child2.awaitLine()) as { id: number };
				child2.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-vn4-2",
					modes: { currentModeId: "kiro_default", availableModes: [] },
					models: { currentModelId: "auto", availableModels: [] } }});
				child2.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available",
					params: { sessionId: "sess-vn4-2", commands: [] }});
				const promptReq = (await child2.awaitLine()) as { id: number };
				child2.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata",
					params: { sessionId: "sess-vn4-2", contextUsagePercentage: 1.0 }});
				child2.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-vn4-2",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "clean" }}}});
				child2.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-vn4-2",
					contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child2.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child2.end();
			})();
			const events2 = await collect({ messages: [user("after abort")] });
			expect(events2.find((e) => e.type === "done")).toBeDefined();
			// A new spawn was required (zombie-free registry)
			expect(spawnMock).toHaveBeenCalledTimes(2);
		});
	});

	describe("sentinel leakage prevention (spec §3.4)", () => {
		it("prompt sent to kiro does not contain the sentinel instruction line", async () => {
			// Verify the ACP transport passes sentinel:false to buildPromptFromContext.
			// Capture what was written to stdin and check no pi_final instruction is present.
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			let capturedPromptText = "";
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-sentinel1",
					modes: { currentModeId: "kiro_default", availableModes: [] },
					models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available",
					params: { sessionId: "sess-sentinel1", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number; params?: { prompt?: Array<{ text?: string }> } };
				capturedPromptText = promptReq.params?.prompt?.[0]?.text ?? "";
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata",
					params: { sessionId: "sess-sentinel1", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-sentinel1",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-sentinel1",
					contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();
			await collect({ messages: [user("no sentinel please")] });
			// The prompt text must NOT contain the sentinel instruction
			expect(capturedPromptText).not.toContain("<pi_final>");
			expect(capturedPromptText).not.toContain("Wrap ONLY your final answer");
			// But it must still contain the standard executor preamble
			expect(capturedPromptText).toContain("You are the executor");
		});

		it("strips sentinel tags from model output when a model emits them despite no instruction", async () => {
			// Defensive strip: a model with sentinel habits from a previous chat-transport
			// session may still emit <pi_final>…</pi_final> wrappers. The ACP transport
			// must strip them from the final text so they don't leak verbatim to the caller.
			const sentinelWrapped = "<pi_final>This is the real answer</pi_final>";
			const events = await driveConversation({ messages: [user("hi")] }, {
				sessionId: "sess-sentinel2",
				text: sentinelWrapped,
			});
			const done = events.find((e) => e.type === "done");
			expect(done?.type).toBe("done");
			if (done?.type === "done") {
				const textBlock = done.message.content.find((b) => b.type === "text");
				const text = textBlock && "text" in textBlock ? textBlock.text : "";
				// Tags stripped — clean answer
				expect(text).not.toContain("<pi_final>");
				expect(text).not.toContain("</pi_final>");
				expect(text).toContain("This is the real answer");
			}
		});

		it("strips sentinel tags even when split across multiple chunks", async () => {
			// Defensive strip must work on the accumulated text, not per-chunk,
			// so split delivery (open tag in one chunk, close in another) is handled.
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-sentinel3",
					modes: { currentModeId: "kiro_default", availableModes: [] },
					models: { currentModelId: "auto", availableModels: [] } }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available",
					params: { sessionId: "sess-sentinel3", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata",
					params: { sessionId: "sess-sentinel3", contextUsagePercentage: 1.0 }});
				// Deliver sentinel wrapper split across chunks
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-sentinel3",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "<pi_final>split " }}}});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-sentinel3",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer</pi_final>" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-sentinel3",
					contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();
			const events = await collect({ messages: [user("split sentinel")] });
			const done = events.find((e) => e.type === "done");
			expect(done?.type).toBe("done");
			if (done?.type === "done") {
				const textBlock = done.message.content.find((b) => b.type === "text");
				const text = textBlock && "text" in textBlock ? textBlock.text : "";
				expect(text).not.toContain("<pi_final>");
				expect(text).not.toContain("</pi_final>");
				expect(text).toContain("split");
				expect(text).toContain("answer");
			}
		});
	});

	describe("idle/turn timeout robustness (long-running turns must not be killed as idle)", () => {
		const savedEnv: Record<string, string | undefined> = {};
		beforeEach(() => {
			savedEnv.idle = process.env.PI_KIRO_IDLE_TIMEOUT_MS;
			savedEnv.turn = process.env.PI_KIRO_TURN_TIMEOUT_MS;
			return () => {
				if (savedEnv.idle === undefined) delete process.env.PI_KIRO_IDLE_TIMEOUT_MS;
				else process.env.PI_KIRO_IDLE_TIMEOUT_MS = savedEnv.idle;
				if (savedEnv.turn === undefined) delete process.env.PI_KIRO_TURN_TIMEOUT_MS;
				else process.env.PI_KIRO_TURN_TIMEOUT_MS = savedEnv.turn;
			};
		});

		const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

		/** Handshake driver shared by the timeout tests. Returns the prompt request id. */
		async function handshake(child: AcpScriptChild, sessionId: string): Promise<number> {
			const initReq = (await child.awaitLine()) as { id: number };
			child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: {
				protocolVersion: 1,
				agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} },
				authMethods: [],
				agentInfo: { name: "Kiro CLI Agent", version: "test" },
			}});
			const sessionReq = (await child.awaitLine()) as { id: number };
			child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: { currentModelId: "auto", availableModels: [] } }});
			child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId, commands: [] }});
			const promptReq = (await child.awaitLine()) as { id: number };
			return promptReq.id;
		}

		it("turn_streaming_past_the_idle_window_survives_because_traffic_resets_the_clock", async () => {
			// Idle window far shorter than the turn; streaming chunks arrive
			// throughout. Old behavior killed the child mid-turn; traffic-based
			// reset must keep it alive to completion.
			process.env.PI_KIRO_IDLE_TIMEOUT_MS = "120";
			process.env.PI_KIRO_TURN_TIMEOUT_MS = "60000";

			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const promptId = await handshake(child, "sess-idle-1");
				// Work for ~4 idle windows, streaming a chunk each half-window.
				for (let i = 0; i < 8; i++) {
					await sleep(60);
					child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-idle-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `chunk${i} ` }}}});
				}
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-idle-1", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 480 }});
				child.sendLine({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" }});
				child.end();
			})();

			const events = await collect({ messages: [user("long streaming turn")] });
			const done = events.find((e) => e.type === "done");
			expect(done).toBeDefined();
			const err = events.find((e) => e.type === "error");
			expect(err).toBeUndefined();
		});

		it("silent_pending_turn_survives_idle_windows_but_is_killed_at_the_turn_ceiling", async () => {
			// Nothing streams after the prompt is sent. The idle window alone
			// must not kill a pending turn; the (short) turn ceiling must.
			process.env.PI_KIRO_IDLE_TIMEOUT_MS = "60";
			process.env.PI_KIRO_TURN_TIMEOUT_MS = "250";

			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				await handshake(child, "sess-silent-1");
				// Say nothing: the transport must decide when to give up.
			})();

			const start = Date.now();
			const events = await collect({ messages: [user("silent turn")] });
			const elapsed = Date.now() - start;
			const err = events.find((e) => e.type === "error");
			expect(err).toBeDefined();
			if (err?.type === "error") {
				expect(err.error.errorMessage).toMatch(/turn timeout/);
			}
			// Died at the ceiling (~250ms), not the first idle window (~60ms).
			expect(elapsed).toBeGreaterThanOrEqual(200);
		});

		it("idle_child_with_no_pending_request_is_still_killed_after_the_idle_window", async () => {
			// Complete a turn, then let the child sit idle past the window; the
			// next turn must respawn (proving the idle kill still works).
			process.env.PI_KIRO_IDLE_TIMEOUT_MS = "80";
			process.env.PI_KIRO_TURN_TIMEOUT_MS = "60000";

			const events1 = await driveConversation({ messages: [user("turn 1")] }, { sessionId: "sess-idle-kill" });
			expect(events1.find((e) => e.type === "done")).toBeDefined();

			await sleep(220); // > idle window with nothing pending

			const child2 = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child2);
			void (async () => {
				const promptId = await handshake(child2, "sess-idle-kill-2");
				child2.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-idle-kill-2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fresh" }}}});
				child2.sendLine({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" }});
				child2.end();
			})();
			const events2 = await collect({ messages: [user("turn 2")] });
			expect(events2.find((e) => e.type === "done")).toBeDefined();
			// The idle kill forced a respawn: two children total.
			expect(spawnMock).toHaveBeenCalledTimes(2);
		});
	});

	describe("ACP-specific: DoD assertions", () => {
		it("does not import or use FINAL_OPEN/FINAL_CLOSE sentinel constants", async () => {
			// Static: check the import graph
			// acp-transport.ts should not contain FINAL_OPEN or FINAL_CLOSE usage
			const fs = await import("node:fs");
			const src = fs.readFileSync(new URL("../src/acp-transport.ts", import.meta.url).pathname, "utf8");
			expect(src).not.toContain("FINAL_OPEN");
			expect(src).not.toContain("FINAL_CLOSE");
		});

		it("does not call parseKiroToolUses or synthesizeToolCallBlocks", async () => {
			const fs = await import("node:fs");
			const src = fs.readFileSync(new URL("../src/acp-transport.ts", import.meta.url).pathname, "utf8");
			expect(src).not.toContain("parseKiroToolUses");
			expect(src).not.toContain("synthesizeToolCallBlocks");
		});

		it("does not call snapshotSessions, recordFreshSession, or makeListSessions", async () => {
			const fs = await import("node:fs");
			const src = fs.readFileSync(new URL("../src/acp-transport.ts", import.meta.url).pathname, "utf8");
			expect(src).not.toContain("snapshotSessions");
			expect(src).not.toContain("recordFreshSession");
			expect(src).not.toContain("makeListSessions");
		});

		it("does not use cleanBody or extractFinal", async () => {
			const fs = await import("node:fs");
			const src = fs.readFileSync(new URL("../src/acp-transport.ts", import.meta.url).pathname, "utf8");
			expect(src).not.toContain("cleanBody");
			expect(src).not.toContain("extractFinal");
		});
	});
});
