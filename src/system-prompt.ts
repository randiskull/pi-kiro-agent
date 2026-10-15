/**
 * System prompt access for both context shapes pi has passed to providers.
 *
 * pi < 0.86 handed providers a `Context` whose prompt was
 * `context.systemPrompt`. pi >= 0.86 hands them a normalized
 * `TranscriptContext` with no `systemPrompt` field: the prompt is a leading
 * `role: "system"` message, and later system messages append text or patch
 * named `sections`. Reading only the old field on a new host silently drops
 * pi's whole prompt (AGENTS.md, skills, tool guidance) from every turn.
 *
 * The replay is pi-ai's own `getCurrentSystemPrompt`, looked up on the module
 * namespace rather than imported by name: the peer range is "*", and a named
 * import of an export an older pi-ai lacks fails at module link time, which
 * would stop the whole extension from loading.
 */
import * as piAi from "@earendil-works/pi-ai";

type RoleOnly = { role: string };
type Replay = (messages: readonly RoleOnly[]) => string;

/** Either context shape: the old optional field, plus the message list both carry. */
export interface PromptSource {
	systemPrompt?: string;
	messages: readonly RoleOnly[];
}

const upstreamReplay: Replay | undefined = (() => {
	const fn = (piAi as unknown as { getCurrentSystemPrompt?: unknown }).getCurrentSystemPrompt;
	return typeof fn === "function" ? (fn as Replay) : undefined;
})();

/** True when the message list carries any `role: "system"` entry. */
export function hasSystemMessage(messages: readonly RoleOnly[]): boolean {
	return messages.some((message) => message.role === "system");
}

function replay(messages: readonly RoleOnly[]): string {
	if (!upstreamReplay || !hasSystemMessage(messages)) return "";
	return upstreamReplay(messages);
}

/**
 * The prompt in effect for this request: every system message in the
 * transcript replayed in order (base text, appended text, patched sections),
 * falling back to the legacy `systemPrompt` field on pre-0.86 hosts.
 */
export function currentSystemPrompt(context: PromptSource): string {
	const fromTranscript = replay(context.messages);
	if (fromTranscript.trim().length > 0) return fromTranscript;
	return context.systemPrompt ?? "";
}

/**
 * Only the LEADING system message, rendered. Stable for the life of a
 * conversation, because pi appends prompt and tool changes as later system
 * messages instead of rewriting the first one; that makes it the right input
 * for a per-conversation key, where the full current prompt would re-key (and
 * respawn a kiro child) on every mid-conversation update.
 */
export function initialSystemPrompt(context: PromptSource): string {
	const first = context.messages[0];
	if (first?.role === "system") {
		const text = replay([first]);
		if (text.trim().length > 0) return text;
	}
	return context.systemPrompt ?? "";
}
