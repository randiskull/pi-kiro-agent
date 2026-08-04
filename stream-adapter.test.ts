import { EventEmitter } from "node:events";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildPromptFromContext,
	cleanBody,
	extractFinal,
	FINAL_CLOSE,
	FINAL_OPEN,
	makeStreamViaKiro,
	mapEffort,
	stripAnsi,
} from "./stream-adapter.js";

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

describe("live tool-use streaming + end-of-turn reconciliation", () => {
	it("final message has exactly ONE authoritative block per tool use (no live-placeholder dupes) with parsed args", async () => {
		const out = [
			"prose",
			"Running tool gsd_exec with the param (from mcp server: gsdworkflow)",
			' ⋮  { "cmd": "cargo test" }',
			" - Completed in 2s",
			`${FINAL_OPEN}done${FINAL_CLOSE}`,
		].join("\n");
		scriptSpawn(out, 0);
		const events = await collect({ systemPrompt: "", messages: [{ role: "user", content: "go", timestamp: 0 }] });
		const done = events.find((e) => e.type === "done") as { message: { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> } };
		const toolCalls = done.message.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.id).not.toContain("kiro-live-");
		expect(toolCalls[0]?.arguments).toEqual({ cmd: "cargo test" });
		// the live marker made it into the thinking feed
		const thinking = done.message.content.find((b) => b.type === "thinking") as { thinking?: string } | undefined;
		expect(thinking?.thinking).toContain("⚙ gsd_exec");
	});
});
