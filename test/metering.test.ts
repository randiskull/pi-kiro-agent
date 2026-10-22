import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addTurnToTotals,
	createMeteringTotals,
	CREDIT_UNIT,
	creditCostUsd,
	creditUsdRate,
	DEFAULT_CREDIT_USD,
	formatMeteringStatus,
	meteringDiagnostic,
	readMeteringDiagnostic,
	sumCredits,
	type TurnMetering,
} from "../src/metering.js";

const turn = (over: Partial<TurnMetering> = {}): TurnMetering => ({
	credits: 0.5,
	source: "acp",
	precision: "exact",
	...over,
});

afterEach(() => {
	delete process.env.PI_KIRO_CREDIT_USD;
});

describe("sumCredits", () => {
	// Wire-probed shape: one entry per internal model call, all unit "credit".
	it("sums every credit-unit entry of one notification", () => {
		const result = sumCredits([
			{ value: 0.7422902506135989, unit: "credit", unitPlural: "credits" },
			{ value: 0.4813684293200663, unit: "credit", unitPlural: "credits" },
			{ value: 0.41016790587064683, unit: "credit", unitPlural: "credits" },
		]);
		expect(result.credits).toBeCloseTo(1.6338265858043122, 12);
		expect(result.unitPlural).toBe("credits");
		expect(result.otherUnits).toBeUndefined();
	});

	// The reason the unit is checked rather than assumed: a future non-credit
	// line item must not be added to a credit total it does not belong to.
	it("keeps a non-credit unit out of the credit total", () => {
		const result = sumCredits([
			{ value: 0.25, unit: "credit" },
			{ value: 900, unit: "token" },
		]);
		expect(result.credits).toBe(0.25);
		expect(result.otherUnits).toEqual({ token: 900 });
	});

	it("sums repeats of the same foreign unit separately", () => {
		const result = sumCredits([
			{ value: 1, unit: "widget" },
			{ value: 2, unit: "widget" },
		]);
		expect(result.credits).toBeUndefined();
		expect(result.otherUnits).toEqual({ widget: 3 });
	});

	// "No figure" must stay distinguishable from "free turn", because the chat
	// text path legitimately renders 0.00 for a real but tiny cost.
	it("returns undefined, not 0, when no credit entry is present", () => {
		expect(sumCredits([]).credits).toBeUndefined();
		expect(sumCredits(undefined).credits).toBeUndefined();
		expect(sumCredits("nonsense").credits).toBeUndefined();
		expect(sumCredits([{ unit: "credit" }]).credits).toBeUndefined();
	});

	it("reports a real zero as 0", () => {
		expect(sumCredits([{ value: 0, unit: "credit" }]).credits).toBe(0);
	});

	it("skips malformed entries without poisoning the total", () => {
		const result = sumCredits([
			{ value: 0.5, unit: CREDIT_UNIT },
			{ value: Number.NaN, unit: CREDIT_UNIT },
			{ value: "0.5" as unknown as number, unit: CREDIT_UNIT },
			null,
			42,
		]);
		expect(result.credits).toBe(0.5);
	});

	it("treats a missing unit as credits, matching the pre-unitPlural wire", () => {
		expect(sumCredits([{ value: 0.3 }]).credits).toBe(0.3);
	});
});

describe("creditUsdRate", () => {
	it("falls back to the published plan ratio when unset or blank", () => {
		expect(creditUsdRate({})).toBe(DEFAULT_CREDIT_USD);
		expect(creditUsdRate({ PI_KIRO_CREDIT_USD: "" })).toBe(DEFAULT_CREDIT_USD);
		expect(creditUsdRate({ PI_KIRO_CREDIT_USD: "   " })).toBe(DEFAULT_CREDIT_USD);
	});

	it("pins the default to Kiro's published plans: $20 per 1,000 credits", () => {
		expect(DEFAULT_CREDIT_USD).toBe(20 / 1000);
		expect(DEFAULT_CREDIT_USD).toBe(40 / 2000);
		expect(DEFAULT_CREDIT_USD).toBe(200 / 10000);
	});

	it("honours an explicit zero as 'do not show money'", () => {
		expect(creditUsdRate({ PI_KIRO_CREDIT_USD: "0" })).toBe(0);
	});

	it("uses an explicit rate", () => {
		expect(creditUsdRate({ PI_KIRO_CREDIT_USD: "0.04" })).toBe(0.04);
	});

	// The old inline `Number.parseFloat(env ?? "0")` produced NaN here and then
	// silently wrote NaN into the session cost total.
	it("falls back rather than returning NaN or a negative rate", () => {
		expect(creditUsdRate({ PI_KIRO_CREDIT_USD: "free" })).toBe(DEFAULT_CREDIT_USD);
		expect(creditUsdRate({ PI_KIRO_CREDIT_USD: "-1" })).toBe(DEFAULT_CREDIT_USD);
	});
});

describe("creditCostUsd", () => {
	it("projects credits at the given rate", () => {
		expect(creditCostUsd(2, 0.02)).toBeCloseTo(0.04, 10);
	});

	it("is 0 for an absent or non-finite figure", () => {
		expect(creditCostUsd(undefined, 0.02)).toBe(0);
		expect(creditCostUsd(Number.NaN, 0.02)).toBe(0);
	});

	it("reads the environment when no rate is passed", () => {
		process.env.PI_KIRO_CREDIT_USD = "0.5";
		expect(creditCostUsd(2)).toBeCloseTo(1, 10);
	});
});

