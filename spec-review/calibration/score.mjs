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
 *
 * Per run, before any case is scored: the blobs its RUN.json records. shipBar.blobs
 * ties a run to the rubric, the answer key and the cases by blob sha and counts it
 * "only when both match the committed blobs", and shipBar rule 5 is what makes a
 * stale run visible instead of plausible. A run counts only when it records a blob
 * for the rubric, the key and every case in expected.json, every one of those blobs
 * matches the file as it stands here, and its own countsTowardsShipBar says true.
 * A run that records countsTowardsShipBar: true over blobs that do not match is a
 * contradiction and is called out as one: that is the shape this check exists for.
 *
 * Exit 0 only when every run counts, every case meets every expectation in every
 * run and, with two or more runs, all gate decisions agree. Criterion 12 of
 * docs/specs/spec-review-bus.md is this exit code, so a stale or self-declared
 * non-counting run cannot produce it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

/** The sha git would store for this file's current bytes, or null if it is gone. */
function blobSha(path) {
	if (!existsSync(path)) return null;
	const body = readFileSync(path);
	return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

/**
 * Enforces shipBar.blobs. Returns { counted, line }: a run counts only when it
 * records every blob the rule names, each matches the file here, and its own
 * countsTowardsShipBar is true. The reference is the file on disk, which is the
 * blob a clean checkout has committed; a dirty tree reads as a mismatch, which is
 * the safe direction.
 */
function checkBlobs(dir) {
	const runJson = join(dir, "RUN.json");
	if (!existsSync(runJson)) return { counted: false, line: "blobs: no RUN.json, so nothing is recorded and the run cannot count (shipBar.blobs)" };
	const run = JSON.parse(readFileSync(runJson, "utf8"));
	const against = run.scoredAgainst;
	if (!against || typeof against !== "object") return { counted: false, line: "blobs: RUN.json has no scoredAgainst, so the run cannot count (shipBar.blobs)" };
	const recorded = [
		["spec-review/rubric.md", join(here, "..", "rubric.md"), against.rubric],
		["spec-review/calibration/expected.json", join(here, "expected.json"), against.expected],
		...Object.entries(against.cases ?? {}).map(([name, sha]) => [`cases/${name}.md`, join(here, "cases", `${name}.md`), sha]),
	];
	const problems = [];
	for (const [label, path, sha] of recorded) {
		if (typeof sha !== "string" || !sha) problems.push(`${label}: no blob recorded`);
		else {
			const actual = blobSha(path);
			if (actual === null) problems.push(`${label}: recorded ${sha.slice(0, 12)}, file is gone`);
			else if (actual !== sha) problems.push(`${label}: recorded ${sha.slice(0, 12)}, here ${actual.slice(0, 12)}`);
		}
	}
	const unrecorded = Object.keys(expected.cases).filter((name) => !(against.cases ?? {})[name]);
	if (unrecorded.length) problems.push(`no blob recorded for ${unrecorded.join(", ")}`);
	const claims = run.countsTowardsShipBar === true;
	if (problems.length) {
		const lead = claims
			? "blobs: STALE, and RUN.json claims countsTowardsShipBar: true - a run cannot count against blobs it was not scored against"
			: "blobs: stale (RUN.json already says countsTowardsShipBar is not true)";
		return { counted: false, line: `${lead}\n${problems.map((p) => `    ${p}`).join("\n")}` };
	}
	if (!claims) return { counted: false, line: "blobs: match, but RUN.json says countsTowardsShipBar is not true, so the run does not count" };
	return { counted: true, line: "blobs: match the rubric, the key and every case here; the run counts" };
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
const runs = dirs.map((d) => ({ dir: d, blobs: checkBlobs(d), ...scoreRun(d) }));
for (const r of runs) console.log(`=== ${basename(r.dir)}\n  ${r.blobs.line}\n${r.lines.join("\n")}`);
let disagreements = [];
if (runs.length > 1) {
	const keys = Object.keys(runs[0].decisions);
	disagreements = keys.filter((k) => new Set(runs.map((r) => r.decisions[k])).size > 1);
	console.log(`gate agreement: ${keys.length - disagreements.length}/${keys.length}${disagreements.length ? `  (disagree: ${disagreements.join(", ")})` : ""}`);
}
const missed = runs.reduce((n, r) => n + r.missed, 0);
console.log(`cases with a miss: ${missed}`);
const notCounted = runs.filter((r) => !r.blobs.counted);
if (notCounted.length) console.log(`runs that do not count: ${notCounted.length}/${runs.length} (${notCounted.map((r) => basename(r.dir)).join(", ")}) - the ship bar asks for two that do`);
process.exit(missed === 0 && notCounted.length === 0 && disagreements.length === 0 ? 0 : 1);
