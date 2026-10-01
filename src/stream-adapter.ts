/**
 * streamSimple bridge: Pi turn -> `kiro-cli chat --no-interactive` -> Pi
 * AssistantMessageEventStream.
 *
 * Kiro has no agent SDK and (as of CLI 2.12 / v3 early access) no structured
 * output — kirodotdev/Kiro#5423 tracks NDJSON. Until that ships:
 *
 * - The Pi conversation is serialized into one XML-tagged prompt (XML-tagged) with a sentinel instruction: the model wraps ONLY
 *   its final answer in <pi_final>...</pi_final>.
 * - stdout is ANSI-stripped and streamed into a thinking block live; when
 *   the process exits, the sentinel span becomes the text block (fallback:
 *   the whole cleaned body).
 * - stderr is scanned for tool activity, NOT folded into the answer. As of
 *   kiro-cli 2.21 that is where tool-use lines are printed, so a turn's tool
 *   calls are invisible on stdout alone (see toolUseTranscript).
 * - The dim footer line ` ▸ Credits: N.NN • Time: Ns` is parsed for cost:
 *   credits land in usage.cost.total scaled by PI_KIRO_CREDIT_USD
 *   (default 0 — seat-billed). Token counts are not reported by the CLI.
 *
 * Compliance: all model traffic runs inside the official kiro-cli under the
 * user's own login; this module never touches credentials.
 */

import { spawn } from "node:child_process";
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
import { type KiroAgentProfile, writeAgentProfile } from "./kiro-bridge.js";
import { registerChildForCleanup, unregisterChildForCleanup } from "./orphan-reaper.js";
import { discoverWorkflowMcpServers } from "./workflow-mcp-discovery.js";
import { createToolUseStreamParser, parseKiroToolUses, synthesizeToolCallBlocks } from "./kiro-tooluse-parser.js";
import { trace } from "./trace.js";
import { CHAT_ENGINE, authMethod, identityBlock, identityLine, redactSecrets, resolvePiVersion } from "./identity.js";
import {
	advanceSession,
	dropSession,
	type ListSessionsFn,
	makeListSessions,
	planTurn,
	recordFreshSession,
	resumeEnabled,
	snapshotSessions,
} from "./session-manager.js";

/** kiro exits with code 3 when --require-mcp-startup can't connect a server. */
const MCP_STARTUP_EXIT_CODE = 3;
// Up to 3: one turn plus room for an MCP-startup retry and a resume→full fallback.
const MAX_ATTEMPTS = 3;

/** Id prefix for live-progress toolCall placeholders — shared by every producer
 * (id construction in both chat stream handlers and the ACP session/update
 * handler) and every strip site, so they cannot drift apart [L1-03].
 *
 * Exported because the ACP transport surfaces the same kind of display-only
 * block: pi dispatches ANY toolCall block it finds on an assistant message
 * (agent-loop.ts keys off presence, not stopReason), so a block describing a
 * call kiro has ALREADY executed must be marked and stripped, or pi runs it a
 * second time. */
export const LIVE_TOOL_ID_PREFIX = "kiro-live-";

