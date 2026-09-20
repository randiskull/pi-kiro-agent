import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildPromptFromContext,
	cleanBody,
	escapeXmlAttr,
	extractFinal,
	FINAL_CLOSE,
	FINAL_OPEN,
	LIVE_TOOL_ID_PREFIX,
	makeStreamViaKiro,
	mapEffort,
	stripAnsi,
	toolUseTranscript,
} from "../src/stream-adapter.js";
import { resetTraceTarget } from "../src/trace.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

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

/** A raw capture of kiro-cli headless output (ESC = ). */
const RAW_SAMPLE = [
	"[32mAll tools are now trusted ([0m[31m![0m[32m).[0m",
	"Agents can sometimes do unexpected things so understand the risks.",
	"",
	"Learn more at [38;5;141mhttps://kiro.dev/docs/cli/chat/security/[0m",
	"",
	`[38;5;252m[0m[?25l[38;5;141m> [0m${FINAL_OPEN}KIRO-OK${FINAL_CLOSE}[0m`,
	"[38;5;8m",
	" ▸ Credits: 0.03 • Time: 1s",
	"",
	"[0m[1G[0m[0m[?25h",
].join("\n");

class FakeChild extends EventEmitter {
	pid = 4242;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn(() => this.emit("exit", 130));
}

function scriptSpawn(stdout: string, exitCode = 0): FakeChild {
	const child = new FakeChild();
	spawnMock.mockImplementation(() => {
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from(stdout));
			queueMicrotask(() => child.emit("exit", exitCode));
		});
		return child;
	});
	return child;
}

