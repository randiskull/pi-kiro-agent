/**
 * ACP transport: Pi turn -> kiro-cli acp (NDJSON JSON-RPC) -> Pi
 * AssistantMessageEventStream. The default transport; PI_KIRO_TRANSPORT=chat
 * selects the per-turn chat transport (stream-adapter.ts) instead.
 *
 * 1. Persistent child: one `kiro-cli acp` per (cwd, conversationKey), kept
 *    alive across turns, idle-timeout after 10 min. conversationKey is a hash
 *    of the system prompt, so the parent conversation and each subagent get
 *    their OWN child even in one cwd -- on a shared child, a subagent turn's
 *    abort rejects the parent's in-flight turn. The registry is bounded by
 *    PI_KIRO_MAX_CHILDREN (default 32) with LRU eviction of idle children;
 *    PI_KIRO_CHILD_KEY=cwd forces the old cwd-only keying.
 * 2. Tool mounting: both bridge (HTTP) and gsd-workflow (stdio) are injected
 *    directly in session/new.mcpServers, with no agent profile file. The bridge
 *    is per child: getBridge() is handed `entry.sessionAbort.signal`, so it
 *    outlives a turn exactly as long as the ACP session it is mounted into.
 * 3. Session startup gate: wait for every server_initialized event before
 *    sending session/prompt. kiro initializes servers sequentially and fires
 *    commands/available once per server init.
 * 4. Divergence: a prefix-hash mismatch means session/new on the same child,
 *    resending the full context.
 *
 * Protocol facts this depends on (kiro-cli 2.16.0 and later):
 *  - NDJSON, one JSON object per newline; protocolVersion 1 (integer)
 *  - session/new: { cwd, mcpServers: [array, not map] }
 *  - session/prompt: { sessionId, prompt: [array] } -- 'prompt', NOT 'content'
 *  - session/update: streaming updates (sessionUpdate discriminator)
 *  - session/cancel: -32601, so an abort is a SIGTERM
 *  - credits: _kiro.dev/metadata.meteringUsage[].value, summed on the final
 *    notification
 *  - _kiro.dev/mcp/server_initialized fires once per server mount
 *
 * Compliance: all model traffic runs inside the official kiro-cli under the
 * user's own login; this module never touches credentials.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import type { ChildScopedHttpBridgeHandle, HttpBridgeHandle } from "./bridge.js";
import { announceToolRow, createBlockWriter, createTagStripper, emptyAssistantMessage, envMs } from "./transport-utils.js";
import { registerChildForCleanup, unregisterChildForCleanup } from "./orphan-reaper.js";
import {
	buildDeltaPrompt,
	buildPromptFromContext,
	LIVE_TOOL_ID_PREFIX,
	mapEffort,
	stripLivePlaceholders,
} from "./stream-adapter.js";
import { trace } from "./trace.js";
import { initialSystemPrompt } from "./system-prompt.js";
import { ACP_ENGINE, authMethod, identityLine, pluginName, pluginVersion, redactSecrets, resolvePiVersion } from "./identity.js";
import { creditCostUsd, meteringDiagnostic, sumCredits, type TurnMetering } from "./metering.js";
import { discoverWorkflowMcpServers } from "./workflow-mcp-discovery.js";
import { prepareAcpAgent, type AcpAgentLaunch } from "./acp-agent.js";
import { disableInheritedResources } from "./kiro-bridge.js";
import { BRIDGE_MCP_SERVER_KEY, displayToolName } from "./tool-names.js";
import {
	advanceAcpSession,
	dropAcpSession,
	planAcpTurn,
	recordAcpSession,
} from "./acp-session.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Resolve which ACP session this turn runs against, mutating `acpEntry` as
 * needed: a brand-new child (no acpSessionId yet) gets its first session; an
 * existing session whose message-prefix diverged (Pi compacted/edited history)
 * is dropped and replaced with a fresh one on the same child; a session that
 * still matches the prefix resumes as-is.
 */
/**
 * Mount this child's bridge once, then keep it pointed at the CURRENT session.
 *
 * LIFETIME is per child: childAbort.signal owns the HTTP server, so the URL
 * kiro learned at session/new stays valid for every successor session (section
 * 5e.3). The SESSION a bridged tool runs against is per session, so
 * rebindOrigin re-points it at every session start -- a child-scoped bridge
 * outlives the session that mounted it, and without the rebind every later
 * bridged tool call resolves a retired session's ExtensionContext (the LRU
 * still holds it, so the latestCtx fallback never fires either). Called from
 * both session-creating branches of resolveSession, where
 * before_provider_request has already run for the turn.
 */