/** Drop live-progress placeholder toolCall blocks (matched by LIVE_TOOL_ID_PREFIX). */
export function stripLivePlaceholders(content: AssistantMessage["content"]): AssistantMessage["content"] {
	return content.filter(
		(block) => !(block.type === "toolCall" && String(block.id).startsWith(LIVE_TOOL_ID_PREFIX)),
	);
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

export const FINAL_OPEN = "<pi_final>";
export const FINAL_CLOSE = "</pi_final>";
// TODO(stream-json): demote to fallback once `chat --output-format stream-json`
// is default (it exposes structured output directly, making FINAL_OPEN,
// FINAL_CLOSE, extractFinal, and the sentinel instruction unnecessary); delete
// only once support for kiro-cli versions lacking the flag is dropped. The
// ACP field gate this used to cite is stale (ACP was demoted to an optional
// contingency) — see docs/design/acp-transport.md §5c.

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
		// do and re-issued the calls: a user was asked the same
		// @pi/ask_user_question twice, and each turn re-fired the PRIOR turn's
		// @pi/steer_subagent / @pi/get_subagent_result at already-reaped agent ids
		// lifted verbatim out of the replayed text. The paired <tool_result>
		// already carries what ran and what came back, so nothing is lost by
		// omitting the call itself -- only the invitation to run it again.
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
}

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
			`These calling-session tools ARE available to you as MCP tools from the "pi" server — call them as @pi/<tool_name>: ${bridgedTools.join(", ")}.`,
		);
		if (bridgedTools.includes("ask_user_question")) {
			toolContextLines.push(
				"- For structured user questions call @pi/ask_user_question instead of guessing at ambiguous requirements.",
			);
		}
		if (bridgedTools.includes("todo")) {
			toolContextLines.push("- Track task progress with @pi/todo (same contract as the caller's todo tool).");
		}
		if (bridgedTools.includes("Agent")) {
			toolContextLines.push(
				"- Dispatch specialist subagents with @pi/Agent; collect results with @pi/get_subagent_result.",
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
	if (context.systemPrompt && context.systemPrompt.trim().length > 0) {
		parts.push(`<prior_system_context>\n${context.systemPrompt}\n</prior_system_context>`);
	}
	const history = context.messages.map(serializeMessage).filter((block): block is string => block !== undefined);
	if (history.length > 0) {
		parts.push(`<conversation_history>\n${history.join("\n")}\n</conversation_history>`);
	}
	return parts.join("\n\n");
}

/**
 * Delta prompt for a `--resume-id` turn: the same scaffolding, but only the NEW
 * turn's input — no <prior_system_context> and no <conversation_history> (kiro
 * already holds those in the resumed session). Assistant messages are skipped:
 * they are kiro's own prior replies, already in-session — re-sending them would
 * echo the model's output back as user input.
 */
export function buildDeltaPrompt(deltaMessages: Message[], bridgedTools?: string[], workflowMcp?: boolean, opts?: PromptBuildOpts): string {
	const parts = buildScaffolding(bridgedTools, workflowMcp, opts);
	const blocks = deltaMessages
		.filter((message) => message.role !== "assistant")
		.map(serializeMessage)
		.filter((block): block is string => block !== undefined);
	if (blocks.length > 0) parts.push(blocks.join("\n"));
	return parts.join("\n\n");
}

/**
 * One spawn+drain of the kiro-cli child for a single attempt of the retry
 * loop in streamViaKiro below. Wires abort/ceiling kill timers and LIVE
 * tool-use detection on stdout/stderr -- mutating `output.content` with
 * placeholder toolCall blocks and feeding `pushThinking` as they arrive --
 * then resolves once the child exits. The retry POLICY (whether to retry,
 * drop a resume session, etc.) stays in the caller: this only runs one
 * attempt and reports what happened [L1-01].
 */
async function runAttempt(
	args: string[],
	binaryPath: string | undefined,
	output: AssistantMessage,
	pushThinking: (delta: string) => void,
	abortSignal: AbortSignal | undefined,
): Promise<{ exitCode: number; raw: string; stderrText: string; timedOut: boolean }> {
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
	const onAbort = () => {
		killTree("SIGTERM");
		// kiro-cli's graceful shutdown can be slow -- escalate.
		killTimer = setTimeout(() => killTree("SIGKILL"), 1_500);
		killTimer.unref?.();
	};
	abortSignal?.addEventListener("abort", onAbort, { once: true });
	// Hard turn ceiling: a wedged child even with a live, patient parent
	// must not run forever. Env read at spawn time; unref'd so the timer
	// never keeps the host alive.
	const ceilingMs = chatTimeoutMs();
	const ceilingTimer = setTimeout(() => {
		turnTimedOut = true;
		killTree("SIGTERM");
		killTimer = setTimeout(() => killTree("SIGKILL"), 1_500);
		killTimer.unref?.();
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
	const liveParser = createToolUseStreamParser();
	let liveCount = 0;
	child.stdout.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		raw += text;
		pushThinking(stripAnsi(text));
		for (const use of liveParser.feed(stripAnsi(text))) {
			output.content.push({
				type: "toolCall",
				id: `${LIVE_TOOL_ID_PREFIX}${liveCount++}-${use.name}`,
				name: use.name,
				arguments: {},
			});
			pushThinking(`\n⚙ ${use.name}\n`);
		}
	});
	// Tool-use lines arrive HERE on kiro-cli 2.21+ (see toolUseTranscript),
	// so stderr gets its own parser instance: one line only ever lands on
	// one stream, and a shared instance would splice the two streams'
	// partial trailing lines into each other.
	const liveStderrParser = createToolUseStreamParser();
	child.stderr.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		stderrText += text;
		for (const use of liveStderrParser.feed(stripAnsi(text))) {
			output.content.push({
				type: "toolCall",
				id: `${LIVE_TOOL_ID_PREFIX}${liveCount++}-${use.name}`,
				name: use.name,
				arguments: {},
			});
			pushThinking(`\n⚙ ${use.name}\n`);
		}
	});

	const exitCode: number = await new Promise((resolve, reject) => {
		child.on("error", reject);
		// "close" waits for the stdio pipes of the whole process tree to
		// drain; "exit" fires at process exit. Settle on "exit" so an
		// aborted run doesn't hang on a grandchild holding the pipes.
		child.on("exit", (code) => resolve(code ?? -1));
	});
	abortSignal?.removeEventListener("abort", onAbort);
	clearTimeout(ceilingTimer);
	if (killTimer) clearTimeout(killTimer);
	unregisterChildForCleanup(child);

	return { exitCode, raw, stderrText, timedOut: turnTimedOut };
}

