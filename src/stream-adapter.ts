/**
 * streamSimple bridge: Pi turn -> `kiro-cli chat --no-interactive` -> Pi
 * AssistantMessageEventStream.
 *
 * Kiro has no agent SDK and no structured output (kirodotdev/Kiro#5423 tracks
 * NDJSON). Until that ships:
 *
 * - The Pi conversation is serialized into one XML-tagged prompt with a
 *   sentinel instruction: the model wraps ONLY its final answer in
 *   <pi_final>...</pi_final>.
 * - stdout is ANSI-stripped and streamed into a thinking block live; on exit
 *   the sentinel span becomes the text block (fallback: the whole cleaned body).
 * - stderr is scanned for tool activity, NOT folded into the answer. As of
 *   kiro-cli 2.21 that is where tool-use lines are printed, so a turn's tool
 *   calls are invisible on stdout alone (see toolUseTranscript).
 * - The dim footer line ` ▸ Credits: N.NN • Time: Ns` is parsed for cost:
 *   credits land in usage.cost.total scaled by PI_KIRO_CREDIT_USD (default 0,
 *   seat-billed). The CLI reports no token counts.
 *
 * Compliance: all model traffic runs inside the official kiro-cli under the
 * user's own login; this module never touches credentials.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { HttpBridgeHandle } from "./bridge.js";
import { createThinkingWriter, emptyAssistantMessage, envMs } from "./transport-utils.js";
import {
	disableInheritedResources,
	type KiroAgentProfile,
	type WorkspaceSettingsHandle,
	writeAgentProfile,
} from "./kiro-bridge.js";
import { registerChildForCleanup, unregisterChildForCleanup } from "./orphan-reaper.js";
import { discoverWorkflowMcpServers } from "./workflow-mcp-discovery.js";
import { createToolUseStreamParser, parseKiroToolUses, synthesizeToolCallBlocks } from "./kiro-tooluse-parser.js";
import { BRIDGE_MCP_SERVER_KEY, displayToolName } from "./tool-names.js";
import { createStreamJsonReader, type StreamJsonTurn } from "./stream-json-reader.js";
import { trace } from "./trace.js";
import { currentSystemPrompt } from "./system-prompt.js";
import { KIRO_PROVIDER } from "./models.js";
import { CHAT_ENGINE, authMethod, identityBlock, identityLine, redactSecrets, resolvePiVersion } from "./identity.js";
import {
	advanceSession,
	dropSession,
	type ListSessionsFn,
	makeListSessions,
	planTurn,
	recordFreshSession,
	recordKnownSession,
	resumeEnabled,
	snapshotSessions,
} from "./session-manager.js";

/** kiro exits with code 3 when --require-mcp-startup can't connect a server. */
const MCP_STARTUP_EXIT_CODE = 3;
// Up to 3: one turn plus room for an MCP-startup retry and a resume→full fallback.
const MAX_ATTEMPTS = 3;

/** Id prefix for live-progress toolCall placeholders -- shared by every
 * producer (both chat stream handlers and the ACP session/update handler) and
 * every strip site, so they cannot drift apart.
 *
 * Exported because the ACP transport surfaces the same display-only blocks: pi
 * dispatches ANY toolCall block it finds on an assistant message, keying off
 * presence rather than stopReason, so a block describing a call kiro has
 * ALREADY executed must be marked and stripped. */
export const LIVE_TOOL_ID_PREFIX = "kiro-live-";

type LiveToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function isLivePlaceholder(block: AssistantMessage["content"][number]): block is LiveToolCall {
	return block.type === "toolCall" && String(block.id).startsWith(LIVE_TOOL_ID_PREFIX);
}

/** Drop live-progress placeholder toolCall blocks (matched by LIVE_TOOL_ID_PREFIX). */
export function stripLivePlaceholders(content: AssistantMessage["content"]): AssistantMessage["content"] {
	return content.filter((block) => !isLivePlaceholder(block));
}

/**
 * Live toolCall placeholders for one chat attempt.
 *
 * pi's TUI draws a row per toolCall id the first time it sees one on a
 * partial, and only ever refreshes that row's arguments under the SAME id.
 * kiro's tool-use line names the tool but (in the 2.21+ compact form) carries
 * no arguments, so a placeholder starts as `{}` -- which a tool's renderCall
 * shows as e.g. "todo undefined" -- and nothing used to fill it. For bridged
 * tools the bridge sees the real arguments; `fill` puts them on the oldest
 * unfilled placeholder of that name and emits a toolcall_delta so pi redraws
 * the row. A call that reaches the bridge before its line is parsed is held
 * and applied when `surface` creates the placeholder.
 */
function createLiveToolCalls(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	pushThinking: (delta: string) => void,
) {
	const unfilled = new Set<string>();
	const early = new Map<string, Array<Record<string, unknown>>>();
	return {
		surface(name: string): void {
			const args = early.get(name)?.shift();
			// Random, not a per-turn counter: pi keys rows by id, so ids must not
			// repeat across turns.
			const id = `${LIVE_TOOL_ID_PREFIX}${randomUUID()}-${name}`;
			output.content.push({ type: "toolCall", id, name, arguments: (args ?? {}) as LiveToolCall["arguments"] });
			if (!args) unfilled.add(id);
			pushThinking(`\n⚙ ${name}\n`);
		},
		fill(name: string, args: Record<string, unknown>): void {
			const index = output.content.findIndex((block) => isLivePlaceholder(block) && block.name === name && unfilled.has(block.id));
			const block = output.content[index];
			if (!block || !isLivePlaceholder(block)) {
				const queued = early.get(name) ?? [];
				queued.push(args);
				early.set(name, queued);
				return;
			}
			unfilled.delete(block.id);
			block.arguments = args as LiveToolCall["arguments"];
			// `index` is looked up now, not cached at surface time: while a bridge
			// listener is subscribed (one attempt), output.content is append-only --
			// its only reassignments are runAttempt's strip before subscribing and
			// reconcileToolCalls after unsubscribing -- so this is the block's
			// current slot in the partial being pushed.
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial: output });
		},
	};
}

