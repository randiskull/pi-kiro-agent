/**
 * Live integration against a real, authenticated kiro-cli. Skipped unless
 * PI_KIRO_LIVE=1 (needs a seat + network; each turn is a real model call).
 *   PI_KIRO_LIVE=1 npx vitest run stream-adapter-live.test.ts
 * Uses the REAL node:child_process (this file installs no mock).
 */
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { _resetSessions } from "./session-manager.js";
import { makeStreamViaKiro } from "./stream-adapter.js";

const LIVE = process.env.PI_KIRO_LIVE === "1";

const MODEL = {
	id: "claude-haiku-4.5",
	name: "claude-haiku-4.5 [kiro]",
	api: "anthropic-messages",
	provider: "kiro",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as Model<any>;

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;
const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as Message;

async function run(context: Context): Promise<{ text: string; totalTokens: number }> {
	const stream = makeStreamViaKiro({ binaryPath: "kiro-cli" })(MODEL, context, undefined);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const done = events.find((event) => event.type === "done");
	if (done?.type !== "done") {
		const err = events.find((event) => event.type === "error");
		throw new Error(`no done event: ${err?.type === "error" ? err.error.errorMessage : "unknown"}`);
	}
	const block = done.message.content.find((b) => b.type === "text");
	return {
		text: block && "text" in block ? block.text : "",
		totalTokens: done.message.usage.totalTokens,
	};
}

describe.skipIf(!LIVE)("live kiro resume", () => {
	it(
		"turn 2 resumes the session, recalls turn-1 context, and stays seat-billed",
		async () => {
			_resetSessions();
			const seed = "Remember this codeword for later: ZEBRA-LIVE-42. Reply with just OK.";

			const t1 = await run({ messages: [user(seed)] });
			expect(t1.text.length).toBeGreaterThan(0);
			expect(t1.totalTokens).toBe(0); // seat-billed, no token accounting

			const t2 = await run({
				messages: [user(seed), assistant(t1.text), user("What was the codeword? Reply with just the codeword.")],
			});
			expect(t2.text).toContain("ZEBRA-LIVE-42"); // only answerable from turn 1's context
			expect(t2.totalTokens).toBe(0);
		},
		300_000,
	);
});
