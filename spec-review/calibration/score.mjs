#!/usr/bin/env node
/**
 * Interim calibration scorer: scores run directories against expected.json and,
 * given more than one run, reports every gate decision on which they disagree.
 * `scripts/spec-review.mjs score` (docs/specs/spec-review-bus.md, Approach 4)
 * replaces it; until then this is what SCORE.md files are produced by, so a score
 * can be reproduced from the committed verdicts.
 *
 *   node spec-review/calibration/score.mjs <run-dir> [<run-dir>...]
 *
 * Per case: the outcome, every gate label, every dimension threshold ("1", "<=2",
 * ">=3"), and mustQuoteOneOf (some finding's line contains one of the strings).
 * Exit 0 only when every case meets every expectation in every run and, with two
 * or more runs, all gate decisions agree.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"));
const GATES = ["G1", "G2", "G3", "G4", "G5"];
const DIMS = ["D1", "D2", "D3", "D4", "D5", "D6"];

function parseVerdict(text) {
	const outcome = /^Outcome:\s*(\w+)\s*$/m.exec(text)?.[1] ?? null;
	const gates = Object.fromEntries(GATES.map((g) => [g, new RegExp(`^- ${g} (pass|fail)\\s*$`, "m").exec(text)?.[1] ?? null]));
	const dims = Object.fromEntries(DIMS.map((d) => [d, Number(new RegExp(`^- ${d} ([1-4])\\s*$`, "m").exec(text)?.[1] ?? Number.NaN)]));
	const findings = text.slice(text.indexOf("## Findings")).split("\n").filter((l) => /^- \[[GD]\d\]/.test(l));
	return { outcome, gates, dims, findings };
}

function meets(score, want) {
	const m = /^(<=|>=)?([1-4])$/.exec(want);
	if (!m || Number.isNaN(score)) return false;
	const n = Number(m[2]);
	return m[1] === "<=" ? score <= n : m[1] === ">=" ? score >= n : score === n;
}

function scoreRun(dir) {
	const lines = [];
	const decisions = {};
	let missed = 0;
	for (const [name, c] of Object.entries(expected.cases)) {
		const v = parseVerdict(readFileSync(join(dir, `${name}.verdict.md`), "utf8"));
		const want = c.review;
		const misses = [];
		if (v.outcome !== want.outcome) misses.push(`outcome ${v.outcome} (want ${want.outcome})`);
		for (const g of GATES) {
			decisions[`${name} ${g}`] = v.gates[g];
			if (v.gates[g] !== want.gates[g]) misses.push(`${g} ${v.gates[g]} (want ${want.gates[g]})`);
		}
		for (const [d, threshold] of Object.entries(want.dimensions ?? {})) {
			if (!meets(v.dims[d], threshold)) misses.push(`${d} ${v.dims[d]} (want ${threshold})`);
		}
		if (want.mustQuoteOneOf && !v.findings.some((f) => want.mustQuoteOneOf.some((q) => f.includes(q)))) {
			misses.push("no finding quotes any mustQuoteOneOf string");
		}
		if (misses.length) missed += 1;
		const gates = GATES.map((g) => (v.gates[g] === "pass" ? "P" : v.gates[g] === "fail" ? "F" : "?")).join("");
		const dims = DIMS.map((d) => `${d}${Number.isNaN(v.dims[d]) ? "?" : v.dims[d]}`).join(" ");
		lines.push(`  ${name}: ${(v.outcome ?? "?").padEnd(7)} gates ${gates} ${dims}  ${misses.length ? `MISS: ${misses.join("; ")}` : "OK"}`);
	}
	return { lines, decisions, missed };
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
	console.error("usage: score.mjs <run-dir> [<run-dir>...]");
	process.exit(2);
}
const runs = dirs.map((d) => ({ dir: d, ...scoreRun(d) }));
for (const r of runs) console.log(`=== ${basename(r.dir)}\n${r.lines.join("\n")}`);
let disagreements = [];
if (runs.length > 1) {
	const keys = Object.keys(runs[0].decisions);
	disagreements = keys.filter((k) => new Set(runs.map((r) => r.decisions[k])).size > 1);
	console.log(`gate agreement: ${keys.length - disagreements.length}/${keys.length}${disagreements.length ? `  (disagree: ${disagreements.join(", ")})` : ""}`);
}
const missed = runs.reduce((n, r) => n + r.missed, 0);
console.log(`cases with a miss: ${missed}`);
process.exit(missed === 0 && disagreements.length === 0 ? 0 : 1);