/**
 * Hard ceiling for one chat-transport turn (default 45 min). Unlike the ACP
 * transport there is no protocol heartbeat to distinguish "working" from
 * "wedged", so a stuck kiro-cli child would otherwise live as long as its
 * parent does — the ceiling bounds it. Mirrors the ACP transport's
 * PI_KIRO_TURN_TIMEOUT_MS. Override: PI_KIRO_CHAT_TIMEOUT_MS.
 */
function chatTimeoutMs(): number {
	return envMs("PI_KIRO_CHAT_TIMEOUT_MS", 45 * 60 * 1000);
}

export type ChatFormat = "text" | "stream-json";

/**
 * PI_KIRO_CHAT_FORMAT (#47): `text` (the default) scrapes kiro's prose;
 * `stream-json` reads `--output-format stream-json` (stream-json-reader.ts).
 * Matched exactly after trimming; anything else fails the turn before kiro is
 * spawned, rather than silently picking a transport the user did not ask for.
 */
export function chatFormat(): ChatFormat {
	const raw = (process.env.PI_KIRO_CHAT_FORMAT ?? "").trim();
	if (raw === "" || raw === "text") return "text";
	if (raw === "stream-json") return "stream-json";
	throw new Error(`unknown PI_KIRO_CHAT_FORMAT "${raw}" (expected text or stream-json)`);
}

/** Upper bound on waiting for stdout to drain after a stream-json child exits. */
const STREAM_JSON_DRAIN_MS = 1_000;

export const FINAL_OPEN = "<pi_final>";
export const FINAL_CLOSE = "</pi_final>";
// TODO(stream-json): demote to fallback once `chat --output-format stream-json`
// is default (it exposes structured output directly, making FINAL_OPEN,
// FINAL_CLOSE, extractFinal and the sentinel instruction unnecessary); delete
// only once support for kiro-cli versions lacking the flag is dropped. See
// docs/design/acp-transport.md section 5c.

/** Map Pi thinking levels onto kiro-cli --effort values. */
export function mapEffort(level: ThinkingLevel | undefined): string | undefined {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		default:
			return undefined;
	}
}

// CSI sequences, OSC sequences, and stray C0 controls (except \n and \t).
const CSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const OSC_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
	return text.replace(CSI_PATTERN, "").replace(OSC_PATTERN, "").replace(CONTROL_PATTERN, "");
}

const PREAMBLE_PATTERNS = [
	/^All tools are now trusted/,
	/^Agents can sometimes do unexpected/,
	/^Learn more at/,
	/^\s*>\s*$/,
];

/** Remove kiro's trust-notice preamble and the leading "> " response marker. */
export function cleanBody(raw: string): { body: string; credits: number | undefined } {
	let credits: number | undefined;
	const lines = stripAnsi(raw).split("\n");
	const kept: string[] = [];
	for (const line of lines) {
		const creditsMatch = line.match(/▸\s*Credits:\s*([\d.]+)/);
		if (creditsMatch) {
			credits = Number.parseFloat(creditsMatch[1]);
			continue;
		}
		if (PREAMBLE_PATTERNS.some((pattern) => pattern.test(line))) continue;
		kept.push(line.replace(/^>\s?/, ""));
	}
	return { body: kept.join("\n").trim(), credits };
}

/**
 * The text to scan for tool-use lines, which is NOT the same as the answer body.
 *
 * kiro-cli 2.21 prints tool activity on STDERR, not stdout: a turn that calls
 * @gsdworkflow/gsd_doctor leaves stdout holding only the model's answer while
 * stderr holds "[tool] Running: @gsdworkflow/gsd_doctor". Parsing stdout alone
 * therefore finds zero tool calls no matter how the line is formatted, GSD's
 * snapshotUnitActivity counts zero, and a unit that did the work gets salvaged.
 * Older kiro-cli put those lines on stdout, so both streams are scanned; a given
 * line only ever appears on one of them, so nothing is double counted.
 *
 * Kept separate from `body` on purpose: `body` feeds extractFinal and becomes the
 * user-visible answer, and stderr must never leak into it.
 */
export function toolUseTranscript(body: string, rawStderr: string): string {
	const stderrClean = stripAnsi(rawStderr).trim();
	if (!stderrClean) return body;
	return body ? `${body}\n${stderrClean}` : stderrClean;
}

/**
 * Find the opening tag that pairs with the closing tag at `close`, scanning
 * backwards and treating every tag pair in between as nested. Returns -1 when
 * the tags before `close` do not balance.
 */
function matchingOpen(body: string, close: number): number {
	let depth = 1;
	let pos = close;
	while (pos > 0) {
		const open = body.lastIndexOf(FINAL_OPEN, pos - 1);
		if (open === -1) return -1;
		const inner = body.lastIndexOf(FINAL_CLOSE, pos - 1);
		if (inner > open) {
			depth++;
			pos = inner;
		} else {
			depth--;
			if (depth === 0) return open;
			pos = open;
		}
	}
	return -1;
}

