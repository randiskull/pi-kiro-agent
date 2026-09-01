/**
 * ACP transport (Option B): Pi turn → kiro-cli acp (NDJSON JSON-RPC) → Pi AssistantMessageEventStream.
 *
 * Key design decisions:
 *
 * 1. Persistent child: one `kiro-cli acp` per (cwd) pair, kept alive across turns,
 *    idle-timeout after 10 min. Session identity via ACP sessionId (not --list-sessions).
 *
 * 2. Option B tool mounting (gate: probes/p3-gate-findings.md — PASSED):
 *    - Both bridge (HTTP) and gsd-workflow (stdio) injected directly in session/new.mcpServers
 *    - No agent profile file; writeAgentProfile() untouched (chat transport unchanged)
 *    - Per-session bridge: getBridge() called once at session creation, lives until session end
 *    - Bridge closed on session end (divergence reset / idle-timeout / child crash)
 *    - Discovery code (discoverWorkflowMcpServers, getBridge) unchanged per Q3 decision
 *
 * 3. Session startup gate: must wait for all server_initialized events before sending
 *    session/prompt (gate confirmed by P3-gate probe: servers initialize sequentially,
 *    commands/available fires once per server init).
 *
 * 4. Divergence handling: prefix hash mismatch → session/new on same child (full context resend).
 *    Bridge for the new session is also fresh: close old bridge, start new one.
 *
 * Protocol confirmed by probe campaign against kiro-cli 2.16.0 (probes/):
 *  - NDJSON (one JSON object per newline)
 *  - protocolVersion: 1 (integer)
 *  - session/new: { cwd, mcpServers: [array, not map] }
 *  - session/prompt: { sessionId, prompt: [array] } — 'prompt' NOT 'content'
 *  - session/update: streaming updates (sessionUpdate discriminator)
 *  - session/cancel: -32601 (not implemented) → abort = SIGTERM
 *  - Credits: _kiro.dev/metadata.meteringUsage[].value (sum all, on final notification)
 *  - _kiro.dev/mcp/server_initialized: fires once per server mount (can fire multiple times)
 *
 * Deleted vs chat transport: sentinel, exit-salvage, --list-sessions snapshot-diff.
 * Enable with PI_KIRO_TRANSPORT=acp. Default (chat) transport untouched.
 *
 * Compliance: all model traffic runs inside the official kiro-cli under the user's own
 * login; this module never touches credentials.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
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
import { registerChildForCleanup, unregisterChildForCleanup } from "./orphan-reaper.js";
import { buildDeltaPrompt, buildPromptFromContext, mapEffort } from "./stream-adapter.js";
import { discoverWorkflowMcpServers } from "./workflow-mcp.js";
import {
	advanceAcpSession,
	dropAcpSession,
	planAcpTurn,
	recordAcpSession,
} from "./acp-session.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AcpDeps {
	binaryPath: string | undefined;
	/** Builds the loopback HTTP MCP bridge. Per-session under ACP (not per-turn). */
	getBridge?: (signal: AbortSignal) => Promise<HttpBridgeHandle | undefined>;
}