async function collect(
	context: Context,
	options?: { signal?: AbortSignal; reasoning?: string },
): Promise<AssistantMessageEvent[]> {
	const stream = makeStreamViaKiro({ binaryPath: "kiro-cli" })(MODEL, context, options as never);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("output parsing", () => {
	it("strips CSI/OSC/control sequences", () => {
		expect(stripAnsi("[32mgreen[0m and [?25lplain")).toBe("green and plain");
	});

	it("cleans the real headless capture and parses credits", () => {
		const { body, credits } = cleanBody(RAW_SAMPLE);
		expect(credits).toBe(0.03);
		expect(body).toBe(`${FINAL_OPEN}KIRO-OK${FINAL_CLOSE}`);
		expect(body).not.toContain("tools are now trusted");
	});

	it("cleanBody does not strip or misparse a model line containing Credits: N without the ▸ footer marker", () => {
		const bodyWithPricingText = "Some response text\nCredits: 2.5 per month\nMore text";
		const { body, credits } = cleanBody(bodyWithPricingText);
		expect(credits).toBeUndefined();
		expect(body).toContain("Credits: 2.5 per month");
	});

	it("scans stderr for tool activity without letting it into the answer body", () => {
		// kiro-cli 2.21 prints tool lines on stderr and the answer on stdout, so
		// parsing stdout alone reports zero tool calls for a turn that made them.
		const body = "DONE";
		const stderr = "\u001b[2m\n[tool] Running: @gsdworkflow/gsd_doctor\n[tool] status: Completed\u001b[0m\n";
		const transcript = toolUseTranscript(body, stderr);
		expect(transcript).toContain("[tool] Running: @gsdworkflow/gsd_doctor");
		expect(transcript.startsWith(body)).toBe(true);
		// extractFinal still sees only stdout: stderr must never become the answer.
		expect(extractFinal(body).final).toBe("DONE");
	});

	it("toolUseTranscript is a no-op when stderr carries nothing", () => {
		expect(toolUseTranscript("answer", "")).toBe("answer");
		expect(toolUseTranscript("answer", "   \n\n  ")).toBe("answer");
		expect(toolUseTranscript("", "[tool] Running: @pi/todo")).toBe("[tool] Running: @pi/todo");
	});

	it("extracts the sentinel span and falls back to the whole body", () => {
		expect(extractFinal(`notes ${FINAL_OPEN}answer${FINAL_CLOSE} trailing`)).toEqual({
			working: "notes  trailing",
			final: "answer",
		});
		expect(extractFinal("no markers here")).toEqual({ working: "", final: "no markers here" });
	});

	it("maps Pi thinking levels to kiro effort", () => {
		expect(mapEffort("minimal")).toBe("low");
		expect(mapEffort("medium")).toBe("medium");
		expect(mapEffort("high")).toBe("high");
		expect(mapEffort("xhigh")).toBe("xhigh");
		expect(mapEffort(undefined)).toBeUndefined();
	});

	it("includes the sentinel instruction and history in the prompt", () => {
		const prompt = buildPromptFromContext({
			systemPrompt: "You are rpiv.",
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});
		expect(prompt).toContain(FINAL_OPEN);
		expect(prompt).toContain("<prior_system_context>\nYou are rpiv.\n</prior_system_context>");
		expect(prompt).toContain("<user_message>\nhello\n</user_message>");
	});

	it("omits the sentinel instruction when opts.sentinel is false (ACP variant)", () => {
		const promptAcp = buildPromptFromContext(
			{ systemPrompt: "You are rpiv.", messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			undefined,
			undefined,
			{ sentinel: false },
		);
		// sentinel instruction line must be absent
		expect(promptAcp).not.toContain(FINAL_OPEN);
		expect(promptAcp).not.toContain(FINAL_CLOSE);
		expect(promptAcp).not.toContain("Wrap ONLY your final answer");
		// scaffolding and history must still be present
		expect(promptAcp).toContain("You are the executor");
		expect(promptAcp).toContain("<user_message>\nhello\n</user_message>");
		expect(promptAcp).toContain("Do not emit <user_message>");

		// default (chat) variant still includes the sentinel
		const promptChat = buildPromptFromContext(
			{ systemPrompt: "You are rpiv.", messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		);
		expect(promptChat).toContain(FINAL_OPEN);
		expect(promptChat).toContain("Wrap ONLY your final answer");
	});
});

describe("prior tool calls are not replayed as prompt text", () => {
	// Regression: assistant toolCall blocks used to serialize as
	// `[called tool name({...})]` inside <assistant_message>. Replayed to kiro on
	// every full resend, next to a <tool_context> block advertising those same
	// tools as @pi/<name>, kiro treated them as work to do and re-ran them --
	// asking a user the same question twice and re-firing a prior turn's
	// subagent calls at reaped agent ids.
	const withToolCall = {
		systemPrompt: "You are rpiv.",
		messages: [
			{ role: "user" as const, content: "is the sky blue?", timestamp: 0 },
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "Let me ask." },
					{
						type: "toolCall" as const,
						toolCallId: "call-1",
						name: "ask_user_question",
						arguments: { question: "is the sky blue?" },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult" as const,
				toolName: "ask_user_question",
				toolCallId: "call-1",
				content: "Yes",
				timestamp: 2,
			},
		],
	} as unknown as Parameters<typeof buildPromptFromContext>[0];

	it("omits the call marker, its tool name and its arguments from the replayed history", () => {
		const prompt = buildPromptFromContext(withToolCall);
		expect(prompt).not.toContain("[called tool");
		// the arguments must not survive in any form -- an agent id or question
		// lifted out of them is exactly what got re-issued
		expect(prompt).not.toContain('{"question":"is the sky blue?"}');
		expect(prompt).not.toContain("<assistant_message>\nask_user_question");
	});

	it("keeps the assistant's own prose and the paired tool_result", () => {
		const prompt = buildPromptFromContext(withToolCall);
		expect(prompt).toContain("<assistant_message>\nLet me ask.\n</assistant_message>");
		expect(prompt).toContain('<tool_result tool="ask_user_question">\nYes\n</tool_result>');
	});

	it("emits no empty assistant block when the message was nothing but a tool call", () => {
		const callOnly = {
			systemPrompt: "You are rpiv.",
			messages: [
				{
					role: "assistant" as const,
					content: [
						{
							type: "toolCall" as const,
							toolCallId: "call-2",
							name: "steer_subagent",
							arguments: { agentId: "16ac182d-c7bf-418" },
						},
					],
					timestamp: 0,
				},
			],
		} as unknown as Parameters<typeof buildPromptFromContext>[0];
		const prompt = buildPromptFromContext(callOnly);
		// Assert on identifiers, not on the tag name: the scaffolding prose itself
		// says "Do not emit <user_message>, <assistant_message>, ..." so a bare
		// not.toContain("<assistant_message>") would fail on the preamble.
		// A message that serializes to undefined leaves the history empty, so no
		// <conversation_history> wrapper is emitted at all.
		expect(prompt).not.toContain("<conversation_history>");
		expect(prompt).not.toContain("16ac182d-c7bf-418");
		expect(prompt).not.toContain("steer_subagent");
	});
});

describe("prompt serialization security", () => {
	it("escapeXmlAttr escapes the four XML special characters", () => {
		expect(escapeXmlAttr('a&b"c<d>e')).toBe("a&amp;b&quot;c&lt;d&gt;e");
		// ampersand must be escaped first so &amp; is not double-escaped
		expect(escapeXmlAttr("&amp;")).toBe("&amp;amp;");
	});

	it("toolName containing quotes and angle brackets cannot break the XML attribute", () => {
		// A crafted toolName that attempts attribute injection:
		// 'x" foo="bar' would close the attribute and inject a new one.
		// After escaping, the whole value must appear safely inside the attribute.
		const maliciousToolName = '"><inject foo="bad';
		const prompt = buildPromptFromContext({
			systemPrompt: "",
			messages: [
				{
					role: "toolResult",
					toolName: maliciousToolName,
					content: "result text",
					timestamp: 0,
				} as never,
			],
		});
		// The raw injection characters must NOT appear unescaped inside the attribute.
		expect(prompt).not.toContain(`tool="${maliciousToolName}"`);
		// The escaped form must be present.
		expect(prompt).toContain('tool="&quot;&gt;&lt;inject foo=&quot;bad"');
		// The tool_result closing tag must not be prematurely injected.
		expect(prompt).not.toContain("</tool_result><inject");
	});
});

describe("makeStreamViaKiro", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("streams stdout as thinking and the sentinel span as text with credit cost", async () => {
		process.env.PI_KIRO_CREDIT_USD = "2";
		scriptSpawn(RAW_SAMPLE);
		const events = await collect({ messages: [] }, { reasoning: "high" });
		delete process.env.PI_KIRO_CREDIT_USD;
		const done = events.find((event) => event.type === "done");
		if (done?.type !== "done") throw new Error("expected done");
		const text = done.message.content.find((block) => block.type === "text");
		expect(text && "text" in text ? text.text : "").toBe("KIRO-OK");
		expect(done.message.usage.cost.total).toBeCloseTo(0.06);
		expect(events.some((event) => event.type === "thinking_delta")).toBe(true);
		const args = spawnMock.mock.calls[0]?.[1] as string[];
		expect(args).toContain("--no-interactive");
		expect(args).toContain("--effort");
		expect(args).toContain("high");
		expect(args).not.toContain("--model"); // "auto" is the CLI default
	});

	it("surfaces nonzero exits as errors with the profile remedy", async () => {
		scriptSpawn("[31mError: profileArn is required for this request[0m", 1);
		const events = await collect({ messages: [] });
		const error = events.find((event) => event.type === "error");
		if (error?.type !== "error") throw new Error("expected error");
		expect(error.error.errorMessage).toContain("exit 1");
		expect(error.error.errorMessage).toContain("kiro-cli profile");
	});

	it("classifies aborted runs and kills the process group", async () => {
		const child = new FakeChild();
		const controller = new AbortController();
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			child.emit("exit", 130);
			return true;
		});
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => controller.abort());
			return child;
		});
		const events = await collect({ messages: [] }, { signal: controller.signal });
		const error = events.find((event) => event.type === "error");
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
		killSpy.mockRestore();
		if (error?.type !== "error") throw new Error("expected error");
		expect(error.error.stopReason).toBe("aborted");
	});

	it("wires the bridge: agent profile args, @pi tool context, and exit-3 retry", async () => {
		const bridge = {
			url: "http://127.0.0.1:6666/mcp",
			urlWithToken: "http://127.0.0.1:6666/mcp/tok",
			token: "tok",
			toolNames: ["todo", "Agent", "ask_user_question"],
			close: vi.fn(async () => undefined),
		};
		// First spawn exits 3 (MCP startup failure), second succeeds.
		const outputs = ["", `> ${FINAL_OPEN}BRIDGED${FINAL_CLOSE}\n ▸ Credits: 0.02 • Time: 1s`];
		const codes = [3, 0];
		spawnMock.mockImplementation(() => {
			const child = new FakeChild();
			const stdout = outputs.shift() ?? "";
			const code = codes.shift() ?? 0;
			queueMicrotask(() => {
				if (stdout) child.stdout.emit("data", Buffer.from(stdout));
				queueMicrotask(() => child.emit("exit", code));
			});
			return child;
		});
		const stream = makeStreamViaKiro({
			binaryPath: "kiro-cli",
			getBridge: async () => bridge as never,
		})(MODEL, { messages: [] });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);

		expect(spawnMock).toHaveBeenCalledTimes(2);
		const args = spawnMock.mock.calls[0]?.[1] as string[];
		expect(args).toContain("--agent");
		expect(args[args.indexOf("--agent") + 1]).toMatch(/^pi-kiro-bridge-/);
		expect(args).toContain("--require-mcp-startup");
		const prompt = args.at(-1) as string;
		expect(prompt).toContain("@pi/<tool_name>");
		expect(prompt).toContain("@pi/ask_user_question");
		expect(prompt).toContain("@pi/Agent");
		const done = events.find((event) => event.type === "done");
		if (done?.type !== "done") throw new Error("expected done after retry");
		const text = done.message.content.find((block) => block.type === "text");
		expect(text && "text" in text ? text.text : "").toBe("BRIDGED");
		expect(bridge.close).toHaveBeenCalled();
	});

	it("passes explicit model ids through", async () => {
		scriptSpawn(`> ${FINAL_OPEN}ok${FINAL_CLOSE}\n ▸ Credits: 0.01 • Time: 1s`);
		await collect({ messages: [] });
		scriptSpawn(`> ${FINAL_OPEN}ok${FINAL_CLOSE}`);
		const explicit = { ...MODEL, id: "claude-sonnet" } as Model<any>;
		const stream = makeStreamViaKiro({ binaryPath: "kiro-cli" })(explicit, { messages: [] });
		for await (const _event of stream) {
			// drain
		}
		const args = spawnMock.mock.calls.at(-1)?.[1] as string[];
		expect(args).toContain("--model");
		expect(args).toContain("claude-sonnet");
	});
});

