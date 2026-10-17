/**
 * The deterministic half of the spec-review rubric (spec-review/rubric.md),
 * pinned two ways:
 *
 * 1. Against the calibration set, whose expectations are DERIVED from
 *    spec-review/calibration/expected.json rather than restated here, so the set
 *    and this test cannot drift apart. The cases are pinned by sha256 too: an
 *    edit to a case is an edit to the answer key and has to be made on purpose.
 * 2. Per citation class, on a synthetic spec. The unmutated spec is asserted to
 *    pass first: a harness that never reports a pass would otherwise read every
 *    mutation below as caught.
 *
 * Citations resolve at the calibration ref, so these tests need full history
 * (ci.yml checks out with fetch-depth: 0). In a shallow clone the linter exits 2
 * and says why, rather than passing.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const calibration = join(root, "spec-review", "calibration");

interface Check {
	id: string;
	pass: boolean;
	findings: string[];
}
interface LintResult {
	spec: string;
	type: string | null;
	pass: boolean;
	checks: Check[];
	notes: Record<string, string[]>;
}
interface Expected {
	ref: string;
	aliases: Record<string, string>;
	cases: Record<string, { sha256: string; lint: { fail: string[]; mustName?: string[] } }>;
}

const expected = JSON.parse(readFileSync(join(calibration, "expected.json"), "utf8")) as Expected;

function lint(files: string[], extra: string[] = []): { status: number | null; results: LintResult[]; stderr: string } {
	const aliasArgs = Object.entries(expected.aliases).flatMap(([cited, actual]) => ["--alias", `${cited}=${actual}`]);
	const run = spawnSync(
		process.execPath,
		["scripts/spec-lint.mjs", "--json", "--ref", expected.ref, ...aliasArgs, ...extra, ...files],
		{ cwd: root, encoding: "utf8" },
	);
	const results = run.status === 2 ? [] : (JSON.parse(run.stdout) as LintResult[]);
	return { status: run.status, results, stderr: run.stderr };
}

const failing = (r: LintResult) => r.checks.filter((c) => !c.pass).map((c) => c.id);
const findings = (r: LintResult, id: string) => r.checks.find((c) => c.id === id)?.findings ?? [];

describe("spec-lint on the calibration set (spec-review/calibration)", () => {
	const caseNames = Object.keys(expected.cases).sort();
	const files = caseNames.map((name) => `spec-review/calibration/cases/${name}.md`);
	const run = lint(files);

	it("runs to a verdict rather than giving up (exit 0 or 1, never 2)", () => {
		expect(run.stderr, "spec-lint could not verify; a shallow clone needs fetch-depth: 0").toBe("");
		expect([0, 1]).toContain(run.status);
		expect(run.results.map((r) => r.spec)).toEqual(files);
	});

	it("expected.json and cases/ name the same cases", () => {
		const onDisk = readdirSync(join(calibration, "cases"))
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(/\.md$/, ""))
			.sort();
		expect(onDisk).toEqual(caseNames);
		expect(caseNames.length).toBe(6);
	});

	it("every case is byte-identical to the one that was labelled", () => {
		for (const name of caseNames) {
			const text = readFileSync(join(calibration, "cases", `${name}.md`));
			expect(createHash("sha256").update(text).digest("hex"), `${name}.md changed after it was labelled`).toBe(
				expected.cases[name].sha256,
			);
		}
	});

	// At least one case must pass and at least one must fail, or a linter that
	// always passes (or always fails) would satisfy the per-case loop below.
	it("the set contains both outcomes", () => {
		const outcomes = new Set(caseNames.map((name) => expected.cases[name].lint.fail.length === 0));
		expect([...outcomes].sort()).toEqual([false, true]);
	});

	it.each(caseNames)("%s fails exactly the checks expected.json says it fails", (name) => {
		const result = run.results[caseNames.indexOf(name)];
		expect(failing(result), JSON.stringify(result.checks, null, 2)).toEqual(expected.cases[name].lint.fail);
		for (const token of expected.cases[name].lint.mustName ?? []) {
			expect(findings(result, "G2").join("\n"), `${name}: no G2 finding names ${token}`).toContain(token);
		}
	});

	it("lists, without failing, the exemplar's gitignored investigation note", () => {
		const exemplar = run.results[caseNames.indexOf("c4")];
		expect(exemplar.notes.local).toContain(".gsd/workflows/spikes/261017-1-spike/research/ANGLE-5.md");
	});

	it("lists, without failing, paths and symbols from an external codebase", () => {
		const dualHost = run.results[caseNames.indexOf("c2")];
		expect(dualHost.notes.external).toContain("packages/pi-coding-agent/dist/core/extensions/loader.js");
		expect(dualHost.notes.unresolvedSymbols).toContain("mergeExtensionEntryPaths");
	});
});

/** A minimal spec that cites one thing of every class the linter resolves. */
function syntheticSpec(cites: string): string {
	return [
		"# Implementation Spec: synthetic",
		"",
		"- Status: Draft",
		"- Area: test fixture",
		"- Target release: none",
		"- Related: `src/bridge.ts`",
		"",
		"## Goal",
		"",
		cites,
		"",
		"## Observed failure",
		"",
		"It fails.",
		"",
		"## Root cause",
		"",
		"A cause.",
		"",
		"## Scope",
		"",
		"### In scope",
		"- One thing.",
		"",
		"### Out of scope",
		"- Nothing else (unchanged, no follow-up).",
		"",
		"## Approach",
		"",
		"Do it.",
		"",
		"## Acceptance criteria",
		"",
		"1. It works. Evidence: a test.",
		"",
		"## Verification plan",
		"",
		"- **Negative control first.** The test fails before the fix.",
		"",
		"## Risks and notes",
		"",
		"- None.",
		"",
		"## Attribution",
		"",
		"Spec: Test, Model 1.",
	].join("\n");
}

