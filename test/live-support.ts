/**
 * Shared scaffolding for the live suite (test/*-live.test.ts).
 *
 * Every live test here needs three things CI does not have: a real kiro-cli on
 * PATH, an authenticated seat, and the developer's REAL $HOME. None of them run
 * unless PI_KIRO_LIVE=1. See CONTRIBUTORS.md for the recipe and what it costs.
 */
import { userInfo } from "node:os";
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { afterAll, beforeAll } from "vitest";

export const LIVE = process.env.PI_KIRO_LIVE === "1";

/** Budget for a test that makes two real model calls plus child startup. */
export const LIVE_TIMEOUT_MS = 300_000;

/**
 * test-setup.ts points $HOME at a throwaway dir so no test can write into the
 * developer's real configuration. Correct for every other test, fatal for these:
 * kiro-cli resolves its own chat helper at $HOME/.local/bin/kiro-cli-chat (and
 * its config alongside), so a redirected $HOME makes the child exit 1 with
 * "failed to launch .../kiro-cli-chat" -- AFTER authenticating fine, because
 * credentials come from the OS keychain rather than $HOME. That failure looked
 * like a broken transport and was invisible for as long as these tests were
 * skipped, which is every run including CI.
 *
 * The bridge tests need the real $HOME for a second reason: pi installs
 * user-scope packages under ~/.pi/agent, and the bridge imports them from there.
 *
 * userInfo().homedir reads the passwd database, so it survives the redirect
 * (node's os.homedir() does NOT -- it prefers $HOME when set). Restored
 * afterwards to leave the redirect intact for anything sharing this worker.
 */
export function withRealHome(): void {
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

export const LIVE_MODEL = {
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

export const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;
export const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as Message;

export const ctx = (messages: Message[]): Context => ({ messages });

type DoneMessage = Extract<AssistantMessageEvent, { type: "done" }>["message"];

export interface LiveTurn {
	text: string;
	totalTokens: number;
	content: DoneMessage["content"];
	events: AssistantMessageEvent[];
}

/** Drain a transport stream to its terminal event, failing loudly on error. */
export async function drainTurn(stream: AsyncIterable<AssistantMessageEvent>): Promise<LiveTurn> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const done = events.find((event) => event.type === "done");
	if (done?.type !== "done") {
		const err = events.find((event) => event.type === "error");
		throw new Error("no done event: " + (err?.type === "error" ? err.error.errorMessage : "unknown"));
	}
	const block = done.message.content.find((b) => b.type === "text");
	return {
		text: block && "text" in block ? block.text : "",
		totalTokens: done.message.usage.totalTokens,
		content: done.message.content,
		events,
	};
}