/** ACP protocol version — pinned to guard against kiro-cli drift (§5 row 1). */
const ACP_PROTOCOL_VERSION = 1;
/** Parse a positive-integer millisecond override from the environment. */
function envMs(name: string, fallback: number): number {
	const raw = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
/**
 * Idle-timeout before killing the persistent acp child (10 min per §3.1).
 * "Idle" means the child has been SILENT for this long — any inbound NDJSON
 * traffic (streaming updates, tool events, responses) resets the clock. A
 * turn that runs longer than this but keeps streaming is not idle.
 * Override: PI_KIRO_IDLE_TIMEOUT_MS.
 */
function idleTimeoutMs(): number {
	return envMs("PI_KIRO_IDLE_TIMEOUT_MS", 10 * 60 * 1000);
}
/**
 * Hard ceiling for a single pending turn. While a request is in flight the
 * child may be legitimately silent for long stretches (a tool call running a
 * cold cargo build emits nothing), so silence alone must not kill it — but a
 * turn pending past this ceiling is treated as wedged and the child is killed.
 * Override: PI_KIRO_TURN_TIMEOUT_MS.
 */
function turnTimeoutMs(): number {
	return envMs("PI_KIRO_TURN_TIMEOUT_MS", 45 * 60 * 1000);
}
/** Startup timeout: wait up to 30s for all MCP servers to initialize after session/new. */
const MCP_STARTUP_TIMEOUT_MS = 30_000;

// ─── NDJSON message types ─────────────────────────────────────────────────────

interface AcpMessage {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
	params?: unknown;
}

interface SessionUpdateParams {
	sessionId: string;
	update: {
		sessionUpdate: string;
		content?: { type: string; text?: string };
		toolCallId?: string;
		title?: string;
		rawInput?: unknown;
		rawOutput?: unknown;
		kind?: string;
		status?: string;
		_meta?: { kiro?: { toolName?: string; mcpServerName?: string } };
	};
}

interface MetadataParams {
	sessionId: string;
	contextUsagePercentage?: number;
	meteringUsage?: Array<{ value: number; unit: string }>;
	turnDurationMs?: number;
}

// ─── Child registry ───────────────────────────────────────────────────────────

interface AcpChild {
	child: ChildProcess;
	cwd: string;
	/** Active ACP session ID (undefined between session/new calls). */
	acpSessionId: string | undefined;
	/** Per-session loopback bridge (Option B: lives for the ACP session duration). */
	bridge: HttpBridgeHandle | undefined;
	/** Pending request map: id → resolver. */
	pending: Map<number, (msg: AcpMessage) => void>;
	/** Notification listeners: method → handlers. */
	listeners: Map<string, Set<(msg: AcpMessage) => void>>;
	/** AbortController for the current session's bridge and startup signals. */
	sessionAbort: AbortController;
	alive: boolean;
	ready: boolean;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Epoch ms when pending went 0 → 1; undefined while nothing is in flight. */
	oldestPendingSince: number | undefined;
	nextId: number;
}

// One child per cwd (Option B: no per-agentName keying since there's no profile).
const childRegistry = new Map<string, AcpChild>();

/** Test hook: clear the child registry and kill all cached children. */
export function _resetAcpChildren(): void {
	for (const entry of childRegistry.values()) {
		killChild(entry, "test reset");
	}
	childRegistry.clear();
}

// ─── Child lifecycle ──────────────────────────────────────────────────────────

function killChild(entry: AcpChild, reason: string): void {
	if (!entry.alive) return;
	entry.alive = false;
	entry.ready = false;
	if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined; }
	entry.sessionAbort.abort();
	// Close the per-session bridge
	void entry.bridge?.close().catch(() => undefined);
	entry.bridge = undefined;
	try {
		const { pid } = entry.child;
		if (pid && process.platform !== "win32") process.kill(-pid, "SIGTERM");
		else entry.child.kill("SIGTERM");
	} catch { /* already gone */ }
	unregisterChildForCleanup(entry.child);
	setChildKeepalive(entry, false);
	for (const [, resolve] of entry.pending) {
		resolve({ jsonrpc: "2.0", error: { code: -1, message: `acp child terminated: ${reason}` } });
	}
	entry.pending.clear();
}

function resetIdleTimer(entry: AcpChild): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		if (!entry.alive) return;
		if (entry.pending.size > 0) {
			// A request is in flight: silence may just be a long-running tool
			// (e.g. a cargo build streaming nothing). Extend in idle-window
			// increments until the hard turn ceiling, then treat as wedged.
			const pendingForMs = Date.now() - (entry.oldestPendingSince ?? Date.now());
			if (pendingForMs < turnTimeoutMs()) {
				resetIdleTimer(entry);
				return;
			}
			killChild(entry, `turn timeout (pending ${Math.round(pendingForMs / 1000)}s, silent ${Math.round(idleTimeoutMs() / 1000)}s)`);
			return;
		}
		killChild(entry, "idle timeout");
	}, idleTimeoutMs());
	entry.idleTimer.unref?.();
}