describe("formatMeteringStatus", () => {
	it("stays undefined until a turn reports a figure, so the slot shows nothing", () => {
		expect(formatMeteringStatus(createMeteringTotals(), 0.02)).toBeUndefined();
	});

	it("shows the session credits and the projected dollars", () => {
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ credits: 1.5 }));
		const status = formatMeteringStatus(totals, 0.02);
		expect(status).toContain("1.50 credits");
		expect(status).toContain("~$0.03");
	});

	it("omits dollars when the rate is 0", () => {
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ credits: 1.5 }));
		const status = formatMeteringStatus(totals, 0);
		expect(status).toContain("1.50 credits");
		expect(status).not.toContain("$");
	});

	it("marks a sub-cent projection rather than rounding it to zero", () => {
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ credits: 0.1 }));
		expect(formatMeteringStatus(totals, 0.02)).toContain("<$0.01");
	});

	it("adds the last turn only once there is more than one turn to compare", () => {
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ credits: 1 }));
		expect(formatMeteringStatus(totals, 0.02)).not.toContain("last");
		addTurnToTotals(totals, turn({ credits: 0.25 }));
		const status = formatMeteringStatus(totals, 0.02);
		expect(status).toContain("1.25 credits");
		expect(status).toContain("(last 0.250)");
	});

	it("shows the last turn's context usage when kiro reported one", () => {
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ credits: 1.5 }));
		expect(formatMeteringStatus(totals, 0.02)).not.toContain("ctx");
		addTurnToTotals(totals, turn({ credits: 0.25, contextPercent: 3.7405 }));
		expect(formatMeteringStatus(totals, 0.02)).toBe("\u25b8 1.75 credits ~$0.04 (last 0.250) ctx 3.7%");
	});

	it("uses the server-provided plural", () => {
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ credits: 2, unitPlural: "Credits" }));
		expect(formatMeteringStatus(totals, 0.02)).toContain("2.00 Credits");
	});

	it("counts a figure-less turn as a turn without disturbing the total", () => {
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ credits: 1 }));
		addTurnToTotals(totals, turn({ credits: undefined }));
		expect(totals.turns).toBe(2);
		expect(totals.credits).toBe(1);
		expect(formatMeteringStatus(totals, 0.02)).toContain("1.00 credits");
	});

	// The figure is a share of one model's window. Carried past a turn that did
	// not report one (the chat text path, a model switch), the footer would show
	// it beside credits it has nothing to do with.
	it("tracks the last turn's context percentage, and drops it when a turn reports none", () => {
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ contextPercent: 6.05 }));
		addTurnToTotals(totals, turn({ contextPercent: 10.2 }));
		expect(totals.lastContextPercent).toBe(10.2);
		addTurnToTotals(totals, turn({ contextPercent: undefined }));
		expect(totals.lastContextPercent).toBeUndefined();
		expect(formatMeteringStatus(totals, 0.02)).not.toContain("ctx");
	});

	it("prints exactly the two status examples the README documents", () => {
		// Wire-probed 2026-10-16: one three-tool ACP turn carried these three
		// meteringUsage entries, and a following turn carried the last one again.
		const probed = [0.7422902506135989, 0.4813684293200663, 0.41016790587064683];
		const totals = createMeteringTotals();
		addTurnToTotals(totals, turn({ credits: probed.reduce((a, b) => a + b, 0) }));
		const first = formatMeteringStatus(totals, DEFAULT_CREDIT_USD);
		// 3.7405% is what a lean-agent ACP turn on Haiku 4.5 reported, live, 2026-10-19.
		addTurnToTotals(totals, turn({ credits: probed[2], contextPercent: 3.7405 }));
		const second = formatMeteringStatus(totals, DEFAULT_CREDIT_USD);
		expect(first).toBe("\u25b8 1.63 credits ~$0.03");
		// The README quotes what the formatter prints, not a plausible-looking string:
		// derive the documented examples from the file rather than restating them here.
		const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
		const quoted = [...readme.matchAll(/`(\u25b8 [^`]+)`/g)].map((m) => m[1]);
		expect(quoted).toEqual([first, second]);
	});
});

describe("meteringDiagnostic round-trip", () => {
	it("carries every field a transport measured", () => {
		const source = turn({
			credits: 1.6338265858043122,
			contextPercent: 10.20009994506836,
			turnDurationMs: 9593,
		});
		const diagnostic = meteringDiagnostic(source);
		expect(diagnostic.type).toBe("kiro.metering");
		const read = readMeteringDiagnostic([diagnostic]);
		expect(read?.credits).toBe(source.credits);
		expect(read?.contextPercent).toBe(source.contextPercent);
		expect(read?.turnDurationMs).toBe(source.turnDurationMs);
		expect(read?.source).toBe("acp");
		expect(read?.precision).toBe("exact");
	});

	it("omits absent fields instead of emitting zeros", () => {
		const details = meteringDiagnostic(turn({ credits: undefined })).details ?? {};
		expect("credits" in details).toBe(false);
		expect("contextPercent" in details).toBe(false);
		expect("turnDurationMs" in details).toBe(false);
	});

	it("records the rendered-2dp precision of the chat text path", () => {
		const diagnostic = meteringDiagnostic(turn({ source: "chat-text", precision: "rendered-2dp" }));
		expect(readMeteringDiagnostic([diagnostic])?.precision).toBe("rendered-2dp");
	});

	it("preserves a foreign unit for inspection", () => {
		const details = meteringDiagnostic(turn({ otherUnits: { token: 900 } })).details ?? {};
		expect(details.otherUnits).toEqual({ token: 900 });
	});

	it("ignores unrelated diagnostics and a missing list", () => {
		expect(readMeteringDiagnostic(undefined)).toBeUndefined();
		expect(readMeteringDiagnostic([{ type: "other", timestamp: 1 }])).toBeUndefined();
	});
});
