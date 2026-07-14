/**
 * Model catalog for the kiro provider — fetched live from
 * `kiro-cli chat --list-models --format json` at registration time, because
 * the visible set is entitlement-dependent (many seats expose only "auto",
 * Kiro's internal router). Costs are zero: usage is billed to the user's
 * Kiro seat/credits by the CLI itself.
 */

import { execFile } from "node:child_process";

export const KIRO_PROVIDER = "kiro";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const LIST_TIMEOUT_MS = 15_000;

export interface KiroModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: typeof ZERO_COST;
	contextWindow: number;
	maxTokens: number;
}

export function kiroModel(id: string, contextWindow = 200_000): KiroModelConfig {
	return {
		id,
		name: `${id} [kiro]`,
		// reasoning=true lets Pi thinking levels flow through to --effort
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow,
		maxTokens: 32_000,
	};
}

export const FALLBACK_MODELS: KiroModelConfig[] = [kiroModel("auto")];

export async function fetchKiroModels(binaryPath: string): Promise<KiroModelConfig[]> {
	const stdout = await new Promise<string>((resolve) => {
		execFile(
			binaryPath,
			["chat", "--list-models", "--format", "json", "--no-interactive"],
			{ timeout: LIST_TIMEOUT_MS, encoding: "utf8" },
			(_error, out) => resolve(out ?? ""),
		);
	});
	try {
		const parsed = JSON.parse(stdout.trim()) as {
			models?: Array<{ model_id?: string; context_window_tokens?: number }>;
		};
		const models = (parsed.models ?? [])
			.filter((model) => typeof model.model_id === "string" && model.model_id.length > 0)
			.map((model) => kiroModel(model.model_id as string, model.context_window_tokens ?? 200_000));
		return models.length > 0 ? models : FALLBACK_MODELS;
	} catch {
		return FALLBACK_MODELS;
	}
}

/** Default model for rpiv-pi's bundled specialist subagents. */
export const DEFAULT_SUBAGENT_MODEL = `${KIRO_PROVIDER}/auto`;