/** A runtime handle that participates in event-loop reference counting. */
type RefCountable = { ref?: () => void; unref?: () => void };

/**
 * Event-loop keepalive for the persistent child.
 *
 * The child is spawned `detached` with piped stdio. Node counts the
 * ChildProcess handle AND each of the three pipes as event-loop references, so
 * a live-but-idle child keeps the HOST process alive: `pi -p` printed its answer
 * and then sat there until the idle timeout killed the child (~10 min at the
 * default PI_KIRO_IDLE_TIMEOUT_MS). Measured: unref'ing the child alone, or the
 * pipes alone, changes nothing — the remaining handles still hold the loop. All
 * four have to go.
 *
 * A blanket unref would be worse than the bug: a turn is an awaited promise
 * resolved from the (now unreferenced) stdout pipe, and a pending promise is not
 * an event-loop reference, so node would exit MID-TURN. Keepalive therefore
 * tracks `pending` — referenced while any request is in flight, unreferenced the
 * moment the last one settles. Re-referencing is verified to restore keepalive.
 */
function setChildKeepalive(entry: AcpChild, active: boolean): void {
	const { child } = entry;
	// The stdio streams are typed Readable | Writable, but at runtime a piped
	// child stdio handle is a net.Socket / Pipe and does carry ref/unref.
	const handles: Array<RefCountable | null | undefined> = [
		child.stdin as unknown as RefCountable | null,
		child.stdout as unknown as RefCountable | null,
		child.stderr as unknown as RefCountable | null,
	];
	if (active) {
		child.ref?.();
		for (const handle of handles) handle?.ref?.();
		return;
	}
	child.unref?.();
	for (const handle of handles) handle?.unref?.();
}

function sendRaw(entry: AcpChild, msg: object): void {
	if (!entry.alive) return;
	entry.child.stdin?.write(JSON.stringify(msg) + "\n");
}

function request(entry: AcpChild, method: string, params: object): Promise<AcpMessage> {
	return new Promise((resolve) => {
		const id = entry.nextId++;
		if (entry.pending.size === 0) {
			entry.oldestPendingSince = Date.now();
			// A turn is starting: the child must hold the event loop again.
			setChildKeepalive(entry, true);
		}
		entry.pending.set(id, resolve);
		sendRaw(entry, { jsonrpc: "2.0", id, method, params });
	});
}

function onNotification(
	entry: AcpChild,
	method: string,
	handler: (msg: AcpMessage) => void,
): () => void {
	if (!entry.listeners.has(method)) entry.listeners.set(method, new Set());
	entry.listeners.get(method)!.add(handler);
	return () => entry.listeners.get(method)?.delete(handler);
}

function dispatchMessage(entry: AcpChild, msg: AcpMessage): void {
	// Any inbound traffic proves the child is alive — reset the idle clock.
	// This is what makes "idle" mean silence rather than turn duration: a
	// multi-minute working turn streams session/update chunks continuously.
	if (entry.alive && entry.idleTimer) resetIdleTimer(entry);
	if (msg.id !== undefined && entry.pending.has(msg.id)) {
		const resolve = entry.pending.get(msg.id)!;
		entry.pending.delete(msg.id);
		if (entry.pending.size === 0) {
			entry.oldestPendingSince = undefined;
			// Nothing in flight: stop holding the host's event loop open so a
			// one-shot (`pi -p`) can exit instead of waiting out the idle timer.
			setChildKeepalive(entry, false);
		}
		resolve(msg);
		return;
	}
	if (msg.method) {
		// Server-initiated request → auto-respond with empty result
		if (msg.id !== undefined) sendRaw(entry, { jsonrpc: "2.0", id: msg.id, result: {} });
		const handlers = entry.listeners.get(msg.method);
		if (handlers) for (const h of handlers) h(msg);
	}
}