const CLEAN = "`src/bridge.ts`, `serveBridgeHttp()`, `setChildKeepalive`, 6ea0510, §5e.3, `npm run verify`, `npm test`.";

describe("spec-lint per citation class (synthetic spec)", () => {
	const dir = mkdtempSync(join(tmpdir(), "spec-lint-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const write = (name: string, text: string) => {
		const file = join(dir, `${name}.md`);
		writeFileSync(file, text);
		return file;
	};

	// [name, replacement for one clean citation, token the G2 finding must name]
	const broken: Array<[string, string, string]> = [
		["missing repo path", CLEAN.replace("`src/bridge.ts`", "`src/nope.ts`"), "src/nope.ts"],
		["near-miss path", CLEAN.replace("`src/bridge.ts`", "`scr/bridge.ts`"), "scr/bridge.ts"],
		["near-miss symbol", CLEAN.replace("`serveBridgeHttp()`", "`serveBridgeHTTP()`"), "serveBridgeHTTP"],
		["missing commit", CLEAN.replace("6ea0510", "6ea0517"), "6ea0517"],
		["unknown section", CLEAN.replace("§5e.3", "§9z.9"), "9z.9"],
		["unknown npm script", CLEAN.replace("`npm run verify`", "`npm run nosuch`"), "nosuch"],
		["(new) excuses only its own token", CLEAN.replace("`src/bridge.ts`", "`src/made.ts` (new), `src/nope.ts`"), "src/nope.ts"],
		["one-edit symbol typo", CLEAN.replace("`setChildKeepalive`", "`setChildKeepalve`"), "setChildKeepalive"],
		["digits-only commit in backticks", CLEAN.replace("6ea0510", "`6281470`"), "6281470"],
	];

	const cleanFile = write("clean", syntheticSpec(CLEAN));
	const brokenFiles = broken.map(([, cites], i) => write(`broken-${i}`, syntheticSpec(cites)));
	const run = lint([cleanFile, ...brokenFiles]);

	it("the unmutated synthetic spec passes every check (baseline)", () => {
		expect(run.status, run.stderr).toBe(1); // 1 because the broken ones fail
		expect(failing(run.results[0]), JSON.stringify(run.results[0].checks)).toEqual([]);
		expect(run.results[0].type).toBe("defect");
	});

	it.each(broken.map(([name, , token], i) => [name, token, i] as const))(
		"%s fails G2 and only G2, naming %s",
		(_name, token, i) => {
			const result = run.results[i + 1];
			expect(failing(result)).toEqual(["G2"]);
			expect(findings(result, "G2").join("\n")).toContain(token);
		},
	);

	it("a path marked (new) is listed as proposed, not failed", () => {
		const file = write("proposed", syntheticSpec(CLEAN.replace("`src/bridge.ts`", "`src/made.ts` (new)")));
		const [result] = lint([file]).results;
		expect(failing(result)).toEqual([]);
		expect(result.notes.proposed).toEqual(["src/made.ts"]);
	});

	it("a gitignored file under a tracked directory is listed as local, not failed", () => {
		// src/ is tracked and *.log is ignored, so this is a local file, not a typo.
		const file = write("ignored", syntheticSpec(CLEAN.replace("`src/bridge.ts`", "`src/bridge.ts`, `src/scratch.log`")));
		const [result] = lint([file]).results;
		expect(failing(result), JSON.stringify(result.checks)).toEqual([]);
		expect(result.notes.local).toEqual(["src/scratch.log"]);
	});

	it("an external repository's commit is listed, not failed, and a bare number is not a commit", () => {
		const cites = `${CLEAN} Upstream fixed it in earendil-works/pi-coding-agent@3f9a1b2. Released 20261017.`;
		const [result] = lint([write("external-commit", syntheticSpec(cites))]).results;
		expect(failing(result)).toEqual([]);
		expect(result.notes.external).toContain("earendil-works/pi-coding-agent@3f9a1b2");
	});

	it("structure, type, attribution and the G3 presence check each fail on their own defect", () => {
		const base = syntheticSpec(CLEAN);
		const cases: Array<[string, string]> = [
			["structure", base.replace("## Acceptance criteria", "## Criteria")],
			["type", base.replace("## Root cause", "## Cause")],
			["attribution", base.replace("Spec: Test, Model 1.", "Written by a person.")],
			["G3", base.replace("- **Negative control first.** The test fails before the fix.", "- Run the tests.")],
		];
		const files = cases.map(([id, text]) => write(`defect-${id}`, text));
		const { results } = lint(files);
		cases.forEach(([id], i) => expect(failing(results[i]), id).toEqual([id]));
	});

	it("a feature spec is typed by its Problem section", () => {
		const text = syntheticSpec(CLEAN).replace("## Observed failure", "## Problem").replace("## Root cause\n\nA cause.\n\n", "");
		const [result] = lint([write("feature", text)]).results;
		expect(result.type).toBe("feature");
		expect(failing(result)).toEqual([]);
	});

	it("exits 2, not 0, when the ref cannot be resolved", () => {
		const out = spawnSync(process.execPath, ["scripts/spec-lint.mjs", "--ref", "no-such-ref", cleanFile], {
			cwd: root,
			encoding: "utf8",
		});
		expect(out.status).toBe(2);
		expect(out.stderr).toContain("does not resolve");
	});
});