/**
 * Split the cleaned body into (working, final) via the sentinel protocol.
 *
 * The final answer is the span ending at the LAST closing tag, opened by the tag
 * that balances it. Neither "first open" nor "last open" is right on its own: a
 * model that writes an earlier span or names the tag in its notes defeats the
 * first (the answer swallows the notes and their raw tags), and an answer that
 * itself quotes both tags, which is routine when kiro works on this repo,
 * defeats the last (the answer is cut to its tail). Balancing handles both.
 * When the tags do not balance (an answer quoting a lone closing tag) it falls
 * back to the first opening tag, the pre-balancing behaviour. The one shape
 * still misread is an answer quoting a lone OPENING tag; there the tags are
 * genuinely ambiguous.
 */
export function extractFinal(body: string): { working: string; final: string } {
	const close = body.lastIndexOf(FINAL_CLOSE);
	const balanced = close === -1 ? -1 : matchingOpen(body, close);
	const open = balanced !== -1 ? balanced : body.indexOf(FINAL_OPEN);
	if (open !== -1 && close > open) {
		const final = body.slice(open + FINAL_OPEN.length, close).trim();
		const working = `${body.slice(0, open)}${body.slice(close + FINAL_CLOSE.length)}`.trim();
		return { working, final };
	}
	return { working: "", final: body };
}

/**
 * Escape a string for safe use inside an XML attribute value (double-quoted).
 * Prevents attribute injection when user-controlled data (e.g. toolName) is
 * interpolated into `<tag attr="...">` markup.
 */
export function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function contentToText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "image") return "[image attachment omitted]";
			if (block.type === "toolCall") {
				return `[called tool ${block.name}(${JSON.stringify(block.arguments ?? {})})]`;
			}
			return "";
		})
		.filter((piece) => piece.length > 0)
		.join("\n");
}

/** Serialize one Pi message to its XML block, or undefined if it carries no text. */
function serializeMessage(message: Message): string | undefined {
	if (message.role === "user") {
		return `<user_message>\n${contentToText(message.content)}\n</user_message>`;
	}
	if (message.role === "assistant") {
		// toolCall blocks are dropped, not rendered. contentToText would turn them
		// into `[called tool name({...})]` text, and this history is replayed to
		// kiro on every full resend alongside a <tool_context> block that tells it
		// those same tools ARE callable as @pi/<name>. kiro read that as work to
		// do and re-issued the calls against ids lifted out of the replayed text.
		// The paired <tool_result> already carries what ran and what came back.
		const text = contentToText(
			message.content.filter((block) => block.type !== "thinking" && block.type !== "toolCall") as Message["content"],
		);
		return text.length > 0 ? `<assistant_message>\n${text}\n</assistant_message>` : undefined;
	}
	if (message.role === "toolResult") {
		return `<tool_result tool="${escapeXmlAttr(message.toolName ?? "")}">\n${contentToText(message.content)}\n</tool_result>`;
	}
	return undefined;
}

export interface PromptBuildOpts {
	/**
	 * Whether to include the sentinel instruction line (`Wrap ONLY your final answer
	 * between <pi_final>…</pi_final>`).
	 *
	 * - `true` (default): included. Used by the chat transport, which relies on
	 *   sentinel extraction to separate working notes from the final answer.
	 * - `false`: omitted. Used by the ACP transport, which receives structured
	 *   protocol events instead of parsing raw text; the sentinel is never needed and
	 *   must not appear (spec §3.4).
	 */
	sentinel?: boolean;
	/**
	 * The harness identity line (identity.ts identityLine). When set, an
	 * <identity> block goes FIRST in every prompt, full and delta alike: the
	 * probes showed a model only reports itself as pi reliably when the
	 * identity is restated on every turn, not just the first.
	 */
	identity?: string;
	/**
	 * Exposed bridge name -> the caller-session name it was registered under
	 * (HttpBridgeHandle.toolAliases). The history names tools the caller's way
	 * (`todo`); kiro must call the exposed one (`@pi/rpiv_todo`).
	 */
	toolAliases?: Record<string, string>;
}

/** The MCP tool-name alphabet; anything else is kept out of the prompt's alias line. */
const PROMPT_SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]+$/;

