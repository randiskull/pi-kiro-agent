/**
 * Credit metering.
 *
 * Kiro bills in credits, and the credit figure the CLI reports is the only
 * authoritative per-turn price available: no transport reports token counts, so
 * Pi cannot derive a cost from a price list the way it does for token-billed
 * providers. All three transports carry the same payload shape and this module
 * is the single place that interprets it.
 *
 * - ACP (`_kiro.dev/metadata`) and chat stream-json (`metadata`) both deliver
 *   `meteringUsage: [{value, unit, unitPlural}]` plus `contextUsagePercentage`
 *   and `turnDurationMs`, exactly once per turn, on the final notification. The
 *   array holds one entry per internal model call, so a turn that used tools
 *   reports several entries that must be summed (wire-probed 2026-10-16:
 *   a three-tool turn reported three entries and one notification).
 * - The chat text fallback has no structured channel; credits come from the
 *   rendered footer ` ▸ Credits: N.NN`, which is quantised to two decimals and
 *   reads 0.00 for any turn under half a cent of credit. That path is marked
 *   `rendered-2dp` so a consumer can tell a real 0 from a rounded one.
 *
 * Nothing here converts a credit into money silently: `creditUsdRate` reads
 * PI_KIRO_CREDIT_USD and falls back to Kiro's published plan ratio, and every
 * rendered dollar figure is marked approximate.
 */

import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";

/** The only unit any probed payload has used. Anything else is reported separately. */
export const CREDIT_UNIT = "credit";

/**
 * USD per credit, used when PI_KIRO_CREDIT_USD is unset.
 *
 * Kiro's published plans all price a credit identically: Pro is $20/month for
 * 1,000 credits, Pro+ $40 for 2,000, Power $200 for 10,000
 * (https://kiro.dev/pricing/). That ratio is $0.02, so it is the honest default
 * for an in-plan turn. On-demand and overage pricing differ, and a seat whose
 * subscription is already sunk may prefer 0; set PI_KIRO_CREDIT_USD explicitly
 * in either case. Displayed dollars are always marked approximate.
 */
export const DEFAULT_CREDIT_USD = 0.02;

/** Which transport produced a figure, and therefore how much to trust it. */
export type MeteringSource = "acp" | "chat-stream-json" | "chat-text";

export type MeteringPrecision = "exact" | "rendered-2dp";

/** One `meteringUsage` entry as it arrives on the wire. */
export interface MeteringEntry {
	value?: number;
	unit?: string;
	unitPlural?: string;
}

export interface CreditSum {
	/** Summed value of every `credit`-unit entry. Undefined when none were present. */
	credits: number | undefined;
	/** Server-provided plural, when it offered one, for display. */
	unitPlural?: string;
	/** Values carried under some other unit, summed per unit, never folded into credits. */
	otherUnits?: Record<string, number>;
}

export interface TurnMetering {
	credits: number | undefined;
	source: MeteringSource;
	precision: MeteringPrecision;
	contextPercent?: number;
	turnDurationMs?: number;
	unitPlural?: string;
	otherUnits?: Record<string, number>;
}

