import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_FALLBACK_PROVIDERS,
	ROUTER_THINKING_LEVELS,
	type RouterRegistry,
	type RouterState,
	TIERS,
	cooldownMsFromEnv,
	fallbackProvidersFromEnv,
	isOverflowError,
	routeRequest,
	tierFor,
} from "../src/router.js";

const model = (provider: string, id: string, contextWindow = 1_000_000): Model<Api> =>
	({ provider, id, name: id, api: "test", contextWindow, maxTokens: 32_000, reasoning: true, input: ["text"] }) as unknown as Model<Api>;

/** Every candidate in TIERS, plus kiro/auto, with kiro's real windows for the 200K models. */
function catalog(): Model<Api>[] {
	const small = new Set(["claude-haiku-4.5", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"]);
	const all = new Map<string, Model<Api>>();
	all.set("kiro/auto", model("kiro", "auto"));
	for (const spec of TIERS) {
		for (const [provider, ids] of Object.entries(spec.candidates)) {
			for (const id of ids) all.set(`${provider}/${id}`, model(provider, id, small.has(id) ? 200_000 : 1_000_000));
		}
	}
	return [...all.values()];
}

/** A registry over `models`; providers in `noAuth` have no credentials. */
function registry(models: Model<Api>[] = catalog(), noAuth: string[] = []): RouterRegistry {
	return {
		find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m) => !noAuth.includes(m.provider),
	};
}

const userMsg = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;
const reply = (provider: string, extra: Partial<AssistantMessage> = {}): Message =>
	({ role: "assistant", content: [{ type: "text", text: "a" }], provider, model: "m", stopReason: "stop", timestamp: 0, ...extra }) as unknown as Message;

function req(overrides: Partial<ModelRouteRequest<RouterState>>): ModelRouteRequest<RouterState> {
	return {
		model: model("kiro", "router", 200_000),
		thinkingLevel: "medium",
		reason: "user",
		messages: [userMsg("hi")],
		...overrides,
	} as ModelRouteRequest<RouterState>;
}

const failedWith = (m: Model<Api>, errorMessage: string) => ({
	model: m,
	thinkingLevel: "medium" as const,
	message: { role: "assistant", stopReason: "error", errorMessage, provider: m.provider, content: [] } as unknown as AssistantMessage,
});

const NOW = 1_000_000;
const opts = { now: () => NOW, cooldownMs: 60_000 };
const id = (m: Model<Api>) => `${m.provider}/${m.id}`;

describe("kiro/router tiers", () => {
	it("maps thinking levels to haiku < sonnet < opus < fable", () => {
		expect(ROUTER_THINKING_LEVELS.map(tierFor)).toEqual(["haiku", "sonnet", "opus", "fable"]);
		expect(tierFor("off")).toBe("haiku");
		expect(tierFor("minimal")).toBe("haiku");
		expect(tierFor("max")).toBe("fable");
	});

	it("orders the tiers by strictly increasing kiro credit multiplier", () => {
		const multipliers = TIERS.map((t) => t.kiroMultiplier);
		for (let i = 1; i < multipliers.length; i++) expect(multipliers[i]).toBeGreaterThan(multipliers[i - 1]);
		expect(TIERS.map((t) => t.tier)).toEqual(["haiku", "sonnet", "opus", "fable"]);
	});

	it("offers every tier on kiro and on each default fallback provider", () => {
		for (const spec of TIERS) {
			for (const provider of ["kiro", ...DEFAULT_FALLBACK_PROVIDERS]) {
				expect(spec.candidates[provider]?.length, `${spec.tier}/${provider}`).toBeGreaterThan(0);
			}
		}
	});

	it("uses only us.anthropic.* ids on Bedrock", () => {
		const ids = TIERS.flatMap((t) => t.candidates["amazon-bedrock"] ?? []);
		expect(ids.length).toBeGreaterThan(0);
		for (const bedrockId of ids) expect(bedrockId.startsWith("us.anthropic.")).toBe(true);
	});

	it("routes a user turn to the tier's first kiro model", () => {
		const reg = registry();
		const routed = ROUTER_THINKING_LEVELS.map((thinkingLevel) => id(routeRequest(req({ thinkingLevel }), reg, opts).model));
		expect(routed).toEqual(["kiro/claude-haiku-4.5", "kiro/claude-sonnet-5.5", "kiro/claude-opus-5.5", "kiro/claude-fable-5.1"]);
	});

	it("passes the selected level through as the physical level", () => {
		expect(routeRequest(req({ thinkingLevel: "high" }), registry(), opts).thinkingLevel).toBe("high");
	});

	it("takes the next kiro candidate a seat exposes, then kiro/auto", () => {
		const without = catalog().filter((m) => !(m.provider === "kiro" && m.id === "claude-sonnet-5.5"));
		expect(id(routeRequest(req({}), registry(without), opts).model)).toBe("kiro/claude-sonnet-5");
		const autoOnly = catalog().filter((m) => m.provider !== "kiro" || m.id === "auto");
		expect(id(routeRequest(req({}), registry(autoOnly), opts).model)).toBe("kiro/auto");
	});

	it("fails the request when kiro has no models at all", () => {
		const none = catalog().filter((m) => m.provider !== "kiro");
		expect(() => routeRequest(req({}), registry(none), opts)).toThrow(/no models/);
	});
});

describe("kiro/router request reasons", () => {
	const reg = registry();
	const bedrockSonnet = model("amazon-bedrock", "us.anthropic.claude-sonnet-5");

	it("continuation sticks to the previous physical model and level", () => {
		const previous = { model: bedrockSonnet, thinkingLevel: "low" as const };
		const route = routeRequest(req({ reason: "continuation", previous, thinkingLevel: "xhigh" }), reg, opts);
		expect(route.model).toBe(bedrockSonnet);
		expect(route.thinkingLevel).toBe("low");
		expect(route.state).toBeUndefined();
	});

	it("continuation with no previous routes like a user turn", () => {
		expect(id(routeRequest(req({ reason: "continuation" }), reg, opts).model)).toBe("kiro/claude-sonnet-5.5");
	});

	it("direct (compaction) stays with the transcript's model, even a kiro one at another tier", () => {
		const kiroOpus = model("kiro", "claude-opus-5.5");
		const route = routeRequest(req({ reason: "direct", previous: { model: kiroOpus, thinkingLevel: "high" }, thinkingLevel: "low" }), reg, opts);
		expect(route.model).toBe(kiroOpus);
		expect(route.thinkingLevel).toBe("high");
		expect(route.state).toBeUndefined();
	});

	it("direct with no previous goes to the tier's kiro model, never a fallback", () => {
		const route = routeRequest(req({ reason: "direct", state: { fallbackUntil: NOW + 1 } }), reg, opts);
		expect(id(route.model)).toBe("kiro/claude-sonnet-5.5");
	});

	it("retry of a failed kiro request falls back to Bedrock at the same tier and starts a cooldown", () => {
		const failed = failedWith(model("kiro", "claude-sonnet-5.5"), "kiro-cli acp session/prompt failed: 503 service unavailable");
		const route = routeRequest(req({ reason: "retry", failed }), reg, opts);
		expect(id(route.model)).toBe("amazon-bedrock/us.anthropic.claude-sonnet-5");
		expect(route.state?.fallbackUntil).toBe(NOW + 60_000);
		expect(route.state?.fallbackReason).toContain("503");
	});

	it("follows the fallback order to the first provider with credentials", () => {
		const failed = failedWith(model("kiro", "claude-opus-5.5"), "502 bad gateway");
		const noBedrock = registry(catalog(), ["amazon-bedrock"]);
		expect(id(routeRequest(req({ reason: "retry", failed, thinkingLevel: "high" }), noBedrock, opts).model)).toBe("anthropic/claude-opus-5-5");
		const onlyOpenAI = registry(catalog(), ["amazon-bedrock", "anthropic"]);
		expect(id(routeRequest(req({ reason: "retry", failed, thinkingLevel: "high" }), onlyOpenAI, opts).model)).toBe("openai-codex/gpt-5.6-terra");
	});

	it("maps each tier to the OpenAI model with the nearest kiro multiplier", () => {
		const onlyOpenAI = registry(catalog(), ["amazon-bedrock", "anthropic"]);
		const failed = failedWith(model("kiro", "claude-haiku-4.5", 200_000), "timeout");
		const routed = ROUTER_THINKING_LEVELS.map((thinkingLevel) =>
			routeRequest(req({ reason: "retry", failed, thinkingLevel }), onlyOpenAI, opts).model.id);
		expect(routed).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol"]);
	});

	it("retries kiro itself when no fallback provider has credentials", () => {
		const kiroSonnet = model("kiro", "claude-sonnet-5.5");
		const none = registry(catalog(), [...DEFAULT_FALLBACK_PROVIDERS]);
		const route = routeRequest(req({ reason: "retry", failed: failedWith(kiroSonnet, "timeout") }), none, opts);
		expect(route.model).toBe(kiroSonnet);
		expect(route.state).toBeUndefined();
	});

	it("a failed fallback moves to the next provider, and past the last one back to kiro", () => {
		const fromBedrock = routeRequest(req({ reason: "retry", failed: failedWith(bedrockSonnet, "ThrottlingException 429") }), reg, opts);
		expect(id(fromBedrock.model)).toBe("anthropic/claude-sonnet-5-5");
		const fromOpenAI = routeRequest(req({ reason: "retry", failed: failedWith(model("openai-codex", "gpt-5.6-terra"), "500") }), reg, opts);
		expect(id(fromOpenAI.model)).toBe("kiro/claude-sonnet-5.5");
	});

	it("retry after a context overflow moves to a larger window, haiku -> a 1M sonnet", () => {
		const haiku = model("kiro", "claude-haiku-4.5", 200_000);
		const route = routeRequest(req({ reason: "retry", thinkingLevel: "low", failed: failedWith(haiku, "prompt is too long: 230000 tokens > 200000 maximum") }), reg, opts);
		expect(id(route.model)).toBe("kiro/claude-sonnet-5.5");
		expect(route.model.contextWindow).toBe(1_000_000);
		expect(route.state).toBeUndefined();
	});

	it("retry after an overflow on a model already at the largest window stays on it", () => {
		const opus = model("kiro", "claude-opus-5.5");
		const route = routeRequest(req({ reason: "retry", thinkingLevel: "high", failed: failedWith(opus, "input is too long for requested model") }), reg, opts);
		expect(route.model).toBe(opus);
	});

	it("retry with no failed request (routing itself failed) routes like a user turn", () => {
		expect(id(routeRequest(req({ reason: "retry" }), reg, opts).model)).toBe("kiro/claude-sonnet-5.5");
	});
});

describe("kiro/router fallback on user turns", () => {
	const reg = registry();

	it("a kiro error left in the transcript (pi did not retry it) sends the next user turn to a fallback", () => {
		const messages = [userMsg("one"), reply("kiro", { stopReason: "error", errorMessage: "quota exceeded: out of credits" }), userMsg("two")];
		const route = routeRequest(req({ messages }), reg, opts);
		expect(id(route.model)).toBe("amazon-bedrock/us.anthropic.claude-sonnet-5");
		expect(route.state).toEqual({ fallbackUntil: NOW + 60_000, fallbackReason: "quota exceeded: out of credits" });
	});

	it("an aborted or successful kiro turn does not trigger a fallback", () => {
		for (const last of [reply("kiro", { stopReason: "aborted" }), reply("kiro")]) {
			const route = routeRequest(req({ messages: [userMsg("one"), last, userMsg("two")] }), reg, opts);
			expect(route.model.provider).toBe("kiro");
		}
	});

	it("a kiro overflow error in the transcript does not trigger a provider fallback", () => {
		const messages = [userMsg("one"), reply("kiro", { stopReason: "error", errorMessage: "prompt is too long" }), userMsg("two")];
		expect(routeRequest(req({ messages }), reg, opts).model.provider).toBe("kiro");
	});

	it("holds the fallback during the cooldown, keeping the provider the session uses", () => {
		const state = { fallbackUntil: NOW + 1 };
		const previous = { model: model("anthropic", "claude-sonnet-5-5") };
		const route = routeRequest(req({ state, previous, messages: [userMsg("one"), reply("anthropic"), userMsg("two")] }), reg, opts);
		expect(id(route.model)).toBe("anthropic/claude-sonnet-5-5");
		expect(route.state).toBeUndefined(); // unchanged state is not re-stored
		const noPrev = routeRequest(req({ state }), reg, opts);
		expect(id(noPrev.model)).toBe("amazon-bedrock/us.anthropic.claude-sonnet-5");
	});

	it("returns to kiro once the cooldown expires, and clears the state", () => {
		const route = routeRequest(req({ state: { fallbackUntil: NOW, fallbackReason: "x" } }), reg, opts);
		expect(route.model.provider).toBe("kiro");
		expect(route.state).toEqual({});
	});

	it("stays on kiro when the transcript's kiro error has no fallback with credentials", () => {
		const none = registry(catalog(), [...DEFAULT_FALLBACK_PROVIDERS]);
		const messages = [userMsg("one"), reply("kiro", { stopReason: "error", errorMessage: "401" }), userMsg("two")];
		const route = routeRequest(req({ messages }), none, opts);
		expect(route.model.provider).toBe("kiro");
		expect(route.state).toBeUndefined();
	});

	it("every route's state survives a JSON round trip", () => {
		const messages = [userMsg("one"), reply("kiro", { stopReason: "error", errorMessage: "boom" }), userMsg("two")];
		const state = routeRequest(req({ messages }), reg, opts).state;
		expect(state).toBeDefined();
		expect(JSON.parse(JSON.stringify(state))).toEqual(state);
	});
});

describe("kiro/router helpers", () => {
	it("isOverflowError matches overflow wording, not throttling", () => {
		expect(isOverflowError("prompt is too long: 1 > 0")).toBe(true);
		expect(isOverflowError("Input is too long for requested model")).toBe(true);
		expect(isOverflowError("This request exceeds the context window")).toBe(true);
		expect(isOverflowError("ThrottlingException: Too many tokens, please wait")).toBe(false);
		expect(isOverflowError("503 service unavailable")).toBe(false);
		expect(isOverflowError(undefined)).toBe(false);
	});

	it("PI_KIRO_ROUTER_FALLBACK overrides the order and can never name kiro", () => {
		expect(fallbackProvidersFromEnv(undefined)).toEqual(DEFAULT_FALLBACK_PROVIDERS);
		expect(fallbackProvidersFromEnv(" ")).toEqual(DEFAULT_FALLBACK_PROVIDERS);
		expect(fallbackProvidersFromEnv("openai-codex, kiro ,anthropic")).toEqual(["openai-codex", "anthropic"]);
	});

	it("PI_KIRO_ROUTER_COOLDOWN_MS parses, and falls back to 15 minutes", () => {
		expect(cooldownMsFromEnv("0")).toBe(0);
		expect(cooldownMsFromEnv("5000")).toBe(5000);
		expect(cooldownMsFromEnv("nope")).toBe(15 * 60 * 1000);
		expect(cooldownMsFromEnv(undefined)).toBe(15 * 60 * 1000);
	});

	it("a custom fallback order is honored", () => {
		const failed = failedWith(model("kiro", "claude-sonnet-5.5"), "503");
		const route = routeRequest(req({ reason: "retry", failed }), registry(), { ...opts, fallbackProviders: ["openai-codex"] });
		expect(id(route.model)).toBe("openai-codex/gpt-5.6-terra");
	});
});