/** The fixed preamble + tool-context scaffolding shared by full and delta prompts. */
function buildScaffolding(bridgedTools?: string[], workflowMcp?: boolean, opts?: PromptBuildOpts): string[] {
	const includeSentinel = opts?.sentinel !== false; // default true
	const toolContextLines = [
		"<tool_context>",
		"The prior context below may reference tools from the calling session (read, grep, bash, Agent, todo, ask_user_question, subagent dispatch, skills, pipeline stages). Do not refuse or explain that you lack them: perform file/search/shell work yourself with your own tools.",
		"When calling your own file-read tool, pass `path` as a top-level argument — not nested inside an `operations` array. That nested shape is a different, unavailable tool signature and will be rejected for a missing top-level `path`.",
	];
	if (bridgedTools && bridgedTools.length > 0) {
		toolContextLines.push(
			`These calling-session tools ARE available to you as MCP tools from the "${BRIDGE_MCP_SERVER_KEY}" server — call them as @${BRIDGE_MCP_SERVER_KEY}/<tool_name>: ${bridgedTools.join(", ")}.`,
		);
		// Names are spliced into the prompt, so only MCP-name-shaped ones are: a
		// name carrying a newline or a closing tag would break the block's structure.
		const aliases = bridgedTools
			.map((name) => [name, opts?.toolAliases?.[name]] as const)
			.filter(([name, original]) => original !== undefined && PROMPT_SAFE_TOOL_NAME.test(original) && PROMPT_SAFE_TOOL_NAME.test(name))
			.map(([name, original]) => `the caller's ${original} is available as @${BRIDGE_MCP_SERVER_KEY}/${name}`);
		if (aliases.length > 0) {
			toolContextLines.push(
				`They are exposed under origin-prefixed names; a tool the prior context names the caller's way maps to its exposed name: ${aliases.join("; ")}.`,
			);
		}
		if (bridgedTools.includes("rpiv_ask_user_question")) {
			toolContextLines.push(
				"- For structured user questions call @pi/rpiv_ask_user_question instead of guessing at ambiguous requirements.",
			);
		}
		if (bridgedTools.includes("rpiv_todo")) {
			toolContextLines.push("- Track task progress with @pi/rpiv_todo (same contract as the caller's todo tool).");
		}
		if (bridgedTools.includes("subagents_Agent")) {
			toolContextLines.push(
				"- Dispatch specialist subagents with @pi/subagents_Agent; collect results with @pi/subagents_get_subagent_result.",
			);
		}
	}
	if (workflowMcp) {
		toolContextLines.push(
			"The gsd_* workflow tools (gsd_plan_slice, gsd_plan_task, gsd_exec, gsd_task_complete, gsd_slice_complete, gsd_uat_exec, and the rest) ARE available to you natively as MCP tools under their bare names. When the task requires them, CALL them — do not describe intended calls in prose, and do not hand-write artifacts those tools own.",
		);
	}
	toolContextLines.push("</tool_context>");

	const lines: string[] = [];
	if (opts?.identity) lines.push(identityBlock(opts.identity));
	lines.push(
		"You are the executor for a task delegated from another agent session. Complete the task in the final user message directly, using your own tools.",
		toolContextLines.join("\n"),
	);
	if (includeSentinel) {
		lines.push(
			`Wrap ONLY your final answer between ${FINAL_OPEN} and ${FINAL_CLOSE} tags — everything outside the tags is treated as working notes.`,
		);
	}
	lines.push("Do not emit <user_message>, <assistant_message>, <tool_result> or <prior_system_context> tags in your reply.");
	return lines;
}

/** Full prompt: preamble + system prompt + the entire conversation history. */
export function buildPromptFromContext(context: Context, bridgedTools?: string[], workflowMcp?: boolean, opts?: PromptBuildOpts): string {
	const parts = buildScaffolding(bridgedTools, workflowMcp, opts);
	// pi >= 0.86 carries the prompt as transcript system messages, not
	// context.systemPrompt; see system-prompt.ts.
	const systemPrompt = currentSystemPrompt(context);
	if (systemPrompt.trim().length > 0) {
		parts.push(`<prior_system_context>\n${systemPrompt}\n</prior_system_context>`);
	}
	const history = context.messages.map(serializeMessage).filter((block): block is string => block !== undefined);
	if (history.length > 0) {
		parts.push(`<conversation_history>\n${history.join("\n")}\n</conversation_history>`);
	}
	return parts.join("\n\n");
}

/**
 * True for an assistant message another pi provider produced (a manual /model
 * switch, or a router fallback to Bedrock / Anthropic / OpenAI). kiro never
 * saw it, so a resumed kiro session does not hold it. A message with no
 * provider is treated as kiro's own: pi stamps every assistant message it
 * records, so only hand-built transcripts lack one.
 */
export function isForeignAssistant(message: Message): boolean {
	if (message.role !== "assistant") return false;
	const provider = (message as { provider?: unknown }).provider;
	return typeof provider === "string" && provider !== KIRO_PROVIDER;
}

/**
 * Delta prompt for a `--resume-id` turn: the same scaffolding, but only the NEW
 * turn's input — no <prior_system_context> and no <conversation_history> (kiro
 * already holds those in the resumed session). kiro's OWN assistant messages
 * are skipped: they are already in-session, and re-sending them would echo the
 * model's output back as user input. An assistant message from ANOTHER
 * provider is kept: after kiro -> bedrock -> kiro the delta carries the
 * Bedrock answer, and dropping it left kiro answering a follow-up to a reply it
 * never saw. System messages never reach here: planTurn/planAcpTurn send a
 * turn whose delta carries one fresh.
 */
export function buildDeltaPrompt(deltaMessages: Message[], bridgedTools?: string[], workflowMcp?: boolean, opts?: PromptBuildOpts): string {
	const parts = buildScaffolding(bridgedTools, workflowMcp, opts);
	const blocks = deltaMessages
		.filter((message) => message.role !== "assistant" || isForeignAssistant(message))
		.map(serializeMessage)
		.filter((block): block is string => block !== undefined);
	if (blocks.length > 0) parts.push(blocks.join("\n"));
	return parts.join("\n\n");
}

/**
 * One spawn+drain of the kiro-cli child for a single attempt of the retry loop
 * in streamViaKiro below. Wires abort/ceiling kill timers and LIVE tool-use
 * detection on stdout/stderr -- mutating `output.content` with placeholder
 * toolCall blocks and feeding `pushThinking` as they arrive -- then resolves
 * once the child exits. The retry POLICY stays in the caller.
 */
