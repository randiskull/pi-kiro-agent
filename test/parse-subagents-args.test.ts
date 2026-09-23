/**
 * Pure-function coverage for parseSubagentsArgs/parseNameList (L0-01/L0-02),
 * extracted from the /kiro-subagents command handler so this parsing logic
 * is testable without the command runtime. Cases mirror the handler's prior
 * inline behavior exactly — this is a refactor, not a behavior change.
 */

import { describe, expect, it } from "vitest";
import { parseNameList, parseSubagentsArgs } from "../src/index.js";

describe("parseNameList", () => {
	it("splits, trims, and drops empty entries", () => {
		expect(parseNameList("a, b ,, c")).toEqual(["a", "b", "c"]);
	});

	it("returns an empty array for an empty string", () => {
		expect(parseNameList("")).toEqual([]);
	});
});

describe("parseSubagentsArgs", () => {
	it("off with no names", () => {
		expect(parseSubagentsArgs("off")).toEqual({ mode: "off", only: undefined });
	});

	it("off with a name list", () => {
		expect(parseSubagentsArgs("off foo, bar")).toEqual({ mode: "off", only: ["foo", "bar"] });
	});

	it("on with no model or names — defaults the model", () => {
		expect(parseSubagentsArgs("on")).toEqual({ mode: "on", model: "kiro/auto", only: undefined });
	});

	it("on with an explicit provider/model", () => {
		expect(parseSubagentsArgs("on kiro/claude-4")).toEqual({
			mode: "on",
			model: "kiro/claude-4",
			only: undefined,
		});
	});

	it("on with an explicit model and a name list", () => {
		expect(parseSubagentsArgs("on kiro/claude-4 foo,bar")).toEqual({
			mode: "on",
			model: "kiro/claude-4",
			only: ["foo", "bar"],
		});
	});

	it("on with names but no explicit model — the first token isn't shifted out", () => {
		// rest[0] is "foo,bar" here, has no "/", so it's NOT treated as a model —
		// the default model is used and "foo,bar" is parsed as the name list.
		expect(parseSubagentsArgs("on foo,bar")).toEqual({
			mode: "on",
			model: "kiro/auto",
			only: ["foo", "bar"],
		});
	});

	it("invalid for anything else", () => {
		expect(parseSubagentsArgs("bogus")).toEqual({ mode: "invalid" });
		expect(parseSubagentsArgs("")).toEqual({ mode: "invalid" });
	});
});
