/**
 * Reader for `kiro-cli chat --output-format stream-json`.
 *
 * stream-json is the turn's ACP events as JSON Lines on stdout, one
 * self-describing event per line, opened by a versioned `runStarted` envelope.
 * Unlike the text scrape it carries real tool-call ids, complete arguments,
 * kiro's built-in tools by name, and an explicit end of turn. Recorded shapes
 * and the findings this follows: probes/stream-json-2.32/.
 *
 * The reader maps events onto the in-progress AssistantMessage as they arrive:
 * message and thought chunks stream into the thinking feed, tool calls become
 * display-only rows (LIVE_TOOL_ID_PREFIX, stripped before pi sees the final
 * message). The answer, the terminal event, credits and the session id are
 * collected for the caller, which owns retry policy and the final text.
 *
 * Strict about the envelope, tolerant about events: a missing or unrecognized
 * `runStarted`, or any line that is not JSON, is a violation (the caller kills
 * the child and fails the turn) -- the next kiro format change should be loud.
 * Unknown event types and sessionUpdate subtypes are ignored, so kiro can add
 * events without breaking pi.
 */

import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { sumCredits } from "./metering.js";
import { displayToolName } from "./tool-names.js";
import { announceToolRow } from "./transport-utils.js";

/** The `runStarted.data` this reader understands. `engine` is the pinned chat engine. */
export interface StreamJsonEnvelope {
	payloadSchema: "acp";
	acpProtocolVersion: 1;
	engine: string;
}

export type StreamJsonTerminal =
	| { type: "runFinished"; status: string; sessionId?: string; finalText: string; finalTextTruncated?: boolean }
	| { type: "runError"; stage: string; message: string };

export interface StreamJsonTurn {
	/** Set once the stream broke the envelope contract; nothing after it is read. */
	violation?: string;
	terminal?: StreamJsonTerminal;
	/** Every agent_message_chunk text, concatenated: the answer source. */
	messageText: string;
	/**
	 * Summed `credit`-unit entries of the last metadata that carried a
	 * `meteringUsage`. Probed 2026-10-16: exactly one metadata per turn carries
	 * it, holding one entry per internal model call.
	 */
	credits?: number;
	/** Server-provided plural for the credit unit, for display. */
	creditsUnitPlural?: string;
	/** Non-credit units seen, summed per unit. Never folded into `credits`. */
	creditsOtherUnits?: Record<string, number>;
	/**
	 * Last `contextUsagePercentage` seen. Every metadata carries one, and the
	 * last is the end-of-turn figure (the session-start figure understates a
	 * turn).
	 */
	contextPercent?: number;
	/** `turnDurationMs` from the final metadata: kiro's own server-side timing. */
	turnDurationMs?: number;
	/** runFinished.sessionId, else the latest metadata.sessionId. */
	sessionId?: string;
}

type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