async function runAttempt(
	args: string[],
	binaryPath: string | undefined,
	output: AssistantMessage,
	pushThinking: (delta: string) => void,
	abortSignal: AbortSignal | undefined,
	live: { stream: AssistantMessageEventStream; bridge?: HttpBridgeHandle; format: ChatFormat },
): Promise<{ exitCode: number; raw: string; stderrText: string; timedOut: boolean; streamJson?: StreamJsonTurn }> {
	let turnTimedOut = false;
	// detached: own process group, so aborts can kill kiro's helper
	// children too (a lone SIGTERM to the parent leaves grandchildren
	// holding the stdio pipes and delays teardown).
	const detached = process.platform !== "win32";
	const child = spawn(binaryPath ?? "kiro-cli", args, {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached,
	});
	// Detached children outlive an uncleanly-dying parent -- tether them
	// to the parent's exit hook (see orphan-reaper.ts).
	registerChildForCleanup(child, detached);

	const killTree = (signal: NodeJS.Signals) => {
		try {
			if (detached && child.pid) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {
			// already gone
		}
	};
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	// Arm the SIGKILL escalation after a SIGTERM. Abort, the turn ceiling, and a
	// stream-json envelope violation can each reach this; clear any prior timer
	// first so a second arming doesn't leak the first (unref'd, so it would only
	// fire a redundant kill at an already-dead group, but still worth not leaking).
	const armKill = () => {
		if (killTimer) clearTimeout(killTimer);
		killTimer = setTimeout(() => killTree("SIGKILL"), 1_500);
		killTimer.unref?.();
	};
	const onAbort = () => {
		killTree("SIGTERM");
		// kiro-cli's graceful shutdown can be slow -- escalate.
		armKill();
	};
	abortSignal?.addEventListener("abort", onAbort, { once: true });
	// Hard turn ceiling: a wedged child even with a live, patient parent
	// must not run forever. Env read at spawn time; unref'd so the timer
	// never keeps the host alive.
	const ceilingMs = chatTimeoutMs();
	const ceilingTimer = setTimeout(() => {
		turnTimedOut = true;
		killTree("SIGTERM");
		armKill();
	}, ceilingMs);
	ceilingTimer.unref?.();

	let raw = "";
	let stderrText = "";
	// LIVE progress: detect tool-use lines as they stream and surface
	// them immediately -- a placeholder toolCall block on the partial
	// message (dashboards/ledgers see tool-by-tool activity mid-turn)
	// plus a clean marker in the thinking feed. Reconciled at end of
	// turn by the authoritative synthesizeToolCallBlocks pass.
	// Per-attempt: a retried attempt drops its predecessor's live blocks.
	output.content = stripLivePlaceholders(output.content);
	let stopListening: (() => void) | undefined;
	let reader: ReturnType<typeof createStreamJsonReader> | undefined;
	let finishReader = () => undefined as void;
	let stdoutEnded: Promise<void> = Promise.resolve();
	if (live.format === "stream-json") {
		// Structured events: rows carry kiro's own ids and complete
		// rawInput, so neither the text parser nor the bridge fill is needed.
		// StringDecoder because a chunk can end mid-UTF-8 sequence.
		const decoder = new StringDecoder("utf8");
		const streamReader = createStreamJsonReader(output, live.stream, pushThinking, {
			engine: CHAT_ENGINE,
			livePrefix: LIVE_TOOL_ID_PREFIX,
		});
		reader = streamReader;
		let finished = false;
		finishReader = () => {
			if (finished) return;
			finished = true;
			streamReader.feed(decoder.end());
			streamReader.end();
		};
		let violationKilled = false;
		child.stdout.on("data", (chunk: Buffer) => {
			const text = decoder.write(chunk);
			// raw is deliberately NOT accumulated here: the stream-json path
			// settles off the parsed reader result, never cleanBody(raw), so
			// keeping a second full copy of a long turn's stdout is dead weight.
			streamReader.feed(text);
			// A broken envelope fails the turn; stop kiro rather than let it run on.
			if (streamReader.violation && !violationKilled) {
				violationKilled = true;
				killTree("SIGTERM");
				armKill();
			}
		});
		stdoutEnded = new Promise((resolve) => {
			child.stdout.once("end", () => resolve());
			child.once("close", () => resolve());
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrText += chunk.toString("utf8");
		});
	} else {
		const liveCalls = createLiveToolCalls(output, live.stream, pushThinking);
		stopListening = live.bridge?.onToolCall?.(liveCalls.fill);
		const liveParser = createToolUseStreamParser();
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			raw += text;
			pushThinking(stripAnsi(text));
			for (const use of liveParser.feed(stripAnsi(text))) liveCalls.surface(displayToolName(use.name, use.server));
		});
		// Tool-use lines arrive HERE on kiro-cli 2.21+ (see toolUseTranscript),
		// so stderr gets its own parser instance: one line only ever lands on
		// one stream, and a shared instance would splice the two streams'
		// partial trailing lines into each other.
		const liveStderrParser = createToolUseStreamParser();
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderrText += text;
			for (const use of liveStderrParser.feed(stripAnsi(text))) liveCalls.surface(displayToolName(use.name, use.server));
		});
	}

	const exitCode: number = await new Promise((resolve, reject) => {
		child.on("error", reject);
		// "close" waits for the stdio pipes of the whole process tree to
		// drain; "exit" fires at process exit. Settle on "exit" so an
		// aborted run doesn't hang on a grandchild holding the pipes.
		child.on("exit", (code) => resolve(code ?? -1));
	});
	if (reader) {
		// "exit" can fire before stdout drains, and runFinished is the LAST line.
		// Bounded: a grandchild holding the pipe must not stall the turn. The
		// trade is that a runFinished arriving more than STREAM_JSON_DRAIN_MS
		// after exit is lost and the turn fails as "ended without runFinished";
		// in practice stdout "end"/"close" fires immediately after a clean exit.
		await Promise.race([stdoutEnded, new Promise((resolve) => setTimeout(resolve, STREAM_JSON_DRAIN_MS).unref?.())]);
		finishReader();
	}
	abortSignal?.removeEventListener("abort", onAbort);
	stopListening?.();
	clearTimeout(ceilingTimer);
	if (killTimer) clearTimeout(killTimer);
	unregisterChildForCleanup(child);

	return { exitCode, raw, stderrText, timedOut: turnTimedOut, streamJson: reader?.result() };
}

