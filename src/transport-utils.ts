/**
 * Helpers shared by both turn transports (stream-adapter.ts, acp-transport.ts).
 * `emptyAssistantMessage` defines the output message shape both must emit
 * identically -- a cross-transport contract, not incidental duplication.
 */

import type { AssistantMessage, AssistantMessageEventStream, Model, ToolCall } from "@earendil-works/pi-ai";

/** Parse a positive-integer override from the environment; anything else is the fallback. */
export function envPositiveInt(name: string, fallback: number): number {
	const raw = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Parse a positive-integer millisecond override from the environment. */
export function envMs(name: string, fallback: number): number {
	return envPositiveInt(name, fallback);
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

/**
 * One thinking block and one text block, each opened lazily and addressed by
 * its own `contentIndex`.
 *
 * `createThinkingWriter` offers only the thinking channel, which is why the ACP
 * transport used to mirror every answer chunk into the thinking feed just to
 * show it arriving, and then emit the same text AGAIN as the answer at end of
 * turn. The TUI drew both, so every answer appeared twice. This writer streams
 * the answer as the answer, so it appears exactly once.
 *
 * Deltas address a block by index rather than requiring it to be the last
 * block, which is what lets the answer keep growing after a tool marker has
 * opened the thinking block in between. The finished message therefore has the
 * same shape it always had -- at most one thinking block and one text block,
 * the answer whole and in one piece -- and `end()` guarantees a text block
 * exists even for a turn that produced no message chunks, because a message
 * with no text block at all reads as no response rather than an empty answer.
 *
 * Both `push*` methods ignore an empty delta: pi opens a block on `*_start`,
 * and an open-then-close pair with nothing in it renders as a blank card.
 */
export function createBlockWriter(stream: AssistantMessageEventStream, output: AssistantMessage) {
	let thinkingIndex = -1;
	let textIndex = -1;

	return {
		pushThinking(delta: string): void {
			if (delta.length === 0) return;
			if (thinkingIndex === -1) {
				output.content.push({ type: "thinking", thinking: "" });
				thinkingIndex = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
			}
			const block = output.content[thinkingIndex];
			if (block?.type === "thinking") block.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
		},
		pushText(delta: string): void {
			if (delta.length === 0) return;
			if (textIndex === -1) {
				output.content.push({ type: "text", text: "" });
				textIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
			}
			const block = output.content[textIndex];
			if (block?.type === "text") block.text += delta;
			stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
		},
		end(): void {
			if (thinkingIndex !== -1) {
				const block = output.content[thinkingIndex];
				stream.push({
					type: "thinking_end",
					contentIndex: thinkingIndex,
					content: block?.type === "thinking" ? block.thinking : "",
					partial: output,
				});
			}
			if (textIndex === -1) {
				output.content.push({ type: "text", text: "" });
				textIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
			}
			const textBlock = output.content[textIndex];
			stream.push({
				type: "text_end",
				contentIndex: textIndex,
				content: textBlock?.type === "text" ? textBlock.text : "",
				partial: output,
			});
		},
	};
}

/**
 * Strip literal tags from a text stream without waiting for the whole stream.
 *
 * The answer is emitted chunk by chunk now, so a tag can no longer be removed
 * from the finished string -- and a tag can arrive SPLIT across two chunks
 * ("<pi_" then "final>"). Any trailing run of bytes that could still become a
 * tag is therefore held back until the next chunk proves it either is one (and
 * it is dropped) or is not (and it is emitted). `flush` releases a held-back
 * tail that never completed.
 *
 * Leading whitespace is swallowed until the first real content, which is the
 * streaming equivalent of the trim the ACP transport used to apply at the end.
 */
/**
 * Make a toolCall block that was just pushed onto `output.content` visible to
 * the consumer, as a tool row rather than as narration.
 *
 * Pushing a block alone is invisible: pi redraws from the `partial` an event
 * carries, so a block with no event after it is never seen. Every transport
 * used to emit that event by writing a "\u2699 <tool>" line into the THINKING
 * feed, which drew the same call twice -- the \u2699 line, then the row pi
 * renders from the block underneath it (measured live, kiro-cli 2.32.0). The
 * row has its own event pair, so it announces itself.
 *
 * toolcall_end carries the finished block: the call already RAN agent-side, so
 * there are no argument deltas to stream.
 */
export function announceToolRow(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	index: number,
): void {
	const block = output.content[index];
	if (block?.type !== "toolCall") return;
	stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
	stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block as ToolCall, partial: output });
}

export function createTagStripper(tags: readonly string[], emit: (text: string) => void) {
	const longest = Math.max(...tags.map((tag) => tag.length));
	let held = "";
	let started = false;

	function release(text: string): void {
		let out = text;
		if (!started) {
			out = out.replace(/^\s+/, "");
			if (out.length === 0) return;
			started = true;
		}
		if (out.length > 0) emit(out);
	}

	return {
		push(chunk: string): void {
			held += chunk;
			for (const tag of tags) {
				for (let at = held.indexOf(tag); at !== -1; at = held.indexOf(tag)) {
					held = held.slice(0, at) + held.slice(at + tag.length);
				}
			}
			// Longest suffix of `held` that is a proper prefix of some tag.
			let hold = 0;
			for (let n = Math.min(longest - 1, held.length); n > 0; n--) {
				const tail = held.slice(held.length - n);
				if (tags.some((tag) => tag.startsWith(tail))) {
					hold = n;
					break;
				}
			}
			let out = held.slice(0, held.length - hold);
			let keep = hold === 0 ? "" : held.slice(held.length - hold);
			// Trailing whitespace is held back too, so the streamed answer equals
			// the trimmed whole the end-of-turn code used to produce: a run of
			// spaces mid-answer is released as soon as real content follows it,
			// and a run at the very end is dropped by `flush`.
			const trailing = out.match(/\s+$/);
			if (trailing) {
				out = out.slice(0, out.length - trailing[0].length);
				keep = trailing[0] + keep;
			}
			held = keep;
			release(out);
		},
		flush(): void {
			const out = held.replace(/\s+$/, "");
			held = "";
			release(out);
		},
	};
}