async function ensureChildBridge(
	deps: AcpDeps,
	acpEntry: AcpChild,
): Promise<ChildScopedHttpBridgeHandle | undefined> {
	acpEntry.bridgePromise ??=
		deps.getBridge?.(acpEntry.childAbort.signal, () => acpEntry.sessionAbort.signal) ??
		Promise.resolve(undefined);
	const handle = await acpEntry.bridgePromise;
	// teardownChild is SYNCHRONOUS and may have run start-to-finish while this
	// function was suspended at the await above -- a real window, because
	// getBridge does I/O to mount the HTTP server on first call. It sets
	// alive=false, aborts childAbort (closing the server) and clears both
	// fields. Assigning the resolved handle back without re-checking would
	// resurrect a CLOSED bridge onto a dead child, and the caller advertises
	// `bridge.urlWithToken` in session/new.mcpServers -- so kiro would be handed
	// a port nothing is listening on. Leave the fields cleared.
	if (!acpEntry.alive) {
		void handle?.close("child-torn-down-during-mount").catch(() => undefined);
		return undefined;
	}
	acpEntry.bridge = handle;
	// Not an optional call: ChildScopedHttpBridgeHandle requires rebindOrigin.
	acpEntry.bridge?.rebindOrigin();
	return acpEntry.bridge;
}

async function resolveSession(
	deps: AcpDeps,
	acpEntry: AcpChild,
	useResume: boolean,
	workflowServers: ReturnType<typeof discoverWorkflowMcpServers>,
): Promise<string> {
	if (!acpEntry.acpSessionId) {
		// New child: no session yet -- create one now. A previous startSession
		// attempt may have failed the MCP startup gate after mounting a bridge;
		// nothing else owns that handle, so close it here or its HTTP server
		// leaks for the life of the child.
		// The bridge is CHILD-scoped: kiro learns its URL once, at session/new,
		// and has no way to learn a new one, so one bridge is mounted on the
		// first session and reused by every successor, including the divergence
		// branch below (section 5e.3).
		// The two signals differ: childAbort.signal is the server's lifetime,
		// while the accessor returns the CURRENT sessionAbort.signal for
		// per-call cancellation, read per request rather than captured, so a
		// session reset still cancels the retired session's in-flight calls.
		await ensureChildBridge(deps, acpEntry);
		const mcpServers = buildMcpServersConfig(acpEntry.bridge, workflowServers);
		await startSession(acpEntry, mcpServers);
		resetIdleTimer(acpEntry);
		return acpEntry.acpSessionId!;
	} else if (!useResume) {
		// Existing session but prefix diverged -- create a fresh session on the same child.
		dropAcpSession(acpEntry.acpSessionId);
		acpEntry.acpSessionId = undefined;
		acpEntry.sessionModelId = undefined;
		acpEntry.availableModelIds = undefined;
		acpEntry.ready = false;
		// Retire the session controller: this branch discards a session that reached
		// `ready`, so bridged tool calls may be in flight and must be cancelled.
		acpEntry.sessionAbort.abort();
		acpEntry.sessionAbort = new AbortController();
		// The bridge's SERVER is NOT touched: it rides childAbort and reads the
		// session signal through an accessor, so the successor session keeps the
		// same URL -- the only URL kiro will ever call (section 5e.3). Its ctx
		// origin IS re-pointed at the successor session; see ensureChildBridge.
		await ensureChildBridge(deps, acpEntry);
		const mcpServers = buildMcpServersConfig(acpEntry.bridge, workflowServers);
		await startSession(acpEntry, mcpServers);
		resetIdleTimer(acpEntry);
		return acpEntry.acpSessionId!;
	} else {
		// Resume: reuse the existing session.
		resetIdleTimer(acpEntry);
		return acpEntry.acpSessionId!;
	}
}

interface AcpDeps {
	binaryPath: string | undefined;
	/**
	 * Builds the loopback HTTP MCP bridge. Per-session under ACP (not per-turn),
	 * so this transport passes the child's session-scoped `sessionAbort.signal`.
	 * The chat transport (stream-adapter.ts) mounts a genuinely per-turn bridge
	 * and correctly passes the caller's turn signal to the same dep.
	 */
	getBridge?: (
		signal: AbortSignal,
		getCallSignal?: () => AbortSignal,
	) => Promise<ChildScopedHttpBridgeHandle | undefined>;
	/** Bare kiro-cli semver from readiness (e.g. "2.26.1"), for the identity line. */
	kiroVersion?: string;
}

/** ACP protocol version — pinned to guard against kiro-cli drift (§5 row 1). */
const ACP_PROTOCOL_VERSION = 1;
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
/**
 * Longest the workspace setting that disables inherited resources stays on disk
 * while a child starts. kiro answers initialize in about a second; a child that
 * has not by now is stuck, and the user's own kiro sessions in that project
 * should not run without steering for as long as it stays stuck.
 * Override: PI_KIRO_ACP_SETTINGS_HOLD_MS.
 */