export interface MeteringTotals {
	credits: number;
	turns: number;
	lastCredits: number | undefined;
	lastContextPercent: number | undefined;
	unitPlural: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sum the `credit`-unit entries of a `meteringUsage` array.
 *
 * The unit is checked rather than assumed: an unrecognised unit is accumulated
 * under `otherUnits` instead of being added to a credit total it does not
 * belong to. Returns `credits: undefined` (not 0) when the array carried no
 * credit entry at all, so "no figure" stays distinguishable from "free turn".
 */
export function sumCredits(raw: unknown): CreditSum {
	if (!Array.isArray(raw)) return { credits: undefined };
	let credits: number | undefined;
	let unitPlural: string | undefined;
	let otherUnits: Record<string, number> | undefined;
	for (const entry of raw as MeteringEntry[]) {
		if (!isRecord(entry) || typeof entry.value !== "number" || !Number.isFinite(entry.value)) continue;
		const unit = typeof entry.unit === "string" ? entry.unit : CREDIT_UNIT;
		if (unit === CREDIT_UNIT) {
			credits = (credits ?? 0) + entry.value;
			if (!unitPlural && typeof entry.unitPlural === "string" && entry.unitPlural) {
				unitPlural = entry.unitPlural;
			}
			continue;
		}
		otherUnits ??= {};
		otherUnits[unit] = (otherUnits[unit] ?? 0) + entry.value;
	}
	return { credits, ...(unitPlural ? { unitPlural } : {}), ...(otherUnits ? { otherUnits } : {}) };
}

/**
 * USD per credit from PI_KIRO_CREDIT_USD, else DEFAULT_CREDIT_USD.
 *
 * An explicit 0 is honoured (it means "do not show money"). A malformed or
 * negative value falls back to the default rather than poisoning the total with
 * NaN, which is what the previous inline `Number.parseFloat(... ?? "0")` did
 * when the variable held something unparseable.
 */
export function creditUsdRate(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_KIRO_CREDIT_USD;
	if (raw === undefined || raw.trim() === "") return DEFAULT_CREDIT_USD;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CREDIT_USD;
	return parsed;
}

/** Projected USD for a credit figure. Returns 0 for an absent figure. */
export function creditCostUsd(credits: number | undefined, rate: number = creditUsdRate()): number {
	if (credits === undefined || !Number.isFinite(credits)) return 0;
	return credits * rate;
}

export function createMeteringTotals(): MeteringTotals {
	return { credits: 0, turns: 0, lastCredits: undefined, lastContextPercent: undefined, unitPlural: "credits" };
}

/** Fold one turn into a session total. A turn with no credit figure still counts as a turn. */
export function addTurnToTotals(totals: MeteringTotals, turn: TurnMetering): void {
	totals.turns += 1;
	totals.lastCredits = turn.credits;
	if (turn.contextPercent !== undefined) totals.lastContextPercent = turn.contextPercent;
	if (turn.unitPlural) totals.unitPlural = turn.unitPlural;
	if (turn.credits !== undefined) totals.credits += turn.credits;
}

function formatCredits(credits: number): string {
	if (credits >= 100) return credits.toFixed(0);
	if (credits >= 1) return credits.toFixed(2);
	// Sub-credit turns are the common case; three places keeps them legible
	// without implying the 17 significant digits the wire actually sends.
	return credits.toFixed(3);
}

function formatUsd(usd: number): string {
	if (usd <= 0) return "$0.00";
	if (usd < 0.01) return "<$0.01";
	return "$" + usd.toFixed(2);
}

/**
 * The footer/status string: session credits, the projected dollars, and the
 * last turn. Dollars are omitted when the rate is 0, because a zero is less
 * informative than no figure at all. Returns undefined before any turn has
 * reported a credit figure, so the status key stays clear rather than showing
 * a misleading 0.
 */
export function formatMeteringStatus(
	totals: MeteringTotals,
	rate: number = creditUsdRate(),
): string | undefined {
	if (totals.credits <= 0 && totals.lastCredits === undefined) return undefined;
	const parts = ["\u25b8 " + formatCredits(totals.credits) + " " + totals.unitPlural];
	if (rate > 0) parts.push("~" + formatUsd(creditCostUsd(totals.credits, rate)));
	if (totals.lastCredits !== undefined && totals.turns > 1) {
		parts.push("(last " + formatCredits(totals.lastCredits) + ")");
	}
	return parts.join(" ");
}

/** The per-turn record attached to the assistant message. */
export function meteringDiagnostic(turn: TurnMetering): AssistantMessageDiagnostic {
	return {
		type: "kiro.metering",
		timestamp: Date.now(),
		details: {
			...(turn.credits !== undefined ? { credits: turn.credits } : {}),
			unit: CREDIT_UNIT,
			source: turn.source,
			precision: turn.precision,
			...(turn.contextPercent !== undefined ? { contextPercent: turn.contextPercent } : {}),
			...(turn.turnDurationMs !== undefined ? { turnDurationMs: turn.turnDurationMs } : {}),
			...(turn.otherUnits ? { otherUnits: turn.otherUnits } : {}),
		},
	};
}

/** Read a `kiro.metering` record back off an assistant message. */
export function readMeteringDiagnostic(
	diagnostics: readonly AssistantMessageDiagnostic[] | undefined,
): TurnMetering | undefined {
	const found = diagnostics?.find((d) => d.type === "kiro.metering");
	if (!found) return undefined;
	const d = found.details;
	if (!isRecord(d)) return undefined;
	const credits = typeof d.credits === "number" ? d.credits : undefined;
	return {
		credits,
		source: (typeof d.source === "string" ? d.source : "acp") as MeteringSource,
		precision: (typeof d.precision === "string" ? d.precision : "exact") as MeteringPrecision,
		...(typeof d.contextPercent === "number" ? { contextPercent: d.contextPercent } : {}),
		...(typeof d.turnDurationMs === "number" ? { turnDurationMs: d.turnDurationMs } : {}),
	};
}
