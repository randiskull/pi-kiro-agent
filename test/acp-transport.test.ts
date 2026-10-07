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
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Writable } from "node:stream";
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAcpSessions, _acpSessionCount } from "../src/acp-session.js";
import { _getAcpChildRegistry, _resetAcpChildren, _acpRegistryKey, buildInitializeParams, isUnadvertisedClientMethod, makeStreamViaAcp } from "../src/acp-transport.js";
import { _resetPiVersionForTest, ACP_ENGINE, identityBlock } from "../src/identity.js";
import { resetTraceTarget } from "../src/trace.js";
import { VERSION as HOST_PI_VERSION } from "@earendil-works/pi-coding-agent";

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

/**
 * What a real kiro session reports at session/new (live probe 2026-10-07,
 * kiro-cli acp --agent-engine v2): a CONCRETE current model, never "auto",
 * and the ids it offers as `{ modelId, name, description }`. Fixtures that
 * report "auto" make kiro/auto skip set_model, which production never does.
 */
const KIRO_MODEL_IDS = [
	"auto", "claude-opus-5.5", "claude-sonnet-5.5", "claude-opus-5", "claude-sonnet-5",
	"claude-opus-4.8", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-opus-4.7",
	"claude-sonnet-4.6", "claude-opus-4.5", "claude-sonnet-4.5", "claude-sonnet-4",
	"claude-fable-5.1", "claude-haiku-4.5", "deepseek-3.2", "minimax-m2.5", "minimax-m2.1",
	"glm-5", "qwen3-coder-next", "agi-nova-beta-1m",
];
const KIRO_AVAILABLE_MODELS = KIRO_MODEL_IDS.map((modelId) => ({ modelId, name: modelId, description: "" }));
const SESSION_MODELS = { currentModelId: "claude-opus-4.8", availableModels: KIRO_AVAILABLE_MODELS };

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

	/**
	 * Every session/set_model this child answered itself (see constructor).
	 * Scripts that read stdin in a fixed order never see these requests.
	 */
	setModelCalls: Array<{ sessionId: unknown; modelId: unknown }> = [];

	private _stdinLines: string[] = [];
	private _stdinWaiters: Array<(line: string) => void> = [];
	private _stdinBuf = "";

	/**
	 * @param autoSetModel Answer session/set_model with `{}` here instead of
	 * queueing it for awaitLine(). On by default: with a concrete
	 * SESSION_MODELS.currentModelId every turn starts with one, and scripts
	 * written as "next line is the prompt" must not have to know.
	 */
	constructor({ autoSetModel = true }: { autoSetModel?: boolean } = {}) {
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
					if (line.trim() && autoSetModel && self.answerSetModel(line)) {
						// answered in place; not queued for the script
					} else if (line.trim()) {
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

	private answerSetModel(line: string): boolean {
		let msg: { id?: number; method?: string; params?: { sessionId?: unknown; modelId?: unknown } };
		try {
			msg = JSON.parse(line);
		} catch {
			return false;
		}
		if (msg.method !== "session/set_model" || msg.id === undefined) return false;
		this.setModelCalls.push({ sessionId: msg.params?.sessionId, modelId: msg.params?.modelId });
		queueMicrotask(() => this.sendLine({ jsonrpc: "2.0", id: msg.id, result: {} }));
		return true;
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

/** One recorded getBridge() call: the signal it was handed and its spies. */
interface BridgeCall {
	signal: AbortSignal;
	close: ReturnType<typeof makeCloseSpy>;
	/** Called by resolveSession at every session start; see the §5e.3 test. */
	rebindOrigin: ReturnType<typeof vi.fn>;
}

/**
 * Deps whose getBridge hands back a fake HttpBridgeHandle and records the
 * AbortSignal it was given. The signal is the whole point of the F1 tests:
 * serveBridgeHttp uses it both to shut the HTTP server down and as the
 * cancellation signal for every bridged tool.execute call.
 */
function makeBridgeDeps(): { calls: BridgeCall[]; deps: AcpDeps } {
	const calls: BridgeCall[] = [];
	// Each mount gets a DISTINCT port, mirroring the real bridge: serveBridgeHttp
	// listens on 0 and the OS hands out a fresh ephemeral port every time. A
	// constant url here would make "both sessions saw the same url" vacuously true
	// for the §5e.3 regression test.
	let port = 40000;
	const getBridge = async (signal: AbortSignal) => {
		const close = makeCloseSpy();
		const rebindOrigin = vi.fn();
		calls.push({ signal, close, rebindOrigin });
		const p = port++;
		return {
			url: `http://127.0.0.1:${p}/mcp`,
			urlWithToken: `http://127.0.0.1:${p}/mcp/fake-token`,
			token: "fake-token",
			toolNames: ["todo"],
			close,
			rebindOrigin,
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
	child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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
		child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-2", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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

		it("forwards options.reasoning as effort in session/prompt params", async () => {
			let capturedEffort: string | undefined;
			let capturedMethod: string | undefined;
			const events = await driveConversation(
				{ messages: [user("hello")] },
				{
					sessionId: "sess-effort-1",
					options: { reasoning: "high" },
					// Capture only; never expect() in here. beforePrompt is awaited
					// inside driveConversation's detached `void (async () => ...)()`
					// driver, so a throw leaves the prompt unanswered and collect()
					// hangs to its timeout instead of failing on the assertion.
					beforePrompt: (req: unknown) => {
						const r = req as { method?: string; params?: { effort?: string } };
						capturedMethod = r.method;
						capturedEffort = r.params?.effort;
					},
				},
			);
			expect(events.find((e) => e.type === "done")).toBeDefined();
			// Name the request we read, so a shape change fails on the method
			// itself rather than as a bare "expected undefined to be high".
			expect(capturedMethod).toBe("session/prompt");
			expect(capturedEffort).toBe("high");
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
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-c2", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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
		it("surfaces tool_call events for display but strips them from the final message", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-t1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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

			// The block MUST reach the partial: that is what drives the mid-turn
			// tool-by-tool progress display (and is asserted end-to-end by the
			// "commit 802a6a1 parity" test below).
			const partialToolCalls = events
				.flatMap((e) => ("partial" in e && e.partial ? e.partial.content : []))
				.filter((b) => b.type === "toolCall");
			expect(partialToolCalls.length).toBeGreaterThan(0);
			expect((partialToolCalls[0] as { name: string }).name).toBe("my_tool");
			// ...tagged display-only, so the strip pass can find it.
			expect((partialToolCalls[0] as { id: string }).id).toContain("kiro-live-");
			// ...and it keeps kiro's own id in the suffix so traces stay correlatable.
			expect((partialToolCalls[0] as { id: string }).id).toContain("tooluse_abc");

			const done = events.find((e) => e.type === "done");
			expect(done?.type).toBe("done");
			if (done?.type === "done") {
				// The FINAL message must carry no toolCall block. kiro already executed
				// this tool; pi dispatches any toolCall block it finds on an assistant
				// message (it keys off presence, not stopReason), so leaving one here
				// made pi run the tool a SECOND time — a bridged ask_user_question
				// raised a duplicate questionnaire card that bypassed the bridge
				// entirely, and a kiro-native tool pi does not register came back as
				// "Tool shell not found", which then fed back to kiro as a stray prompt.
				const toolCalls = done.message.content.filter((b) => b.type === "toolCall");
				expect(toolCalls).toHaveLength(0);
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
					models: SESSION_MODELS }});
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
			// ...and must be GONE from the final done event. kiro already executed the
			// tool; pi dispatches any toolCall block it finds on an assistant message,
			// so one left here made pi run it a second time. The two halves are the
			// whole point of the split: live in the partials, absent from the final.
			const done = events.find((e) => e.type === "done");
			expect(done?.type === "done" && done.message.content.some((b) => b.type === "toolCall")).toBe(false);
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
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-e1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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
			const registry = _getAcpChildRegistry();
			const entry = registry.get(_acpRegistryKey(process.cwd(), undefined));
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
						result: { sessionId: "sess-timeout", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS },
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
				const entry = _getAcpChildRegistry().get(_acpRegistryKey(process.cwd(), undefined));
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

	describe("bridge mount racing child teardown (Kiro review of the F1 fix)", () => {
		// ensureChildBridge awaits getBridge, and the first mount does real I/O
		// (serveBridgeHttp has to listen before it can report a port). teardownChild
		// is SYNCHRONOUS and clears entry.bridge / entry.bridgePromise, so it can run
		// start-to-finish inside that await window -- and the code then assigned the
		// resolved handle back onto a child that is already dead.
		//
		// The damage is not a leaked HTTP server: serveBridgeHttp closes on
		// childAbort, which teardown aborts. It is downstream. The caller advertises
		// bridge.urlWithToken in session/new.mcpServers, so kiro would be handed a
		// port nothing is listening on and every bridged tool call on that session
		// would fail with an opaque "error sending request for url".
		it("closes a bridge that resolved after teardown instead of adopting it", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			const controller = new AbortController();

			const close = makeCloseSpy();
			const rebindOrigin = vi.fn();
			let releaseMount: (() => void) | undefined;
			let mountStarted: (() => void) | undefined;
			const mountCalled = new Promise<void>((resolve) => { mountStarted = resolve; });
			// A getBridge the test can hold open, which is the whole race: the real one
			// is suspended in serveBridgeHttp's listen() for exactly this window.
			const deps: AcpDeps = {
				binaryPath: "kiro-cli",
				getBridge: async () => {
					mountStarted?.();
					await new Promise<void>((resolve) => { releaseMount = resolve; });
					return {
						url: "http://127.0.0.1:41000/mcp",
						urlWithToken: "http://127.0.0.1:41000/mcp/fake-token",
						token: "fake-token",
						toolNames: ["todo"],
						close,
						rebindOrigin,
					} as never;
				},
			};

			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: {
					protocolVersion: 1,
					agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} },
					authMethods: [],
					agentInfo: { name: "Kiro CLI Agent", version: "test" },
				}});
				// Ordering is the test: the mount is in flight and session/new has NOT
				// been sent, so nothing has learned the URL yet when the child dies.
				await mountCalled;
				controller.abort(); // host ESC -> onAbort -> killChild -> teardownChild
				releaseMount?.();
			})();

			const events = await collect({ messages: [user("hi")] }, { signal: controller.signal }, deps);
			const error = events.find((e) => e.type === "error");
			expect(error?.type === "error" && error.error.stopReason).toBe("aborted");
			await settle();

			// The handle is disowned, not adopted...
			expect(close).toHaveBeenCalledWith("child-torn-down-during-mount");
			// ...and its ctx origin is never re-pointed at a session that will never
			// exist. rebindOrigin firing here is the tell that the dead entry adopted
			// it: teardown had already cleared entry.bridge.
			expect(rebindOrigin).not.toHaveBeenCalled();
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
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-orphan", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
				// Silence: no server_initialized, no commands/available.
			})();

			const events1 = await collect({ messages: [user("turn one")] }, undefined, deps);
			const error = events1.find((e) => e.type === "error");
			expect(error?.type === "error" && error.error.errorMessage).toMatch(/startup timed out/);

			// The orphaned id must be gone. recordAcpSession never ran for it, so
			// keeping it would make the next turn plan against a session nothing
			// tracks — the exact condition that routes control into the divergence
			// branch instead of the clean new-session branch.
			const entry = _getAcpChildRegistry().get(_acpRegistryKey(process.cwd(), undefined));
			expect(entry?.ready).toBe(false);
			expect(entry?.acpSessionId).toBeUndefined();
			// Captured for the branch check after turn 2: the new-session branch reuses
			// this controller, the divergence branch replaces it.
			const sessionAbortBefore = entry?.sessionAbort;

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

			// Which branch turn 2 took. `!acpEntry.acpSessionId` is the predicate. The
			// bridge no longer discriminates: it is child-scoped now and BOTH branches
			// reuse it, because kiro cannot be told a new URL (§5e.3). So the
			// discriminator is the session controller:
			//  - new-session branch reuses it (this path discards a session that never
			//    reached `ready`, so no bridged call can be in flight to cancel);
			//  - divergence branch aborts it and installs a replacement.
			expect(entry?.sessionAbort).toBe(sessionAbortBefore);
			expect(sessionAbortBefore?.signal.aborted).toBe(false);
			// One bridge for the life of the child, still the one turn 1 mounted.
			expect(calls).toHaveLength(1);
			expect(calls[0].close).not.toHaveBeenCalled();
		});
	});

	describe("session reuse (ACP parity with --resume-id)", () => {
		it("reuses the same child for a second turn (pure append)", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementation(() => child);
			const promptTexts: string[] = [];

			// Shared handshake driver that handles MULTIPLE prompts on the same child
			void (async () => {
				// Handshake
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-r1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-r1", commands: [] }});
				// Turn 1
				const p1 = (await child.awaitLine()) as { id: number; params: { prompt: Array<{ text: string }> } };
				promptTexts.push(p1.params.prompt[0]?.text ?? "");
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-r1", contextUsagePercentage: 1.0 }});
				child.sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-r1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply1" }}}});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: { sessionId: "sess-r1", contextUsagePercentage: 1.5, meteringUsage: [{ value: 0.01, unit: "credit" }], turnDurationMs: 100 }});
				child.sendLine({ jsonrpc: "2.0", id: p1.id, result: { stopReason: "end_turn" }});
				// Turn 2 (same session, child reused)
				const p2 = (await child.awaitLine()) as { id: number; params: { prompt: Array<{ text: string }> } };
				promptTexts.push(p2.params.prompt[0]?.text ?? "");
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
			// Turn 2 is a delta (no replayed history) and still restates the identity first.
			expect(promptTexts).toHaveLength(2);
			expect(promptTexts[1]).not.toContain("<conversation_history>");
			for (const text of promptTexts) expect(text.startsWith("<identity>")).toBe(true);
		});

		it("a resumed delta carries another provider's answer, but not kiro's own (P1)", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementation(() => child);
			const promptTexts: string[] = [];
			void (async () => {
				await passStartupGate(child, "sess-p1");
				for (const reply of ["KIRO-A1", "A3"]) {
					const p = (await child.awaitLine()) as { id: number; params: { prompt: Array<{ text: string }> } };
					promptTexts.push(p.params.prompt[0]?.text ?? "");
					await deliverTurn(child, "sess-p1", reply);
					child.sendLine({ jsonrpc: "2.0", id: p.id, result: { stopReason: "end_turn" }});
				}
			})();

			const stamped = (text: string, provider: string): Message =>
				({ ...(assistant(text) as object), provider }) as unknown as Message;
			await collect({ messages: [user("turn one")] });
			await collect({
				messages: [
					user("turn one"),
					stamped("KIRO-A1", "kiro"),
					user("turn two"),
					stamped("BEDROCK-A2", "amazon-bedrock"),
					user("turn three"),
				],
			});

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(promptTexts).toHaveLength(2);
			const delta = promptTexts[1];
			expect(delta).not.toContain("<conversation_history>");
			const u2 = delta.indexOf("<user_message>\nturn two\n</user_message>");
			const a2 = delta.indexOf("<assistant_message>\nBEDROCK-A2\n</assistant_message>");
			const u3 = delta.indexOf("<user_message>\nturn three\n</user_message>");
			expect(u2).toBeGreaterThan(-1);
			expect(a2).toBeGreaterThan(u2);
			expect(u3).toBeGreaterThan(a2);
			expect(delta).not.toContain("KIRO-A1");
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
				child.sendLine({ jsonrpc: "2.0", id: sessionReq1.id, result: { sessionId: "sess-d1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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
					child.sendLine({ jsonrpc: "2.0", id: req2.id, result: { sessionId: "sess-d2", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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

		it("keeps one bridge URL across a divergence reset, so kiro never calls a dead port", async () => {
			// Regression, docs/design/acp-transport.md §5e.3. kiro learns the bridge
			// URL once, from the mcpServers array in session/new, and has no way to be
			// told a new one. The divergence branch used to close the bridge and mount
			// a replacement on a fresh ephemeral port: kiro accepted the new session
			// but kept the MCP client it had already built for the server named "pi",
			// still pointed at the closed port, so every bridged tool call for the rest
			// of the conversation failed with
			// `error sending request for url (http://127.0.0.1:59808/mcp/...)`.
			// Observed live as steer_subagent and get_subagent_result failing while
			// native tools (read, glob) kept working.
			const child = new AcpScriptChild();
			spawnMock.mockImplementation(() => child);
			const { calls, deps } = makeBridgeDeps();
			const urlsPerSession: Array<string | undefined> = [];

			const answerSessionNew = (req: { id: number; params: { mcpServers: Array<{ name: string; url?: string }> } }, sessionId: string) => {
				urlsPerSession.push(req.params.mcpServers.find((s) => s.name === "pi")?.url);
				child.sendLine({ jsonrpc: "2.0", id: req.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
				for (const server of req.params.mcpServers) {
					child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/mcp/server_initialized", params: { sessionId, serverName: server.name }});
				}
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId, commands: [] }});
			};

			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				answerSessionNew((await child.awaitLine()) as never, "sess-b1");
				const p1 = (await child.awaitLine()) as { id: number };
				await deliverTurn(child, "sess-b1", "reply1");
				child.sendLine({ jsonrpc: "2.0", id: p1.id, result: { stopReason: "end_turn" }});
				// Turn 2 diverges, so the transport sends a second session/new.
				answerSessionNew((await child.awaitLine()) as never, "sess-b2");
				const p2 = (await child.awaitLine()) as { id: number };
				await deliverTurn(child, "sess-b2", "reply2");
				child.sendLine({ jsonrpc: "2.0", id: p2.id, result: { stopReason: "end_turn" }});
			})();

			await collect({ messages: [user("original")] }, undefined, deps);
			const entry = _getAcpChildRegistry().get(_acpRegistryKey(process.cwd(), undefined));
			const sessionAbortBefore = entry?.sessionAbort;

			await collect({ messages: [user("SUMMARY: replaced"), user("new turn")] }, undefined, deps);

			// Both sessions were handed the SAME url — the whole point.
			expect(urlsPerSession).toHaveLength(2);
			expect(urlsPerSession[0]).toBeDefined();
			expect(urlsPerSession[1]).toBe(urlsPerSession[0]);
			// One mount for the life of the child, never closed, its lifetime signal
			// untouched by the reset.
			expect(calls).toHaveLength(1);
			expect(calls[0].close).not.toHaveBeenCalled();
			expect(calls[0].signal.aborted).toBe(false);
			// The URL is per CHILD, but the session a bridged tool runs against is per
			// SESSION: every session start must re-point the handle's ctx origin, or
			// session two keeps executing bridged tools against session one's
			// ExtensionContext (src/index.ts _makeBridgeCtxBinding). Once per
			// session/new, so a rebind missing from either branch of resolveSession
			// leaves this at 1.
			expect(calls[0].rebindOrigin).toHaveBeenCalledTimes(2);
			// The reset still did its real job: the SESSION controller was retired, so
			// bridged calls the discarded session had in flight are cancelled.
			expect(sessionAbortBefore?.signal.aborted).toBe(true);
			expect(entry?.sessionAbort).not.toBe(sessionAbortBefore);
			expect(entry?.sessionAbort.signal.aborted).toBe(false);
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
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-k1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-k2", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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
					models: SESSION_MODELS }});
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
						models: SESSION_MODELS }});
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
					models: SESSION_MODELS }});
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
			// spawnAcpChild. The abort handler in makeStreamViaAcp uses childRegistry.get(key)
			// (the composite (cwd, conversationKey) key) to find and kill the child. If the entry
			// were added AFTER await, the abort handler would not find the child and the pending
			// initialize request would hang. The fact
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
					models: SESSION_MODELS }});
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
					models: SESSION_MODELS }});
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
					models: SESSION_MODELS }});
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
			child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
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

	describe("per-conversation children (subagent isolation) + maxChildren cap", () => {
		/** Drive a child through the handshake to a PENDING session/prompt; resolves
		 *  with the prompt request id (the turn is left in flight, unanswered). */
		async function driveToPendingPrompt(child: AcpScriptChild, sessionId: string): Promise<number> {
			const initReq = (await child.awaitLine()) as { id: number };
			child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
			const sessionReq = (await child.awaitLine()) as { id: number };
			child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
			child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId, commands: [] }});
			const promptReq = (await child.awaitLine()) as { id: number };
			return promptReq.id;
		}

		it("gives conversations with different system prompts their own child", async () => {
			// Parent and subagent differ only in system prompt; each must resolve to
			// its own kiro child, keyed by (cwd, conversationKey).
			await driveConversation({ systemPrompt: "You are the PARENT.", messages: [user("hi")] } as Context, { sessionId: "sess-convA" });
			await driveConversation({ systemPrompt: "You are a SUBAGENT.", messages: [user("hi")] } as Context, { sessionId: "sess-convB" });

			expect(spawnMock).toHaveBeenCalledTimes(2);
			const reg = _getAcpChildRegistry();
			expect(reg.size).toBe(2);
			expect(reg.has(_acpRegistryKey(process.cwd(), "You are the PARENT."))).toBe(true);
			expect(reg.has(_acpRegistryKey(process.cwd(), "You are a SUBAGENT."))).toBe(true);
		});

		it("keys pi-normalized contexts (pi >= 0.86) by their leading system prompt", async () => {
			// pi >= 0.86 passes a TranscriptContext with NO systemPrompt field. Keying
			// on context.systemPrompt hashed every conversation in a cwd to one key.
			await driveConversation(normalizeContext({ systemPrompt: "You are the PARENT.", messages: [user("hi")] }) as unknown as Context, { sessionId: "sess-tcA" });
			await driveConversation(normalizeContext({ systemPrompt: "You are a SUBAGENT.", messages: [user("hi")] }) as unknown as Context, { sessionId: "sess-tcB" });

			const reg = _getAcpChildRegistry();
			expect(reg.has(_acpRegistryKey(process.cwd(), "You are the PARENT."))).toBe(true);
			expect(reg.has(_acpRegistryKey(process.cwd(), "You are a SUBAGENT."))).toBe(true);
			expect(reg.has(_acpRegistryKey(process.cwd(), undefined))).toBe(false);
		});

		it("a subagent turn's abort does not terminate the parent's in-flight turn", async () => {
			// The bug this whole change fixes: parent + subagent shared one cwd-keyed
			// child, so aborting the subagent's turn rejected the parent's pending
			// request with `acp child terminated: aborted`. With per-conversation
			// children the parent's turn must survive the subagent's abort untouched.
			const parent = new AcpScriptChild();
			const sub = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => parent).mockImplementationOnce(() => sub);

			// Park the parent at a pending prompt (turn in flight, unanswered).
			let parentPromptId = -1;
			const parentDriver = (async () => {
				parentPromptId = await driveToPendingPrompt(parent, "sess-parent");
			})();
			const parentEventsP = collect({ systemPrompt: "PARENT", messages: [user("parent turn")] } as Context);
			await parentDriver;

			// Now run the subagent turn to a pending prompt, then abort it.
			const subAbort = new AbortController();
			const subDriver = (async () => {
				await driveToPendingPrompt(sub, "sess-sub"); // never answered
				subAbort.abort();
			})();
			const subEvents = await collect(
				{ systemPrompt: "SUBAGENT", messages: [user("subagent turn")] } as Context,
				{ signal: subAbort.signal },
			);
			await subDriver;

			// Subagent turn aborted…
			const subErr = subEvents.find((e) => e.type === "error");
			expect(subErr?.type === "error" && subErr.error.stopReason).toBe("aborted");
			// …and it spawned a SECOND child (distinct key), not reused the parent's.
			expect(spawnMock).toHaveBeenCalledTimes(2);
			// The parent's child is still registered and was not killed.
			expect(_getAcpChildRegistry().has(_acpRegistryKey(process.cwd(), "PARENT"))).toBe(true);

			// Complete the parent turn: it must succeed, proving its pending request
			// was never rejected by the subagent's abort.
			await deliverTurn(parent, "sess-parent", "parent done");
			parent.sendLine({ jsonrpc: "2.0", id: parentPromptId, result: { stopReason: "end_turn" }});
			parent.end();
			const parentEvents = await parentEventsP;
			expect(doneText(parentEvents)).toContain("parent done");
			expect(parentEvents.find((e) => e.type === "error")).toBeUndefined();
		});

		it("evicts the LRU idle child when PI_KIRO_MAX_CHILDREN is reached", async () => {
			const prev = process.env.PI_KIRO_MAX_CHILDREN;
			process.env.PI_KIRO_MAX_CHILDREN = "2";
			try {
				// Two idle children fill the cap (A created before B → A is LRU).
				await driveConversation({ systemPrompt: "A", messages: [user("a")] } as Context, { sessionId: "sess-cap-a" });
				await driveConversation({ systemPrompt: "B", messages: [user("b")] } as Context, { sessionId: "sess-cap-b" });
				// A third conversation forces eviction of the LRU idle child (A).
				await driveConversation({ systemPrompt: "C", messages: [user("c")] } as Context, { sessionId: "sess-cap-c" });

				expect(spawnMock).toHaveBeenCalledTimes(3);
				const reg = _getAcpChildRegistry();
				// Cap honored (env=2, not the default 32) AND the oldest idle child evicted.
				expect(reg.size).toBe(2);
				expect(reg.has(_acpRegistryKey(process.cwd(), "A"))).toBe(false);
				expect(reg.has(_acpRegistryKey(process.cwd(), "B"))).toBe(true);
				expect(reg.has(_acpRegistryKey(process.cwd(), "C"))).toBe(true);
			} finally {
				if (prev === undefined) delete process.env.PI_KIRO_MAX_CHILDREN;
				else process.env.PI_KIRO_MAX_CHILDREN = prev;
			}
		});

		it("reclaims a dead (torn-down) entry instead of counting it toward the cap", async () => {
			// Regression: the idle/turn-timeout path calls killChild (alive=false)
			// but the entry can linger in the registry until its key is deleted. A
			// dead zombie must NOT count toward maxChildren — ensureChildCapacity
			// reclaims it, so a new conversation still gets its own child rather than
			// being wrongly rejected/evicted at the cap.
			const prev = process.env.PI_KIRO_MAX_CHILDREN;
			process.env.PI_KIRO_MAX_CHILDREN = "1";
			try {
				const reg = _getAcpChildRegistry();
				// Seed a dead entry occupying the cap-of-1 slot (as a timeout teardown
				// would leave it: alive=false, no pending requests).
				const deadKey = _acpRegistryKey(process.cwd(), "DEAD");
				reg.set(deadKey, { alive: false, pending: new Map() } as unknown as ReturnType<typeof reg.get> & object);
				expect(reg.size).toBe(1);

				// A new conversation at the cap: the dead entry is reclaimed (not a
				// spurious "all children busy" throw), and the live child is created.
				await driveConversation({ systemPrompt: "LIVE", messages: [user("hi")] } as Context, { sessionId: "sess-reclaim" });

				expect(reg.has(deadKey)).toBe(false); // zombie reclaimed
				expect(reg.has(_acpRegistryKey(process.cwd(), "LIVE"))).toBe(true);
				expect(reg.size).toBe(1); // cap honored — the dead one did not inflate it
			} finally {
				if (prev === undefined) delete process.env.PI_KIRO_MAX_CHILDREN;
				else process.env.PI_KIRO_MAX_CHILDREN = prev;
			}
		});

		it("rejects a new conversation when at the cap and every child is busy", async () => {
			const prev = process.env.PI_KIRO_MAX_CHILDREN;
			process.env.PI_KIRO_MAX_CHILDREN = "1";
			try {
				// One busy child fills the cap-of-1 (turn left pending → not evictable).
				const a = new AcpScriptChild();
				spawnMock.mockImplementationOnce(() => a);
				let aPromptId = -1;
				const aDriver = (async () => { aPromptId = await driveToPendingPrompt(a, "sess-busy-a"); })();
				const aEventsP = collect({ systemPrompt: "A", messages: [user("a")] } as Context);
				await aDriver;

				// A second conversation hits the cap with the only child busy → clean
				// throw, and no second child is spawned.
				const bEvents = await collect({ systemPrompt: "B", messages: [user("b")] } as Context);
				const bErr = bEvents.find((e) => e.type === "error");
				expect(bErr?.type === "error" && bErr.error.errorMessage).toContain("all children busy");
				expect(spawnMock).toHaveBeenCalledTimes(1);
				expect(_getAcpChildRegistry().has(_acpRegistryKey(process.cwd(), "A"))).toBe(true);

				// Drain A so nothing dangles into the next test.
				await deliverTurn(a, "sess-busy-a", "a done");
				a.sendLine({ jsonrpc: "2.0", id: aPromptId, result: { stopReason: "end_turn" }});
				a.end();
				await aEventsP;
			} finally {
				if (prev === undefined) delete process.env.PI_KIRO_MAX_CHILDREN;
				else process.env.PI_KIRO_MAX_CHILDREN = prev;
			}
		});
	});

	describe("child death drops its ACP session (L1-06 drop-on-death)", () => {
		it("forgets the session when the child dies, so no dead session lingers", async () => {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-drop1", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-drop1", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				await deliverTurn(child, "sess-drop1", "ok");
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				// Deliberately NOT ending the child: keep it alive so we can prove the
				// session is tracked first, THEN kill it and prove drop-on-death.
			})();

			await collect({ messages: [user("hi")] });
			expect(_acpSessionCount()).toBe(1); // recorded while the child is alive

			child.emit("exit", 1); // child dies on its own → teardownChild
			await settle();
			expect(_acpSessionCount()).toBe(0); // drop-on-death forgot the dead session
		});
	});

	describe("escape hatch: PI_KIRO_CHILD_KEY=cwd", () => {
		it("forces cwd-only keying so conversations collapse onto one child", () => {
			const prev = process.env.PI_KIRO_CHILD_KEY;
			process.env.PI_KIRO_CHILD_KEY = "cwd";
			try {
				const cwd = process.cwd();
				const kParent = _acpRegistryKey(cwd, "PARENT");
				const kSub = _acpRegistryKey(cwd, "SUBAGENT");
				// Both collapse to the bare cwd — the pre-per-conversation key.
				expect(kParent).toBe(cwd);
				expect(kSub).toBe(cwd);
				expect(kParent).toBe(kSub);
			} finally {
				if (prev === undefined) delete process.env.PI_KIRO_CHILD_KEY;
				else process.env.PI_KIRO_CHILD_KEY = prev;
			}
		});

		it("default (unset) keeps different system prompts on separate children", () => {
			const prev = process.env.PI_KIRO_CHILD_KEY;
			delete process.env.PI_KIRO_CHILD_KEY; // guard against leak from another test
			try {
				const cwd = process.cwd();
				expect(_acpRegistryKey(cwd, "PARENT")).not.toBe(_acpRegistryKey(cwd, "SUBAGENT"));
			} finally {
				if (prev !== undefined) process.env.PI_KIRO_CHILD_KEY = prev;
			}
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

// --- G9 + identity (pi-mode-spec.md build order 1 and 1b) --------------------

const PKG = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

const INIT_RESULT = {
	protocolVersion: 1,
	agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} },
	authMethods: [],
	agentInfo: { name: "Kiro CLI Agent", version: "test" },
};

/**
 * One full turn against a fresh fake child, with hooks at the two points the
 * G9/identity tests inspect: the initialize request, and the moment after the
 * session/prompt request arrives (before the turn is delivered).
 */
async function driveIdentityTurn(opts: {
	deps: AcpDeps;
	onInit?: (req: { params?: unknown }) => void;
	onPrompt?: (child: AcpScriptChild, req: { params?: unknown }) => Promise<void>;
}): Promise<AssistantMessageEvent[]> {
	const child = new AcpScriptChild();
	spawnMock.mockImplementationOnce(() => child);
	const sessionId = "sess-g9";
	void (async () => {
		const initReq = (await child.awaitLine()) as { id: number; params?: unknown };
		opts.onInit?.(initReq);
		child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });
		const sessionReq = (await child.awaitLine()) as { id: number };
		child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
		child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId, commands: [] }});
		const promptReq = (await child.awaitLine()) as { id: number; params?: unknown };
		if (opts.onPrompt) await opts.onPrompt(child, promptReq);
		await deliverTurn(child, sessionId, "ok");
		child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
		child.end();
	})();
	return collect({ messages: [user("who are you?")] }, undefined, opts.deps);
}

