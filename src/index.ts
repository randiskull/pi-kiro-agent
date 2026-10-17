/**
 * pi-kiro-agent — Pi provider for the local Kiro CLI.
 *
 * Registers a `kiro` provider whose streamSimple delegates each turn to the
 * user's authenticated kiro-cli (`chat --no-interactive`). Seat/credit
 * billing applies because requests come from AWS's official client; this
 * extension never reads or replays credentials.
 *
 * An MCP bridge (loopback Streamable-HTTP + per-turn kiro agent profile)
 * exposes the calling Pi session's tools inside delegated runs as
 * @pi/<prefix>_<tool> — whatever bridgeable extensions are installed
 * (pi-subagents' subagents_Agent/_get_subagent_result/_steer_subagent; rpiv's
 * rpiv_ask_user_question, rpiv_todo, rpiv_advisor when present).
 *
 * Commands:
 *   /kiro            — readiness status; (re)registers the provider
 *   /kiro-subagents  — on [model] [names,...] | off [names,...]: route pi-subagents
 *                      agent profiles through kiro
 */

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	captureBridgeTools,
	type ChildScopedHttpBridgeHandle,
	serveBridgeHttp,
	setBridgeNotice,
} from "./bridge.js";
import { bridgeEnabled, sweepStaleAgentProfiles } from "./kiro-bridge.js";
import { trace } from "./trace.js";
import {
	addTurnToTotals,
	createMeteringTotals,
	formatMeteringStatus,
	readMeteringDiagnostic,
} from "./metering.js";
import { DEFAULT_SUBAGENT_MODEL, FALLBACK_MODELS, fetchKiroModels, KIRO_PROVIDER } from "./models.js";
import { checkKiroReadiness, clearKiroReadinessCache } from "./readiness.js";
import { reapOrphanedKiroChildren } from "./orphan-reaper.js";
import { makeStreamViaAcp } from "./acp-transport.js";
import { chatFormat, makeStreamViaKiro } from "./stream-adapter.js";
import { wireSubagents } from "./subagent-wiring.js";
import {
	cooldownMsFromEnv,
	fallbackProvidersFromEnv,
	ROUTER_MODEL_ID,
	ROUTER_THINKING_LEVELS,
	type RouterState,
	routeRequest,
} from "./router.js";
import {
	ACP_ENGINE,
	CHAT_ENGINE,
	authMethod,
	identityLine,
	type KiroChatFormat,
	parseKiroVersion,
	pluginName,
	pluginVersion,
	resolvePiVersion,
} from "./identity.js";

