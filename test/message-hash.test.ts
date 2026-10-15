/**
 * Tests for the shared message-prefix hash (message-hash.ts): both transports
 * must hash identically.
 */

import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { hashMessages } from "../src/message-hash.js";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;

describe("message-hash", () => {
	it("resists content that embeds the field-separator pattern (collision test)", () => {
		// Two distinct user messages:
		const twoMessages = [user("x"), user("y")];
		// A single message whose content mimics the concatenation of two message
		// keys joined by a null-byte field separator. If the inter-message
		// delimiter were also \0, these would hash identically.
		const crafted = [user("x\0user\0\0y")];
		expect(hashMessages(twoMessages)).not.toBe(hashMessages(crafted));
	});

	it("hashes deterministically and ignores volatile thinking blocks", () => {
		const withThinkingA = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "musing A" },
				{ type: "text", text: "answer" },
			],
			timestamp: 0,
		} as unknown as Message;
		const withThinkingB = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "totally different musing B" },
				{ type: "text", text: "answer" },
			],
			timestamp: 0,
		} as unknown as Message;
		// Same visible text, different thinking → same hash (thinking excluded).
		expect(hashMessages([withThinkingA])).toBe(hashMessages([withThinkingB]));
		// Deterministic across calls.
		expect(hashMessages([user("a"), user("b")])).toBe(hashMessages([user("a"), user("b")]));
		// Order-sensitive.
		expect(hashMessages([user("a"), user("b")])).not.toBe(hashMessages([user("b"), user("a")]));
	});
});
