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
 * Nothing a RUN.json can contain makes this throw: a malformed file, an unreadable
 * one, or a case name that is not a bare name all come back as a non-counting run,
 * because the exit code is what criterion 12 reads.
 *
 * A run is scored on the cases its RUN.json says it reviewed (scoredAgainst.cases),
 * or on every case when it has no RUN.json. A case added to the set after a run was
 * made is named on a line of its own and not scored, so an older run still prints
 * its original lines; but a run that did not review every case has not met the set,
 * so any absent case also makes the exit 1. Gate agreement is over the cases every
 * run has.
 *
 * Exit 0 only when every run counts, no case is absent from any run, every case
 * meets every expectation in every run and, with two or more runs, all gate
 * decisions agree. Criterion 12 of docs/specs/spec-review-bus.md is this exit
 * code, so a stale run, a self-declared non-counting one and one that skipped a
 * case all cannot produce it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"));
const SPENT = new Set(Array.isArray(expected.shipBar?.spent) ? expected.shipBar.spent : []);

/**
 * The runner's prompt wording, for the blob rule. A prompt is not a file, and
 * `d98d5b6` showed a defective one causing every gate disagreement of a pair
 * whose recorded blobs all matched, so the runner records a fingerprint of the
 * wording and this is the other half of that comparison.
 *
 * Imported lazily and without letting a failure escape: if the runner cannot be
 * loaded the fingerprint is unknown, every run reads as unverifiable, and that
 * is the safe direction.
 */
let promptFingerprintHere = null;
try {
	({ promptFingerprint: promptFingerprintHere } = await import("../../scripts/calibrate.mjs"));
} catch {
	promptFingerprintHere = null;
}
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

/**
 * RUN.json as an object, tagged so a caller can tell "there is none" from "it does
 * not parse". Both the blob check and the case list read it, and neither may throw:
 * the exit code is what criterion 12 reads, so an unreadable RUN.json has to come
 * back as a line.
 */
function readRunJson(dir) {
	const path = join(dir, "RUN.json");
	if (!existsSync(path)) return { present: false, run: null, error: null };
	try {
		return { present: true, run: JSON.parse(readFileSync(path, "utf8")), error: null };
	} catch (e) {
		return { present: true, run: null, error: e.message };
	}
}

/**
 * The sha git would store for this file's current bytes, or null if it cannot be
 * read as a file at all. Every failure in this check has to come back as a line,
 * never as a stack trace, because the exit code is what criterion 12 reads.
 */
function blobSha(path) {
	if (!existsSync(path)) return null;
	try {
		const body = readFileSync(path);
		return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
	} catch {
		return null;
	}
}

/**
 * A case name out of RUN.json is used to build a path, so it has to be a bare
 * name. Rejecting a separator or a dot segment is not just hygiene: a name like
 * "../rubric" would otherwise be compared against the wrong file and reported as
 * a match.
 */
const BARE_CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Enforces shipBar.blobs. Returns { counted, line }: a run counts only when it
 * records every blob the rule names, each matches the file here, and its own
 * countsTowardsShipBar is true. The reference is the file on disk, which is the
 * blob a clean checkout has committed; a dirty tree reads as a mismatch, which is
 * the safe direction.
 */
