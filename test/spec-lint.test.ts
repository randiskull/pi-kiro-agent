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
	cases: Record<string, { ref?: string; sha256: string; lint: { fail: string[]; mustName?: string[] } }>;
}

const expected = JSON.parse(readFileSync(join(calibration, "expected.json"), "utf8")) as Expected;

function lint(
	files: string[],
	extra: string[] = [],
	ref: string = expected.ref,
): { status: number | null; results: LintResult[]; stderr: string } {
	const aliasArgs = Object.entries(expected.aliases).flatMap(([cited, actual]) => ["--alias", `${cited}=${actual}`]);
	const run = spawnSync(
		process.execPath,
		["scripts/spec-lint.mjs", "--json", "--ref", ref, ...aliasArgs, ...extra, ...files],
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
	// A case cites the code at its own ref (expected.json cases.<name>.ref), else
	// the set's: one lint run per ref, results put back in case order.
	const refOf = (name: string) => expected.cases[name].ref ?? expected.ref;
	const runs = [...new Set(caseNames.map(refOf))].map((ref) => {
		const names = caseNames.filter((name) => refOf(name) === ref);
		return { names, ...lint(names.map((name) => `spec-review/calibration/cases/${name}.md`), [], ref) };
	});
	const byName = new Map(runs.flatMap((r) => r.names.map((name, i) => [name, r.results[i]] as const)));
	const run = { results: caseNames.map((name) => byName.get(name) as LintResult) };

	it("runs to a verdict rather than giving up (exit 0 or 1, never 2)", () => {
		for (const r of runs) {
			expect(r.stderr, "spec-lint could not verify; a shallow clone needs fetch-depth: 0").toBe("");
			expect([0, 1]).toContain(r.status);
			expect(r.results.map((x) => x.spec)).toEqual(r.names.map((name) => `spec-review/calibration/cases/${name}.md`));
		}
		expect(run.results.map((r) => r?.spec)).toEqual(files);
	});

	it("expected.json and cases/ name the same cases", () => {
		const onDisk = readdirSync(join(calibration, "cases"))
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(/\.md$/, ""))
			.sort();
		expect(onDisk).toEqual(caseNames);
		expect(caseNames.length).toBe(8);
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
		// Forms that used to be neither checked nor listed.
		["call with arguments", CLEAN.replace("`serveBridgeHttp()`", "`serveBridgeHTTP(port, host.name)`"), "serveBridgeHTTP"],
		["dotted method", CLEAN.replace("`serveBridgeHttp()`", "`bridge.serveBridgeHTTP`"), "serveBridgeHTTP"],
		["PascalCase symbol", CLEAN.replace("`setChildKeepalive`", "`KiroAgentProfil`"), "KiroAgentProfile"],
		["SCREAMING_SNAKE symbol", CLEAN.replace("`setChildKeepalive`", "`BRIDGE_MCP_SERVER_KEYY`"), "BRIDGE_MCP_SERVER_KEY"],
		["uppercase commit", CLEAN.replace("6ea0510", "6EA0517"), "6EA0517"],
		["far end of a commit range", CLEAN.replace("6ea0510", "6ea0510..6ea0517"), "6ea0517"],
		["commit after a non-repository @", CLEAN.replace("6ea0510", "fix@6ea0517"), "6ea0517"],
		["letters-only commit in backticks", CLEAN.replace("6ea0510", "`deadbeef`"), "deadbeef"],
		["npm run with trailing flags", CLEAN.replace("`npm run verify`", "`npm run nosuch -- --watch`"), "nosuch"],
		["npm run-script", CLEAN.replace("`npm run verify`", "`npm run-script nosuch`"), "nosuch"],
		["section in the wrong case", CLEAN.replace("§5e.3", "§5E.3"), "5E.3"],
		["section that is not a number", CLEAN.replace("§5e.3", "§A.1"), "§A.1 is not a section number"],
		["section named by a prefix of a real one", CLEAN.replace("§5e.3", "§5e.3.1"), "5e.3.1"],
		["markdown link target", CLEAN.replace("`src/bridge.ts`", "[the bridge](src/nope.ts)"), "src/nope.ts"],
		["top-level directory in the wrong case", CLEAN.replace("`src/bridge.ts`", "`SRC/bridge.ts`"), "SRC/bridge.ts"],
		["one-edit directory typo, whatever the file", CLEAN.replace("`src/bridge.ts`", "`scr/nope.ts`"), "scr/nope.ts"],
		["leading ./", CLEAN.replace("`src/bridge.ts`", "`./src/nope.ts`"), "./src/nope.ts"],
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

	// Forms a real spec writes that are NOT broken citations.
	it.each([
		["a line anchor", "`src/bridge.ts#L10`"],
		["a line range", "`src/bridge.ts:86-88`"],
		["npm's own commands", "`npm ci`, `npm pack --dry-run`, `npm install`"],
		["a colour, not a commit", "the colour #ff00aa11"],
		["an English word made of hex letters", "a defaced banner"],
		["a type next to a field of the same name", "`StopReason`"],
		["an id that only looks like a path", "`kiro/auto`"],
		["another repository's commit as a URL", "https://github.com/earendil-works/pi-coding-agent/commit/3f9a1b2c"],
	])("does not fail %s", (_name, cite) => {
		const [result] = lint([write(`ok-${_name.replace(/\W+/g, "-")}`, syntheticSpec(`${CLEAN} ${cite}`))]).results;
		expect(failing(result), JSON.stringify(result.checks)).toEqual([]);
	});

	it("lists another repository's commit URL as external", () => {
		const cite = "https://github.com/earendil-works/pi-coding-agent/commit/3f9a1b2c";
		const [result] = lint([write("commit-url", syntheticSpec(`${CLEAN} ${cite}`))]).results;
		expect(result.notes.external).toContain("earendil-works/pi-coding-agent@3f9a1b2c");
	});

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
		const plan = "- **Negative control first.** The test fails before the fix.";
		const criteria = "## Acceptance criteria\n\n1. It works. Evidence: a test.\n";
		const cases: Array<[string, string]> = [
			["structure", base.replace("## Acceptance criteria", "## Criteria")],
			// A required section that exists only where a reader never sees it.
			["structure", base.replace(criteria, `~~~\n${criteria}~~~\n`)],
			["structure", base.replace(criteria, `<!--\n${criteria}-->\n`)],
			["structure", base.replace(criteria, `\`\`\`\`md\n\`\`\`\n${criteria}\`\`\`\n\`\`\`\`\n`)],
			// A heading that only starts with the required word.
			["structure", base.replace("## Goal", "## Goalposts")],
			["structure", base.replace("### In scope", "### In scopes elsewhere")],
			["structure", base.replace("## Verification plan", "## Verification planning").replace(plan, "")],
			// Header bullets: each required one, with a value.
			["structure", base.replace("- Status: Draft", "- Status:")],
			["structure", base.replace("- Area: test fixture\n", "")],
			["structure", base.replace("- Related: `src/bridge.ts`", "- Related:")],
			["structure", base.replace("- Target release: none", "- Targetless: none")],
			["structure", base.replace("### Out of scope", "### Later")],
			["structure", `${base}\n\n## Goal\n\nA second goal.`],
			["type", base.replace("## Root cause", "## Cause")],
			["attribution", base.replace("Spec: Test, Model 1.", "Written by a person.")],
			["attribution", base.replace("Spec: Test, Model 1.", "Spec: , TBD.")],
			["attribution", base.replace("Spec: Test, Model 1.", "Spec: Test.")],
			["attribution", base.replace("Spec: Test, Model 1.", "Spec: Test, TODO")],
			["G3", base.replace(plan, "- Run the tests.")],
			["G3", base.replace(plan, "- **Negative controls are not needed.**")],
			["G3", base.replace(plan, "- **Negative control:** TODO")],
			["G3", base.replace(plan, "Negative control first: the test fails before the fix.")],
		];
		// One file per case: several share an id, and a shared name would lint only the last.
		const files = cases.map(([id, text], i) => write(`defect-${id}-${i}`, text));
		const { results } = lint(files);
		cases.forEach(([id], i) => expect(failing(results[i]), id).toEqual([id]));
	});

	it("passes the forms of a negative control and attribution a real spec writes", () => {
		const base = syntheticSpec(CLEAN);
		const plan = "- **Negative control first.** The test fails before the fix.";
		const texts = [
			base.replace(plan, "* **Negative control first.** The test fails before the fix."),
			base.replace(plan, "- **Negative control first.**\n  The test fails before the fix, because the timer is still referenced."),
			base.replace(plan, "- **Negative control first (per docs/releasing.md):** before the fix, the test fails."),
			base.replace("Spec: Test, Model 1.", "Investigation and spec: Kiro, Claude Opus 5."),
			base.replace("Spec: Test, Model 1.", "Design: a person. Spec: other, Model 1."),
			base.replace(/\n/g, "\r\n"),
		];
		const { results } = lint(texts.map((text, i) => write(`real-form-${i}`, text)));
		results.forEach((r, i) => expect(failing(r), `form ${i}: ${JSON.stringify(r.checks)}`).toEqual([]));
	});

	it("a defect spec with a Problem section as well is still a defect spec", () => {
		const text = syntheticSpec(CLEAN).replace("## Observed failure", "## Problem\n\nContext.\n\n## Observed failure");
		const [result] = lint([write("both-types", text)]).results;
		expect(result.type).toBe("defect");
	});

	it("checks a cited directory against the tree", () => {
		const { results } = lint([
			write("dir-ok", syntheticSpec(`${CLEAN} \`src/\``)),
			write("dir-missing", syntheticSpec(`${CLEAN} \`src/nowhere/\``)),
		]);
		expect(failing(results[0])).toEqual([]);
		expect(findings(results[1], "G2").join("\n")).toContain("src/nowhere");
	});

	it("a feature spec is typed by its Problem section", () => {
		const text = syntheticSpec(CLEAN).replace("## Observed failure", "## Problem").replace("## Root cause\n\nA cause.\n\n", "");
		const [result] = lint([write("feature", text)]).results;
		expect(result.type).toBe("feature");
		expect(failing(result)).toEqual([]);
	});

	// HEAD, not the calibration ref: this test file spells the typos it tests, and
	// once it is committed a plain grep of test/ would find them as real words.
	it("still fails a typo at HEAD that only this test file spells", () => {
		const typos = CLEAN.replace("`serveBridgeHttp()`", "`serveBridgeHTTP()`").replace("`setChildKeepalive`", "`setChildKeepalve`");
		const [result] = lint([write("typo-at-head", syntheticSpec(typos))], ["--ref", "HEAD"]).results;
		const g2 = findings(result, "G2").join("\n");
		expect(g2).toContain("serveBridgeHTTP");
		expect(g2).toContain("setChildKeepalve");
	});

	it("fails a commit that exists but is not an ancestor of the ref, and an object that is not a commit", () => {
		const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
		const later = git(["rev-parse", "--short=10", "HEAD"]); // never an ancestor of the calibration ref
		const tree = git(["rev-parse", "--short=10", "HEAD^{tree}"]);
		// In backticks: lint skips a bare all-digit run as a number, and about one
		// commit in a hundred has a 10-character prefix with no letter in it.
		const { results } = lint([
			write("not-ancestor", syntheticSpec(CLEAN.replace("6ea0510", `\`${later}\``))),
			write("tree-object", syntheticSpec(CLEAN.replace("6ea0510", `\`${tree}\``))),
		]);
		expect(findings(results[0], "G2").join("\n")).toContain(`${later} is not an ancestor of ${expected.ref}`);
		expect(findings(results[1], "G2").join("\n")).toContain(`${tree} names an object that is not a commit`);
	});

	it("gives the same answer from a subdirectory as from the repository root", () => {
		const cites = CLEAN.replace("`src/bridge.ts`", "`src/nope.ts`").replace("`serveBridgeHttp()`", "`serveBridgeHTTP()`");
		const file = write("from-subdir", syntheticSpec(cites));
		const out = spawnSync(process.execPath, ["../scripts/spec-lint.mjs", "--json", "--ref", expected.ref, file], {
			cwd: join(root, "src"),
			encoding: "utf8",
		});
		expect(out.status, out.stderr).toBe(1);
		const [result] = JSON.parse(out.stdout) as LintResult[];
		const g2 = findings(result, "G2").join("\n");
		expect(g2).toContain("`src/nope.ts` does not exist");
		expect(g2).toContain("probable typo of `serveBridgeHttp`");
	});

	it("a section reference names that section, not a longer one it prefixes", async () => {
		const { sectionResolves } = (await import(join(root, "scripts", "spec-lint.mjs"))) as {
			sectionResolves: (id: string, headings: string[]) => boolean;
		};
		expect(sectionResolves("1", ["1. Why"])).toBe(true);
		expect(sectionResolves("1", ["1 Why"])).toBe(true);
		expect(sectionResolves("5e.3", ["5e.3 Fixed: a reset"])).toBe(true);
		expect(sectionResolves("1", ["1.2 Detail"])).toBe(false);
		expect(sectionResolves("5e", ["5e.3 Fixed: a reset"])).toBe(false);
		expect(sectionResolves("5", ["5e. Field evidence"])).toBe(false);
	});

	it("refuses a spec larger than any spec, before reading it", () => {
		const huge = write("huge", syntheticSpec(CLEAN) + "\n" + "x".repeat(600 * 1024));
		const out = spawnSync(process.execPath, ["scripts/spec-lint.mjs", "--ref", expected.ref, huge], { cwd: root, encoding: "utf8" });
		expect(out.status).toBe(2);
		expect(out.stderr).toContain("a spec is at most");
	});

	it("handles hostile input in linear time and without crashing", () => {
		const spaces = syntheticSpec(CLEAN).replace("Spec: Test, Model 1.", `spec:${" ".repeat(400_000)}`);
		const section = syntheticSpec(`${CLEAN} §1${".1".repeat(20_000)}`);
		const started = Date.now();
		const { status, results } = lint([write("redos-attribution", spaces), write("long-section", section)]);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(status).toBe(1);
		expect(failing(results[0])).toEqual(["attribution"]);
		expect(failing(results[1])).toEqual(["G2"]);
	});

	it.each([
		["a missing file", (dir: string) => [join(dir, "no-such.md")]],
		["a directory", (dir: string) => [dir]],
		["an unknown option", () => ["--jsno", cleanFile]],
		["one unreadable file among good ones", (dir: string) => [cleanFile, join(dir, "no-such.md")]],
	])("exits 2, with nothing on stdout, for %s", (_name, args) => {
		const out = spawnSync(process.execPath, ["scripts/spec-lint.mjs", "--json", "--ref", expected.ref, ...args(dir)], {
			cwd: root,
			encoding: "utf8",
		});
		expect(out.status).toBe(2);
		expect(out.stdout).toBe("");
		expect(out.stderr).toMatch(/^spec-lint: /);
		if (_name === "an unknown option") expect(out.stderr).toContain("unknown option --jsno");
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