function settingsHoldMs(): number {
	return envMs("PI_KIRO_ACP_SETTINGS_HOLD_MS", 30_000);
}

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
	meteringUsage?: Array<{ value: number; unit: string; unitPlural?: string }>;
	turnDurationMs?: number;
}

// ─── Child registry ───────────────────────────────────────────────────────────

interface AcpChild {
	child: ChildProcess;
	cwd: string;
	/** The kiro agent this child runs; see acp-agent.ts. */
	agent: AcpAgentLaunch;
	/** Composite registry key: `${cwd}\x00${conversationKey}`. */
	registryKey: string;
	/** Active ACP session ID (undefined between session/new calls). */
	acpSessionId: string | undefined;
	/**
	 * The model kiro says the CURRENT session runs: `models.currentModelId` from
	 * session/new, then whatever session/set_model last switched it to. kiro v2
	 * IGNORES `model` on session/prompt and runs the user's kiro default, so this
	 * is what ensureSessionModel compares against to decide whether the turn
	 * needs a set_model first. Undefined = unknown, which always forces one.
	 */
	sessionModelId: string | undefined;
	/**
	 * The model ids kiro says the CURRENT session offers:
	 * `models.availableModels[].modelId` from session/new. kiro-cli 2.x accepts
	 * ANY id on session/set_model (a bogus one returns OK), so this list is the
	 * only check that pi's model exists. Undefined or empty = unknown (an older
	 * kiro-cli), which skips the check.
	 */
	availableModelIds: ReadonlySet<string> | undefined;
	/**
	 * Loopback MCP bridge, CHILD-scoped: kiro learns its URL once, at session/new,
	 * and cannot be told a new one, so one bridge serves every session on this
	 * child and dies only with the child (docs/design/acp-transport.md §5e.3).
	 */
	bridge: ChildScopedHttpBridgeHandle | undefined;
	/**
	 * The in-flight mount, cached so concurrent turns on one child cannot each
	 * mount a server. `bridge ??= await getBridge(...)` is not idempotent: the
	 * check and the assignment sit either side of an await, so both turns mount
	 * and the loser's HTTP server leaks until childAbort. Caching the PROMISE
	 * closes that window, because `??=` on it completes synchronously.
	 */
	bridgePromise: Promise<ChildScopedHttpBridgeHandle | undefined> | undefined;
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
	/**
	 * Lifetime of everything that must outlive a SESSION but die with the CHILD --
	 * currently just the MCP bridge's HTTP server. Distinct from sessionAbort
	 * because kiro learns the bridge URL once, at session/new, and cannot be told a
	 * new one: closing the server on a session reset stranded it on a dead port
	 * (docs/design/acp-transport.md §5e.3). Aborted only by teardownChild.
	 */
	childAbort: AbortController;
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
 * separates their kiro children. The input is the LEADING system prompt
 * (initialSystemPrompt), not the full current prompt: pi appends
 * mid-conversation updates as later system messages, and keying on those would
 * respawn the child on every update.
 */
function conversationKey(systemPrompt: string | undefined): string {
	return createHash("sha256").update(systemPrompt ?? "").digest("hex").slice(0, 16);
}

/**
 * Registry key: one child per (cwd, conversationKey). NUL-joined -- NUL cannot
 * occur in a hex hash or a filesystem path, so the two fields cannot bleed
 * together into a colliding key.
 *
 * PI_KIRO_CHILD_KEY=cwd reverts to keying on cwd alone, a rollback lever only:
 * it re-collapses the parent and its subagents onto one shared child, which
 * reintroduces the subagent-abort collision this keying removes.
 */
function registryKey(cwd: string, systemPrompt: string | undefined): string {
	if (process.env.PI_KIRO_CHILD_KEY === "cwd") return cwd;
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
	/**
	 * Exposed so tests can tell the new-session branch of resolveSession from
	 * the divergence branch. The child-scoped bridge is reused by both, so this
	 * controller's identity -- reused vs aborted-and-replaced -- is the
	 * discriminator.
	 */
	sessionAbort: AbortController;
}

/**
 * Test hook: the raw child registry Map, for asserting on listener-map size
 * (leak detection) and post-failure session state.
 */
export function _getAcpChildRegistry(): Map<string, AcpChildProbe> {
	return childRegistry as unknown as Map<string, AcpChildProbe>;
}

/**
 * Test hook: the exact composite registry key for a (cwd, systemPrompt) pair,
 * so tests can look up the per-conversation child instead of guessing the key.
 */
export function _acpRegistryKey(cwd: string, systemPrompt: string | undefined): string {
	return registryKey(cwd, systemPrompt);
}

// ─── Child lifecycle ──────────────────────────────────────────────────────────

/**
 * Idempotent child teardown, shared by killChild (we initiate the kill via
 * SIGTERM) and the child `exit` handler (the process died on its own). The
 * `!alive` guard makes the second entry a no-op: killChild SIGTERMs the child,
 * whose `exit` then re-enters here — teardown must run exactly once.
 *
 * Drop-on-death: a dead child's ACP session is unusable, so forget it here.
 * Otherwise acp-session.ts retains dead sessions until its MAX_SESSIONS FIFO
 * evicts them — harmless (a fresh child takes the new-session path and never
 * resumes a dead sessionId) but leaky. Dropping keeps the session map honest.
 */
function teardownChild(entry: AcpChild, reason: string, options: { kill: boolean }): void {
	if (!entry.alive) return;
	// Traced before any state changes: a child dying takes its session-scoped
	// bridge with it (line below), which surfaces to kiro only as an opaque
	// "error sending request for url" on the NEXT bridged tool call. Without the
	// reason recorded here that failure has to be inferred from timing.
	trace("acp.child.teardown", {
		registryKey: entry.registryKey,
		pid: entry.child.pid,
		reason,
		killed: options.kill,
		acpSessionId: entry.acpSessionId,
		pending: entry.pending.size,
	});
	entry.alive = false;
	entry.ready = false;
	if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined; }
	entry.sessionAbort.abort();
	// childAbort is what the bridge's HTTP server listens on; aborting it is the
	// only thing that closes a bridge now that one outlives every session on the
	// child. The explicit close() stays: it is idempotent and makes the shutdown
	// synchronous with teardown rather than dependent on listener ordering.
	entry.childAbort.abort();
	void entry.bridge?.close("child-teardown").catch(() => undefined);
	entry.bridge = undefined;
	entry.bridgePromise = undefined;
	if (entry.acpSessionId) {
		dropAcpSession(entry.acpSessionId);
		entry.acpSessionId = undefined;
	}
	entry.sessionModelId = undefined;
	entry.availableModelIds = undefined;
	if (options.kill) {
		try {
			const { pid } = entry.child;
			if (pid && process.platform !== "win32") process.kill(-pid, "SIGTERM");
			else entry.child.kill("SIGTERM");
		} catch { /* already gone */ }
	}
	unregisterChildForCleanup(entry.child);
	setChildKeepalive(entry, false);
	for (const [, resolve] of entry.pending) {
		resolve({ jsonrpc: "2.0", error: { code: -1, message: `acp child terminated: ${reason}` } });
	}
	entry.pending.clear();
	entry.agent.cleanup();
}

