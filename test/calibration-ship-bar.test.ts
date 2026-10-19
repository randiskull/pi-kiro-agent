/**
 * The ship bar makes claims about the calibration set that are only true while
 * the set is shaped a certain way. Prose cannot hold those; the key's own data
 * can, so every assertion here is derived from `expected.json` rather than from
 * the sentence it guards.
 *
 * The defect this exists for was live twice in one day: the case counts in the
 * spec and the key said six cases and 30 gate decisions while the set had eight,
 * and nothing failed. A count written by hand drifts from the set it describes
 * the moment a case is added.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const key = JSON.parse(readFileSync(join(root, "spec-review", "calibration", "expected.json"), "utf8")) as {
	cases: Record<
		string,
		{ review: { gates: Record<string, string>; dimensions?: Record<string, string>; mustQuoteOneOf?: string[] } }
	>;
	shipBar: Record<string, string | string[]>;
};
const quotes = Object.entries(key.cases).flatMap(([name, c]) =>
	(c.review.mustQuoteOneOf ?? []).map((text) => ({ name, text })),
);
const GATES = ["G1", "G2", "G3", "G4", "G5"];

describe("the ship bar describes the set it is keyed to", () => {
	// shipBar.agreement states the decision count in words. Derive it: a case
	// added without touching that sentence has to fail here, not pass quietly.
	it("states the gate-decision count the set actually has", () => {
		const n = Object.keys(key.cases).length;
		expect(key.shipBar.agreement).toContain(`${n} cases x ${GATES.length} gates = ${n * GATES.length} decisions`);
	});

	// shipBar.featureColumn says the bar is not met unless both runs separate c7
	// from c8 on D1. That sentence rests on the two cases carrying opposing D1
	// expectations, which is the part worth holding: without it the rule asks for
	// a separation the key does not define.
	it("keeps c7 and c8 opposed on D1, which is what the featureColumn rule asks a run to find", () => {
		const floor = key.cases.c7?.review.dimensions?.D1;
		const ceiling = key.cases.c8?.review.dimensions?.D1;
		const lo = /^>=([1-4])$/.exec(floor ?? "");
		const hi = /^<=([1-4])$/.exec(ceiling ?? "");
		expect(lo, `c7 D1 must be a floor, got ${floor}`).not.toBeNull();
		expect(hi, `c8 D1 must be a ceiling, got ${ceiling}`).not.toBeNull();
		expect(Number(lo?.[1]), "c7's floor must sit above c8's ceiling or the pair does not separate").toBeGreaterThan(
			Number(hi?.[1]),
		);
	});

	// The rule exists and names what it governs. This is the weaker half on
	// purpose: the assertion above is what fails when the data drifts.
	it("carries a featureColumn rule naming the pair and the dimension", () => {
		const rule = key.shipBar.featureColumn;
		expect(rule, "shipBar.featureColumn is missing").toBeTruthy();
		for (const token of ["c7", "c8", "D1"]) expect(rule).toContain(token);
	});

	// The reason featureColumn is a rule at all. If a later edit gives the pair a
	// failing gate, the rule's stated justification stops being true and should be
	// rewritten rather than left standing on a dead argument.
	it("holds that the feature pair contributes no failing gate label, which is why gate agreement cannot stand for it", () => {
		const fails = (name: string) => GATES.filter((g) => key.cases[name]?.review.gates[g] === "fail").length;
		expect(fails("c7") + fails("c8")).toBe(0);
		expect(key.shipBar.featureColumn).toContain("no fail");
	});

	// shipBar.quoteMatching: score.mjs matches a mustQuoteOneOf string as a plain
	// substring of a finding's line, so a string ending in the sentence's own full
	// stop asks a reviewer for a character it has no reason to carry. Rubric 2's
	// pair paid for that: a finding on the right sentence, with the right tag and
	// the right score, missed on one period. The count guard is the point of the
	// test - an empty `quotes` would pass the loop below having checked nothing.
	it("keeps every mustQuoteOneOf string free of terminal punctuation", () => {
		expect(quotes.length, "no mustQuoteOneOf strings found; the extractor is broken, not the key clean").toBeGreaterThan(0);
		const bad = quotes.filter((q) => /[.,;]$/.test(q.text)).map((q) => `${q.name}: ${JSON.stringify(q.text)}`);
		expect(bad, "a terminal . , or ; makes the substring match fail on a verbatim quote").toEqual([]);
		expect(key.shipBar.quoteMatching, "shipBar.quoteMatching is missing").toBeTruthy();
	});

	// And the strings have to be findable in the case, or the rule above would be
	// satisfied by trimming them into something no reviewer could quote. This is
	// what makes the punctuation test safe rather than merely green.
	it("asks only for text the case actually contains", () => {
		expect(quotes.length).toBeGreaterThan(0);
		const missing = quotes.filter((q) => {
			const file = join(root, "spec-review", "calibration", "cases", `${q.name}.md`);
			return !readFileSync(file, "utf8").includes(q.text);
		});
		expect(missing.map((q) => `${q.name}: ${JSON.stringify(q.text)}`)).toEqual([]);
	});

	// Every case the key scores has a label for every gate; a missing one would be
	// read as undefined and compared against a run's answer.
	it("labels every gate of every case", () => {
		for (const [name, c] of Object.entries(key.cases)) {
			for (const g of GATES) {
				expect(["pass", "fail"], `${name} ${g}`).toContain(c.review.gates[g]);
			}
		}
	});
});
