/**
 * kiro/router -- an opt-in virtual model (pi >= 1.0 `registerVirtualModel`)
 * that picks a kiro model by tier and falls back to another provider when kiro
 * cannot serve the turn. It sits beside kiro/auto (kiro's own router) and is
 * never the default: a user selects it with `/model kiro/router`.
 *
 * Tiers. The selected thinking level picks the tier, and the level passes
 * through as the physical reasoning effort:
 *
 *   low -> haiku   medium -> sonnet   high -> opus   xhigh -> fable
 *
 * Each tier is anchored on a kiro credit multiplier (kiro-cli chat
 * --list-models): haiku 0.4x, sonnet 1.3x, opus 2.0-2.2x, fable 6.0x. Bedrock and Anthropic fall back to the same Claude family. kiro
 * sells no OpenAI model at sonnet's 1.3x, so the OpenAI subscription
 * (openai-codex) takes the gpt-5.6 model with the NEAREST kiro multiplier:
 * luna 0.6x for haiku, terra 2.2x for sonnet and opus, sol 4.4x for fable.
 * Bedrock ids are always `us.anthropic.*`.
 *
 * Request reasons (docs/virtual-models.md):
 * - `continuation` (tool follow-ups) is sticky to `previous`: one kiro request
 *   is kiro's whole agent loop, and moving mid-turn orphans its session.
 * - `direct` (compaction, extension calls) stays with the transcript: the
 *   model that produced the latest response, never a different provider.
 * - `retry` after a context overflow moves to a larger window in the same
 *   tier family; any other failed kiro request moves to the first fallback
 *   provider with credentials, and a failed fallback moves to the next one.
 * - `user` goes to the tier's kiro model, unless kiro failed recently: pi does
 *   not retry quota/auth errors, so a kiro error left in the transcript also
 *   triggers the fallback on the next user turn. A fallback holds for a
 *   cooldown (state.fallbackUntil) before kiro is tried again.
 */

import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { KIRO_PROVIDER } from "./models.js";
import { trace } from "./trace.js";

export const ROUTER_MODEL_ID = "router";

export type RouterTier = "haiku" | "sonnet" | "opus" | "fable";

/** Default order in which non-kiro providers are tried. Override: PI_KIRO_ROUTER_FALLBACK. */
export const DEFAULT_FALLBACK_PROVIDERS = ["amazon-bedrock", "anthropic", "openai-codex"] as const;

interface TierSpec {
	tier: RouterTier;
	/** kiro's credit multiplier for the tier's anchor model. */
	kiroMultiplier: number;
	/** Per provider, candidate ids in preference order; the first one found with credentials wins. */
	candidates: Record<string, readonly string[]>;
}

export const TIERS: readonly TierSpec[] = [
	{
		tier: "haiku",
		kiroMultiplier: 0.4,
		candidates: {
			[KIRO_PROVIDER]: ["claude-haiku-4.5"],
			"amazon-bedrock": ["us.anthropic.claude-haiku-4-5-20251001-v1:0"],
			anthropic: ["claude-haiku-4-5"],
			"openai-codex": ["gpt-5.6-luna"],
		},
	},
	{
		tier: "sonnet",
		kiroMultiplier: 1.3,
		candidates: {
			[KIRO_PROVIDER]: ["claude-sonnet-5.5", "claude-sonnet-5", "claude-sonnet-4.6"],
			"amazon-bedrock": ["us.anthropic.claude-sonnet-5", "us.anthropic.claude-sonnet-4-6"],
			anthropic: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6"],
			"openai-codex": ["gpt-5.6-terra"],
		},
	},
	{
		tier: "opus",
		kiroMultiplier: 2.0,
		candidates: {
			[KIRO_PROVIDER]: ["claude-opus-5.5", "claude-opus-5", "claude-opus-4.8"],
			"amazon-bedrock": ["us.anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5", "us.anthropic.claude-opus-4-8"],
			anthropic: ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
			"openai-codex": ["gpt-5.6-terra"],
		},
	},
	{
		tier: "fable",
		kiroMultiplier: 6.0,
		candidates: {
			[KIRO_PROVIDER]: ["claude-fable-5.1"],
			"amazon-bedrock": ["us.anthropic.claude-fable-5-1", "us.anthropic.claude-fable-5"],
			anthropic: ["claude-fable-5-1", "claude-fable-5"],
			"openai-codex": ["gpt-5.6-sol"],
		},
	},
];