interface KiroUpdate {
	sessionUpdate?: string;
	content?: { type?: string; text?: string };
	toolCallId?: string;
	status?: string | null;
	rawInput?: unknown;
	_meta?: { kiro?: { toolName?: string; mcpServerName?: string } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createStreamJsonReader(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	pushThinking: (delta: string) => void,
	options: { engine: string; livePrefix: string },
) {
	const turn: StreamJsonTurn = { messageText: "" };
	let pending = "";
	let lineNumber = 0;
	let started = false;
	let metadataSessionId: string | undefined;
	const rows = new Map<string, ToolCallBlock>();
	const failedMarked = new Set<string>();

	const violate = (message: string) => {
		turn.violation ??= message;
	};

	const surfaceRow = (id: string, update: KiroUpdate): ToolCallBlock => {
		const meta = update._meta?.kiro;
		const name = displayToolName(meta?.toolName ?? "unknown", meta?.mcpServerName);
		const block: ToolCallBlock = {
			type: "toolCall",
			id: `${options.livePrefix}${id}`,
			name,
			arguments: (isRecord(update.rawInput) ? update.rawInput : {}) as ToolCallBlock["arguments"],
		};
		output.content.push(block);
		rows.set(id, block);
		// The row announces itself; a "⚙ <tool>" thinking line here as well
		// drew every call twice (announceToolRow).
		announceToolRow(stream, output, output.content.length - 1);
		return block;
	};

	const onUpdate = (update: KiroUpdate) => {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content?.type === "text" && update.content.text) {
					turn.messageText += update.content.text;
					pushThinking(update.content.text);
				}
				return;
			case "agent_thought_chunk":
				if (update.content?.type === "text" && update.content.text) pushThinking(update.content.text);
				return;
			case "tool_call": {
				const id = update.toolCallId;
				if (!id || rows.has(id)) return;
				surfaceRow(id, update);
				return;
			}
			case "tool_call_update": {
				const id = update.toolCallId;
				if (!id) return;
				let block = rows.get(id);
				// A failed call can arrive as an update with no tool_call before it
				// (probes/stream-json-2.32/p3): create its row from the update itself.
				if (!block) {
					if (!update._meta?.kiro?.toolName) return;
					block = surfaceRow(id, update);
				} else if (Object.keys(block.arguments).length === 0 && isRecord(update.rawInput)) {
					block.arguments = update.rawInput as ToolCallBlock["arguments"];
					const index = output.content.indexOf(block);
					if (index !== -1) {
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(update.rawInput), partial: output });
					}
				}
				if (update.status === "failed" && !failedMarked.has(id)) {
					failedMarked.add(id);
					pushThinking(`\n⚙ ${block.name} — failed\n`);
				}
				return;
			}
			default:
				return;
		}
	};

	const onLine = (line: string) => {
		lineNumber += 1;
		if (turn.violation || turn.terminal) return;
		if (line.trim() === "") return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			violate(`kiro-cli stream-json line ${lineNumber} is not JSON: ${line.slice(0, 80)}`);
			return;
		}
		const type = isRecord(event) ? event.type : undefined;
		const data = isRecord(event) && isRecord(event.data) ? event.data : {};
		if (!started) {
			const ok =
				type === "runStarted" &&
				data.payloadSchema === "acp" &&
				data.acpProtocolVersion === 1 &&
				data.engine === options.engine;
			if (!ok) {
				violate(
					type === "runStarted"
						? `kiro-cli stream-json envelope not recognized (payloadSchema=${String(data.payloadSchema)}, acpProtocolVersion=${String(data.acpProtocolVersion)}, engine=${String(data.engine)}; expected acp, 1, ${options.engine})`
						: `kiro-cli stream-json did not open with runStarted (line ${lineNumber}: ${line.slice(0, 80)})`,
				);
				return;
			}
			started = true;
			return;
		}
		switch (type) {
			case "sessionUpdate":
				if (isRecord(data.update)) onUpdate(data.update as KiroUpdate);
				return;
			case "metadata":
				if (typeof data.sessionId === "string") metadataSessionId = data.sessionId;
				if (typeof data.contextUsagePercentage === "number") turn.contextPercent = data.contextUsagePercentage;
				if (typeof data.turnDurationMs === "number") turn.turnDurationMs = data.turnDurationMs;
				if (Array.isArray(data.meteringUsage)) {
					const summed = sumCredits(data.meteringUsage);
					turn.credits = summed.credits;
					turn.creditsUnitPlural = summed.unitPlural;
					turn.creditsOtherUnits = summed.otherUnits;
				}
				return;
			case "runFinished":
				turn.terminal = {
					type: "runFinished",
					status: typeof data.status === "string" ? data.status : "unknown",
					sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
					finalText: typeof data.finalText === "string" ? data.finalText : "",
					finalTextTruncated: typeof data.finalTextTruncated === "boolean" ? data.finalTextTruncated : undefined,
				};
				return;
			case "runError":
				turn.terminal = {
					type: "runError",
					stage: typeof data.stage === "string" ? data.stage : "unknown",
					message: typeof data.message === "string" ? data.message : "",
				};
				return;
			default:
				return;
		}
	};

	return {
		/** Feed decoded stdout text; complete lines are processed immediately. */
		feed(text: string): void {
			pending += text;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		},
		/** Flush a final line that had no trailing newline. */
		end(): void {
			if (pending !== "") onLine(pending);
			pending = "";
		},
		get violation(): string | undefined {
			return turn.violation;
		},
		result(): StreamJsonTurn {
			const terminalSession = turn.terminal?.type === "runFinished" ? turn.terminal.sessionId : undefined;
			return { ...turn, sessionId: terminalSession ?? metadataSessionId };
		},
	};
}