describe("nonzero-exit salvage (kiro-cli dies after completing work)", () => {
	it("salvages exit 1 when MCP tool calls landed — done with toolCall blocks, no error", async () => {
		const out = [
			"working prose",
			"Running tool gsd_task_complete with the param (from mcp server: gsdworkflow)",
			' ⋮  { "taskId": "T05" }',
			" - Completed in 0.72s",
		].join("\n");
		scriptSpawn(out, 1);
		const events = await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
		const done = events.find((e) => e.type === "done") as { message: { content: unknown[]; stopReason: string } } | undefined;
		expect(done).toBeDefined();
		expect(events.find((e) => e.type === "error")).toBeUndefined();
		const toolCalls = (done?.message.content ?? []).filter((b) => (b as { type?: string }).type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect((toolCalls[0] as { name: string }).name).toBe("gsd_task_complete");
		expect(done?.message.stopReason).toBe("stop");
	});

	it("salvages exit 1 when a sentinel final answer is present", async () => {
		scriptSpawn(`${FINAL_OPEN}DONE-ANYWAY${FINAL_CLOSE}`, 1);
		const events = await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
		const done = events.find((e) => e.type === "done") as { message: { content: Array<{ type: string; text?: string }> } } | undefined;
		expect(done).toBeDefined();
		expect(done?.message.content.find((b) => b.type === "text")?.text).toBe("DONE-ANYWAY");
	});

	it("still hard-fails exit 1 with no tool calls and no final — detail carries the output TAIL", async () => {
		const longPreamble = "early prose that must NOT appear in the error detail ".repeat(20);
		scriptSpawn(`${longPreamble}\nthe actual crash happened here at the very end`, 1);
		const events = await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
		const error = events.find((e) => e.type === "error") as { error?: { errorMessage?: string }; message?: { errorMessage?: string } } | undefined;
		expect(error).toBeDefined();
		const errorMessage = (error as { error?: { errorMessage?: string } })?.error?.errorMessage ?? "";
		expect(errorMessage).toContain("kiro-cli failed (exit 1)");
		// detail must carry the output TAIL (the crash point), not just the head
		expect(errorMessage).toContain("crash happened here at the very end");
	});
});

describe("chat-turn hard ceiling (PI_KIRO_CHAT_TIMEOUT_MS)", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("kills a wedged child and fails the turn naming the env knob", async () => {
		process.env.PI_KIRO_CHAT_TIMEOUT_MS = "30";
		const child = new FakeChild();
		// The ceiling fires killTree → group SIGTERM; the fake dies on it.
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			child.emit("exit", 130);
			return true;
		});
		// The child streams nothing and never exits on its own.
		spawnMock.mockImplementation(() => child);
		const events = await collect({ messages: [] });
		delete process.env.PI_KIRO_CHAT_TIMEOUT_MS;
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
		killSpy.mockRestore();
		const error = events.find((event) => event.type === "error");
		if (error?.type !== "error") throw new Error("expected error");
		expect(error.error.stopReason).toBe("error");
		expect(error.error.errorMessage).toContain("PI_KIRO_CHAT_TIMEOUT_MS");
		expect(error.error.errorMessage).toContain("30 ms");
		// A timed-out turn is terminal: no MCP-retry or resume-fallback respawn.
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it("does not fire when the turn completes first", async () => {
		process.env.PI_KIRO_CHAT_TIMEOUT_MS = "60000";
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		scriptSpawn(`> ${FINAL_OPEN}FAST${FINAL_CLOSE}\n ▸ Credits: 0.01 • Time: 1s`);
		const events = await collect({ messages: [] });
		delete process.env.PI_KIRO_CHAT_TIMEOUT_MS;
		expect(killSpy).not.toHaveBeenCalled();
		killSpy.mockRestore();
		const done = events.find((event) => event.type === "done");
		if (done?.type !== "done") throw new Error("expected done");
		const text = done.message.content.find((block) => block.type === "text");
		expect(text && "text" in text ? text.text : "").toBe("FAST");
	});
});