describe("G9: ACP initialize and client-method replies", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		_resetAcpSessions();
		_resetAcpChildren();
	});

	it("advertises NO client fs/terminal capabilities and reports the real plugin name/version", async () => {
		let params: Record<string, unknown> | undefined;
		await driveIdentityTurn({ deps: { binaryPath: "kiro-cli" }, onInit: (req) => (params = req.params as Record<string, unknown>) });
		expect(params?.clientCapabilities).toEqual({});
		expect(params?.clientInfo).toEqual({ name: PKG.name, version: PKG.version });
		expect(params).toEqual(buildInitializeParams());
	});

	it("spawns the engine the identity line reports (ACP_ENGINE drives the argv)", async () => {
		await driveIdentityTurn({ deps: { binaryPath: "kiro-cli" } });
		const args = spawnMock.mock.calls[0]?.[1] as string[];
		const i = args.indexOf("--agent-engine");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe(ACP_ENGINE);
	});

	it("answers an unadvertised fs/* or terminal/* request with -32601, other agent requests with {}", async () => {
		const replies = new Map<number, { result?: unknown; error?: { code: number } }>();
		await driveIdentityTurn({
			deps: { binaryPath: "kiro-cli" },
			onPrompt: async (child) => {
				child.sendLine({ jsonrpc: "2.0", id: 501, method: "fs/read_text_file", params: { path: "/etc/hosts" } });
				child.sendLine({ jsonrpc: "2.0", id: 502, method: "terminal/create", params: { command: "ls" } });
				child.sendLine({ jsonrpc: "2.0", id: 503, method: "session/request_permission", params: {} });
				for (let n = 0; n < 3; n++) {
					const reply = (await child.awaitLine()) as { id: number; result?: unknown; error?: { code: number } };
					replies.set(reply.id, reply);
				}
			},
		});
		expect(replies.get(501)?.error?.code).toBe(-32601);
		expect(replies.get(501)?.result).toBeUndefined();
		expect(replies.get(502)?.error?.code).toBe(-32601);
		expect(replies.get(503)?.result).toEqual({});
		expect(replies.get(503)?.error).toBeUndefined();
	});

	it("isUnadvertisedClientMethod matches only the fs/ and terminal/ namespaces", () => {
		expect(isUnadvertisedClientMethod("fs/write_text_file")).toBe(true);
		expect(isUnadvertisedClientMethod("terminal/output")).toBe(true);
		expect(isUnadvertisedClientMethod("session/request_permission")).toBe(false);
		expect(isUnadvertisedClientMethod("_kiro.dev/fs/x")).toBe(false);
	});
});

