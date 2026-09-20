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
 * @pi/<tool> — whatever bridgeable extensions are installed (pi-subagents'
 * Agent/get_subagent_result/steer_subagent; rpiv's ask_user_question, todo,
 * advisor when present).
 *
 * Commands:
 *   /kiro            — readiness status; (re)registers the provider
 *   /kiro-subagents  — on [model] [names,...] | off [names,...]: route pi-subagents
 *                      agent profiles through kiro
 */

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { captureBridgeTools, type HttpBridgeHandle, serveBridgeHttp } from "./bridge.js";
import { bridgeEnabled } from "./kiro-bridge.js";
import { DEFAULT_SUBAGENT_MODEL, FALLBACK_MODELS, fetchKiroModels, KIRO_PROVIDER } from "./models.js";
import { checkKiroReadiness, clearKiroReadinessCache } from "./readiness.js";
import { reapOrphanedKiroChildren } from "./orphan-reaper.js";
import { makeStreamViaAcp } from "./acp-transport.js";
import { makeStreamViaKiro } from "./stream-adapter.js";
import { wireSubagents } from "./subagent-wiring.js";

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
// execution. A bridged tool call resolves through this map at CALL TIME (not
// a snapshot taken when the bridge was created), so a tool call made inside
// one session's delegated turn always reaches for THAT session's newest ctx,
// never a different session's turn that happened to write more recently
// [L0-04]. latestCtx stays as a last-resort fallback for the rare case a
// session id cannot be resolved.
const sessionCtxMap = new Map<string, ExtensionContext>();
let latestCtx: ExtensionContext | undefined;

const deps: {
	binaryPath: string | undefined;
	getBridge?: (
		signal: AbortSignal,
		getCallSignal?: () => AbortSignal,
	) => Promise<HttpBridgeHandle | undefined>;
} = { binaryPath: undefined };
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

/** ensureRegistered's per-call outcome — read this, never the lingering module-global `registered` flag [L0-03]. */
interface RegistrationResult {
	ok: boolean;
	detail: string;
}

async function ensureRegistered(pi: ExtensionAPI, force = false): Promise<RegistrationResult> {
	if (force) clearKiroReadinessCache();
	const readiness = await checkKiroReadiness(force);
	deps.binaryPath = readiness.binaryPath;
	if (!readiness.ready) {
		return { ok: false, detail: `kiro provider NOT registered: ${readiness.detail}` };
	}
	// ALWAYS register when ready — never gate on the local `registered` flag.
	// The host's registerProvider is an upsert (validate → apply → upsert), and
	// the host DROPS dynamic providers on session resets (/new, /resume, fork,
	// reload) while this module (and its flag) survive. Gating on the flag made
	// ensureRegistered, /kiro, and the lazy self-heal all no-ops after /new,
	// wedging the provider until a full process relaunch. The flag remains only
	// as maybeSelfHeal's throttle hint ("have we ever registered") — /kiro reads
	// this call's own {ok, detail} for its notify level, not the flag [L0-03].
	{
		const models = readiness.binaryPath
			? await fetchKiroModels(readiness.binaryPath)
			: FALLBACK_MODELS;
		// GSD (and other pi hosts) classify a provider that wraps a local CLI via
		// authMode: "externalCli". It gates flat-rate routing detection and the
		// workflow-MCP question/tool transport — both require authMode ===
		// "externalCli" alongside a local:// baseUrl. Without it, kiro is resolved
		// as an "apiKey" provider (from the dummy apiKey below), so GSD treats a
		// seat-billed local CLI as a metered API and skips the external-CLI
		// transport. Upstream pi's ProviderConfig type predates the field, so
		// widen it here; hosts that don't read authMode ignore it.
		//
		// PI_KIRO_TRANSPORT=acp: use the persistent ACP transport instead of the
		// per-turn chat transport. See acp-transport.ts and docs/design/acp-transport.md.
		const useAcp = process.env.PI_KIRO_TRANSPORT === "acp";
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
	}
	return {
		ok: true,
		detail: `kiro provider registered (${readiness.detail}). Select with /model ${KIRO_PROVIDER}/<id>.`,
	};
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

	pi.on("context", (_event, ctx) => {
		latestCtx = ctx;
		sessionCtxMap.set(ctx.sessionManager.getSessionId(), ctx);
	});
	pi.on("before_provider_request", (_event, ctx) => {
		latestCtx = ctx;
		sessionCtxMap.set(ctx.sessionManager.getSessionId(), ctx);
		maybeSelfHeal(pi);
	});
	// Session starts/reloads (/new, /resume, fork, reload) drop dynamically
	// registered providers in the host while this module survives — re-register
	// in the background so kiro models stay selectable without a relaunch.
	// registerProvider is an upsert, so the extra call on "startup" is harmless.
	pi.on("session_start", () => {
		registered = false;
		void ensureRegistered(pi).catch(() => undefined);
	});

	deps.getBridge = async (signal, getCallSignal) => {
		if (!bridgeEnabled()) return undefined;
		const tools = await captureBridgeTools(pi, process.env.PI_KIRO_BRIDGE_TOOLS);
		// Pin this bridge to the session that is creating it: both transports
		// await options.onPayload (-> before_provider_request -> the handler
		// above) before ever calling deps.getBridge, so sessionCtxMap already
		// holds THIS turn's session by the time we get here. Captured once, at
		// call time, rather than re-read from the global on every bridged tool
		// call -- so a DIFFERENT session's turn writing to the map afterward
		// can no longer steal this bridge's tool calls [L0-04].
		//
		// Residual interleave window (accepted, not closed here): a concurrent
		// turn from another session racing its own before_provider_request
		// between that await and this line would still win originId. Closing
		// that fully means threading session identity explicitly from the
		// transport into getBridge(signal) instead of reading the global here
		// -- an intentionally deferred, larger ripple into both transports'
		// getBridge(signal) call sites (stream-adapter.ts, acp-transport.ts).
		const originId = latestCtx?.sessionManager.getSessionId();
		return serveBridgeHttp(
			tools,
			() => (originId ? sessionCtxMap.get(originId) ?? latestCtx : latestCtx),
			signal,
			getCallSignal,
		);
	};

	pi.registerCommand("kiro", {
		description: "Show Kiro delegation status and (re)register the provider",
		handler: async (_args, ctx) => {
			const result = await ensureRegistered(pi, true);
			ctx.ui.notify(result.detail, result.ok ? "info" : "error");
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