/**
 * Settle a stream-json turn once the attempt loop is done:
 * a broken envelope, a non-success finish, a runError or a stream with no
 * terminal event fails the turn; otherwise the answer is extractFinal over the
 * reassembled message chunks (the sentinel still applies -- finalText is ALL of
 * the turn's message text, narration included).
 */
function settleStreamJsonTurn(turn: StreamJsonTurn | undefined, exitCode: number): { final: string; credits: number | undefined } {
	const textHint = "set PI_KIRO_CHAT_FORMAT=text to use the text transport.";
	if (turn?.violation) throw new Error(`${turn.violation}; ${textHint}`);
	const terminal = turn?.terminal;
	if (!turn || !terminal) {
		throw new Error(`kiro-cli stream-json ended without runFinished or runError (exit ${exitCode}); ${textHint}`);
	}
	if (terminal.type === "runError") throw new Error(`kiro-cli run failed (${terminal.stage}): ${terminal.message}`);
	if (terminal.status !== "success") throw new Error(`kiro-cli run finished with status ${terminal.status}`);
	if (terminal.finalText !== turn.messageText) {
		trace("chat.stream.finaltext_mismatch", {
			finalTextChars: terminal.finalText.length,
			messageChars: turn.messageText.length,
			finalTextTruncated: terminal.finalTextTruncated,
		});
	}
	return { final: extractFinal(turn.messageText).final, credits: turn.credits };
}

/**
 * Decide whether a nonzero exit still represents a completed turn: kiro-cli
 * sometimes dies AFTER the final answer, or after MCP tool calls have already
 * landed server-side (seen on 2.15.2: exit 1 following a successful
 * gsd_task_complete). Failing the whole turn would discard finished work and
 * pause GSD auto-mode, so degrade to success and let the caller's own
 * verification be the arbiter. A nonzero exit with NO final sentinel and NO
 * tool activity is still a hard failure.
 *
 * TODO(stream-json): demote to fallback once stream-json is default (turn
 * completion becomes a protocol event there); delete only once support for
 * kiro-cli versions lacking the flag is dropped.
 */
function salvageOrThrow(exitCode: number, body: string, stderrText: string, toolTranscript: string, pushThinking: (delta: string) => void): void {
	if (exitCode === 0) return;
	const salvageToolUses = parseKiroToolUses(toolTranscript);
	const hasFinal = body.includes(FINAL_OPEN);
	if (!hasFinal && salvageToolUses.length === 0) {
		const stderrClean = stripAnsi(stderrText).trim();
		const detail = [body.slice(-400), stderrClean.slice(-200)].filter(Boolean).join(" ⏐ stderr: ") || `exit code ${exitCode}`;
		throw new Error(`kiro-cli failed (exit ${exitCode}): ${detail.slice(0, 600)}`);
	}
	pushThinking(`\n[kiro-cli exited ${exitCode} after completing work (${salvageToolUses.length} tool call(s)${hasFinal ? ", final answer present" : ""}) -- salvaging turn]\n`);
}

/**
 * Tag synthesized end-of-turn toolCall blocks with LIVE_TOOL_ID_PREFIX so
 * stripLivePlaceholders removes them from the final done/error message before
 * pi sees it. pi's agent loop (agent-loop.ts:228) dispatches on the PRESENCE
 * of toolCall blocks, not on stopReason; any block without the prefix
 * triggers redispatch of work kiro already executed.
 *
 * A block whose call was already surfaced live takes over that placeholder's
 * id (oldest same-name first), so pi refreshes the existing row instead of
 * drawing a second one. Parsed arguments win when the transcript has them
 * (legacy ⋮ form); otherwise the placeholder's bridge-filled ones are kept.
 */
function reconcileToolCalls(
	output: AssistantMessage,
	toolTranscript: string,
	pushThinking: (delta: string) => void,
): void {
	const unclaimed = output.content.filter(isLivePlaceholder);
	output.content = stripLivePlaceholders(output.content);
	for (const block of synthesizeToolCallBlocks(toolTranscript)) {
		const match = unclaimed.findIndex((placeholder) => placeholder.name === block.name);
		const placeholder = match === -1 ? undefined : unclaimed.splice(match, 1)[0];
		if (placeholder) {
			const parsed = Object.keys(block.arguments).length > 0;
			output.content.push({ ...block, id: placeholder.id, arguments: parsed ? block.arguments : placeholder.arguments });
		} else {
			output.content.push({ ...block, id: `${LIVE_TOOL_ID_PREFIX}${block.id}` });
			pushThinking(`\n⚙ ${block.name}\n`);
		}
		trace("chat.toolcall.surfaced", { tool: block.name, displayOnly: true, reusedLiveRow: placeholder !== undefined });
	}
	// A live row the end-of-turn transcript has no call for is dropped with the
	// rest of the placeholders; trace it so a tool that appeared mid-turn and
	// then vanished can be diagnosed.
	for (const leftover of unclaimed) {
		trace("chat.toolcall.dropped", { tool: leftover.name, id: leftover.id });
	}
}

