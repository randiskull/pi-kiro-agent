/**
 * pi >= 0.86 (and 1.0) hands providers a normalized TranscriptContext: no
 * `systemPrompt` field; the prompt is a leading `role: "system"` message and
 * later system messages append text or patch named sections. Every older test
 * builds the legacy `Context` shape by hand, which is how a provider that read
 * only `context.systemPrompt` passed 300 tests while sending kiro NO system
 * prompt. These tests go through pi-ai's own normalizeContext() instead.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, type Message, normalizeContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { _resetAcpSessions, planAcpTurn, recordAcpSession } from "../src/acp-session.js";
import { _makeCaptureShim } from "../src/bridge.js";
import { _resetSessions, planTurn, recordFreshSession } from "../src/session-manager.js";
import { buildPromptFromContext } from "../src/stream-adapter.js";
import { currentSystemPrompt, initialSystemPrompt } from "../src/system-prompt.js";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as Message;
const system = (content: string, sections?: Record<string, string | null>): Message =>
	({ role: "system", content, ...(sections ? { sections } : {}), timestamp: 0 }) as Message;
const viaPi = (systemPrompt: string, messages: Message[]) => normalizeContext({ systemPrompt, messages });
const priorBlock = (prompt: string) => /<prior_system_context>\n([\s\S]*?)\n<\/prior_system_context>/.exec(prompt)?.[1];

describe("system prompt from a pi-normalized TranscriptContext", () => {
	it("normalizeContext really moves the prompt into a leading system message", () => {
		// Pins the premise: if pi ever stops doing this, these tests must be revisited.
		const ctx = viaPi("BASE-PROMPT", [user("hi")]) as unknown as { systemPrompt?: string; messages: Message[] };
		expect(ctx.systemPrompt).toBeUndefined();
		expect(ctx.messages[0]).toMatchObject({ role: "system", content: "BASE-PROMPT" });
	});

	it("puts the system prompt in <prior_system_context>", () => {
		const prompt = buildPromptFromContext(viaPi("BASE-PROMPT", [user("hi")]) as unknown as Context);
		expect(priorBlock(prompt)).toBe("BASE-PROMPT");
	});

	it("replays a mid-conversation system message and a patched section", () => {
		const base = viaPi("BASE", [user("t1")]).messages;
		base[0] = system("BASE", { rules: "<rules>OLD</rules>" });
		const messages = [...base, system("LATER-ADDITION"), system("", { rules: "<rules>NEW</rules>" }), user("t2")];
		const block = priorBlock(buildPromptFromContext({ messages } as Context));
		expect(block).toContain("BASE");
		expect(block).toContain("LATER-ADDITION");
		expect(block).toContain("<rules>NEW</rules>");
		expect(block).not.toContain("<rules>OLD</rules>");
	});

	it("still reads the legacy Context.systemPrompt field (pre-0.86 hosts)", () => {
		const prompt = buildPromptFromContext({ systemPrompt: "LEGACY", messages: [user("hi")] } as Context);
		expect(priorBlock(prompt)).toBe("LEGACY");
	});

	it("never serializes a system message as conversation history", () => {
		const prompt = buildPromptFromContext(viaPi("BASE-PROMPT", [user("hi")]) as unknown as Context);
		const history = prompt.slice(prompt.indexOf("<conversation_history>"));
		expect(history).not.toContain("BASE-PROMPT");
	});
});

describe("ACP conversation key input (initialSystemPrompt)", () => {
	it("differs between conversations whose prompts differ", () => {
		const parent = viaPi("You are the PARENT.", [user("hi")]);
		const sub = viaPi("You are a SUBAGENT.", [user("hi")]);
		expect(initialSystemPrompt(parent)).toBe("You are the PARENT.");
		expect(initialSystemPrompt(sub)).toBe("You are a SUBAGENT.");
	});

	it("is stable when pi appends a mid-conversation system update", () => {
		const first = viaPi("You are the PARENT.", [user("hi")]);
		const later = { messages: [...first.messages, system("UPDATE"), user("next")] };
		expect(initialSystemPrompt(later)).toBe(initialSystemPrompt(first));
		// ...while the prompt actually SENT does change.
		expect(currentSystemPrompt(later)).toContain("UPDATE");
	});
});

describe("resume planning when the delta carries a system message", () => {
	beforeEach(() => {
		_resetSessions();
		_resetAcpSessions();
		delete process.env.PI_KIRO_RESUME;
	});

	it("chat: a system update in the delta forces a fresh full resend", async () => {
		const sent = viaPi("BASE", [user("t1")]).messages;
		// One new session id in the post-spawn listing = the session kiro created.
		expect(await recordFreshSession("/w", sent, new Set(), async () => [{ sessionId: "s1" }])).toBe("s1");
		expect(planTurn("/w", [...sent, user("t2")]).mode).toBe("resume"); // control
		expect(planTurn("/w", [...sent, system("UPDATE"), user("t2")])).toEqual({ mode: "fresh", deltaStart: 0 });
		expect(planTurn("/w", [...sent, system("UPDATE")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});

	it("acp: a system update in the delta forces a fresh full resend", () => {
		const sent = viaPi("BASE", [user("t1")]).messages;
		recordAcpSession("/w", "k", "acp-1", sent);
		expect(planAcpTurn("/w", "k", [...sent, user("t2")]).mode).toBe("resume"); // control
		expect(planAcpTurn("/w", "k", [...sent, system("UPDATE"), user("t2")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});
});

describe("bridge capture shim vs pi's ExtensionAPI", () => {
	const typesPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"core",
		"extensions",
		"types.d.ts",
	);

	/** Every ExtensionAPI member, read from the INSTALLED pi's own type file. */
	function extensionApiMembers(): string[] {
		const source = readFileSync(typesPath, "utf8");
		const head = /export interface ExtensionAPI\b[^{]*\{/.exec(source);
		if (!head) throw new Error(`ExtensionAPI not found in ${typesPath}`);
		let depth = 1;
		let end = head.index + head[0].length;
		while (depth > 0 && end < source.length) {
			const ch = source[end++];
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
		}
		const body = source.slice(head.index + head[0].length, end);
		return [...new Set([...body.matchAll(/^ {4}(\w+)\s*[<(:?]/gm)].map((m) => m[1]))];
	}

	it("no-ops every host mutator pi declares (registerTool is captured instead)", () => {
		const mutators = extensionApiMembers().filter(
			(name) => /^(register|unregister|set|send|append)[A-Z]/.test(name) && name !== "registerTool",
		);
		mutators.push("on");
		// Not vacuous: the list must contain the 1.0 additions and the old core.
		expect(mutators).toEqual(expect.arrayContaining(["registerMcpServer", "registerVirtualModel", "registerCommand", "setModel"]));

		const reached: string[] = [];
		const real = new Proxy({}, { get: (_t, prop) => () => reached.push(String(prop)) }) as unknown as ExtensionAPI;
		const shim = _makeCaptureShim(real, []) as unknown as Record<string, (...args: unknown[]) => unknown>;
		for (const name of mutators) shim[name]({});
		expect(reached).toEqual([]);
	});

	it("still passes reads through to the real host", () => {
		const reached: string[] = [];
		const real = new Proxy({}, { get: (_t, prop) => () => reached.push(String(prop)) }) as unknown as ExtensionAPI;
		const shim = _makeCaptureShim(real, []) as unknown as Record<string, () => unknown>;
		shim.getAllTools();
		expect(reached).toEqual(["getAllTools"]);
	});
});
