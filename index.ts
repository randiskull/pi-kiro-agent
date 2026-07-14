/**
 * pi-kiro — Pi provider for the local Kiro CLI.
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
 *   /kiro-subagents  — on [model] [names,...] | off: route pi-subagents
 *                      agent profiles through kiro
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureBridgeTools, type HttpBridgeHandle, serveBridgeHttp } from "./bridge.js";
import { bridgeEnabled } from "./kiro-bridge.js";
import { DEFAULT_SUBAGENT_MODEL, FALLBACK_MODELS, fetchKiroModels, KIRO_PROVIDER } from "./models.js";
import { checkKiroReadiness, clearKiroReadinessCache } from "./readiness.js";
import { makeStreamViaKiro } from "./stream-adapter.js";
import { wireSubagents } from "./subagent-wiring.js";

// Latest ExtensionContext, captured per turn for bridged tool execution.
// Last-writer-wins under parallel turns in concurrent sessions.
let latestCtx: ExtensionContext | undefined;

const deps: {
	binaryPath: string | undefined;
	getBridge?: (signal: AbortSignal) => Promise<HttpBridgeHandle | undefined>;
} = { binaryPath: undefined };
let registered = false;

async function ensureRegistered(pi: ExtensionAPI, force = false): Promise<string> {
	if (force) clearKiroReadinessCache();
	const readiness = await checkKiroReadiness(force);
	deps.binaryPath = readiness.binaryPath;
	if (!readiness.ready) {
		return `kiro provider NOT registered: ${readiness.detail}`;
	}
	if (!registered) {
		const models = readiness.binaryPath
			? await fetchKiroModels(readiness.binaryPath)
			: FALLBACK_MODELS;
		pi.registerProvider(KIRO_PROVIDER, {
			name: "Kiro CLI (local runtime)",
			baseUrl: "local://kiro-cli",
			// Never used for requests — streamSimple owns transport.
			apiKey: "kiro-local",
			api: "anthropic-messages",
			models,
			streamSimple: makeStreamViaKiro(deps),
		});
		registered = true;
	}
	return `kiro provider registered (${readiness.detail}). Select with /model ${KIRO_PROVIDER}/<id>.`;
}

export default async function piKiro(pi: ExtensionAPI): Promise<void> {
	pi.on("context", (_event, ctx) => {
		latestCtx = ctx;
	});
	pi.on("before_provider_request", (_event, ctx) => {
		latestCtx = ctx;
	});

	deps.getBridge = async (signal) => {
		if (!bridgeEnabled()) return undefined;
		const tools = await captureBridgeTools(pi, process.env.PI_KIRO_BRIDGE_TOOLS);
		return serveBridgeHttp(tools, () => latestCtx, signal);
	};

	pi.registerCommand("kiro", {
		description: "Show Kiro delegation status and (re)register the provider",
		handler: async (_args, ctx) => {
			const summary = await ensureRegistered(pi, true);
			ctx.ui.notify(summary, registered ? "info" : "error");
		},
	});

	pi.registerCommand("kiro-subagents", {
		description: "Route pi-subagents agents through kiro: on [provider/model] [names,...] | off",
		getArgumentCompletions: (prefix) =>
			["on", `on ${DEFAULT_SUBAGENT_MODEL}`, "off"]
				.filter((item) => item.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "off") {
				const result = wireSubagents(undefined);
				ctx.ui.notify(
					`Removed kiro routing from ${result.changed.length} agent(s) (${result.skipped.length} untouched).`,
					"info",
				);
				return;
			}
			if (trimmed === "on" || trimmed.startsWith("on ")) {
				const rest = trimmed === "on" ? [] : trimmed.slice(3).trim().split(/\s+/);
				const model = rest[0]?.includes("/") ? rest.shift() : DEFAULT_SUBAGENT_MODEL;
				const only = rest.length > 0 ? rest.join(" ").split(",").map((name) => name.trim()) : undefined;
				if (!model || !model.startsWith(`${KIRO_PROVIDER}/`)) {
					ctx.ui.notify(`Model must be ${KIRO_PROVIDER}/<id> (got "${model}").`, "error");
					return;
				}
				const registration = await ensureRegistered(pi);
				const result = wireSubagents(model, only);
				ctx.ui.notify(
					`${result.changed.length} agent(s) now use ${model}; ${result.skipped.length} already set or missing. ${registration}`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /kiro-subagents on [provider/model] [names,...] | off", "error");
		},
	});

	// Best-effort registration at load; /kiro retries interactively.
	await ensureRegistered(pi);
}