/** Kill a live child (SIGTERM) and tear it down. Idempotent via teardownChild. */
function killChild(entry: AcpChild, reason: string): void {
	teardownChild(entry, reason, { kill: true });
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
 * transport pays no subprocess cost. Reads /proc/self/limits directly (Linux —
 * the CI and deployment target) rather than forking a `ulimit -n` shell, so it
 * never blocks the event loop from inside the async spawn path. Non-Linux
 * platforms have no /proc; the advisory is simply skipped there.
 */
function warnIfUlimitTooLow(): void {
	if (ulimitChecked || process.platform !== "linux") return;
	ulimitChecked = true;
	try {
		const limits = readFileSync("/proc/self/limits", "utf8");
		// Column layout: "Max open files  <soft>  <hard>  files". "unlimited" → NaN → skipped.
		const match = /^Max open files\s+(\d+|unlimited)/im.exec(limits);
		const soft = match ? Number.parseInt(match[1], 10) : Number.NaN;
		const need = maxChildren() * PARENT_FDS_PER_CHILD;
		if (Number.isFinite(soft) && soft < need) {
			console.error(
				`[pi-kiro] soft FD limit (/proc/self/limits Max open files = ${soft}) is below the ` +
				`parent-side estimate for PI_KIRO_MAX_CHILDREN=${maxChildren()} ` +
				`(${maxChildren()} × ${PARENT_FDS_PER_CHILD} = ${need} FDs). ` +
				`A wide fan-out may hit EMFILE in pi. Raise it, e.g. \`ulimit -n ${Math.ceil(need / 1024) * 1024}\`.`,
			);
		}
	} catch { /* /proc unavailable — skip advisory */ }
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
			childRegistry.delete(entry.registryKey);
			return;
		}
		killChild(entry, "idle timeout");
		// Drop the dead entry from the registry: killChild flips alive=false but
		// leaves the entry in the map, and ensureChildCapacity counts map size,
		// so a lingering zombie would inflate the maxChildren cap. Delete by the
		// entry's own composite key (no outer-scope capture needed).
		childRegistry.delete(entry.registryKey);
	}, idleTimeoutMs());
	entry.idleTimer.unref?.();
}

