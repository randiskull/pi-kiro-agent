/**
 * Shared message-prefix hashing for the kiro session managers.
 *
 * Both the chat-transport session manager (session-manager.ts) and the ACP
 * session manager (acp-session.ts) anchor conversation identity / divergence
 * detection on a hash of the sent message prefix. This module is the single
 * source of truth for that hash, so the two transports cannot silently diverge
 * — divergence would break resume continuity on one transport only, the hardest
 * failure mode to notice (resume degrades to a correct-but-expensive full
 * re-send). Collision test: message-hash.test.ts.
 *
 * `messageText` and `messageKey` are module-private; only `hashMessages` is
 * exported, matching the previous per-file surface.
 */

import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";

/** Stable, thinking-insensitive text of one message's content (for hashing). */
function messageText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "toolCall") return `toolCall:${block.name}:${JSON.stringify(block.arguments ?? {})}`;
			if (block.type === "image") return "[image]";
			return ""; // thinking and unknowns are volatile — excluded so a settled prefix stays stable
		})
		.filter((piece) => piece.length > 0)
		.join("\n");
}

function messageKey(message: Message): string {
	const toolName = (message as { toolName?: string }).toolName ?? "";
	return message.role + "\x00" + toolName + "\x00" + messageText(message.content);
}

/** Deterministic hash of a message sequence — thinking/signatures excluded. */
export function hashMessages(messages: Message[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		hash.update(messageKey(message));
		// Inter-message delimiter uses SOH (\x01), NOT \0, because messageKey
		// uses \0 as its field separator. A distinct byte here prevents crafted
		// content from mimicking a message boundary.
		hash.update("\x01");
	}
	return hash.digest("hex");
}