/** Test hook: the end-of-turn reconciliation pass. */
export const _reconcileToolCalls = reconcileToolCalls;

/**
 * Record/advance the kiro session bookkeeping BEFORE the caller emits `done`,
 * so a sequential next turn sees it instead of creating a duplicate session.
 * Advance (resume path) is sync; capture (fresh path) does one list-sessions
 * call, paid once per session rather than per turn. Best-effort: never fail a
 * good turn over session bookkeeping.
 */
async function recordSession(
	useResume: boolean,
	resumeId: string | undefined,
	cwd: string,
	messages: Message[],
	preSnapshot: Set<string>,
	listSessions: ListSessionsFn,
): Promise<void> {
	if (!resumeEnabled()) return;
	try {
		if (useResume && resumeId) {
			advanceSession(resumeId, messages);
		} else {
			await recordFreshSession(cwd, messages, preSnapshot, listSessions);
		}
	} catch {
		// session bookkeeping is opportunistic -- a failure just means the
		// next turn re-sends full context.
	}
}

/**
 * Session bookkeeping for a stream-json turn: kiro names the session in its
 * own events, so record that id directly instead of diffing session lists.
 * Best-effort, like recordSession.
 */
function recordStreamJsonSession(sessionId: string | undefined, resumeId: string | undefined, cwd: string, messages: Message[]): void {
	if (!resumeEnabled()) return;
	try {
		if (sessionId) recordKnownSession(sessionId, cwd, messages);
		else if (resumeId) advanceSession(resumeId, messages);
	} catch {
		// opportunistic -- the next turn re-sends full context
	}
}

interface StreamDeps {
	binaryPath: string | undefined;
	/**
	 * Builds a fresh loopback HTTP MCP bridge for one delegated turn, or
	 * undefined when disabled or no bridgeable tools are available.
	 */
	getBridge?: (signal: AbortSignal) => Promise<HttpBridgeHandle | undefined>;
	/** Bare kiro-cli semver from readiness (e.g. "2.26.1"), for the identity line. */
	kiroVersion?: string;
}