/** A runtime handle that participates in event-loop reference counting. */
type RefCountable = { ref?: () => void; unref?: () => void };

/**
 * Event-loop keepalive for the persistent child.
 *
 * The child is spawned `detached` with piped stdio, and node counts the
 * ChildProcess handle AND each of the three pipes as event-loop references, so
 * a live-but-idle child keeps the HOST process alive until the idle timeout
 * kills it. All four have to be unref'd; unref'ing the child alone, or the
 * pipes alone, changes nothing.
 *
 * A blanket unref would be worse than the bug: a turn is an awaited promise
 * resolved from the (now unreferenced) stdout pipe, and a pending promise is
 * not an event-loop reference, so node would exit MID-TURN. Keepalive
 * therefore tracks `pending`: referenced while any request is in flight,
 * unreferenced the moment the last one settles.
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
	// A request issued AFTER teardown could never be answered: sendRaw drops the
	// write on a dead child, and teardownChild only settles the requests already
	// pending, so the promise would sit unresolved forever with nothing bounding
	// the await (an abort landing during the first bridge mount left
	// resolveSession hung on session/new instead of failing the turn). Answer
	// with the same terminated-child error shape teardownChild uses.
	if (!entry.alive) {
		return Promise.resolve({
			jsonrpc: "2.0",
			error: { code: -1, message: `acp child terminated before ${method}` },
		});
	}
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

/** Client methods gated by capabilities pi-kiro does not advertise. */
export function isUnadvertisedClientMethod(method: string): boolean {
	return method.startsWith("fs/") || method.startsWith("terminal/");
}

/**
 * The initialize params. Advertise no client fs/terminal capabilities (kiro
 * runs its own tools) and report the real plugin name/version.
 */
export function buildInitializeParams(): Record<string, unknown> {
	return {
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientCapabilities: {},
		clientInfo: { name: pluginName(), version: pluginVersion() },
	};
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
		if (msg.id !== undefined) {
			if (isUnadvertisedClientMethod(msg.method)) {
				// initialize advertises NO fs/terminal capability, so the agent
				// must not call these. If it does, say so instead of answering {}
				// (an empty result reads as an empty file / a silent no-op).
				sendRaw(entry, {
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32601, message: `pi-kiro does not provide ${msg.method}` },
				});
			} else {
				// Other server-initiated requests (session/request_permission under
				// --trust-all-tools, kiro extensions) keep the empty-result reply.
				sendRaw(entry, { jsonrpc: "2.0", id: msg.id, result: {} });
			}
		}
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
		servers.push({ type: "http", name: BRIDGE_MCP_SERVER_KEY, url: bridge.urlWithToken, headers: [] });
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
 * Start a new ACP session on `entry`, mounting bridge + workflow servers via
 * session/new. Waits for every server_initialized event: kiro fires one per
 * server, and a prompt sent before all are ready gets "Prompt already in
 * progress" or is ignored.
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
	// The URLs handed to kiro here are the ONLY ones it will ever use for this
	// session: it has no way to learn a new port. Recording them makes a later
	// "error sending request for url (…:PORT…)" joinable to a bridge.serve /
	// bridge.close pair on that same port.
	trace("acp.session.new", {
		registryKey: entry.registryKey,
		pid: entry.child.pid,
		servers: mcpServers.map((s) => ({ name: s.name, url: (s as { url?: string }).url })),
	});

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

	// Both notification listeners live on the long-lived child, so remove them
	// on EVERY exit path -- including the startup-timeout rejection and the
	// zero-server path, where server_initialized never fires. Both are
	// Set.delete closures, so double-invocation is safe.
	try {
		const sessionResp = await request(entry, "session/new", {
			cwd: entry.cwd,
			mcpServers,
		});
		if (sessionResp.error) {
			throw new Error(`kiro-cli acp session/new failed: ${sessionResp.error.message}`);
		}
		const sessionResult = sessionResp.result as
			| {
					sessionId?: string;
					models?: { currentModelId?: string; availableModels?: Array<{ modelId?: unknown }> };
			  }
			| undefined;
		const sessionId = sessionResult?.sessionId;
		if (!sessionId) throw new Error("kiro-cli acp session/new: no sessionId");
		entry.acpSessionId = sessionId;
		// A fresh session starts on the user's kiro default, not on pi's model.
		const reported = sessionResult?.models?.currentModelId;
		entry.sessionModelId = typeof reported === "string" && reported ? reported : undefined;
		const offered = sessionResult?.models?.availableModels;
		const ids = Array.isArray(offered)
			? offered.map((m) => m?.modelId).filter((id): id is string => typeof id === "string" && id.length > 0)
			: [];
		entry.availableModelIds = ids.length > 0 ? new Set(ids) : undefined;

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
		if (!entry.ready) {
			entry.acpSessionId = undefined;
			entry.sessionModelId = undefined;
			entry.availableModelIds = undefined;
		}
	}
}