// ─── MCP server config builders ───────────────────────────────────────────────

type AcpMcpServer =
	| { type: "http"; name: string; url: string; headers: [] }
	| { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

function buildMcpServersConfig(
	bridge: HttpBridgeHandle | undefined,
	workflowServers: Record<string, { command: string; args: string[]; env?: Record<string, string>; timeout?: number }> | undefined,
): AcpMcpServer[] {
	const servers: AcpMcpServer[] = [];
	if (bridge) {
		servers.push({ type: "http", name: "pi", url: bridge.urlWithToken, headers: [] });
	}
	if (workflowServers) {
		for (const [name, server] of Object.entries(workflowServers)) {
			// Convert env Record<string,string> to ACP's { name, value }[] array
			const envArray = server.env
				? Object.entries(server.env).map(([n, v]) => ({ name: n, value: v }))
				: [];
			servers.push({ name, command: server.command, args: server.args, env: envArray });
		}
	}
	return servers;
}

// ─── Session startup ──────────────────────────────────────────────────────────

/**
 * Start a new ACP session on `entry`, mounting bridge + workflow servers via session/new.
 *
 * Waits for all server_initialized events (gate from P3 probe: kiro fires one per server,
 * and prompts sent before all are ready get "Prompt already in progress" or are ignored).
 */
async function startSession(
	entry: AcpChild,
	mcpServers: AcpMcpServer[],
): Promise<void> {
	const expectedServers = new Set(mcpServers.map((s) => s.name));
	const readyServers = new Set<string>();

	// Track server_initialized events
	let onServersReady: (() => void) | undefined;
	const serversReadyPromise = expectedServers.size === 0
		? Promise.resolve()
		: new Promise<void>((resolve) => { onServersReady = resolve; });

	const off = onNotification(entry, "_kiro.dev/mcp/server_initialized", (msg) => {
		const name = (msg.params as { serverName?: string })?.serverName;
		if (name) readyServers.add(name);
		if (expectedServers.size > 0 && [...expectedServers].every((s) => readyServers.has(s))) {
			onServersReady?.();
			off();
		}
	});

	// Register _kiro.dev/commands/available listener BEFORE sending session/new to
	// avoid a race: the server may send commands/available synchronously after the
	// session/new response (before any await yields control back to this function).
	const cmdAvailablePromise = new Promise<void>((resolve) => {
		const offCmd = onNotification(entry, "_kiro.dev/commands/available", () => {
			// After all servers are ready, the next commands/available has the full tool list
			if (expectedServers.size === 0 || readyServers.size >= expectedServers.size) {
				offCmd();
				resolve();
			}
		});
	});

	const sessionResp = await request(entry, "session/new", {
		cwd: entry.cwd,
		mcpServers,
	});
	if (sessionResp.error) {
		off();
		throw new Error(`kiro-cli acp session/new failed: ${sessionResp.error.message}`);
	}
	const sessionId = (sessionResp.result as { sessionId?: string })?.sessionId;
	if (!sessionId) { off(); throw new Error("kiro-cli acp session/new: no sessionId"); }
	entry.acpSessionId = sessionId;

	// Wait for both: all servers initialized + commands/available with full tool list
	const timeout = new Promise<void>((_, reject) =>
		setTimeout(() => reject(new Error(`ACP MCP startup timed out after ${MCP_STARTUP_TIMEOUT_MS}ms`)), MCP_STARTUP_TIMEOUT_MS).unref?.()
	);

	await Promise.race([
		Promise.all([serversReadyPromise, cmdAvailablePromise]),
		timeout,
	]);

	entry.ready = true;
}

// ─── Child spawn ──────────────────────────────────────────────────────────────

async function spawnAcpChild(
	binaryPath: string | undefined,
	cwd: string,
	registry: Map<string, AcpChild>,
	turnSignal: AbortSignal,
): Promise<AcpChild> {
	const args = ["acp", "--trust-all-tools", "--agent-engine", "v2"];
	const detached = process.platform !== "win32";
	const child = spawn(binaryPath ?? "kiro-cli", args, {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached,
	});
	// Detached children outlive an uncleanly-dying parent — tether them to the
	// parent's exit hook (see orphan-reaper.ts).
	registerChildForCleanup(child, detached);

	const entry: AcpChild = {
		child,
		cwd,
		acpSessionId: undefined,
		bridge: undefined,
		pending: new Map(),
		listeners: new Map(),
		sessionAbort: new AbortController(),
		alive: true,
		ready: false,
		idleTimer: undefined,
		oldestPendingSince: undefined,
		nextId: 1,
	};

	// Hold the event loop across spawn and the initialize/session-new handshake;
	// request() and dispatchMessage() take over the ref/unref cycle from here.
	setChildKeepalive(entry, true);

	const rl = createInterface({ input: child.stdout! });
	rl.on("line", (line) => {
		if (!line.trim()) return;
		try {
			const msg = JSON.parse(line) as AcpMessage;
			dispatchMessage(entry, msg);
		} catch { /* malformed line */ }
	});
	child.stderr?.on("data", () => { /* consumed */ });
	child.on("exit", () => {
		unregisterChildForCleanup(child);
		setChildKeepalive(entry, false);
		entry.alive = false;
		entry.ready = false;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.sessionAbort.abort();
		void entry.bridge?.close().catch(() => undefined);
		entry.bridge = undefined;
		for (const [, resolve] of entry.pending) {
			resolve({ jsonrpc: "2.0", error: { code: -1, message: "acp child exited unexpectedly" } });
		}
		entry.pending.clear();
	});

	// Register entry in registry BEFORE the initialize handshake so the abort
	// handler in makeStreamViaAcp can find and kill it even mid-spawn.
	registry.set(cwd, entry);

	// Handshake: initialize
	const initResp = await request(entry, "initialize", {
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
		clientInfo: { name: "pi-kiro", version: "0.1.0" },
	});
	if (initResp.error) {
		registry.delete(cwd);
		killChild(entry, "initialize failed");
		throw new Error(`kiro-cli acp initialize failed: ${initResp.error.message}`);
	}
	if (turnSignal.aborted) {
		registry.delete(cwd);
		killChild(entry, "aborted");
		throw new Error("kiro-cli acp run aborted");
	}
	// Note: 'initialized' notification → -32601 in kiro-cli 2.16.0; skip it.

	return entry;
}

/**
 * Get or create a live (initialized) ACP child process for `cwd`.
 *
 * Returns the child entry. Does NOT start a session — the caller is responsible
 * for calling `startSession` on a child that has no acpSessionId yet, and for
 * divergence detection (resetting the session if the prefix hash mismatches).
 */
async function getOrCreateChild(
	deps: AcpDeps,
	cwd: string,
	turnSignal: AbortSignal,
): Promise<AcpChild> {
	let entry = childRegistry.get(cwd);
	if (entry?.alive) {
		// Return the alive child regardless of session state — the caller decides
		// whether to reuse the session, start a new one, or divergence-reset.
		return entry;
	}
	// Stale or missing — kill old and create fresh
	if (entry) killChild(entry, "stale");
	childRegistry.delete(cwd);

	return spawnAcpChild(deps.binaryPath, cwd, childRegistry, turnSignal);
}

// ─── emptyAssistantMessage ────────────────────────────────────────────────────

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

function mapStopReason(reason: string | undefined): AssistantMessage["stopReason"] {
	switch (reason) {
		case "end_turn": return "stop";
		case "max_tokens": return "length";
		case "refusal": return "error";
		default: return "stop";
	}
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeStreamViaAcp(deps: AcpDeps) {
	return function streamViaAcp(
		model: Model<any>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output = emptyAssistantMessage(model);

		(async () => {
			let removeUpdateHandler: (() => void) | undefined;
			let removeMetadataHandler: (() => void) | undefined;

			try {
				stream.push({ type: "start", partial: output });
				await options?.onPayload?.({ provider: "kiro", model: model.id }, model);

				const cwd = process.cwd();
				const workflowServers = discoverWorkflowMcpServers(cwd);
				const turnSignal = options?.signal ?? new AbortController().signal;

				// Abort handler: kill child on abort
				const onAbort = () => {
					const entry = childRegistry.get(cwd);
					if (entry) {
						killChild(entry, "aborted");
						childRegistry.delete(cwd);
					}
				};
				options?.signal?.addEventListener("abort", onAbort, { once: true });

				let acpEntry: AcpChild;
				try {
					acpEntry = await getOrCreateChild(deps, cwd, turnSignal);
				} catch (err) {
					options?.signal?.removeEventListener("abort", onAbort);
					if (options?.signal?.aborted) throw new Error("kiro-cli acp run aborted");
					throw err;
				}

				if (options?.signal?.aborted) {
					options.signal.removeEventListener("abort", onAbort);
					throw new Error("kiro-cli acp run aborted");
				}

				// Plan this turn using the child's current session (if any).
				// planAcpTurn uses (cwd, acpSessionId) as the session key.
				const plan = acpEntry.acpSessionId
					? planAcpTurn(cwd, acpEntry.acpSessionId, context.messages)
					: { mode: "fresh" as const, deltaStart: 0 };
				const useResume = plan.mode === "resume";
				let currentSessionId: string;

				if (!acpEntry.acpSessionId) {
					// New child: no session yet — create one now.
					const bridge = await deps.getBridge?.(turnSignal);
					acpEntry.bridge = bridge;
					const mcpServers = buildMcpServersConfig(bridge, workflowServers);
					await startSession(acpEntry, mcpServers);
					resetIdleTimer(acpEntry);
					currentSessionId = acpEntry.acpSessionId!;
				} else if (!useResume) {
					// Existing session but prefix diverged — create a fresh session on the same child.
					dropAcpSession(acpEntry.acpSessionId);
					acpEntry.acpSessionId = undefined;
					acpEntry.ready = false;
					acpEntry.sessionAbort.abort();
					await acpEntry.bridge?.close().catch(() => undefined);
					acpEntry.bridge = undefined;
					acpEntry.sessionAbort = new AbortController();
					const newBridge = await deps.getBridge?.(turnSignal);
					acpEntry.bridge = newBridge;
					const mcpServers = buildMcpServersConfig(newBridge, workflowServers);
					await startSession(acpEntry, mcpServers);
					resetIdleTimer(acpEntry);
					currentSessionId = acpEntry.acpSessionId!;
				} else {
					// Resume: reuse the existing session.
					resetIdleTimer(acpEntry);
					currentSessionId = acpEntry.acpSessionId!;
				}

				// Thinking block management
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

				let textAccum = "";
				let creditsTotal = 0;

				// session/update notification handler
				removeUpdateHandler = onNotification(acpEntry, "session/update", (msg) => {
					const params = msg.params as SessionUpdateParams | undefined;
					if (!params?.update) return;
					const u = params.update;
					switch (u.sessionUpdate) {
						case "agent_message_chunk":
							if (u.content?.type === "text" && u.content.text) {
								pushThinking(u.content.text); // stream as thinking (interim view)
								textAccum += u.content.text;
							}
							break;
						case "tool_call":
							output.content.push({
								type: "toolCall",
								id: u.toolCallId ?? `acp-tool-${Date.now()}`,
								name: u._meta?.kiro?.toolName ?? u.title ?? "unknown",
								arguments: (u.rawInput as Record<string, unknown>) ?? {},
							} as AssistantMessage["content"][number]);
							break;
						case "tool_call_update":
							// Update is informational; stopReason stays "stop"
							break;
						default:
							break;
					}
				});

				// _kiro.dev/metadata handler — capture credits on final notification
				removeMetadataHandler = onNotification(acpEntry, "_kiro.dev/metadata", (msg) => {
					const p = msg.params as MetadataParams | undefined;
					if (p?.meteringUsage && p.turnDurationMs !== undefined) {
						// Final metadata notification has both meteringUsage AND turnDurationMs
						creditsTotal = p.meteringUsage.reduce((sum, m) => sum + (m.value ?? 0), 0);
					}
				});

				// Build prompt content
				const bridgeToolNames = acpEntry.bridge?.toolNames;
				// ACP transport: omit the sentinel instruction (spec §3.4 — turn completion
				// is a protocol event; sentinel is a chat-transport artifact).
				const promptContent = useResume
					? buildDeltaPrompt(context.messages.slice(plan.deltaStart), bridgeToolNames, !!workflowServers, { sentinel: false })
					: buildPromptFromContext(context, bridgeToolNames, !!workflowServers, { sentinel: false });

				const promptParams: Record<string, unknown> = {
					sessionId: currentSessionId,
					prompt: [{ type: "text", text: promptContent }],
				};
				if (model.id !== "auto") promptParams.model = model.id;
				const effort = mapEffort(options?.reasoning as ThinkingLevel | undefined);
				if (effort) promptParams.effort = effort;

				const promptResp = await request(acpEntry, "session/prompt", promptParams);

				// Clean up notification handlers
				removeUpdateHandler();
				removeUpdateHandler = undefined;
				removeMetadataHandler();
				removeMetadataHandler = undefined;
				options?.signal?.removeEventListener("abort", onAbort);

				if (options?.signal?.aborted) throw new Error("kiro-cli acp run aborted");

				if (promptResp.error) {
					let detail = `${promptResp.error.message} (code ${promptResp.error.code})`;
					if (/profileArn is required/i.test(detail)) {
						detail += " — run `kiro-cli profile` to select a profile for this IdC seat.";
					}
					throw new Error(`kiro-cli acp session/prompt failed: ${detail}`);
				}

				// Close thinking block
				if (thinkingIndex !== -1) {
					const block = output.content[thinkingIndex];
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: block.type === "thinking" ? block.thinking : "",
						partial: output,
					});
				}

				// Push text block
				// Defensive sentinel strip: a model that previously ran under the chat
				// transport (which injects a sentinel instruction) may still emit
				// <pi_final>…</pi_final> wrapper tags. Under ACP these are never parsed —
				// strip them so they don't leak verbatim into the assistant text.
				const finalText = textAccum
					.replace(/<pi_final>/g, "")
					.replace(/<\/pi_final>/g, "")
					.trim();
				output.content.push({ type: "text", text: "" });
				const textIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
				const textBlock = output.content[textIndex];
				if (textBlock.type === "text") textBlock.text = finalText;
				stream.push({ type: "text_delta", contentIndex: textIndex, delta: finalText, partial: output });
				stream.push({ type: "text_end", contentIndex: textIndex, content: finalText, partial: output });

				// Credits
				if (creditsTotal > 0) {
					const usdPerCredit = Number.parseFloat(process.env.PI_KIRO_CREDIT_USD ?? "0");
					output.usage.cost.total = Number.isFinite(usdPerCredit) ? creditsTotal * usdPerCredit : 0;
				}

				// stopReason
				output.stopReason = mapStopReason(
					(promptResp.result as { stopReason?: string })?.stopReason,
				);

				// Record / advance session
				if (useResume && plan.acpSessionId) {
					advanceAcpSession(plan.acpSessionId, context.messages);
				} else {
					recordAcpSession(cwd, currentSessionId, currentSessionId, context.messages);
				}

				resetIdleTimer(acpEntry);
				stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
				stream.end();
			} catch (error) {
				removeUpdateHandler?.();
				removeMetadataHandler?.();
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				if (/profileArn is required/i.test(output.errorMessage) && !output.errorMessage.includes("kiro-cli profile")) {
					output.errorMessage += " — run `kiro-cli profile` to select a profile for this IdC seat.";
				}
				stream.push({
					type: "error",
					reason: output.stopReason as "error" | "aborted",
					error: output,
				});
				stream.end();
			}
		})();

		return stream;
	};
}