/** Virtual thinking levels offered for selection, one per tier, lowest first. */
export const ROUTER_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["low", "medium", "high", "xhigh"];

export function tierFor(level: ModelThinkingLevel | undefined): RouterTier {
	switch (level) {
		case "medium":
			return "sonnet";
		case "high":
			return "opus";
		case "xhigh":
		case "max":
			return "fable";
		default:
			// off, minimal, low, and anything unknown: the cheapest tier.
			return "haiku";
	}
}

/** Router state stored on the session branch. JSON-serializable by construction. */
export interface RouterState {
	/** Epoch ms until which user turns skip kiro and go straight to a fallback. */
	fallbackUntil?: number;
	/**
	 * Why the fallback started (the kiro error, truncated to 200 chars). Also
	 * emitted on the router.fallback.start / router.fallback.end trace events
	 * (PI_KIRO_TRACE), so "why is this session off kiro" has an answer
	 * without reading the session branch.
	 */
	fallbackReason?: string;
}

/** The slice of pi's ModelRegistry the router reads. */
export interface RouterRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface RouterOptions {
	now?: () => number;
	cooldownMs?: number;
	fallbackProviders?: readonly string[];
}

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

/** PI_KIRO_ROUTER_FALLBACK: comma-separated provider ids; empty or unset = the default order. */
export function fallbackProvidersFromEnv(raw: string | undefined): readonly string[] {
	const list = (raw ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0 && name !== KIRO_PROVIDER);
	return list.length > 0 ? list : DEFAULT_FALLBACK_PROVIDERS;
}

export function cooldownMsFromEnv(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COOLDOWN_MS;
}

/**
 * Context-overflow wording across kiro and the fallback providers. pi handles
 * an overflow by compacting and then retrying, so this only decides whether the
 * retry should also move to a larger window.
 */
const OVERFLOW_PATTERN =
	/prompt (?:is )?too long|input is too long|request_too_large|exceeds? (?:the )?(?:model'?s )?(?:maximum )?context|context (?:window|length) (?:exceeded|overflow)|context.?overflow|too many tokens/i;
const THROTTLE_PATTERN = /throttl|rate.?limit|too many requests/i;

export function isOverflowError(message: string | undefined): boolean {
	if (!message) return false;
	return OVERFLOW_PATTERN.test(message) && !THROTTLE_PATTERN.test(message);
}

function specFor(tier: RouterTier): TierSpec {
	const spec = TIERS.find((t) => t.tier === tier);
	if (!spec) throw new Error(`kiro/router: unknown tier ${tier}`);
	return spec;
}

/** The first candidate of `provider` at `tier` that is in the catalog and has credentials. */
function pick(registry: RouterRegistry, tier: RouterTier, provider: string): Model<Api> | undefined {
	for (const id of specFor(tier).candidates[provider] ?? []) {
		const model = registry.find(provider, id);
		if (model && registry.hasConfiguredAuth(model)) return model;
	}
	return undefined;
}

/** The tier's kiro model. A seat that exposes none of them gets kiro/auto (1.0x). */
function kiroModelFor(registry: RouterRegistry, tier: RouterTier): Model<Api> {
	const model = pick(registry, tier, KIRO_PROVIDER) ?? registry.find(KIRO_PROVIDER, "auto");
	if (!model) throw new Error("kiro/router: the kiro provider has no models; run /kiro");
	return model;
}

/** The first fallback provider, after `after` in the order, with a model at `tier`. */
function fallbackFor(
	registry: RouterRegistry,
	tier: RouterTier,
	providers: readonly string[],
	after?: string,
): Model<Api> | undefined {
	const start = after === undefined ? 0 : providers.indexOf(after) + 1;
	for (const provider of providers.slice(start)) {
		const model = pick(registry, tier, provider);
		if (model) return model;
	}
	return undefined;
}

/** A model of the same provider with a larger window: this tier first, then higher tiers. */
function largerWindow(registry: RouterRegistry, failed: Model<Api>, tier: RouterTier): Model<Api> | undefined {
	const from = TIERS.findIndex((t) => t.tier === tier);
	for (const spec of TIERS.slice(from)) {
		for (const id of spec.candidates[failed.provider] ?? []) {
			const model = registry.find(failed.provider, id);
			if (model && registry.hasConfiguredAuth(model) && model.contextWindow > failed.contextWindow) return model;
		}
	}
	return undefined;
}

function lastAssistant(messages: readonly Message[]): Message | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
	return undefined;
}