export function makeStreamViaKiro(deps: StreamDeps) {
	return function streamViaKiro(
		model: Model<any>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output = emptyAssistantMessage(model);

		(async () => {
			let bridge: HttpBridgeHandle | undefined;
			let profile: KiroAgentProfile | undefined;
			let workspaceSettings: WorkspaceSettingsHandle | undefined;
			try {
				stream.push({ type: "start", partial: output });

				// Parity with built-in providers: fires before_provider_request so
				// extensions (including our own ctx capture) see the turn.
				await options?.onPayload?.({ provider: "kiro", model: model.id }, model);
				const format = chatFormat();

				const identity = identityLine({
					piVersion: await resolvePiVersion(),
					kiroVersion: deps.kiroVersion,
					engine: CHAT_ENGINE,
					model: model.id,
				});
				trace("identity", { transport: "chat", format, line: identity, auth: authMethod() });

				bridge = await deps.getBridge?.(options?.signal ?? new AbortController().signal);
				// GSD workflow-MCP transport: mount the project's gsd-workflow stdio
				// server inside kiro so GSD units can actually call gsd_* tools.
				const workflowServers = discoverWorkflowMcpServers(process.cwd());
				if (bridge || workflowServers) profile = writeAgentProfile(bridge, workflowServers);
				// Only worth doing behind a custom profile: kiro's built-in agents keep
				// inheriting regardless of the setting, so with no profile there is
				// nothing to save and no reason to touch the user's project.
				if (profile) workspaceSettings = disableInheritedResources(process.cwd());

				// Incremental context: resume the kiro session that mirrors this Pi
				// conversation and send only the delta, instead of re-serializing the
				// whole history every turn. `plan` decides fresh vs resume by matching
				// the message-prefix hash; a diverged prefix (Pi compacted/edited) or
				// any uncertainty falls back to a full fresh send.
				const cwd = process.cwd();
				const listSessions: ListSessionsFn = makeListSessions(deps.binaryPath);
				const plan = planTurn(cwd, context.messages);
				let useResume = plan.mode === "resume";
				// Snapshot existing sessions before a fresh spawn so we can identify the
				// one kiro creates (exactly-one-new-in-cwd; ambiguity => fallback).
				// TODO(stream-json): this snapshot-diff capture can die once
				// stream-json is default -- metadata.data.sessionId is in the output
				// directly. The --resume-id/prefix-hash resume logic STAYS regardless.
				// See docs/design/acp-transport.md section 5c.
				// stream-json reports its session id directly: it never lists sessions.
				const snapshot = () => (format === "stream-json" ? Promise.resolve(new Set<string>()) : snapshotSessions(cwd, listSessions));
				let preSnapshot = useResume ? new Set<string>() : await snapshot();
				let streamJson: StreamJsonTurn | undefined;

				let raw = "";
				let stderrText = "";
				let exitCode = -1;
				let turnTimedOut = false;
				const thinkingWriter = createThinkingWriter(stream, output);
				const pushThinking = thinkingWriter.push;

				for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
					// Engine pinned, never left to kiro's default: kiro-cli 2.26 documents v2 as
					// "the pre-3.0 default", so a kiro upgrade would otherwise switch engines
					// silently and make the identity line (engine CHAT_ENGINE) wrong.
					const args = ["chat", "--no-interactive", "--trust-all-tools", "--agent-engine", CHAT_ENGINE];
					if (format === "stream-json") args.push("--output-format", "stream-json");
					if (useResume && plan.resumeId) args.push("--resume-id", plan.resumeId);
					if (profile) args.push("--agent", profile.name, "--require-mcp-startup");
					if (model.id !== "auto") args.push("--model", model.id);
					const effort = mapEffort(options?.reasoning);
					if (effort) args.push("--effort", effort);
					const promptText = useResume
						? buildDeltaPrompt(context.messages.slice(plan.deltaStart), bridge?.toolNames, !!workflowServers, { identity, toolAliases: bridge?.toolAliases })
						: buildPromptFromContext(context, bridge?.toolNames, !!workflowServers, { identity, toolAliases: bridge?.toolAliases });
					args.push(promptText);
					// attempt is traced explicitly: this loop re-sends the whole prompt on
					// an MCP-startup retry or a resume fallback, so a bridged tool already
					// executed on attempt 0 gets asked again on attempt 1. Counting sends
					// is the only way to tell that apart from a model choosing to re-call.
					trace("chat.prompt.send", {
						attempt,
						format,
						mode: useResume ? "resume" : "fresh",
						deltaStart: plan.deltaStart,
						messageCount: context.messages.length,
						promptChars: promptText.length,
						prompt: redactSecrets(promptText),
					});

					const attemptResult = await runAttempt(args, deps.binaryPath, output, pushThinking, options?.signal, {
						stream,
						bridge,
						format,
					});
					raw = attemptResult.raw;
					stderrText = attemptResult.stderrText;
					exitCode = attemptResult.exitCode;
					turnTimedOut = attemptResult.timedOut;
					streamJson = attemptResult.streamJson;

					// A ceiling kill is terminal for this turn: never retried (a fresh
					// attempt would just burn another 45 min) and never exit-salvaged.
					if (turnTimedOut) break;
					// stream-json precedence: a broken envelope or a finished
					// run settles the attempt; only then do the retries below apply.
					if (streamJson?.violation || streamJson?.terminal?.type === "runFinished") break;
					// MCP-startup readiness gate: with --require-mcp-startup kiro
					// exits 3 when the bridge didn't connect. Retry once.
					if (
						profile &&
						exitCode === MCP_STARTUP_EXIT_CODE &&
						attempt + 1 < MAX_ATTEMPTS &&
						!options?.signal?.aborted
					) {
						pushThinking("\n[bridge MCP failed to connect -- retrying]\n");
						continue;
					}
					// Resume fallback: a --resume-id spawn failed (stale/unusable
					// session). Drop it and retry this turn with the full context, so a
					// bad session never hard-fails the turn. Under stream-json the
					// signal is explicit: a runError at stage "init" (probes p2b).
					const resumeFailed = streamJson
						? streamJson.terminal?.type === "runError" && streamJson.terminal.stage === "init"
						: exitCode !== 0;
					if (useResume && resumeFailed && attempt + 1 < MAX_ATTEMPTS && !options?.signal?.aborted) {
						if (plan.resumeId) dropSession(plan.resumeId);
						useResume = false;
						preSnapshot = await snapshot();
						pushThinking("\n[kiro resume failed -- retrying with full context]\n");
						continue;
					}
					break;
				}

				thinkingWriter.end();

				if (options?.signal?.aborted) throw new Error("kiro-cli run aborted");
				if (turnTimedOut) {
					throw new Error(
						`kiro-cli chat turn exceeded PI_KIRO_CHAT_TIMEOUT_MS (${chatTimeoutMs()} ms) — child killed. Raise PI_KIRO_CHAT_TIMEOUT_MS for longer turns.`,
					);
				}

				let final: string;
				let credits: number | undefined;
				if (format === "stream-json") {
					({ final, credits } = settleStreamJsonTurn(streamJson, exitCode));
				} else {
					const cleaned = cleanBody(raw);
					credits = cleaned.credits;
					const toolTranscript = toolUseTranscript(cleaned.body, stderrText);
					salvageOrThrow(exitCode, cleaned.body, stderrText, toolTranscript, pushThinking);
					final = extractFinal(cleaned.body).final;
					reconcileToolCalls(output, toolTranscript, pushThinking);
				}
				output.content.push({ type: "text", text: "" });
				const textIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
				const textBlock = output.content[textIndex];
				if (textBlock.type === "text") textBlock.text = final;
				stream.push({ type: "text_delta", contentIndex: textIndex, delta: final, partial: output });
				stream.push({ type: "text_end", contentIndex: textIndex, content: final, partial: output });

				if (credits !== undefined) {
					const usdPerCredit = Number.parseFloat(process.env.PI_KIRO_CREDIT_USD ?? "0");
					output.usage.cost.total = Number.isFinite(usdPerCredit) ? credits * usdPerCredit : 0;
				}

				if (format === "stream-json") {
					recordStreamJsonSession(streamJson?.sessionId, useResume ? plan.resumeId : undefined, cwd, context.messages);
				} else {
					await recordSession(useResume, plan.resumeId, cwd, context.messages, preSnapshot, listSessions);
				}

				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: { ...output, content: stripLivePlaceholders(output.content) } });
				stream.end();
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = redactSecrets(error instanceof Error ? error.message : String(error));
				if (/profileArn is required/i.test(output.errorMessage)) {
					output.errorMessage += " — run `kiro-cli profile` to select a profile for this IdC seat.";
				}
				stream.push({
					type: "error",
					reason: output.stopReason as "error" | "aborted",
					error: { ...output, content: stripLivePlaceholders(output.content) } as typeof output,
				});
				stream.end();
			} finally {
				workspaceSettings?.restore();
				profile?.remove();
				await bridge?.close().catch(() => undefined);
			}
		})();

		return stream;
	};
}
