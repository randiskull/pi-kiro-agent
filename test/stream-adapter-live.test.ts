/**
 * Live integration against a real, authenticated kiro-cli. Skipped unless
 * PI_KIRO_LIVE=1 (needs a seat + network; each turn is a real model call).
 *   PI_KIRO_LIVE=1 npx vitest run stream-adapter-live.test.ts
 * Uses the REAL node:child_process (this file installs no mock).
 *
 * Unlike every other test here, this one needs the developer's REAL $HOME (see
 * withRealHome below). It therefore writes real kiro-cli session history under
 * it, and the turns are billed to the seat that is logged in.
 */
import { userInfo } from "node:os";
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _resetSessions } from "../src/session-manager.js";
import { makeStreamViaKiro } from "../src/stream-adapter.js";

const LIVE = process.env.PI_KIRO_LIVE === "1";

/**
 * test-setup.ts points $HOME at a throwaway dir so no test can write into the
 * developer's real configuration. Correct for every other test, fatal for this
 * one: kiro-cli resolves its own chat helper at $HOME/.local/bin/kiro-cli-chat
 * (and its config alongside), so a redirected $HOME makes the child exit 1 with
 * "failed to launch .../kiro-cli-chat" -- AFTER authenticating fine, because
 * credentials come from the OS keychain rather than $HOME. That failure looked
 * like a broken transport and was invisible for as long as this test was
 * skipped, which is every run including CI.
 *
 * userInfo().homedir reads the passwd database, not $HOME, so it survives the
 * redirect. Restored afterwards to leave the redirect intact for anything that
 * shares this worker.
 */
function withRealHome(): void {
	const redirected = { home: process.env.HOME, userProfile: process.env.USERPROFILE };
	beforeAll(() => {
		const real = userInfo().homedir;
		process.env.HOME = real;
		process.env.USERPROFILE = real;
	});
	afterAll(() => {
		process.env.HOME = redirected.home;
		process.env.USERPROFILE = redirected.userProfile;
	});
}

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
	withRealHome();

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