/** Comma-separated name list → trimmed, non-empty names. Shared by both /kiro-subagents branches. */
export function parseNameList(csv: string): string[] {
	return csv
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

interface SubagentsArgs {
	mode: "on" | "off" | "invalid";
	model?: string;
	only?: string[];
}

/** Pure parse of /kiro-subagents's argument string — no runtime deps, unit-testable standalone. */
export function parseSubagentsArgs(args: string): SubagentsArgs {
	const trimmed = args.trim();
	if (trimmed === "off" || trimmed.startsWith("off ")) {
		const names = trimmed === "off" ? "" : trimmed.slice(4).trim();
		const only = names.length > 0 ? parseNameList(names) : undefined;
		return { mode: "off", only };
	}
	if (trimmed === "on" || trimmed.startsWith("on ")) {
		const rest = trimmed === "on" ? [] : trimmed.slice(3).trim().split(/\s+/);
		const model = rest[0]?.includes("/") ? rest.shift() : DEFAULT_SUBAGENT_MODEL;
		const only = parseNameList(rest.join(" "));
		return { mode: "on", model, only: only.length > 0 ? only : undefined };
	}
	return { mode: "invalid" };
}

// ExtensionContext keyed by session id, captured per turn for bridged tool
// execution. A bridged tool call resolves through this map at CALL TIME, not
// from a snapshot taken when the bridge was created, so a call made inside one
// session's delegated turn always reaches THAT session's newest ctx. latestCtx
// is a last-resort fallback for when a session id cannot be resolved.
//
// Bounded (LRU, touch-on-use): pi emits no session-end event to hang a delete
// on, so a long-lived host serving many sessions would otherwise retain one
// ExtensionContext per session id forever. The cap mirrors acp-session.ts's
// session registry. Touch-on-use, including the getter read below, keeps an
// in-flight session's ctx off the eviction front while its bridge is still
// making tool calls.
const MAX_SESSION_CTX = 64;
const sessionCtxMap = new Map<string, ExtensionContext>();
let latestCtx: ExtensionContext | undefined;

/** Record/refresh a session's ctx at the most-recently-used end, evicting the
 * least-recently-used entry once the cap is exceeded. */
function rememberSessionCtx(sessionId: string, ctx: ExtensionContext): void {
	sessionCtxMap.delete(sessionId); // re-insert at the MRU end (Map preserves insertion order)
	sessionCtxMap.set(sessionId, ctx);
	if (sessionCtxMap.size > MAX_SESSION_CTX) {
		const lru = sessionCtxMap.keys().next().value; // first key = least-recently-used
		if (lru !== undefined) sessionCtxMap.delete(lru);
	}
}

/** Resolve a session's ctx, counting the read as a touch so an in-flight
 * session's ctx is not evicted mid-turn under churn from other sessions. */
function resolveSessionCtx(sessionId: string): ExtensionContext | undefined {
	const ctx = sessionCtxMap.get(sessionId);
	if (ctx !== undefined) {
		sessionCtxMap.delete(sessionId);
		sessionCtxMap.set(sessionId, ctx); // move to the MRU end
	}
	return ctx;
}

/** Test hook: number of session ctxs currently retained (bound regression). */
export function _sessionCtxCount(): number {
	return sessionCtxMap.size;
}

/**
 * The ctx accessor handed to one bridge, plus the rebind its owner calls when a
 * new session starts on that same bridge.
 *
 * getCtx pins to the session that was current when the binding was made, so a
 * concurrent turn from another session cannot steal this bridge's tool calls.
 * rebindOrigin re-points that pin, which is what a CHILD-scoped bridge needs:
 * an ACP bridge is mounted once and reused by every session on its child, so
 * with a one-shot capture the second and later sessions keep resolving the
 * FIRST session's ctx (the LRU still holds it, so the latestCtx fallback never
 * fires either).
 */
export function _makeBridgeCtxBinding(): {
	getCtx: () => ExtensionContext | undefined;
	rebindOrigin: () => void;
} {
	let originId = latestCtx?.sessionManager?.getSessionId();
	return {
		// Reads through resolveSessionCtx, so a long-lived bridge's own session
		// counts as recently used and cannot be evicted by churn from others.
		getCtx: () => (originId ? resolveSessionCtx(originId) ?? latestCtx : latestCtx),
		rebindOrigin: () => {
			originId = latestCtx?.sessionManager?.getSessionId();
		},
	};
}

const deps: {
	binaryPath: string | undefined;
	getBridge?: (
		signal: AbortSignal,
		getCallSignal?: () => AbortSignal,
	) => Promise<ChildScopedHttpBridgeHandle | undefined>;
	kiroVersion?: string;
} = { binaryPath: undefined };

let transportFallbackTraced = false;
/** Test hook: allow the once-per-process unknown-transport trace to fire again. */
export function _resetTransportFallback(): void {
	transportFallbackTraced = false;
}

/**
 * Which transport ensureRegistered wires up. ACP is the default.
 *
 * ACP holds one kiro-cli child for the session and speaks a protocol:
 * tool arguments and the credit metadata arrive as structured events, and
 * kiro keeps its own prefix cache warm across turns. The chat transport
 * spawns a child per turn and, below the stream-json floor, recovers the
 * answer by scraping prose. `PI_KIRO_TRANSPORT=chat` selects it as a
 * fallback, for a kiro-cli whose `acp` subcommand is missing or broken.
 *
 * An unrecognized value keeps the default and traces once. It must not
 * select the fallback: a typo silently downgrading a session to the scrape
 * path is the failure mode this default exists to remove.
 */
function useAcpTransport(): boolean {
	const raw = (process.env.PI_KIRO_TRANSPORT ?? "").trim();
	if (raw === "chat") return false;
	if (raw === "" || raw === "acp") return true;
	if (!transportFallbackTraced) {
		transportFallbackTraced = true;
		trace("transport.unknown", { value: raw, using: "acp" });
	}
	return true;
}

/**
 * The chat format for DISPLAY. chatFormat throws on a malformed
 * PI_KIRO_CHAT_FORMAT, which is right for a turn (fail before kiro is
 * spawned) and wrong for the status bar, where the throw would take the
 * whole identity line with it and leave the user with no line at all. The
 * line then says "chat" rather than naming a format the turn will refuse.
 */
function displayChatFormat(kiroVersion?: string): KiroChatFormat | undefined {
	try {
		return chatFormat(kiroVersion);
	} catch {
		return undefined;
	}
}

/**
 * Layer 1 identity: the line pi-kiro renders itself, independent of what the
 * model says. Same parts the transports put in the prompt.
 */
export async function currentIdentityLine(modelId: string): Promise<string> {
	const acp = useAcpTransport();
	return identityLine({
		piVersion: await resolvePiVersion(),
		kiroVersion: deps.kiroVersion,
		engine: acp ? ACP_ENGINE : CHAT_ENGINE,
		transport: acp ? "acp" : "chat",
		format: acp ? undefined : displayChatFormat(deps.kiroVersion),
		model: modelId,
	});
}

const STATUS_KEY = "kiro";
/**
 * Second status slot, for the running credit cost.
 *
 * Kiro bills in credits and reports no token counts, so the credit figure on
 * each turn's final metadata is the only per-turn price that exists. Showing it
 * is the difference between a provider whose spend is legible and one whose
 * footer reads $0.00 forever. Tokens stay blank because the CLI never sends
 * them; the dollar figure next to the credits is a projection at the configured
 * rate and is marked approximate (see metering.ts).
 */
const CREDITS_STATUS_KEY = "kiro-credits";
let meteringTotals = createMeteringTotals();

// Bumped on every status update so a slow identity-line resolution for an
// earlier model never overwrites the status set for a later one.
let statusGeneration = 0;

/**
 * Show the identity line in pi's status bar while a kiro model is active; clear
 * it otherwise. `model` defaults to ctx.model; model_select passes the newly
 * selected model explicitly so a /model switch updates the bar immediately
 * instead of on the next provider request.
 */
function updateIdentityStatus(
	ctx: ExtensionContext | undefined,
	model: { provider: string; id: string } | undefined = ctx?.model,
): void {
	if (!ctx?.hasUI) return;
	const generation = ++statusGeneration;
	if (!model || model.provider !== KIRO_PROVIDER) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	void currentIdentityLine(model.id)
		.then((line) => {
			if (generation === statusGeneration) ctx.ui.setStatus(STATUS_KEY, line);
		})
		.catch(() => undefined);
}
let registered = false;

// Self-heal state: activation registers once, so a cold-start readiness miss
// would otherwise wedge the provider until a manual /kiro. Retry registration
// lazily and throttled on later provider requests (background, never blocking).
const SELF_HEAL_INTERVAL_MS = 10_000;
let lastSelfHealAt = 0;
let selfHealing = false;

function maybeSelfHeal(pi: ExtensionAPI): void {
	if (registered || selfHealing) return;
	const now = Date.now();
	if (now - lastSelfHealAt < SELF_HEAL_INTERVAL_MS) return;
	lastSelfHealAt = now;
	selfHealing = true;
	// Non-forced: re-probes only because a transient miss left the cache empty;
	// a definitively-cached ENOENT/logged-out returns instantly and stays a no-op.
	void ensureRegistered(pi)
		.catch(() => undefined)
		.finally(() => {
			selfHealing = false;
		});
}

/** ensureRegistered's per-call outcome — read this, never the module-global `registered` flag. */
interface RegistrationResult {
	ok: boolean;
	detail: string;
}

async function ensureRegistered(pi: ExtensionAPI, force = false): Promise<RegistrationResult> {
	if (force) clearKiroReadinessCache();
	const readiness = await checkKiroReadiness(force);
	deps.binaryPath = readiness.binaryPath;
	deps.kiroVersion = parseKiroVersion(readiness.version);
	if (!readiness.ready) {
		return { ok: false, detail: `kiro provider NOT registered: ${readiness.detail}` };
	}
	// ALWAYS register when ready -- never gate on the local `registered` flag.
	// The host's registerProvider is an upsert, and the host DROPS dynamic
	// providers on session resets (/new, /resume, fork, reload) while this
	// module and its flag survive. Gating on the flag made ensureRegistered,
	// /kiro and the lazy self-heal no-ops after /new, wedging the provider until
	// a relaunch. The flag is only maybeSelfHeal's throttle hint.
	{
		const models = readiness.binaryPath
			? await fetchKiroModels(readiness.binaryPath)
			: FALLBACK_MODELS;
		// GSD (and other pi hosts) classify a provider that wraps a local CLI via
		// authMode: "externalCli". It gates flat-rate routing detection and the
		// workflow-MCP question/tool transport, both of which also require a
		// local:// baseUrl. Without it kiro is resolved as an "apiKey" provider
		// (from the dummy apiKey below), so GSD treats a seat-billed local CLI as
		// a metered API. Upstream pi's ProviderConfig type predates the field, so
		// widen it here; hosts that don't read authMode ignore it.
		//
		// The persistent ACP transport is the default; PI_KIRO_TRANSPORT=chat
		// selects the per-turn chat transport (docs/design/acp-transport.md).
		const useAcp = useAcpTransport();
		const config: ProviderConfig & { authMode: "externalCli" } = {
			name: "Kiro CLI (local runtime)",
			authMode: "externalCli",
			baseUrl: "local://kiro-cli",
			// Never used for requests — streamSimple owns transport. Kept because
			// upstream pi (no authMode concept) requires apiKey/oauth when models
			// are defined; GSD ignores it since authMode resolves first.
			apiKey: "kiro-local",
			api: "anthropic-messages",
			models,
			streamSimple: useAcp ? makeStreamViaAcp(deps) : makeStreamViaKiro(deps),
		};
		pi.registerProvider(KIRO_PROVIDER, config);
		registered = true;
		registerRouter(pi, models);
	}
	return {
		ok: true,
		detail: `kiro provider registered (${readiness.detail}). Select with /model ${KIRO_PROVIDER}/<id>.`,
	};
}

/**
 * Register the opt-in kiro/router virtual model (router.ts) next to the
 * physical kiro models. Skipped on hosts without registerVirtualModel
 * (pi < 1.0), when PI_KIRO_ROUTER=off, and when the seat exposes a PHYSICAL
 * model with the router's id (a virtual model would hide it). Re-run on every
 * provider registration because the host drops both on session resets.
 * Returns whether it registered.
 */
export function registerRouter(pi: ExtensionAPI, models: ReadonlyArray<{ id: string }>): boolean {
	if (process.env.PI_KIRO_ROUTER === "off") return false;
	if (typeof (pi as { registerVirtualModel?: unknown }).registerVirtualModel !== "function") return false;
	if (models.some((model) => model.id === ROUTER_MODEL_ID)) return false;
	pi.registerVirtualModel<RouterState>({
		provider: KIRO_PROVIDER,
		id: ROUTER_MODEL_ID,
		name: "router: low=haiku, medium=sonnet, high=opus, xhigh=fable [kiro]",
		thinkingLevels: ROUTER_THINKING_LEVELS,
		// Shown before the first response only; the haiku tier's window.
		contextWindow: 200_000,
		maxTokens: 32_000,
		input: ["text"],
		route: (request, ctx) =>
			routeRequest(request, ctx.modelRegistry, {
				cooldownMs: cooldownMsFromEnv(process.env.PI_KIRO_ROUTER_COOLDOWN_MS),
				fallbackProviders: fallbackProvidersFromEnv(process.env.PI_KIRO_ROUTER_FALLBACK),
			}),
	});
	return true;
}

export default async function piKiro(pi: ExtensionAPI): Promise<void> {
	// Kill kiro-cli delegations orphaned by a parent that died uncleanly — the
	// process "exit" tether cannot run on SIGKILL/crash, so each activation
	// sweeps the process table (see orphan-reaper.ts). Best-effort: a reaper
	// failure must never break activation.
	try {
		reapOrphanedKiroChildren();
	} catch {
		// ignore — worst case the orphans survive until the next activation
	}
	// The same crash leaves the turn's agent profile, and any backup kiro wrote
	// beside it, in ~/.kiro/agents with the bridge token in it (kiro-bridge.ts).
	try {
		sweepStaleAgentProfiles();
	} catch {
		// ignore — they are swept again on the next activation
	}

	// Bridge advisories go through the host, not stderr: under the TUI a raw
	// stderr write is painted above the prompt and stays there for the whole
	// session, so a mount-time advisory read as a permanent banner. notify is
	// transient; stderr remains the fallback for print/RPC mode, where there is
	// no UI to notify. Always traced, so the detail survives either way.
	setBridgeNotice((message) => {
		trace("bridge.notice", { message });
		const ctx = latestCtx;
		if (ctx?.hasUI) ctx.ui.notify(message, "warning");
		else console.error(message);
	});

	pi.on("context", (_event, ctx) => {
		latestCtx = ctx;
		const sessionId = ctx?.sessionManager?.getSessionId();
		if (sessionId) rememberSessionCtx(sessionId, ctx);
	});
	pi.on("before_provider_request", (_event, ctx) => {
		latestCtx = ctx;
		const sessionId = ctx?.sessionManager?.getSessionId();
		if (sessionId) rememberSessionCtx(sessionId, ctx);
		maybeSelfHeal(pi);
		updateIdentityStatus(ctx);
	});
	pi.on("model_select", (event, ctx) => {
		updateIdentityStatus(ctx, event.model);
	});
	// Session starts/reloads (/new, /resume, fork, reload) drop dynamically
	// registered providers in the host while this module survives — re-register
	// in the background so kiro models stay selectable without a relaunch.
	// registerProvider is an upsert, so the extra call on "startup" is harmless.
	pi.on("session_start", (_event, ctx) => {
		registered = false;
		// Credits are a per-session running total: /new, /resume and fork all
		// start a fresh tally rather than inheriting the last session's spend.
		meteringTotals = createMeteringTotals();
		if (ctx?.hasUI) ctx.ui.setStatus(CREDITS_STATUS_KEY, undefined);
		void ensureRegistered(pi).catch(() => undefined);
	});
	// A kiro turn attaches its credit figure as a `kiro.metering` diagnostic
	// (both transports). Fold it into the session total and publish it to the
	// footer. Messages from any other provider are ignored, so a session that
	// switches models mid-way does not attribute another provider's turn to
	// kiro's credit pool.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== KIRO_PROVIDER) return;
		// Every kiro turn carries a record, including one that reported no credit
		// figure (the text fallback on a kiro-cli whose footer no longer parses).
		// Such a turn is skipped outright: folding it in would count it as a turn
		// and put a "(last ...)" on the next priced one with nothing before it.
		const turn = readMeteringDiagnostic(message.diagnostics);
		if (turn?.credits === undefined) return;
		addTurnToTotals(meteringTotals, turn);
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(CREDITS_STATUS_KEY, formatMeteringStatus(meteringTotals));
	});

	deps.getBridge = async (signal, getCallSignal) => {
		if (!bridgeEnabled()) return undefined;
		const tools = await captureBridgeTools(pi, process.env.PI_KIRO_BRIDGE_TOOLS);
		// Pin this bridge to the session that is creating it: both transports
		// await options.onPayload (-> before_provider_request -> the handler
		// above) before calling deps.getBridge, so sessionCtxMap already holds
		// THIS turn's session. Captured once, at call time, rather than re-read
		// from the global on every bridged tool call, so a DIFFERENT session's
		// turn writing to the map afterward cannot steal this bridge's calls.
		//
		// Residual window, accepted: a concurrent turn from another session
		// racing its own before_provider_request between that await and this
		// line would still win originId. Closing it means threading session
		// identity from the transport into getBridge(signal).
		//
		// The pin is REBINDABLE because an ACP bridge outlives the session that
		// mounted it (one URL per child, section 5e.3): resolveSession calls
		// rebindOrigin at every session start, so session two does not keep
		// running its bridged tools against session one's ctx.
		const binding = _makeBridgeCtxBinding();
		const handle = await serveBridgeHttp(
			tools,
			binding.getCtx,
			signal,
			getCallSignal,
		);
		return handle && { ...handle, rebindOrigin: binding.rebindOrigin };
	};

	pi.registerCommand("kiro", {
		description: "Show Kiro delegation status and (re)register the provider",
		handler: async (_args, ctx) => {
			const result = await ensureRegistered(pi, true);
			const lines = [result.detail, `${pluginName()} ${pluginVersion()}, auth: ${authMethod()}`];
			if (result.ok && ctx.model?.provider === KIRO_PROVIDER) {
				lines.push(`identity: ${await currentIdentityLine(ctx.model.id)}`);
			}
			ctx.ui.notify(lines.join("\n"), result.ok ? "info" : "error");
			updateIdentityStatus(ctx);
		},
	});

	pi.registerCommand("kiro-subagents", {
		description:
			"Route pi-subagents agents through kiro: on [provider/model] [names,...] | off [names,...]",
		getArgumentCompletions: (prefix) =>
			["on", `on ${DEFAULT_SUBAGENT_MODEL}`, "off"]
				.filter((item) => item.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const parsed = parseSubagentsArgs(args);
			if (parsed.mode === "invalid") {
				ctx.ui.notify(
					"Usage: /kiro-subagents on [provider/model] [names,...] | off [names,...]",
					"error",
				);
				return;
			}
			if (parsed.mode === "off") {
				const result = wireSubagents(undefined, parsed.only);
				ctx.ui.notify(
					`Unrouted ${result.changed.length} ${parsed.only ? "named" : "of all"} agent(s) from kiro (${result.skipped.length} untouched).`,
					"info",
				);
				return;
			}
			if (!parsed.model || !parsed.model.startsWith(`${KIRO_PROVIDER}/`)) {
				ctx.ui.notify(`Model must be ${KIRO_PROVIDER}/<id> (got "${parsed.model}").`, "error");
				return;
			}
			const registration = await ensureRegistered(pi);
			const result = wireSubagents(parsed.model, parsed.only);
			ctx.ui.notify(
				`${result.changed.length} agent(s) now use ${parsed.model}; ${result.skipped.length} already set or missing. ${registration.detail}`,
				"info",
			);
		},
	});

	// Best-effort registration at load; /kiro retries interactively.
	await ensureRegistered(pi);
}
