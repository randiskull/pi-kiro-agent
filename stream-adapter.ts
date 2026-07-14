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
import { type KiroAgentProfile, writeAgentProfile } from "./kiro-bridge.js";

/** kiro exits with code 3 when --require-mcp-startup can't connect a server. */
const MCP_STARTUP_EXIT_CODE = 3;
const MAX_ATTEMPTS = 2;

export const FINAL_OPEN = "<pi_final>";
export const FINAL_CLOSE = "</pi_final>";

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
		const creditsMatch = line.match(/▸?\s*Credits:\s*([\d.]+)/);
		if (creditsMatch) {
			credits = Number.parseFloat(creditsMatch[1]);
			continue;
		}
		if (PREAMBLE_PATTERNS.some((pattern) => pattern.test(line))) continue;
		kept.push(line.replace(/^>\s?/, ""));
	}
	return { body: kept.join("\n").trim(), credits };
}

/** Split the cleaned body into (working, final) via the sentinel protocol. */
export function extractFinal(body: string): { working: string; final: string } {
	const open = body.indexOf(FINAL_OPEN);
	const close = body.lastIndexOf(FINAL_CLOSE);
	if (open !== -1 && close > open) {
		const final = body.slice(open + FINAL_OPEN.length, close).trim();
		const working = `${body.slice(0, open)}${body.slice(close + FINAL_CLOSE.length)}`.trim();
		return { working, final };
	}
	return { working: "", final: body };
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

export function buildPromptFromContext(context: Context, bridgedTools?: string[]): string {
	const toolContextLines = [
		"<tool_context>",
		"The prior context below may reference tools from the calling session (read, grep, bash, Agent, todo, ask_user_question, subagent dispatch, skills, pipeline stages). Do not refuse or explain that you lack them: perform file/search/shell work yourself with your own tools.",
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
	toolContextLines.push("</tool_context>");

	const parts: string[] = [
		"You are the executor for a task delegated from another agent session. Complete the task in the final user message directly, using your own tools.",
		toolContextLines.join("\n"),
		`Wrap ONLY your final answer between ${FINAL_OPEN} and ${FINAL_CLOSE} tags — everything outside the tags is treated as working notes.`,
		"Do not emit <user_message>, <assistant_message>, <tool_result> or <prior_system_context> tags in your reply.",
	];
	if (context.systemPrompt && context.systemPrompt.trim().length > 0) {
		parts.push(`<prior_system_context>\n${context.systemPrompt}\n</prior_system_context>`);
	}
	const history: string[] = [];
	for (const message of context.messages) {
		if (message.role === "user") {
			history.push(`<user_message>\n${contentToText(message.content)}\n</user_message>`);
		} else if (message.role === "assistant") {
			const text = contentToText(message.content.filter((block) => block.type !== "thinking") as Message["content"]);
			if (text.length > 0) history.push(`<assistant_message>\n${text}\n</assistant_message>`);
		} else if (message.role === "toolResult") {
			history.push(`<tool_result tool="${message.toolName}">\n${contentToText(message.content)}\n</tool_result>`);
		}
	}
	if (history.length > 0) {
		parts.push(`<conversation_history>\n${history.join("\n")}\n</conversation_history>`);
	}
	return parts.join("\n\n");
}

function emptyAssistantMessage(model: Model<any>): AssistantMessage {
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

interface StreamDeps {
	binaryPath: string | undefined;
	/**
	 * Builds a fresh loopback HTTP MCP bridge for one delegated turn, or
	 * undefined when disabled or no bridgeable tools are available.
	 */
	getBridge?: (signal: AbortSignal) => Promise<HttpBridgeHandle | undefined>;
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

				bridge = await deps.getBridge?.(options?.signal ?? new AbortController().signal);
				if (bridge) profile = writeAgentProfile(bridge);

				let raw = "";
				let stderrText = "";
				let exitCode = -1;
				let thinkingIndex = -1;
				const pushThinking = (delta: string) => {
					if (delta.length === 0) return;
					if (thinkingIndex === -1) {
						output.content.push({ type: "thinking", thinking: "" });
						thinkingIndex = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
					}
					const block = output.content[thinkingIndex];
					if (block.type === "thinking") block.thinking += delta;
					stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
				};

				for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
					const args = ["chat", "--no-interactive", "--trust-all-tools"];
					if (profile) args.push("--agent", profile.name, "--require-mcp-startup");
					if (model.id !== "auto") args.push("--model", model.id);
					const effort = mapEffort(options?.reasoning);
					if (effort) args.push("--effort", effort);
					args.push(buildPromptFromContext(context, bridge?.toolNames));

					// detached: own process group, so aborts can kill kiro's helper
					// children too (a lone SIGTERM to the parent leaves grandchildren
					// holding the stdio pipes and delays teardown).
					const detached = process.platform !== "win32";
					const child = spawn(deps.binaryPath ?? "kiro-cli", args, {
						cwd: process.cwd(),
						env: process.env,
						stdio: ["ignore", "pipe", "pipe"],
						detached,
					});

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
						// kiro-cli's graceful shutdown can be slow — escalate.
						killTimer = setTimeout(() => killTree("SIGKILL"), 1_500);
						killTimer.unref?.();
					};
					options?.signal?.addEventListener("abort", onAbort, { once: true });

					raw = "";
					stderrText = "";
					child.stdout.on("data", (chunk: Buffer) => {
						const text = chunk.toString("utf8");
						raw += text;
						pushThinking(stripAnsi(text));
					});
					child.stderr.on("data", (chunk: Buffer) => {
						stderrText += chunk.toString("utf8");
					});

					exitCode = await new Promise((resolve, reject) => {
						child.on("error", reject);
						// "close" waits for the stdio pipes of the whole process tree to
						// drain; "exit" fires at process exit. Settle on "exit" so an
						// aborted run doesn't hang on a grandchild holding the pipes.
						child.on("exit", (code) => resolve(code ?? -1));
					});
					options?.signal?.removeEventListener("abort", onAbort);
					if (killTimer) clearTimeout(killTimer);

					// MCP-startup readiness gate: with --require-mcp-startup kiro
					// exits 3 when the bridge didn't connect. Retry once.
					if (
						bridge &&
						exitCode === MCP_STARTUP_EXIT_CODE &&
						attempt + 1 < MAX_ATTEMPTS &&
						!options?.signal?.aborted
					) {
						pushThinking("\n[bridge MCP failed to connect — retrying]\n");
						continue;
					}
					break;
				}

				if (thinkingIndex !== -1) {
					const block = output.content[thinkingIndex];
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: block.type === "thinking" ? block.thinking : "",
						partial: output,
					});
				}

				if (options?.signal?.aborted) throw new Error("kiro-cli run aborted");
				const { body, credits } = cleanBody(raw);
				if (exitCode !== 0) {
					const detail = body || stripAnsi(stderrText).trim() || `exit code ${exitCode}`;
					throw new Error(`kiro-cli failed (exit ${exitCode}): ${detail.slice(0, 500)}`);
				}

				const { final } = extractFinal(body);
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

				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				if (/profileArn is required/i.test(output.errorMessage)) {
					output.errorMessage += " — run `kiro-cli profile` to select a profile for this IdC seat.";
				}
				stream.push({
					type: "error",
					reason: output.stopReason as "error" | "aborted",
					error: output,
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
