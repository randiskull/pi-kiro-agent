/**
 * Harness identity (src/identity.ts) and its plumbing into the chat transport.
 * ACP-side wiring (G9 initialize params, identity in session/prompt) lives in
 * acp-transport.test.ts, which owns the NDJSON fake child.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { VERSION as HOST_PI_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPiVersionForTest, authMethod, CHAT_ENGINE, displayModel, displayTransport, identityBlock, KIRO_ROUTES, identityLine, parseKiroVersion, pluginName, pluginVersion, redactSecrets, resolvePiVersion } from "../src/identity.js";
import { buildDeltaPrompt, buildPromptFromContext, FINAL_CLOSE, FINAL_OPEN, makeStreamViaKiro } from "../src/stream-adapter.js";
import { resetTraceTarget } from "../src/trace.js";
import { IDENTITY_QUESTIONS, scoreIdentityAnswer } from "./identity-score.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const PKG = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;

const LINE = "pi 9.9.9 via Kiro (kiro-cli 2.26.1, engine v2, acp) on claude-sonnet-4.5";

describe("identityLine", () => {
	it("renders every part in the contract order", () => {
		expect(identityLine({ piVersion: "9.9.9", kiroVersion: "2.26.1", engine: "v2", transport: "acp", model: "claude-sonnet-4.5" })).toBe(LINE);
	});

	it("says unknown for a missing version instead of inventing one", () => {
		expect(identityLine({ engine: "v3", transport: "chat", model: "m" })).toBe(
			"pi unknown via Kiro (kiro-cli unknown, engine v3, chat) on m",
		);
	});

	it("names the route: acp, or chat with the format that decides what is visible", () => {
		expect(displayTransport("acp")).toBe("acp");
		expect(displayTransport("chat", "stream-json")).toBe("chat/stream-json");
		expect(displayTransport("chat", "text")).toBe("chat/text");
	});

	it("lists every route a turn can take, for the route-wide conformance suite", () => {
		expect([...KIRO_ROUTES]).toEqual(["acp", "chat/text", "chat/stream-json"]);
	});

	it("says plain chat when no format resolved, rather than naming one that will not be used", () => {
		expect(displayTransport("chat")).toBe("chat");
		expect(identityLine({ engine: "v2", transport: "chat", model: "m" })).toContain(", engine v2, chat) on m");
	});

	// ACP has no format to choose, so a format passed alongside it is a caller
	// bug and must not reach the line -- otherwise the slot would claim a wire
	// format the ACP transport never uses.
	it("ignores a format on the acp route", () => {
		expect(displayTransport("acp", "text")).toBe("acp");
		expect(identityLine({ engine: "v2", transport: "acp", format: "stream-json", model: "m" })).toContain(", engine v2, acp) on m");
	});

	it("puts the route after the engine, inside the same parenthesis", () => {
		expect(identityLine({ piVersion: "1.0.0", kiroVersion: "2.26.1", engine: "v2", transport: "chat", format: "text", model: "m" })).toBe(
			"pi 1.0.0 via Kiro (kiro-cli 2.26.1, engine v2, chat/text) on m",
		);
	});

	it("marks auto as kiro-selected (kiro never reports the serving model)", () => {
		expect(displayModel("auto")).toBe("auto (selected by kiro)");
		expect(displayModel("claude-opus-4.5")).toBe("claude-opus-4.5");
		expect(identityLine({ piVersion: "1.0.0", kiroVersion: "2.0.0", engine: "v2", transport: "acp", model: "auto" })).toMatch(
			/ on auto \(selected by kiro\)$/,
		);
	});
});

describe("identityBlock", () => {
	it("is an <identity> block that tells the model to answer with the exact line", () => {
		const block = identityBlock(LINE);
		const lines = block.split("\n");
		expect(lines[0]).toBe("<identity>");
		expect(lines.at(-1)).toBe("</identity>");
		expect(block).toContain(`answer with exactly: ${LINE}`);
		expect(block).toContain("You are pi");
	});

	it("is ASCII-only (it is a machine-consumed string sent to kiro)", () => {
		expect(/^[\x00-\x7f]*$/.test(identityBlock(LINE))).toBe(true);
	});
});

describe("parseKiroVersion", () => {
	it("extracts the semver from kiro-cli --version output", () => {
		expect(parseKiroVersion("kiro-cli 2.26.1")).toBe("2.26.1");
		expect(parseKiroVersion("kiro-cli 3.0.0-beta.2\n")).toBe("3.0.0-beta.2");
	});

	it("returns undefined when there is nothing to parse", () => {
		expect(parseKiroVersion(undefined)).toBeUndefined();
		expect(parseKiroVersion("kiro-cli")).toBeUndefined();
	});
});

describe("authMethod", () => {
	it("is api-key when KIRO_API_KEY is non-empty, login otherwise", () => {
		expect(authMethod({ KIRO_API_KEY: "ksk_abcdef123456" })).toBe("api-key");
		expect(authMethod({ KIRO_API_KEY: "   " })).toBe("login");
		expect(authMethod({})).toBe("login");
	});

	it("reads process.env by default (test-setup clears KIRO_API_KEY)", () => {
		expect(authMethod()).toBe("login");
	});
});

describe("redactSecrets", () => {
	const KEY = "ksk_live_0123456789abcdef";

	it("replaces every occurrence of the key", () => {
		const out = redactSecrets(`token=${KEY} and again ${KEY}`, { KIRO_API_KEY: KEY });
		expect(out).not.toContain(KEY);
		expect(out.split("[REDACTED:KIRO_API_KEY]").length - 1).toBe(2);
	});

	it("leaves text alone when no key is set, or the key is too short to be a secret", () => {
		expect(redactSecrets(`x ${KEY}`, {})).toBe(`x ${KEY}`);
		expect(redactSecrets("a b c abc", { KIRO_API_KEY: "abc" })).toBe("a b c abc");
	});
});

describe("plugin metadata", () => {
	it("comes from package.json, not a hardcoded placeholder", () => {
		expect(pluginName()).toBe(PKG.name);
		expect(pluginVersion()).toBe(PKG.version);
		expect(pluginVersion()).not.toBe("0.1.0");
	});
});

describe("resolvePiVersion", () => {
	beforeEach(() => _resetPiVersionForTest());
	afterEach(() => _resetPiVersionForTest());

	it("reads the host pi VERSION by default", async () => {
		expect(typeof HOST_PI_VERSION).toBe("string");
		expect(await resolvePiVersion()).toBe(HOST_PI_VERSION);
	});

	it("degrades to undefined when the host has no VERSION or the import fails", async () => {
		expect(await resolvePiVersion(async () => ({}))).toBeUndefined();
		_resetPiVersionForTest();
		expect(await resolvePiVersion(async () => Promise.reject(new Error("no pi")))).toBeUndefined();
	});

	it("memoizes: the loader runs once", async () => {
		const load = vi.fn(async () => ({ VERSION: "1.2.3" }));
		await resolvePiVersion(load);
		await resolvePiVersion(load);
		expect(load).toHaveBeenCalledTimes(1);
	});
});

describe("identity in the prompt", () => {
	const context: Context = { systemPrompt: "SYS", messages: [user("who are you?")] };

	it("puts the identity block FIRST in a full prompt", () => {
		const prompt = buildPromptFromContext(context, undefined, false, { identity: LINE });
		expect(prompt.startsWith(identityBlock(LINE))).toBe(true);
		expect(prompt.indexOf("<identity>")).toBeLessThan(prompt.indexOf("<prior_system_context>"));
	});

	it("puts the identity block FIRST in a delta (resume) prompt too -- every turn, not just the first", () => {
		const prompt = buildDeltaPrompt([user("and now?")], undefined, false, { identity: LINE });
		expect(prompt.startsWith(identityBlock(LINE))).toBe(true);
	});

	it("keeps it first alongside the ACP variant (sentinel off)", () => {
		const prompt = buildPromptFromContext(context, undefined, false, { identity: LINE, sentinel: false });
		expect(prompt.startsWith("<identity>")).toBe(true);
		expect(prompt).not.toContain(FINAL_OPEN);
	});

	it("emits no identity block when none is given", () => {
		expect(buildPromptFromContext(context)).not.toContain("<identity>");
		expect(buildDeltaPrompt([user("x")])).not.toContain("<identity>");
	});
});

// --- chat transport wiring --------------------

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

class FakeChild extends EventEmitter {
	pid = 4243;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn(() => this.emit("exit", 130));
}

function scriptSpawn(stdout: string, exitCode = 0): void {
	spawnMock.mockImplementation(() => {
		const child = new FakeChild();
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from(stdout));
			queueMicrotask(() => child.emit("exit", exitCode));
		});
		return child;
	});
}

async function collect(context: Context, kiroVersion?: string): Promise<AssistantMessageEvent[]> {
	const stream = makeStreamViaKiro({ binaryPath: "kiro-cli", kiroVersion })(MODEL, context, undefined as never);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("chat transport identity", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		_resetPiVersionForTest();
	});
	afterEach(() => {
		delete process.env.KIRO_API_KEY;
	});

	it("sends the real identity line (host pi, deps.kiroVersion, chat engine, model) first in the argv prompt", async () => {
		scriptSpawn(`${FINAL_OPEN}ok${FINAL_CLOSE}`);
		await collect({ messages: [user("who are you?")] }, "2.26.1");
		const args = spawnMock.mock.calls[0]?.[1] as string[];
		const prompt = args.at(-1) ?? "";
		// 2.26.1 is above the stream-json floor, so the route names the format the
		// turn actually resolved -- not a hardcoded one.
		const expected = `pi ${HOST_PI_VERSION} via Kiro (kiro-cli 2.26.1, engine ${CHAT_ENGINE}, chat/stream-json) on auto (selected by kiro)`;
		expect(prompt.startsWith(identityBlock(expected))).toBe(true);
	});

	it("traces the identity line and the auth method, never the key", async () => {
		const KEY = "ksk_live_trace_0123456789";
		process.env.KIRO_API_KEY = KEY;
		const dir = mkdtempSync(join(tmpdir(), "pi-kiro-identity-trace-"));
		const tracePath = join(dir, "trace.jsonl");
		const saved = process.env.PI_KIRO_TRACE;
		process.env.PI_KIRO_TRACE = tracePath;
		resetTraceTarget();
		try {
			scriptSpawn(`${FINAL_OPEN}ok${FINAL_CLOSE}`);
			await collect({ messages: [user(`my key is ${KEY}`)] }, "2.26.1");
			const raw = readFileSync(tracePath, "utf8");
			const events = raw.trim().split("\n").map((l) => JSON.parse(l));
			const identity = events.find((e) => e.event === "identity");
			expect(identity).toMatchObject({ transport: "chat", auth: "api-key" });
			expect(identity.line).toContain("kiro-cli 2.26.1");
			const send = events.find((e) => e.event === "chat.prompt.send");
			expect(send.prompt).toContain("[REDACTED:KIRO_API_KEY]");
			expect(raw).not.toContain(KEY);
		} finally {
			if (saved === undefined) delete process.env.PI_KIRO_TRACE;
			else process.env.PI_KIRO_TRACE = saved;
			resetTraceTarget();
		}
	});

	it("redacts KIRO_API_KEY from a failed turn's error message", async () => {
		const KEY = "ksk_live_error_0123456789";
		process.env.KIRO_API_KEY = KEY;
		scriptSpawn(`auth failed for key ${KEY}`, 1);
		const events = await collect({ messages: [user("hi")] }, "2.26.1");
		const error = events.find((e) => e.type === "error");
		if (error?.type !== "error") throw new Error("expected error event");
		expect(error.error.errorMessage).toContain("[REDACTED:KIRO_API_KEY]");
		expect(error.error.errorMessage).not.toContain(KEY);
	});
});

describe("identity eval scorer (pinned to real probe answers)", () => {
	// Answers captured verbatim by the local probe runs (matrix and reinforce),
	// including GPT's curly apostrophe.
	const PASS = [
		"I am pi, an expert coding assistant built by Mario Zechner.",
		"I'm pi, an expert coding assistant built by Mario Zechner.",
		"I am pi.",
		`Sure. ${LINE}`,
		LINE,
	];
	const FAIL: Array<[string, string]> = [
		["I\u2019m Kiro, an AI-powered development environment built by AWS.", "claims-other"],
		["I\u2019m Kiro.", "claims-other"],
		["I'm Kiro, an AI-powered coding assistant built by Amazon Web Services.", "claims-other"],
		["I'm Claude, an AI assistant.", "claims-other"],
		// Half-obedient: names pi, then also claims to be Kiro. Must not pass.
		["I am pi running here, but really I'm Kiro, built by AWS.", "claims-other"],
		["I can help you with coding tasks.", "no-pi-claim"],
		["", "no-pi-claim"],
	];

	it.each(PASS)("passes %j", (answer) => {
		expect(scoreIdentityAnswer(answer, LINE).pass).toBe(true);
	});

	it.each(FAIL)("fails %j as %s", (answer, reason) => {
		expect(scoreIdentityAnswer(answer, LINE)).toMatchObject({ pass: false, reason });
	});

	it("credits the exact line over a bare claim, and does not read 'via Kiro' in the line as a Kiro self-claim", () => {
		expect(scoreIdentityAnswer(LINE, LINE).reason).toBe("exact-line");
		expect(scoreIdentityAnswer("I am pi.", LINE).reason).toBe("claims-pi");
	});

	it("passes real sweep answers that bold the line or name pi as the harness (2026-10-01)", () => {
		const lineFor = (model: string) => `pi 0.85.1 via Kiro (kiro-cli 2.26.1, engine v2) on ${model}`;
		const cases: Array<[string, string, string]> = [
			["claude-opus-4.5", "This session is running on **pi 0.85.1 via Kiro** (kiro-cli 2.26.1, engine v2) on **claude-opus-4.5**.", "exact-line"],
			["minimax-m2.1", "This session is running on **pi 0.85.1** via **Kiro** (kiro-cli 2.26.1, engine v2) on **minimax-m2.1**.", "exact-line"],
			["minimax-m2.5", "This session is running on:\n- **Harness**: pi 0.85.1 via Kiro\n- **Model**: minimax-m2.5\n- **Kiro CLI**: 2.26.1", "claims-pi"],
		];
		for (const [model, answer, reason] of cases) {
			expect(scoreIdentityAnswer(answer, lineFor(model))).toEqual({ pass: true, reason });
		}
	});

	it("still fails a harness answer that names Kiro, not pi", () => {
		expect(scoreIdentityAnswer("- **Harness**: Kiro CLI 2.26.1\n- **Model**: auto", LINE).pass).toBe(false);
		expect(scoreIdentityAnswer("This session is running on Kiro CLI with claude-sonnet-4.6.", LINE).pass).toBe(false);
		expect(scoreIdentityAnswer("The harness is a pipeline runner.", LINE).pass).toBe(false);
	});

	it("does not take a word merely containing 'pi' as a pi claim", () => {
		expect(scoreIdentityAnswer("I am a spirited API helper.", LINE).pass).toBe(false);
	});

	it("asks three distinct questions, the first two being the probe questions", () => {
		expect(new Set(IDENTITY_QUESTIONS).size).toBe(3);
		expect(IDENTITY_QUESTIONS[0]).toBe("Who are you, and who built you? One sentence.");
	});
});