/**
 * Make the ACP session run `modelId` before a prompt is sent. kiro v2 ignores
 * the `model` field on session/prompt (every turn runs the user's kiro default
 * whatever pi selected); session/set_model is the call that actually switches
 * it. Sent only when the session's known model differs, so a resumed turn on
 * an unchanged model costs no extra round trip. A failure fails the turn:
 * running on a model pi did not select, and reporting the one it did, is the
 * bug this exists to remove.
 *
 * kiro-cli accepts ANY id on set_model, so an OK reply proves nothing. When the
 * session listed its models, an id outside that list fails the turn here,
 * before set_model and before any prompt. "auto" is exempt: it is kiro's own
 * router and the default, and a session that does not list it keeps the
 * pre-check behavior (and the -32601 tolerance).
 */
async function ensureSessionModel(entry: AcpChild, sessionId: string, modelId: string): Promise<void> {
	if (entry.sessionModelId === modelId) return;
	const offered = entry.availableModelIds;
	if (offered && modelId !== "auto" && !offered.has(modelId)) {
		trace("acp.session.set_model", { sessionId, from: entry.sessionModelId, to: modelId, notOffered: true });
		throw new Error(
			`kiro-cli acp: model ${modelId} is not offered by this kiro session (available: ${[...offered].join(", ")})`,
		);
	}
	const from = entry.sessionModelId;
	const resp = await request(entry, "session/set_model", { sessionId, modelId });
	if (resp.error?.code === -32601 && modelId === "auto") {
		// A kiro-cli without session/set_model: kiro/auto runs whatever the
		// session runs, which is what it did before set_model existed. An
		// explicit model still fails below rather than run on the wrong one.
		entry.sessionModelId = modelId;
		trace("acp.session.set_model", { sessionId, from, to: modelId, unsupported: true });
		return;
	}
	if (resp.error) {
		throw new Error(`kiro-cli acp session/set_model ${modelId} failed: ${resp.error.message} (code ${resp.error.code})`);
	}
	entry.sessionModelId = modelId;
	trace("acp.session.set_model", { sessionId, from, to: modelId });
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
	const agent = prepareAcpAgent();
	// kiro reads workspace settings once, at startup, so the project's settings
	// file is ours from just before spawn until initialize has answered, or for
	// settingsHoldMs() if it never does.
	const settings = agent.disableInheritance ? disableInheritedResources(cwd) : undefined;
	const settingsTimer = settings ? setTimeout(() => settings.restore(), settingsHoldMs()) : undefined;
	settingsTimer?.unref?.();
	const releaseSettings = () => {
		if (settingsTimer) clearTimeout(settingsTimer);
		settings?.restore();
	};
	const args = ["acp", "--trust-all-tools", "--agent-engine", ACP_ENGINE, ...agent.args];
	const detached = process.platform !== "win32";
	let child: ChildProcess;
	try {
		child = spawn(binaryPath ?? "kiro-cli", args, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached,
		});
	} catch (error) {
		releaseSettings();
		agent.cleanup();
		throw error;
	}
	// Detached children outlive an uncleanly-dying parent — tether them to the
	// parent's exit hook (see orphan-reaper.ts).
	registerChildForCleanup(child, detached);

	const entry: AcpChild = {
		child,
		cwd,
		agent,
		registryKey: key,
		acpSessionId: undefined,
		sessionModelId: undefined,
		availableModelIds: undefined,
		bridge: undefined,
		bridgePromise: undefined,
		pending: new Map(),
		listeners: new Map(),
		sessionAbort: new AbortController(),
		childAbort: new AbortController(),
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
	// Child died on its own (crash, or the SIGTERM killChild sent). teardownChild
	// is idempotent, so the killChild → SIGTERM → exit path re-enters it harmlessly.
	child.on("exit", () => {
		teardownChild(entry, "exited unexpectedly", { kill: false });
	});

	// Register entry in registry BEFORE the initialize handshake so the abort
	// handler in makeStreamViaAcp can find and kill it even mid-spawn.
	registry.set(key, entry);
	trace("acp.child.spawn", { registryKey: key, pid: child.pid, children: registry.size });

	// Handshake: initialize
	let initResp: AcpMessage;
	try {
		initResp = await request(entry, "initialize", buildInitializeParams());
	} finally {
		releaseSettings();
	}
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

				const identity = identityLine({
					piVersion: await resolvePiVersion(),
					kiroVersion: deps.kiroVersion,
					engine: ACP_ENGINE,
					transport: "acp",
					model: model.id,
				});
				trace("identity", { transport: "acp", line: identity, auth: authMethod() });

				const cwd = process.cwd();
				// One child per (cwd, conversationKey): the parent and each subagent
				// carry different system prompts, so they resolve to different children
				// and a subagent's abort cannot reject the parent's pending turn.
				const key = registryKey(cwd, initialSystemPrompt(context));
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
				const currentSessionId = await resolveSession(deps, acpEntry, useResume, workflowServers);
				await ensureSessionModel(acpEntry, currentSessionId, model.id);

				// Content block management. The answer streams as TEXT, interleaved
				// with thinking, rather than being mirrored into the thinking feed
				// and then emitted again at end of turn (which printed every answer
				// twice -- see createBlockWriter).
				const writer = createBlockWriter(stream, output);
				const pushThinking = writer.pushThinking;
				// Defensive only: ACP never injects the chat transport's sentinel, but
				// a model carried over from a chat session may still wrap its answer
				// in <pi_final>. The tags are dropped as the text streams, so they
				// never reach the answer.
				const answer = createTagStripper(["<pi_final>", "</pi_final>"], writer.pushText);
				let creditsTotal: number | undefined;
				let creditsUnitPlural: string | undefined;
				let creditsOtherUnits: Record<string, number> | undefined;
				// Every metadata notification carries contextUsagePercentage; the last
				// one is the end-of-turn figure, which is the honest one (the figure at
				// session start understates a turn).
				let lastContextPercent: number | undefined;
				let turnDurationMs: number | undefined;
				let finalMetadataCount = 0;

				// session/update notification handler
				removeUpdateHandler = onNotification(acpEntry, "session/update", (msg) => {
					const params = msg.params as SessionUpdateParams | undefined;
					if (!params?.update) return;
					const u = params.update;
					switch (u.sessionUpdate) {
						case "agent_message_chunk":
							// kiro's ANSWER channel (agent_thought_chunk is its thinking
							// channel). Streamed straight to the text block so the user
							// watches the answer arrive once, as the answer.
							if (u.content?.type === "text" && u.content.text) answer.push(u.content.text);
							break;
						case "agent_thought_chunk":
							// kiro's REASONING channel. Parity with the stream-json
							// reader (stream-json-reader.ts), which has always routed
							// it to thinking; ACP dropped it on the floor, so a turn
							// that reasoned before answering showed nothing until the
							// answer landed.
							if (u.content?.type === "text" && u.content.text) pushThinking(u.content.text);
							break;
						case "tool_call": {
							// DISPLAY ONLY. Under ACP kiro has already EXECUTED this tool by
							// the time it notifies us, but pi dispatches every toolCall block
							// it finds on an assistant message -- it keys off presence, not
							// stopReason. A bare block here therefore ran the call a SECOND
							// time: a bridged ask_user_question raised a second questionnaire
							// card that never touched the bridge, and a native tool pi does
							// not register failed with "Tool shell not found", whose error
							// result went back to kiro as its next prompt. Tagging with
							// LIVE_TOOL_ID_PREFIX keeps the mid-turn progress display while
							// stripLivePlaceholders removes the block from the final message.
							const kiroToolName =
								u._meta?.kiro?.toolName ?? u.title?.replace(/^Running:\s*@[^/]*\//, "") ?? "unknown";
							// Drawn origin-prefixed (tool-names.ts): kiro_read for a built-in,
							// rpiv_todo for a bridged tool, gsd_* for the workflow server.
							const kiroServer = u._meta?.kiro?.mcpServerName ?? u.title?.match(/^Running:\s*@([^/\s]+)\//)?.[1];
							const rowName = displayToolName(kiroToolName, kiroServer);
							// The real kiro id is kept in the suffix: the prefix is what marks the
							// block display-only, and retaining the id keeps traces correlatable.
							// randomUUID (not Date.now()): tool_call updates arrive in bursts, so
							// two fallbacks in the same millisecond would collide inside one
							// AssistantMessage. The fallback only fires under protocol drift
							// (toolCallId is normally protocol-supplied).
							trace("acp.toolcall.surfaced", {
								sessionId: currentSessionId,
								tool: kiroToolName,
								kiroToolCallId: u.toolCallId,
								displayOnly: true,
							});
							output.content.push({
								type: "toolCall",
								id: `${LIVE_TOOL_ID_PREFIX}${u.toolCallId ?? `acp-tool-${randomUUID()}`}`,
								// u.title can be a "Running: @<server>/<tool>" progress string; strip
								// that prefix so history carries the bare tool name, not the banner.
								name: rowName,
								arguments: (u.rawInput as Record<string, unknown>) ?? {},
							} as AssistantMessage["content"][number]);
							// The row announces itself (see announceToolRow). It used to be
							// announced by a "⚙ <tool>" thinking line as well, which drew
							// every call twice.
							announceToolRow(stream, output, output.content.length - 1);
							break;
						}
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
					if (p?.contextUsagePercentage !== undefined) lastContextPercent = p.contextUsagePercentage;
					if (p?.meteringUsage && p.turnDurationMs !== undefined) {
						// Final metadata notification has both meteringUsage AND
						// turnDurationMs. Probed 2026-10-16: exactly one such
						// notification per session/prompt, carrying one entry per
						// internal model call, so the array is summed and the
						// notification is not. A second one would mean the wire
						// changed shape -- trace it rather than silently double or
						// drop the turn's cost.
						finalMetadataCount += 1;
						if (finalMetadataCount > 1) {
							trace("acp.metering.unexpected_final", {
								count: finalMetadataCount,
								sessionId: p.sessionId,
							});
						}
						const summed = sumCredits(p.meteringUsage);
						creditsTotal = summed.credits;
						creditsUnitPlural = summed.unitPlural;
						creditsOtherUnits = summed.otherUnits;
						turnDurationMs = p.turnDurationMs;
					}
				});

				// Build prompt content
				const bridgeToolNames = acpEntry.bridge?.toolNames;
				// ACP transport: omit the sentinel instruction (spec §3.4 — turn completion
				// is a protocol event; sentinel is a chat-transport artifact).
				const promptContent = useResume
					? buildDeltaPrompt(context.messages.slice(plan.deltaStart), bridgeToolNames, !!workflowServers, { sentinel: false, identity, toolAliases: acpEntry.bridge?.toolAliases })
					: buildPromptFromContext(context, bridgeToolNames, !!workflowServers, { sentinel: false, identity, toolAliases: acpEntry.bridge?.toolAliases });

				trace("acp.prompt.send", {
					sessionId: currentSessionId,
					mode: plan.mode,
					deltaStart: plan.deltaStart,
					messageCount: context.messages.length,
					promptChars: promptContent.length,
					prompt: redactSecrets(promptContent),
				});

				const promptParams: Record<string, unknown> = {
					sessionId: currentSessionId,
					prompt: [{ type: "text", text: promptContent }],
				};
				// No `model` here: kiro v2 ignores it on session/prompt. The model was
				// selected by ensureSessionModel above.
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

				// Release any tag fragment held back by the stripper, then close the
				// open block. `end` also guarantees a text block exists, so a turn
				// that produced no message chunks still carries an empty answer
				// rather than no answer at all.
				answer.flush();
				writer.end();

				// Credits
				const metering: TurnMetering = {
					credits: creditsTotal,
					source: "acp",
					precision: "exact",
					...(lastContextPercent !== undefined ? { contextPercent: lastContextPercent } : {}),
					...(turnDurationMs !== undefined ? { turnDurationMs } : {}),
					...(creditsUnitPlural ? { unitPlural: creditsUnitPlural } : {}),
					...(creditsOtherUnits ? { otherUnits: creditsOtherUnits } : {}),
				};
				output.usage.cost.total = creditCostUsd(creditsTotal);
				output.diagnostics = [...(output.diagnostics ?? []), meteringDiagnostic(metering)];
				trace("acp.metering", { ...metering });

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
				// End-of-turn reconciliation, mirroring the chat transport: pi must
				// not see the display-only progress blocks, or it re-dispatches work
				// kiro already did. Done as a filtered COPY, not an in-place strip of
				// output.content: every partial event carries `partial: output` BY
				// REFERENCE, so mutating it retroactively empties the mid-turn display
				// for any consumer that reads the partial after the turn ends.
				const finalMessage = {
					...output,
					content: stripLivePlaceholders(output.content),
				} as typeof output;
				stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: finalMessage });
				stream.end();
			} catch (error) {
				removeUpdateHandler?.();
				removeMetadataHandler?.();
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = redactSecrets(error instanceof Error ? error.message : String(error));
				if (/profileArn is required/i.test(output.errorMessage) && !output.errorMessage.includes("kiro-cli profile")) {
					output.errorMessage += " — run `kiro-cli profile` to select a profile for this IdC seat.";
				}
				// Same reconciliation as the success path, and a copy for the same
				// reason. Defence in depth rather than a live bug: pi's agent loop
				// returns on stopReason "error"/"aborted" before it filters for
				// toolCall blocks. The guarantee this keeps is "no display-only block
				// ever leaves this transport", not "the current consumer ignores them".
				stream.push({
					type: "error",
					reason: output.stopReason as "error" | "aborted",
					error: { ...output, content: stripLivePlaceholders(output.content) } as typeof output,
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