describe("identity in the ACP session/prompt", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		_resetAcpSessions();
		_resetAcpChildren();
		_resetPiVersionForTest();
	});

	it("puts the real identity line (host pi, deps.kiroVersion, ACP engine, model) first in the prompt text", async () => {
		let text = "";
		await driveIdentityTurn({
			deps: { binaryPath: "kiro-cli", kiroVersion: "2.26.1" },
			onPrompt: async (_child, req) => {
				text = (req.params as { prompt: Array<{ text: string }> }).prompt[0]?.text ?? "";
			},
		});
		const expected = `pi ${HOST_PI_VERSION} via Kiro (kiro-cli 2.26.1, engine ${ACP_ENGINE}) on auto (selected by kiro)`;
		expect(text.startsWith(identityBlock(expected))).toBe(true);
	});

	it("traces identity + auth and never writes KIRO_API_KEY to the trace", async () => {
		const KEY = "ksk_live_acp_trace_0123456789";
		process.env.KIRO_API_KEY = KEY;
		const dir = mkdtempSync(join(tmpdir(), "pi-kiro-acp-identity-"));
		const tracePath = join(dir, "trace.jsonl");
		const saved = process.env.PI_KIRO_TRACE;
		process.env.PI_KIRO_TRACE = tracePath;
		resetTraceTarget();
		try {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });
				const sessionReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: sessionReq.id, result: { sessionId: "sess-k", modes: { currentModeId: "kiro_default", availableModes: [] }, models: SESSION_MODELS }});
				child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId: "sess-k", commands: [] }});
				const promptReq = (await child.awaitLine()) as { id: number };
				await deliverTurn(child, "sess-k", "ok");
				child.sendLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" }});
				child.end();
			})();
			await collect({ messages: [user(`my key is ${KEY}`)] }, undefined, { binaryPath: "kiro-cli", kiroVersion: "2.26.1" });
			const raw = readFileSync(tracePath, "utf8");
			const events = raw.trim().split("\n").map((l) => JSON.parse(l));
			expect(events.find((e) => e.event === "identity")).toMatchObject({ transport: "acp", auth: "api-key" });
			expect(events.find((e) => e.event === "acp.prompt.send")?.prompt).toContain("[REDACTED:KIRO_API_KEY]");
			expect(raw).not.toContain(KEY);
		} finally {
			delete process.env.KIRO_API_KEY;
			if (saved === undefined) delete process.env.PI_KIRO_TRACE;
			else process.env.PI_KIRO_TRACE = saved;
			resetTraceTarget();
		}
	});

	it("redacts KIRO_API_KEY from an ACP error message", async () => {
		const KEY = "ksk_live_acp_error_0123456789";
		process.env.KIRO_API_KEY = KEY;
		try {
			const child = new AcpScriptChild();
			spawnMock.mockImplementationOnce(() => child);
			void (async () => {
				const initReq = (await child.awaitLine()) as { id: number };
				child.sendLine({ jsonrpc: "2.0", id: initReq.id, error: { code: -32000, message: `invalid api key ${KEY}` } });
			})();
			const events = await collect({ messages: [user("hi")] });
			const error = events.find((e) => e.type === "error");
			if (error?.type !== "error") throw new Error("expected error event");
			expect(error.error.errorMessage).toContain("initialize failed");
			expect(error.error.errorMessage).toContain("[REDACTED:KIRO_API_KEY]");
			expect(error.error.errorMessage).not.toContain(KEY);
		} finally {
			delete process.env.KIRO_API_KEY;
		}
	});
});

