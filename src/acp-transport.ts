/**
 * ACP transport (Option B): Pi turn → kiro-cli acp (NDJSON JSON-RPC) → Pi AssistantMessageEventStream.
 *
 * Key design decisions:
 *
 * 1. Persistent child: one `kiro-cli acp` per (cwd, conversationKey) pair, kept
 *    alive across turns, idle-timeout after 10 min. conversationKey is a hash of
 *    the system prompt, so the parent conversation and each subagent (which carry
 *    different system prompts) get their OWN child even in one cwd. Keying on cwd
 *    alone collapsed them onto a shared child, where a subagent turn's abort
 *    rejected the parent's in-flight turn (`acp child terminated: aborted`). The
 *    registry is bounded by PI_KIRO_MAX_CHILDREN (default 32) with LRU eviction of
 *    idle children. Session identity via ACP sessionId (not --list-sessions).
 *
 * 2. Option B tool mounting (gate: probes/p3-gate-findings.md — PASSED):
 *    - Both bridge (HTTP) and gsd-workflow (stdio) injected directly in session/new.mcpServers
 *    - No agent profile file; writeAgentProfile() untouched (chat transport unchanged)
 *    - Per-session bridge: getBridge() called once at session creation, lives until session end.
 *      It is handed `entry.sessionAbort.signal` — NOT the caller's per-turn signal — so the
 *      bridge outlives a turn exactly as long as the ACP session it is mounted into does.
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

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
	/**
	 * Builds the loopback HTTP MCP bridge. Per-session under ACP (not per-turn),
	 * so this transport passes the child's session-scoped `sessionAbort.signal`.
	 * The chat transport (stream-adapter.ts) mounts a genuinely per-turn bridge
	 * and correctly passes the caller's turn signal to the same dep.
	 */
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
/** Startup timeout: wait up to 30s for all MCP servers to initialize after
 * session/new. Overridable via PI_KIRO_MCP_STARTUP_TIMEOUT_MS (used by tests to
 * exercise the timeout path without a 30s wall). */