/** A kiro request that ended in an error the transcript still shows (pi did not retry it). */
function kiroFailedLastTurn(messages: readonly Message[]): string | undefined {
	const last = lastAssistant(messages) as
		| { provider?: string; stopReason?: string; errorMessage?: string }
		| undefined;
	if (!last || last.provider !== KIRO_PROVIDER || last.stopReason !== "error") return undefined;
	if (isOverflowError(last.errorMessage)) return undefined;
	return last.errorMessage ?? "kiro request failed";
}

const routeId = (model: Model<Api>) => `${model.provider}/${model.id}`;

/** Start a cooldown on `to`. `trigger`: a pi retry of the failed kiro request, or a kiro error left in the transcript. */
function startFallback(
	now: number,
	cooldownMs: number,
	reason: string,
	trigger: "retry" | "transcript",
	to: Model<Api>,
): RouterState {
	const state = { fallbackUntil: now + cooldownMs, fallbackReason: reason.slice(0, 200) };
	trace("router.fallback.start", { trigger, to: routeId(to), until: state.fallbackUntil, reason: state.fallbackReason });
	return state;
}

export function routeRequest(
	request: ModelRouteRequest<RouterState>,
	registry: RouterRegistry,
	options: RouterOptions = {},
): ModelRoute<RouterState> {
	const now = (options.now ?? Date.now)();
	const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	const providers = options.fallbackProviders ?? DEFAULT_FALLBACK_PROVIDERS;
	const tier = tierFor(request.thinkingLevel);
	const level = request.thinkingLevel;
	const previous = request.previous;

	if (request.reason === "direct") {
		// Compaction stays with the transcript (state is ignored for direct).
		if (previous) return { model: previous.model, thinkingLevel: previous.thinkingLevel ?? level };
		return { model: kiroModelFor(registry, tier), thinkingLevel: level };
	}

	if (request.reason === "continuation" && previous) {
		return { model: previous.model, thinkingLevel: previous.thinkingLevel ?? level };
	}

	if (request.reason === "retry" && request.failed) {
		const failed = request.failed;
		const failedLevel = failed.thinkingLevel ?? level;
		if (isOverflowError(failed.message.errorMessage)) {
			return { model: largerWindow(registry, failed.model, tier) ?? failed.model, thinkingLevel: failedLevel };
		}
		if (failed.model.provider === KIRO_PROVIDER) {
			const fallback = fallbackFor(registry, tier, providers);
			if (!fallback) return { model: failed.model, thinkingLevel: failedLevel };
			return {
				model: fallback,
				thinkingLevel: level,
				state: startFallback(now, cooldownMs, failed.message.errorMessage ?? "kiro request failed", "retry", fallback),
			};
		}
		// A fallback provider failed: try the next one, then kiro again.
		const next = fallbackFor(registry, tier, providers, failed.model.provider);
		return { model: next ?? kiroModelFor(registry, tier), thinkingLevel: level };
	}

	// user (and a continuation/retry with nothing to stick to).
	const state = request.state;
	if (state?.fallbackUntil !== undefined && state.fallbackUntil > now) {
		// Keep the fallback provider the session already uses (prompt cache).
		const sticky = previous && previous.model.provider !== KIRO_PROVIDER ? pick(registry, tier, previous.model.provider) : undefined;
		const fallback = sticky ?? fallbackFor(registry, tier, providers);
		if (fallback) return { model: fallback, thinkingLevel: level };
	}
	const kiroError = kiroFailedLastTurn(request.messages);
	if (kiroError !== undefined) {
		const fallback = fallbackFor(registry, tier, providers);
		if (fallback) {
			return { model: fallback, thinkingLevel: level, state: startFallback(now, cooldownMs, kiroError, "transcript", fallback) };
		}
	}
	const model = kiroModelFor(registry, tier);
	// An expired fallback is cleared, so the next kiro error starts a fresh cooldown.
	if (state?.fallbackUntil !== undefined && state.fallbackUntil <= now) {
		trace("router.fallback.end", { to: routeId(model), until: state.fallbackUntil, reason: state.fallbackReason });
		return { model, thinkingLevel: level, state: {} };
	}
	return { model, thinkingLevel: level };
}