function checkBlobs(dir) {
	const { present, run, error } = readRunJson(dir);
	if (!present) return { counted: false, line: "blobs: no RUN.json, so nothing is recorded and the run cannot count (shipBar.blobs)" };
	if (error) return { counted: false, line: `blobs: RUN.json is not valid JSON, so the run cannot count (shipBar.blobs): ${error}` };
	const against = run.scoredAgainst;
	if (!against || typeof against !== "object" || Array.isArray(against)) return { counted: false, line: "blobs: RUN.json has no scoredAgainst object, so the run cannot count (shipBar.blobs)" };
	const problems = [];
	const cases = Object.entries(against.cases ?? {});
	const named = cases.filter(([name]) => BARE_CASE_NAME.test(name));
	for (const [name] of cases.filter(([name]) => !BARE_CASE_NAME.test(name))) {
		problems.push(`${JSON.stringify(name)} is not a case name, so it is not resolved to a file`);
	}
	const recorded = [
		["spec-review/rubric.md", join(here, "..", "rubric.md"), against.rubric],
		["spec-review/calibration/expected.json", join(here, "expected.json"), against.expected],
		["scripts/calibrate.mjs", join(here, "..", "..", "scripts", "calibrate.mjs"), against.runner],
		...named.map(([name, sha]) => [`cases/${name}.md`, join(here, "cases", `${name}.md`), sha]),
	];
	for (const [label, path, sha] of recorded) {
		if (typeof sha !== "string" || !sha) problems.push(`${label}: no blob recorded`);
		else {
			const actual = blobSha(path);
			if (actual === null) problems.push(`${label}: recorded ${sha.slice(0, 12)}, file is gone`);
			else if (actual !== sha) problems.push(`${label}: recorded ${sha.slice(0, 12)}, here ${actual.slice(0, 12)}`);
		}
	}
	// The prompt is the one thing in the rule that is not a file.
	if (typeof against.prompt !== "string" || !against.prompt) problems.push("the runner's prompt: no fingerprint recorded");
	else if (promptFingerprintHere === null) problems.push("the runner's prompt: recorded, but scripts/calibrate.mjs could not be loaded to check it");
	else {
		const hereSha = promptFingerprintHere();
		if (hereSha !== against.prompt) problems.push(`the runner's prompt: recorded ${against.prompt.slice(0, 12)}, here ${hereSha.slice(0, 12)}`);
	}
	// Neither of these is about blobs, and both are reasons a run can never be one
	// of the two. Nothing read shipBar.spent before, so a probe or a re-run of a
	// model that had already taken part could be finalized true and exit 0 here.
	if (run.probe === true) problems.push("RUN.json records probe: true, and a probe is never one of the two (shipBar.capabilityMatched)");
	if (SPENT.has(run.model)) problems.push(`${run.model} is in shipBar.spent, so it is not a held-out model (shipBar.heldOut)`);
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

/**
 * The cases a run is scored on, and any name it listed that is not a case here.
 * No RUN.json, one that does not parse, or one that lists nothing all fall back to
 * the whole set: checkBlobs has already reported that run as non-counting, so the
 * exit is 1 either way, and scoring the whole set is the reading that cannot
 * understate what the run was asked to cover.
 *
 * A listed name that is no case in the key (a rename, a typo) is returned rather
 * than dropped. The blob check already refuses such a run, but without this the
 * run would be scored on fewer cases than its RUN.json names with no line saying
 * which, and a smaller scored set is the direction that hides a miss.
 */
function casesOf(dir) {
	const { run } = readRunJson(dir);
	const listed = Object.keys(run?.scoredAgainst?.cases ?? {});
	if (!listed.length) return { names: Object.keys(expected.cases), unknown: [] };
	return {
		names: Object.keys(expected.cases).filter((name) => listed.includes(name)),
		unknown: listed.filter((name) => !(name in expected.cases)),
	};
}

function scoreRun(dir) {
	const lines = [];
	const decisions = {};
	let missed = 0;
	const { names, unknown } = casesOf(dir);
	for (const [name, c] of Object.entries(expected.cases).filter(([name]) => names.includes(name))) {
		// A run whose RUN.json names a case with no verdict file used to end this
		// in an ENOENT stack trace, which loses every other case's line and the
		// exit code criterion 12 reads. It is a miss, reported like one.
		const verdictPath = join(dir, `${name}.verdict.md`);
		if (!existsSync(verdictPath)) {
			missed += 1;
			for (const g of GATES) decisions[`${name} ${g}`] = null;
			lines.push(`  ${name}: MISS: this run names the case but has no ${name}.verdict.md`);
			continue;
		}
		const v = parseVerdict(readFileSync(verdictPath, "utf8"));
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
	const absent = Object.keys(expected.cases).filter((name) => !names.includes(name));
	if (absent.length) lines.push(`  not in this run (added to the set after it): ${absent.join(", ")}`);
	if (unknown.length) lines.push(`  listed by this run but no case here: ${unknown.join(", ")}`);
	return { lines, decisions, missed, absentNames: absent };
}

/**
 * Everything this script prints, then the exit code as a return value.
 *
 * process.exit() used to run with output still queued, and on macOS a pipe is
 * not drained before the process goes: 27 lines to a file and 7 through `| cat`,
 * every time. Anyone piping this into grep, tail or a paste buffer got a
 * truncated transcript and no sign that it was truncated. Setting
 * process.exitCode and returning lets Node exit once stdout has flushed.
 */
function main(dirs) {
	if (dirs.length === 0) {
		console.error("usage: score.mjs <run-dir> [<run-dir>...]");
		return 2;
	}
	const runs = dirs.map((d) => ({ dir: d, blobs: checkBlobs(d), ...scoreRun(d) }));
	for (const r of runs) console.log(`=== ${basename(r.dir)}\n  ${r.blobs.line}\n${r.lines.join("\n")}`);
	let disagreements = [];
	if (runs.length > 1) {
		const keys = Object.keys(runs[0].decisions).filter((k) => runs.every((r) => k in r.decisions));
		disagreements = keys.filter((k) => new Set(runs.map((r) => r.decisions[k])).size > 1);
		console.log(`gate agreement: ${keys.length - disagreements.length}/${keys.length}${disagreements.length ? `  (disagree: ${disagreements.join(", ")})` : ""}`);
	}
	const missed = runs.reduce((n, r) => n + r.missed, 0);
	console.log(`cases with a miss: ${missed}`);
	const notCounted = runs.filter((r) => !r.blobs.counted);
	if (notCounted.length) console.log(`runs that do not count: ${notCounted.length}/${runs.length} (${notCounted.map((r) => basename(r.dir)).join(", ")}) - the ship bar asks for two that do`);
	const absentNames = [...new Set(runs.flatMap((r) => r.absentNames))].sort();
	const runsShort = runs.filter((r) => r.absentNames.length).length;
	if (absentNames.length) {
		console.log(`cases not reviewed: ${absentNames.join(", ")} (in ${runsShort} of ${runs.length} run(s); a run must review every case to meet the set)`);
	}
// absentNames is subsumed by notCounted today: both read scoredAgainst.cases, and a
// run that leaves a case out of that map has no blob recorded for it, so it already
// fails the blob check. It is kept as its own term because it is a different claim
// (the set was not covered, as against the blobs do not match), and the line above
// is the only place that names which cases are missing. Removing this term changes
// no exit code reachable today, so no test can hold it: see the note in SCORE.md.
	// test/spec-review-score.test.ts pins that LINE, not this term: the exit it asserts
	// is driven by notCounted. Nothing here is evidence that this term works.
	return missed === 0 && notCounted.length === 0 && absentNames.length === 0 && disagreements.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