function mcpStartupTimeoutMs(): number {
	const raw = Number.parseInt(process.env.PI_KIRO_MCP_STARTUP_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

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
	/** Composite registry key: `${cwd}\x00${conversationKey}`. */
	registryKey: string;
	/** Active ACP session ID (undefined between session/new calls). */
	acpSessionId: string | undefined;
	/** Per-session loopback bridge (Option B: lives for the ACP session duration). */
	bridge: HttpBridgeHandle | undefined;
	/** Pending request map: id → resolver. */
	pending: Map<number, (msg: AcpMessage) => void>;
	/** Notification listeners: method → handlers. */
	listeners: Map<string, Set<(msg: AcpMessage) => void>>;
	/**
	 * Lifetime controller for the CURRENT ACP session. Its signal is what
	 * `getBridge` receives, so it is both the bridge's shutdown trigger and the
	 * cancellation signal every bridged `tool.execute` call is handed.
	 *
	 * Aborted at exactly three places, all of them genuine session ends:
	 * killChild (abort / idle timeout / turn ceiling / stale child), the child
	 * `exit` handler, and the divergence reset — which then replaces it with a
	 * fresh controller for the successor session. It is module-internal: no host
	 * can reach it, so it never fires on a normal successful turn.
	 */
	sessionAbort: AbortController;
	alive: boolean;
	ready: boolean;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Epoch ms when pending went 0 → 1; undefined while nothing is in flight. */
	oldestPendingSince: number | undefined;
	/** Epoch ms of the last RPC on this child — LRU anchor for maxChildren eviction. */
	lastUsed: number;
	nextId: number;
}

// One child per (cwd, conversationKey) — see registryKey. Bounded by maxChildren().
const childRegistry = new Map<string, AcpChild>();

/**
 * conversationKey distinguishes conversations that share a cwd: the parent and
 * each subagent carry different system prompts, so a hash of the system prompt
 * separates their kiro children. Hashed directly (not via message-hash.ts's
 * hashMessages) because Context.systemPrompt is a plain string and the Message
 * union has no "system" variant to wrap it in.
 */
function conversationKey(systemPrompt: string | undefined): string {
	return createHash("sha256").update(systemPrompt ?? "").digest("hex").slice(0, 16);
}

/**
 * Registry key: one child per (cwd, conversationKey). NUL-joined — NUL cannot
 * occur in a hex hash or a filesystem path, so the two fields cannot bleed
 * together into a colliding key.
 */
function registryKey(cwd: string, systemPrompt: string | undefined): string {
	return cwd + "\x00" + conversationKey(systemPrompt);
}

/**
 * Max concurrent kiro children before LRU-idle eviction (§5.5). Default 32 =
 * half of acp-session.ts's MAX_SESSIONS (64). Override: PI_KIRO_MAX_CHILDREN.
 */
function maxChildren(): number {
	const raw = Number.parseInt(process.env.PI_KIRO_MAX_CHILDREN ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 32;
}

/** Test hook: clear the child registry and kill all cached children. */
export function _resetAcpChildren(): void {
	for (const entry of childRegistry.values()) {
		killChild(entry, "test reset");
	}
	childRegistry.clear();
}

/** The slice of AcpChild state tests are allowed to inspect directly. */
interface AcpChildProbe {
	listeners: Map<string, Set<(msg: unknown) => void>>;
	/** Undefined unless a session reached `ready` — see startSession's finally. */
	acpSessionId: string | undefined;
	ready: boolean;
}

/**
 * Test hook: return the raw child registry Map for direct state inspection.
 * Allows tests to assert on listeners Map size (leak detection) and on
 * post-failure session state without reaching into private module internals
 * through other means.
 */
export function _getAcpChildRegistry(): Map<string, AcpChildProbe> {
	return childRegistry as unknown as Map<string, AcpChildProbe>;
}

/**
 * Test hook: compute the exact composite registry key for a (cwd, systemPrompt)
 * pair, so tests can look up / assert on the per-conversation child directly
 * instead of guessing the key (a bare-cwd `.get()` returns undefined now).
 */
export function _acpRegistryKey(cwd: string, systemPrompt: string | undefined): string {
	return registryKey(cwd, systemPrompt);
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

// FDs the PARENT (pi) process holds per live child: 3 stdio pipes + the
// per-session bridge listen socket. The child's own ~124 internal FDs count
// against the CHILD's rlimit, not the parent's — each child is a separate
// process, so they never sum into one FD table. Approximate; advisory only.
const PARENT_FDS_PER_CHILD = 4;

let ulimitChecked = false;
/**
 * One-shot advisory (warn, never block): if the parent's soft FD limit is below
 * the estimate for maxChildren() children, a wide fan-out may hit EMFILE. Fires
 * once, lazily, on the first spawn — so a session that never uses the ACP
 * transport pays no subprocess cost. `ulimit` is a POSIX sh builtin, so the
 * default `/bin/sh -c` reads the parent's inherited soft limit portably.
 */
function warnIfUlimitTooLow(): void {
	if (ulimitChecked || process.platform === "win32") return;
	ulimitChecked = true;
	try {
		const soft = Number.parseInt(execSync("ulimit -n", { encoding: "utf8" }).trim(), 10);
		const need = maxChildren() * PARENT_FDS_PER_CHILD;
		if (Number.isFinite(soft) && soft < need) { // "unlimited" → NaN → skipped
			console.error(
				`[pi-kiro] soft FD limit (ulimit -n = ${soft}) is below the parent-side estimate for ` +
				`PI_KIRO_MAX_CHILDREN=${maxChildren()} (${maxChildren()} × ${PARENT_FDS_PER_CHILD} = ${need} FDs). ` +
				`A wide fan-out may hit EMFILE in pi. Raise it, e.g. \`ulimit -n ${Math.ceil(need / 1024) * 1024}\`.`,
			);
		}
	} catch { /* ulimit unavailable — skip advisory */ }
}

/**
 * Enforce the maxChildren() ceiling before creating a new child. Evicts the
 * least-recently-used IDLE child; never evicts one mid-turn — killing a child
 * with a pending request would reject it with "acp child terminated", the exact
 * collision this per-conversation keying exists to remove. If every child is
 * busy, throws a clear error rather than overshooting the FD budget (a clean
 * failure beats a confusing EMFILE mid-fan-out).
 */
function ensureChildCapacity(): void {
	if (childRegistry.size < maxChildren()) return;
	let victimKey: string | undefined;
	let victim: AcpChild | undefined;
	for (const [key, e] of childRegistry) {
		if (e.pending.size > 0) continue; // busy — never evict mid-turn
		if (!victim || e.lastUsed < victim.lastUsed) { victim = e; victimKey = key; }
	}
	if (!victim || victimKey === undefined) {
		throw new Error(
			`pi-kiro: PI_KIRO_MAX_CHILDREN (${maxChildren()}) reached and all children busy — ` +
			`raise PI_KIRO_MAX_CHILDREN and ulimit -n, or reduce concurrent fan-out width`,
		);
	}
	killChild(victim, "evicted (max children)");
	childRegistry.delete(victimKey);
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
	entry.lastUsed = Date.now();
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
	// A session is not ready until the startup gate below passes. Stating that
	// here (rather than relying on every caller to have cleared it) is what makes
	// the `!entry.ready` check in the finally locally sound.
	entry.ready = false;
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
	// offCmd is assigned synchronously inside the Promise constructor below, so
	// it is the real detach function by the time we reach the first await. It is
	// still initialized to a no-op rather than declared with `!`: the `finally`
	// below calls it unconditionally, and a future refactor that moves the
	// assignment off the synchronous path would otherwise turn cleanup into a
	// TypeError that masks the original failure.
	let offCmd: () => void = () => undefined;
	const cmdAvailablePromise = new Promise<void>((resolve) => {
		offCmd = onNotification(entry, "_kiro.dev/commands/available", () => {
			// After all servers are ready, the next commands/available has the full tool list
			if (expectedServers.size === 0 || readyServers.size >= expectedServers.size) {
				offCmd();
				resolve();
			}
		});
	});

	// Both notification listeners live on the long-lived child. Remove them on
	// EVERY exit path — the startup-timeout rejection and the zero-server path
	// (expectedServers.size === 0, so server_initialized never fires) both used
	// to leave `off`/`offCmd` attached, accumulating on the child across turns.
	// Both are Set.delete closures, so double-invocation is safe.
	try {
		const sessionResp = await request(entry, "session/new", {
			cwd: entry.cwd,
			mcpServers,
		});
		if (sessionResp.error) {
			throw new Error(`kiro-cli acp session/new failed: ${sessionResp.error.message}`);
		}
		const sessionId = (sessionResp.result as { sessionId?: string })?.sessionId;
		if (!sessionId) throw new Error("kiro-cli acp session/new: no sessionId");
		entry.acpSessionId = sessionId;

		// Wait for both: all servers initialized + commands/available with full tool list
		const timeoutMs = mcpStartupTimeoutMs();
		const timeout = new Promise<void>((_, reject) =>
			setTimeout(() => reject(new Error(`ACP MCP startup timed out after ${timeoutMs}ms`)), timeoutMs).unref?.()
		);

		await Promise.race([
			Promise.all([serversReadyPromise, cmdAvailablePromise]),
			timeout,
		]);

		entry.ready = true;
	} finally {
		off();
		offCmd();
		// The startup gate can fail (timeout, or a throw between the session/new
		// response and `ready`) with acpSessionId already assigned. Leaving it set
		// hands the next turn a session id that recordAcpSession never tracked, so
		// planAcpTurn returns "fresh" and control lands in the DIVERGENCE branch —
		// which drops a session that was never tracked and recycles the bridge and
		// session controller for nothing. Clearing it restores the invariant the
		// new-session branch tests: an acpSessionId means a *usable* session.
		if (!entry.ready) entry.acpSessionId = undefined;
	}
}

// ─── Child spawn ──────────────────────────────────────────────────────────────

async function spawnAcpChild(
	binaryPath: string | undefined,
	cwd: string,
	key: string,
	registry: Map<string, AcpChild>,
	turnSignal: AbortSignal,
): Promise<AcpChild> {
	warnIfUlimitTooLow();
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
		registryKey: key,
		acpSessionId: undefined,
		bridge: undefined,
		pending: new Map(),
		listeners: new Map(),
		sessionAbort: new AbortController(),
		alive: true,
		ready: false,
		idleTimer: undefined,
		oldestPendingSince: undefined,
		lastUsed: Date.now(),
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
	registry.set(key, entry);

	// Handshake: initialize
	const initResp = await request(entry, "initialize", {
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
		clientInfo: { name: "pi-kiro", version: "0.1.0" },
	});
	if (initResp.error) {
		registry.delete(key);
		killChild(entry, "initialize failed");
		throw new Error(`kiro-cli acp initialize failed: ${initResp.error.message}`);
	}
	// Fail open on protocol drift: kiro-cli's ACP protocol is still moving, so a
	// version mismatch is a warning, not a hard failure — the handshake succeeded
	// and the transport is resilient to unknown update kinds.
	const negotiated = (initResp.result as { protocolVersion?: number })?.protocolVersion;
	if (negotiated !== undefined && negotiated !== ACP_PROTOCOL_VERSION) {
		console.error(
			`[pi-kiro] ACP protocolVersion mismatch: client=${ACP_PROTOCOL_VERSION}, server=${negotiated}. Proceeding; update pi-kiro-agent if the transport misbehaves.`,
		);
	}
	if (turnSignal.aborted) {
		registry.delete(key);
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
	key: string,
	turnSignal: AbortSignal,
): Promise<AcpChild> {
	const entry = childRegistry.get(key);
	if (entry?.alive) {
		// Return the alive child regardless of session state — the caller decides
		// whether to reuse the session, start a new one, or divergence-reset.
		return entry;
	}
	// Stale or missing — kill old and create fresh
	if (entry) killChild(entry, "stale");
	childRegistry.delete(key);

	// The stale same-key delete above runs first, so the cap only evicts a
	// DIFFERENT conversation's idle child when we are genuinely growing the map.
	ensureChildCapacity();

	return spawnAcpChild(deps.binaryPath, cwd, key, childRegistry, turnSignal);
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
			// Hoisted so the catch can detach it on any throw from getOrCreateChild,
			// getBridge, startSession, or request (registered { once: true }, but the
			// captured closure otherwise lingers on the per-turn AbortSignal).
			let onAbort: (() => void) | undefined;
			let abortSignal: AbortSignal | undefined;

			try {
				stream.push({ type: "start", partial: output });
				await options?.onPayload?.({ provider: "kiro", model: model.id }, model);

				const cwd = process.cwd();
				// One child per (cwd, conversationKey): the parent and each subagent
				// carry different system prompts, so they resolve to different children
				// and a subagent's abort can no longer reject the parent's pending turn.
				const key = registryKey(cwd, context.systemPrompt);
				const workflowServers = discoverWorkflowMcpServers(cwd);
				const turnSignal = options?.signal ?? new AbortController().signal;

				// Abort handler: kill this conversation's child on abort. Live lookup by
				// composite key (not a captured entry) so an abort landing mid-spawn —
				// before getOrCreateChild resolves — still finds and kills the child that
				// spawnAcpChild registered under `key` ahead of its initialize handshake.
				abortSignal = options?.signal;
				onAbort = () => {
					const entry = childRegistry.get(key);
					if (entry) {
						killChild(entry, "aborted");
						childRegistry.delete(key);
					}
				};
				options?.signal?.addEventListener("abort", onAbort, { once: true });

				let acpEntry: AcpChild;
				try {
					acpEntry = await getOrCreateChild(deps, cwd, key, turnSignal);
				} catch (err) {
					if (options?.signal?.aborted) throw new Error("kiro-cli acp run aborted");
					throw err;
				}

				if (options?.signal?.aborted) {
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
					// A previous startSession attempt may have failed the MCP startup gate
					// after mounting a bridge (its session never went ready, so acpSessionId
					// was cleared). Nothing else owns that handle now that bridge lifetime is
					// session-scoped, so close it here or its HTTP server leaks for the life
					// of the child.
					if (acpEntry.bridge) {
						await acpEntry.bridge.close().catch(() => undefined);
						acpEntry.bridge = undefined;
					}
					// Session-scoped signal, not turnSignal: the bridge must outlive this
					// turn and die with the session (see AcpChild.sessionAbort).
					//
					// sessionAbort is deliberately REUSED here, not aborted-and-replaced
					// the way the divergence branch below does it. The asymmetry tracks
					// the state, not an oversight: divergence discards a session that
					// reached `ready`, whose bridge may have tool calls in flight, so its
					// controller has to be retired to cancel them. This branch only ever
					// discards a session that never reached `ready` — no prompt was sent,
					// so nothing can be in flight — and the controller was never aborted,
					// so it is still a valid handle on the child's current session.
					// Aborting it would also be wrong on the common path, where this is a
					// brand-new child with no predecessor session at all.
					const bridge = await deps.getBridge?.(acpEntry.sessionAbort.signal);
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
					// The successor session's bridge rides the successor controller — the
					// one aborted above is spent.
					const newBridge = await deps.getBridge?.(acpEntry.sessionAbort.signal);
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
								// randomUUID (not Date.now()): tool_call updates arrive in bursts,
								// so two fallbacks in the same millisecond would collide inside one
								// AssistantMessage. The fallback only fires under protocol drift
								// (toolCallId is normally protocol-supplied).
								id: u.toolCallId ?? `acp-tool-${randomUUID()}`,
								// u.title can be a "Running: @<server>/<tool>" progress string; strip
								// that prefix so history carries the bare tool name, not the banner.
								name: u._meta?.kiro?.toolName ?? u.title?.replace(/^Running:\s*@[^/]*\//, "") ?? "unknown",
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
			} finally {
				// Detach the abort listener on every exit path. It is registered
				// { once: true }, so this only matters when the turn ends without
				// aborting (success or a thrown error), where the closure would
				// otherwise linger attached to the caller's AbortSignal.
				if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
			}
		})();

		return stream;
	};
}