/**
 * Decide whether a nonzero exit still represents a completed turn: kiro-cli
 * sometimes dies AFTER the final answer / after MCP tool calls have already
 * landed server-side (observed on kiro-cli 2.15.2: exit 1 following a
 * successful gsd_task_complete). Failing the whole turn would discard
 * finished work and pause GSD auto-mode; instead, degrade to success and let
 * the caller's own verification (artifact/DB checks) be the arbiter. A
 * nonzero exit with NO final sentinel and NO tool activity is still a hard
 * failure. Named as part of the streamViaKiro post-loop tail [L1-01].
 *
 * TODO(stream-json): demote to fallback once stream-json is default (turn
 * completion becomes a protocol event there, making this exit-code salvage
 * heuristic unnecessary); delete only once support for kiro-cli versions
 * lacking the flag is dropped. See docs/design/acp-transport.md §5c.
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
 */
function reconcileToolCalls(
	output: AssistantMessage,
	toolTranscript: string,
	pushThinking: (delta: string) => void,
): void {
	output.content = stripLivePlaceholders(output.content);
	for (const block of synthesizeToolCallBlocks(toolTranscript)) {
		output.content.push({
			...block,
			id: `${LIVE_TOOL_ID_PREFIX}${block.id}`,
		});
		pushThinking(`\n⚙ ${block.name}\n`);
		trace("chat.toolcall.surfaced", { tool: block.name, displayOnly: true });
	}
}