describe("live tool-use streaming + end-of-turn reconciliation", () => {
	const out = [
		"prose",
		"Running tool gsd_exec with the param (from mcp server: gsdworkflow)",
		' ⋮  { "cmd": "cargo test" }',
		" - Completed in 2s",
		`${FINAL_OPEN}done${FINAL_CLOSE}`,
	].join("\n");

	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("R000: done message has zero toolCall blocks (LIVE_TOOL_ID_PREFIX tagging + stripLivePlaceholders removes synthesized blocks)", async () => {
		scriptSpawn(out, 0);
		const events = await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
		const done = events.find((e) => e.type === "done") as { message: { content: Array<{ type: string }> } };
		const toolCalls = done.message.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(0);
		const thinking = done.message.content.find((b) => b.type === "thinking") as { thinking?: string } | undefined;
		expect(thinking?.thinking).toContain("⚙ gsd_exec");
	});

	it("R001: done message has zero toolCall blocks (synthesized blocks stripped by stripLivePlaceholders)", async () => {
		scriptSpawn(out, 0);
		const events = await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
		const done = events.find((e) => e.type === "done") as { message: { content: Array<{ type: string; id?: string }> } };
		const toolCalls = done.message.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(0);
	});

	it("R002: thinking feed contains ⚙ <toolname> for each surfaced kiro tool", async () => {
		scriptSpawn(out, 0);
		const events = await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
		const done = events.find((e) => e.type === "done") as { message: { content: Array<{ type: string; thinking?: string }> } };
		const thinking = done.message.content.find((b) => b.type === "thinking") as { thinking?: string } | undefined;
		expect(thinking?.thinking).toContain("⚙ gsd_exec");
	});

	it("R003: done push does not mutate partial.content in place — mid-turn partial retains its content after done", async () => {
		scriptSpawn(out, 0);
		const events = await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
		// text_delta fires AFTER reconcileToolCalls and carries partial: output by reference.
		// output.content at that point has [LIVE-tagged toolCall block, text block].
		const textDelta = events.find((e) => e.type === "text_delta") as { partial: { content: unknown[] } } | undefined;
		expect(textDelta).toBeDefined();
		const contentRef = textDelta!.partial.content;
		const lengthAtPartial = contentRef.length;
		// After all events (including done), the array must be unchanged — done used a spread copy.
		expect(contentRef.length).toBe(lengthAtPartial);
		// Confirm the LIVE-tagged block is still present (no in-place strip occurred).
		const stillHasTagged = contentRef.some((b: unknown) => (b as { id?: string }).id?.startsWith(LIVE_TOOL_ID_PREFIX));
		expect(stillHasTagged).toBe(true);
	});

	it("R004: chat.toolcall.surfaced trace event written per surfaced tool when PI_KIRO_TRACE is set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-kiro-trace-test-"));
		const tracePath = join(dir, "trace.jsonl");
		const savedTrace = process.env.PI_KIRO_TRACE;
		process.env.PI_KIRO_TRACE = tracePath;
		resetTraceTarget();
		try {
			scriptSpawn(out, 0);
			await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
			const lines = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			const surfaced = lines.filter((e) => e.event === "chat.toolcall.surfaced");
			expect(surfaced.length).toBeGreaterThanOrEqual(1);
			expect(surfaced[0].tool).toBe("gsd_exec");
			expect(surfaced[0].displayOnly).toBe(true);
		} finally {
			if (savedTrace === undefined) delete process.env.PI_KIRO_TRACE;
			else process.env.PI_KIRO_TRACE = savedTrace;
			resetTraceTarget();
		}
	});
});
