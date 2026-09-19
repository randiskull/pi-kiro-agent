/**
 * Helpers shared by both turn transports (stream-adapter.ts, acp-transport.ts)
 * and, per the architecture review's L1-07 finding, the coming stream-json
 * reader. Extracted because `emptyAssistantMessage` defines the output message
 * shape both transports must emit identically — a cross-transport contract,
 * not incidental duplication.
 */

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";

/** Parse a positive-integer millisecond override from the environment. */
export function envMs(name: string, fallback: number): number {
	const raw = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function emptyAssistantMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * `pushThinking` closes over mutable per-turn state (`thinkingIndex`), so it
 * cannot move as a bare function — this factory captures that state instead.
 * Both transports call `push(delta)` as thinking/text chunks arrive and
 * `end()` once, at end-of-turn, to close the block if one was ever opened.
 */
export function createThinkingWriter(stream: AssistantMessageEventStream, output: AssistantMessage) {
	let thinkingIndex = -1;
	return {
		push(delta: string): void {
			if (delta.length === 0) return;
			if (thinkingIndex === -1) {
				output.content.push({ type: "thinking", thinking: "" });
				thinkingIndex = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
			}
			const block = output.content[thinkingIndex];
			if (block.type === "thinking") block.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
		},
		end(): void {
			if (thinkingIndex === -1) return;
			const block = output.content[thinkingIndex];
			stream.push({
				type: "thinking_end",
				contentIndex: thinkingIndex,
				content: block.type === "thinking" ? block.thinking : "",
				partial: output,
			});
		},
	};
}