/**
 * Record/advance the kiro session bookkeeping BEFORE the caller emits
 * `done`, so a sequential next turn sees it (else it would create a
 * duplicate session). Advance (resume path) is sync; capture (fresh path)
 * does one list-sessions call -- paid once per session, not per turn.
 * Best-effort: never fail a good turn over session bookkeeping. Named as
 * part of the streamViaKiro post-loop tail [L1-01].
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
			try {
				stream.push({ type: "start", partial: output });

				// Parity with built-in providers: fires before_provider_request so
				// extensions (including our own ctx capture) see the turn.
				await options?.onPayload?.({ provider: "kiro", model: model.id }, model);

				const identity = identityLine({
					piVersion: await resolvePiVersion(),
					kiroVersion: deps.kiroVersion,
					engine: CHAT_ENGINE,
					model: model.id,
				});
				trace("identity", { transport: "chat", line: identity, auth: authMethod() });

				bridge = await deps.getBridge?.(options?.signal ?? new AbortController().signal);
				// GSD workflow-MCP transport: mount the project's gsd-workflow stdio
				// server inside kiro so GSD units can actually call gsd_* tools.
				const workflowServers = discoverWorkflowMcpServers(process.cwd());
				if (bridge || workflowServers) profile = writeAgentProfile(bridge, workflowServers);

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
				// one kiro creates (exactly-one-new-in-cwd; ambiguity ⇒ fallback).
				// TODO(stream-json): the snapshot-diff capture here (snapshotSessions,
				// makeListSessions, preSnapshot, recordFreshSession below) can die once
				// stream-json is default — metadata.data.sessionId is in the output
				// directly, no diffing needed. The --resume-id/prefix-hash resume logic
				// (planTurn et al) STAYS regardless of stream-json. Demote to fallback
				// when stream-json ships; delete only when old-version support is
				// dropped. See docs/design/acp-transport.md §5c.
				let preSnapshot = useResume ? new Set<string>() : await snapshotSessions(cwd, listSessions);

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
					if (useResume && plan.resumeId) args.push("--resume-id", plan.resumeId);
					if (profile) args.push("--agent", profile.name, "--require-mcp-startup");
					if (model.id !== "auto") args.push("--model", model.id);
					const effort = mapEffort(options?.reasoning);
					if (effort) args.push("--effort", effort);
					const promptText = useResume
						? buildDeltaPrompt(context.messages.slice(plan.deltaStart), bridge?.toolNames, !!workflowServers, { identity })
						: buildPromptFromContext(context, bridge?.toolNames, !!workflowServers, { identity });
					args.push(promptText);
					// attempt is traced explicitly: this loop re-sends the whole prompt on
					// an MCP-startup retry or a resume fallback, so a bridged tool already
					// executed on attempt 0 gets asked again on attempt 1. Counting sends
					// is the only way to tell that apart from a model choosing to re-call.
					trace("chat.prompt.send", {
						attempt,
						mode: useResume ? "resume" : "fresh",
						deltaStart: plan.deltaStart,
						messageCount: context.messages.length,
						promptChars: promptText.length,
						prompt: redactSecrets(promptText),
					});

					const attemptResult = await runAttempt(args, deps.binaryPath, output, pushThinking, options?.signal);
					raw = attemptResult.raw;
					stderrText = attemptResult.stderrText;
					exitCode = attemptResult.exitCode;
					turnTimedOut = attemptResult.timedOut;

					// A ceiling kill is terminal for this turn: never retried (a fresh
					// attempt would just burn another 45 min) and never exit-salvaged.
					if (turnTimedOut) break;
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
					// bad session never hard-fails the turn.
					if (useResume && exitCode !== 0 && attempt + 1 < MAX_ATTEMPTS && !options?.signal?.aborted) {
						if (plan.resumeId) dropSession(plan.resumeId);
						useResume = false;
						preSnapshot = await snapshotSessions(cwd, listSessions);
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

				const { body, credits } = cleanBody(raw);
				const toolTranscript = toolUseTranscript(body, stderrText);
				salvageOrThrow(exitCode, body, stderrText, toolTranscript, pushThinking);

				const { final } = extractFinal(body);
				reconcileToolCalls(output, toolTranscript, pushThinking);
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

				await recordSession(useResume, plan.resumeId, cwd, context.messages, preSnapshot, listSessions);

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
				profile?.remove();
				await bridge?.close().catch(() => undefined);
			}
		})();

		return stream;
	};
}