describe("ACP model selection (P2: kiro v2 ignores model on session/prompt)", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		_resetAcpSessions();
		_resetAcpChildren();
	});

	const kiroModel = (id: string): Model<any> => ({ ...MODEL, id, name: `${id} [kiro]` }) as Model<any>;

	async function collectAs(model: Model<any>, context: Context): Promise<AssistantMessageEvent[]> {
		const stream = makeStreamViaAcp({ binaryPath: "kiro-cli" })(model, context, undefined);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		return events;
	}

	/**
	 * A child that answers every request after the startup gate: set_model with
	 * `{}` (or `setModelError`), session/prompt with one turn. Records the method
	 * and params of every request, in order.
	 */
	function scriptedChild(opts: {
		sessionIds: string[];
		/** null = session/new reports no `models` at all. */
		currentModelId?: string | null;
		/** Defaults to the live list; [] = an older kiro that lists none. */
		availableModels?: Array<{ modelId: string; name: string; description: string }>;
		setModelError?: { code: number; message: string };
	}): { log: Array<{ method: string; params: Record<string, unknown> }> } {
		const log: Array<{ method: string; params: Record<string, unknown> }> = [];
		const child = new AcpScriptChild({ autoSetModel: false });
		spawnMock.mockImplementation(() => child);
		const models = opts.currentModelId === null
			? undefined
			: {
				currentModelId: opts.currentModelId ?? SESSION_MODELS.currentModelId,
				availableModels: opts.availableModels ?? KIRO_AVAILABLE_MODELS,
			};
		const sessionIds = [...opts.sessionIds];
		void (async () => {
			for (;;) {
				const req = (await child.awaitLine()) as { id: number; method: string; params: Record<string, unknown> };
				log.push({ method: req.method, params: req.params });
				if (req.method === "initialize") {
					child.sendLine({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: {}, auth: {} }, authMethods: [], agentInfo: { name: "Kiro", version: "test" } }});
				} else if (req.method === "session/new") {
					const sessionId = sessionIds.shift() ?? "sess-extra";
					child.sendLine({ jsonrpc: "2.0", id: req.id, result: { sessionId, modes: { currentModeId: "kiro_default", availableModes: [] }, ...(models ? { models } : {}) }});
					child.sendLine({ jsonrpc: "2.0", method: "_kiro.dev/commands/available", params: { sessionId, commands: [] }});
				} else if (req.method === "session/set_model") {
					if (opts.setModelError) child.sendLine({ jsonrpc: "2.0", id: req.id, error: opts.setModelError });
					else child.sendLine({ jsonrpc: "2.0", id: req.id, result: {} });
				} else if (req.method === "session/prompt") {
					await deliverTurn(child, req.params.sessionId as string, "ok");
					child.sendLine({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" }});
				}
			}
		})();
		return { log };
	}

	it("sends set_model before the first prompt, then only when the model changes", async () => {
		const { log } = scriptedChild({ sessionIds: ["sess-m1"] });
		const h = kiroModel("claude-haiku-4.5");
		const s = kiroModel("claude-sonnet-4.6");
		const u1 = user("one");
		const u2 = user("two");
		const u3 = user("three");
		const u4 = user("four");
		await collectAs(h, { messages: [u1] });
		await collectAs(h, { messages: [u1, assistant("ok"), u2] });
		await collectAs(s, { messages: [u1, assistant("ok"), u2, assistant("ok"), u3] });
		await collectAs(MODEL, { messages: [u1, assistant("ok"), u2, assistant("ok"), u3, assistant("ok"), u4] });

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const calls = log
			.filter((e) => e.method === "session/set_model" || e.method === "session/prompt")
			.map((e) => (e.method === "session/set_model" ? `set:${e.params.modelId}` : "prompt"));
		expect(calls).toEqual([
			"set:claude-haiku-4.5", "prompt",
			"prompt",
			"set:claude-sonnet-4.6", "prompt",
			"set:auto", "prompt",
		]);
		for (const e of log.filter((x) => x.method === "session/set_model")) expect(e.params.sessionId).toBe("sess-m1");
		// The ignored field is no longer sent.
		for (const e of log.filter((x) => x.method === "session/prompt")) expect(e.params).not.toHaveProperty("model");
	});

	it("sends no set_model when the session already runs the requested model", async () => {
		const { log } = scriptedChild({ sessionIds: ["sess-m2"], currentModelId: "claude-haiku-4.5" });
		await collectAs(kiroModel("claude-haiku-4.5"), { messages: [user("one")] });
		expect(log.map((e) => e.method)).toEqual(["initialize", "session/new", "session/prompt"]);
	});

	it("kiro/auto sends set_model on the first turn of a session that reports a concrete model", async () => {
		// Real sessions report e.g. claude-opus-4.8, never "auto", so production
		// kiro/auto pays one set_model per session, then none while it holds.
		const { log } = scriptedChild({ sessionIds: ["sess-ma"] });
		const u1 = user("one");
		await collectAs(MODEL, { messages: [u1] });
		await collectAs(MODEL, { messages: [u1, assistant("ok"), user("two")] });
		const calls = log
			.filter((e) => e.method === "session/set_model" || e.method === "session/prompt")
			.map((e) => (e.method === "session/set_model" ? `set:${e.params.modelId}` : "prompt"));
		expect(calls).toEqual(["set:auto", "prompt", "prompt"]);
	});

	it("fails the turn before set_model and prompt when the session does not offer the model", async () => {
		// kiro-cli answers OK to set_model for ANY id (live probe 2026-10-07), so
		// only the session's own availableModels list can catch a bad id.
		const { log } = scriptedChild({ sessionIds: ["sess-no"] });
		const events = await collectAs(kiroModel("definitely-not-a-model"), { messages: [user("one")] });
		const error = events.find((e) => e.type === "error");
		if (error?.type !== "error") throw new Error("expected error event");
		expect(error.error.errorMessage).toContain("model definitely-not-a-model is not offered by this kiro session");
		expect(error.error.errorMessage).toContain("claude-opus-4.8");
		await settle();
		expect(log.map((e) => e.method)).toEqual(["initialize", "session/new"]);
	});

	it("kiro/auto still prompts when the session lists models but not auto", async () => {
		// The default must never hard-fail on the offered-model check.
		const noAuto = KIRO_AVAILABLE_MODELS.filter((m) => m.modelId !== "auto");
		const { log } = scriptedChild({ sessionIds: ["sess-na"], availableModels: noAuto });
		const events = await collectAs(MODEL, { messages: [user("one")] });
		expect(events.some((e) => e.type === "done")).toBe(true);
		const calls = log
			.filter((e) => e.method === "session/set_model" || e.method === "session/prompt")
			.map((e) => (e.method === "session/set_model" ? `set:${e.params.modelId}` : "prompt"));
		expect(calls).toEqual(["set:auto", "prompt"]);
	});

	it("skips the offered-model check when session/new lists no models", async () => {
		const { log } = scriptedChild({ sessionIds: ["sess-nl"], availableModels: [] });
		const events = await collectAs(kiroModel("definitely-not-a-model"), { messages: [user("one")] });
		expect(events.some((e) => e.type === "done")).toBe(true);
		expect(log.map((e) => e.method)).toEqual(["initialize", "session/new", "session/set_model", "session/prompt"]);
	});

	it("sends set_model even for auto when session/new does not report the model", async () => {
		const { log } = scriptedChild({ sessionIds: ["sess-m3"], currentModelId: null });
		await collectAs(MODEL, { messages: [user("one")] });
		expect(log.map((e) => e.method)).toEqual(["initialize", "session/new", "session/set_model", "session/prompt"]);
	});

	it("re-selects the model on the successor session after a divergence", async () => {
		const { log } = scriptedChild({ sessionIds: ["sess-d1", "sess-d2"] });
		const h = kiroModel("claude-haiku-4.5");
		await collectAs(h, { messages: [user("one")] });
		await collectAs(h, { messages: [user("SUMMARY"), user("two")] });
		const seq = log.filter((e) => e.method !== "initialize").map((e) =>
			e.method === "session/set_model" ? `set:${e.params.sessionId}` : e.method);
		expect(seq).toEqual([
			"session/new", "set:sess-d1", "session/prompt",
			"session/new", "set:sess-d2", "session/prompt",
		]);
	});

	it("a kiro-cli without set_model (-32601) still serves kiro/auto, but not an explicit model", async () => {
		const notFound = { code: -32601, message: "Method not found" };
		const auto = scriptedChild({ sessionIds: ["sess-nf1"], currentModelId: null, setModelError: notFound });
		const okEvents = await collectAs(MODEL, { messages: [user("one")] });
		expect(okEvents.some((e) => e.type === "done")).toBe(true);
		expect(auto.log.map((e) => e.method)).toEqual(["initialize", "session/new", "session/set_model", "session/prompt"]);

		_resetAcpSessions();
		_resetAcpChildren();
		const explicit = scriptedChild({ sessionIds: ["sess-nf2"], currentModelId: "auto", setModelError: notFound });
		const errEvents = await collectAs(kiroModel("claude-haiku-4.5"), { messages: [user("one")] });
		expect(errEvents.some((e) => e.type === "error")).toBe(true);
		await settle();
		expect(explicit.log.some((e) => e.method === "session/prompt")).toBe(false);
	});

	it("fails the turn, without prompting, when set_model errors", async () => {
		const { log } = scriptedChild({ sessionIds: ["sess-m4"], setModelError: { code: -32603, message: "Internal error" } });
		const events = await collectAs(kiroModel("claude-haiku-4.5"), { messages: [user("one")] });
		const error = events.find((e) => e.type === "error");
		if (error?.type !== "error") throw new Error("expected error event");
		expect(error.error.errorMessage).toContain("session/set_model claude-haiku-4.5 failed");
		await settle();
		expect(log.some((e) => e.method === "session/prompt")).toBe(false);
	});
});
