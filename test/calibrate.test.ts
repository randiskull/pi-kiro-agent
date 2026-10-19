/**
 * scripts/calibrate.mjs is the runner for a calibration pass, and most of what
 * it does is a check: the clone cannot reach the answer key, the case is given
 * every citation it makes, the verdict judged the spec it was handed, and the
 * `Reviewer:` line is the runner's and not the model's guess. A check that is
 * wrong passes everything, so each one is pinned here against a case it must
 * catch, not only against a case it must allow.
 *
 * Everything that can be derived from the set is derived: the run-id shape comes
 * from a committed run directory's own name, the rubric number from
 * `expected.json`, and the blob function from `git hash-object` itself. A number
 * restated here would drift from the set the moment a case is added, which is
 * the defect test/calibration-ship-bar.test.ts exists for.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as cal from "../scripts/calibrate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAL = join(root, "spec-review", "calibration");
const key = JSON.parse(readFileSync(join(CAL, "expected.json"), "utf8")) as {
	rubric: number;
	ref: string;
	aliases?: Record<string, string>;
	cases: Record<string, { ref?: string }>;
};
const readCase = (name: string) => readFileSync(join(CAL, "cases", `${name}.md`), "utf8");
const temps: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "cal-test-"));
	temps.push(d);
	return d;
};
afterAll(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("run identity", () => {
	// The shape comes from a run directory that is committed, so a change to the
	// naming has to be made in both places on purpose.
	it("rebuilds a committed run directory's name from its own fields", () => {
		expect(cal.runIdFor({ date: "2026-10-17", rubric: 1, harness: "gsd", model: "us.anthropic.claude-fable-5-1" })).toBe(
			"2026-10-17-r1-gsd-us-anthropic-claude-fable-5-1",
		);
		expect(cal.runIdFor({ date: "2026-10-17", rubric: 1, harness: "kiro-cli", model: "gpt-5.6-sol" })).toBe(
			"2026-10-17-r1-kiro-cli-gpt-5-6-sol",
		);
	});

	it("reads the rubric's number from the rubric and not from a constant", () => {
		const n = cal.rubricNumber(readFileSync(join(root, "spec-review", "rubric.md"), "utf8"));
		expect(n, "rubric.md and expected.json disagree about the rubric number").toBe(key.rubric);
	});

	it("refuses a rubric with no number rather than defaulting to one", () => {
		expect(() => cal.rubricNumber("# Spec review rubric\n\nno number here\n")).toThrow(/Rubric/);
	});

	// A dot in a model id and a dot in a path are the same character to a
	// filesystem; `gpt-5.6-terra` must not become a directory named `gpt-5`.
	it("flattens every separator a model id can carry", () => {
		expect(cal.slug("gpt-5.6-terra")).toBe("gpt-5-6-terra");
		expect(cal.slug("us.anthropic.claude-opus-5")).toBe("us-anthropic-claude-opus-5");
		expect(cal.slug("../escape")).toBe("escape");
	});
});

describe("blob shas", () => {
	// Pinned against git, because RUN.json's whole purpose is that a human can
	// re-derive these with git and get the same answer.
	it("agrees with git hash-object on a real file", () => {
		const path = join(root, "spec-review", "rubric.md");
		const fromGit = spawnSync("git", ["hash-object", path], { cwd: root, encoding: "utf8" }).stdout.trim();
		expect(fromGit).toMatch(/^[0-9a-f]{40}$/);
		expect(cal.blobShaOf(readFileSync(path))).toBe(fromGit);
	});
});

describe("the environment a session is given", () => {
	// A pre-push hook exports GIT_DIR, git prefers it over the working
	// directory, and a reviewer session that runs git would then read the
	// repository being pushed - which holds the answer key.
	it("drops every GIT_ variable and keeps the rest", () => {
		const out = cal.stripGitEnv({ GIT_DIR: "/x/.git", GIT_INDEX_FILE: "/x/i", PATH: "/usr/bin", HOME: "/h" });
		expect(Object.keys(out).sort()).toEqual(["HOME", "PATH"]);
	});
});

describe("the case plan", () => {
	it("gives every case that uses the set's ref the alias files, and the others none", () => {
		const plan = cal.planCases(key, readCase);
		expect(plan.length).toBe(Object.keys(key.cases).length);
		const aliasCount = Object.keys(key.aliases ?? {}).length;
		for (const c of plan) {
			expect(c.ref, c.name).toMatch(/^[0-9a-f]{7,40}$/);
			expect(c.aliases.length, `${c.name} alias count`).toBe(c.usesSetRef ? aliasCount : 0);
		}
	});

	// The set's own cases are the fixture: every case that cites the aliased path
	// must be one that is given it. This is the live defect the guard below
	// catches, checked against real text rather than a tidier one.
	it("gives the alias file to every case in the set that cites the aliased path", () => {
		const plan = cal.planCases(key, readCase);
		for (const [cited] of Object.entries(key.aliases ?? {})) {
			const citing = Object.keys(key.cases).filter((name) => readCase(name).includes(cited));
			expect(citing.length, `no case cites ${cited}, so the alias is dead`).toBeGreaterThan(0);
			for (const name of citing) {
				const c = plan.find((p) => p.name === name);
				expect(c?.aliases.some((a) => a.cited === cited), `${name} cites ${cited} and must be given it`).toBe(true);
			}
		}
	});

	it("aborts when a case carrying its own ref cites an aliased path", () => {
		const synthetic = {
			ref: "61bb96f",
			aliases: { "docs/specs/sibling.md": "spec-review/calibration/cases/c2.md" },
			cases: { c9: { ref: "68ffb40" } },
		};
		expect(() => cal.planCases(synthetic, () => "it cites docs/specs/sibling.md in its Approach")).toThrow(
			/c9 cites docs\/specs\/sibling\.md and is not given it/,
		);
		// The same case without the citation is fine: the guard is about the
		// citation, not about carrying a ref.
		expect(() => cal.planCases(synthetic, () => "it cites nothing outside its clone")).not.toThrow();
	});
});

describe("the prompt", () => {
	const base = {
		inputDir: "/t/in-x",
		verdictPath: "/t/in-x/verdict.md",
		reviewerLine: "Reviewer: pi, us.anthropic.claude-opus-5",
	};

	it("names the spec, the rubric, the verdict path and the reviewer line", () => {
		const p = cal.promptFor({ ...base, aliases: [] });
		expect(p).toContain("/t/in-x/spec.md");
		expect(p).toContain("/t/in-x/rubric.md");
		expect(p).toContain("/t/in-x/verdict.md");
		expect(p).toContain("`Reviewer: pi, us.anthropic.claude-opus-5`");
		expect(p).toContain("skipping step 1 (lint)");
	});

	// The README's prompt drops its alias sentence for a case that is given no
	// alias file. A prompt that kept it would point a reviewer at a file that is
	// not there, and the G2 finding would be the runner's fault.
	it("carries the alias sentence only when the case is given the file", () => {
		const withAlias = cal.promptFor({
			...base,
			aliases: [{ cited: "docs/specs/dual-host-pi-gsd.md", target: "spec-review/calibration/cases/c2.md" }],
		});
		expect(withAlias).toContain("Where the spec cites `docs/specs/dual-host-pi-gsd.md`, read /t/in-x/c2.md.");
		expect(cal.promptFor({ ...base, aliases: [] })).not.toContain("Where the spec cites");
	});

	// A prompt that named a case, the set or the key would tell the reviewer what
	// it is being measured on.
	it("says nothing about the calibration set", () => {
		const p = cal.promptFor({
			...base,
			aliases: [{ cited: "docs/specs/dual-host-pi-gsd.md", target: "spec-review/calibration/cases/c2.md" }],
		});
		for (const word of ["calibration", "expected.json", "answer key", "mutant"]) {
			expect(p.toLowerCase(), `the prompt leaks ${word}`).not.toContain(word);
		}
	});
});

describe("verdict verification", () => {
	const blob = "a".repeat(40);
	const good = [
		`spec-review verdict for spec.md blob ${blob}`,
		"Rubric: 2",
		"Reviewer: pi, us.anthropic.claude-opus-5",
		"Outcome: pass",
		"",
		"## Gates",
		"- G1 pass",
		"",
		"## Findings",
		"- [D5] \"x\": y. Fix: z.",
		"",
	].join("\n");
	const line = "Reviewer: pi, us.anthropic.claude-opus-5";

	it("passes a verdict that judged the spec it was given and copied the line", () => {
		const r = cal.verifyVerdict({ text: good, specBlob: blob, reviewerLine: line });
		expect(r.problems).toEqual([]);
		expect(r.corrections).toEqual([]);
		expect(r.text).toBe(good);
	});

	// The field the rubric puts on the runner: a model that guessed its own id is
	// what Rubric 2 changed, so a guess is corrected and the correction is
	// reported for NOTES.md rather than silently overwritten.
	it("corrects a guessed Reviewer line and reports the correction", () => {
		const guessed = good.replace(line, "Reviewer: pi, Claude Opus");
		const r = cal.verifyVerdict({ text: guessed, specBlob: blob, reviewerLine: line });
		expect(r.problems).toEqual([]);
		expect(r.corrections.length).toBe(1);
		expect(r.corrections[0]).toContain("Claude Opus");
		expect(r.text).toContain(line);
		expect(r.text, "the guess must be gone, not merely joined").not.toContain("Reviewer: pi, Claude Opus");
	});

	// A header naming another blob means the session reviewed something else.
	// Rewriting it would hide that, so it is a problem and never a correction.
	it("reports a header that names another blob, and does not rewrite it", () => {
		const other = "b".repeat(40);
		const r = cal.verifyVerdict({ text: good, specBlob: other, reviewerLine: line });
		expect(r.problems.join(" ")).toMatch(/header names blob/);
		expect(r.text).toContain(blob);
	});

	it("reports a missing Reviewer line and a header that is not one", () => {
		const noLine = good.replace(`${line}\n`, "");
		expect(cal.verifyVerdict({ text: noLine, specBlob: blob, reviewerLine: line }).problems.join(" ")).toMatch(
			/no Reviewer: line/,
		);
		const noHeader = `Outcome: pass\n${good}`;
		expect(cal.verifyVerdict({ text: noHeader, specBlob: blob, reviewerLine: line }).problems.join(" ")).toMatch(
			/not a verdict header/,
		);
	});
});

describe("the agent a kiro-cli session runs under", () => {
	// The defect this exists for was live: the first attempt at this pass ran
	// under kiro-cli's default agent, which on a machine with builder-mcp
	// installed carries @builder-mcp/WorkspaceSearch, and that tool ran inside a
	// reviewer session. A session that can search outside its clone is not a
	// blind reviewer, so the pass was voided.
	it("declares no MCP server and does not read mcp.json", () => {
		const agent = cal.reviewerAgent();
		expect(Object.keys(agent.mcpServers), "a reviewer session gets no MCP server").toEqual([]);
		expect(agent.includeMcpJson, "mcp.json would bring this machine's servers back").toBe(false);
	});

	// Every tool it declares has to be trusted too, or the session stops on a
	// confirmation prompt it cannot answer with --no-interactive.
	it("trusts exactly the tools a review needs and nothing else", () => {
		const agent = cal.reviewerAgent();
		expect(agent.tools.slice().sort()).toEqual(["execute_bash", "fs_read", "fs_write"]);
		expect(agent.allowedTools.slice().sort()).toEqual(agent.tools.slice().sort());
	});
});

describe("the leak check", () => {
	const forbidden = [
		{ label: "expected.json", sha: "a".repeat(40) },
		{ label: "cases/c1.md", sha: "b".repeat(40) },
	];

	it("names the file and the blob when one is reachable", () => {
		const message = cal.leakReport({ forbidden, isReachable: (sha) => sha.startsWith("b") });
		expect(message).toContain("LEAK");
		expect(message).toContain("cases/c1.md");
		expect(message).toContain("b".repeat(12));
		expect(message, "a clean file must not be named").not.toContain("expected.json");
	});

	// The direction that matters: a check that always reported a leak would stop
	// every pass, and a check that never did would let a void run through.
	it("returns null when nothing is reachable, and reports every hit when all are", () => {
		expect(cal.leakReport({ forbidden, isReachable: () => false })).toBeNull();
		const all = cal.leakReport({ forbidden, isReachable: () => true }) ?? "";
		expect(all).toContain("expected.json");
		expect(all).toContain("cases/c1.md");
	});
});

describe("the isolation audit", () => {
	it("reports a key string and another session's directory, and nothing in clean output", () => {
		expect(cal.auditText({ text: "read the rubric, wrote the verdict", otherPaths: ["/t/s-other"] })).toEqual([]);
		const hits = cal.auditText({
			text: "I looked at mustQuoteOneOf in expected.json and at /t/s-other/spec.md",
			otherPaths: ["/t/s-other"],
		});
		expect(hits.join(" ")).toMatch(/mustQuoteOneOf/);
		expect(hits.join(" ")).toMatch(/expected\.json/);
		expect(hits.join(" ")).toMatch(/another session's path/);
	});

	// Half the strings are the key's own field names and half are paths. A
	// renamed field, or a moved directory, leaves the audit looking for something
	// that no longer exists, and an audit that can never hit is an audit that
	// always comes back clean.
	it("looks for field names the key contains and paths that exist", () => {
		// The corpus is every file of the set a reviewer is not given: the key,
		// the README that explains it, and the RUN.json of each committed run.
		// A field renamed in all of them is a field no session can leak.
		const corpus = [
			readFileSync(join(CAL, "expected.json"), "utf8"),
			readFileSync(join(CAL, "README.md"), "utf8"),
			...readdirSync(join(CAL, "runs"), { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => readFileSync(join(CAL, "runs", e.name, "RUN.json"), "utf8")),
		].join("\n");
		const paths = cal.LEAK_STRINGS.filter((s) => s.includes("/") || s.endsWith(".json"));
		const fields = cal.LEAK_STRINGS.filter((s) => !paths.includes(s));
		expect(fields.length, "the audit looks for no field name").toBeGreaterThan(2);
		expect(paths.length, "the audit looks for no path").toBeGreaterThan(1);
		for (const s of fields) {
			expect(corpus, `${s} is in no file of the set, so the audit is looking for nothing`).toContain(s);
		}
		for (const s of paths) {
			const found = existsSync(join(root, s)) || existsSync(join(CAL, s));
			expect(found, `${s} names no file or directory in this repository`).toBe(true);
		}
	});
});

describe("the module's surface", () => {
	// scripts/calibrate.d.mts is hand-written and nothing compiles it against the
	// script. This fails when an export it declares stops existing.
	it("exports every name the declaration file promises", () => {
		const declared = readFileSync(join(root, "scripts", "calibrate.d.mts"), "utf8");
		const names = [...declared.matchAll(/^export declare (?:function|const) (\w+)/gm)].map((m) => m[1]);
		expect(names.length).toBeGreaterThan(8);
		for (const n of names) expect(Object.keys(cal), `${n} is declared but not exported`).toContain(n);
	});
});

describe("the runner end to end, without a reviewer", () => {
	// --dry-run does everything except launch a model: the clone, the ref strip,
	// the leak check, the input directory and the prompt. One case, one ref, so
	// one clone.
	it("prepares a case from a clone that cannot reach the key", () => {
		const work = temp();
		const r = spawnSync(
			process.execPath,
			["scripts/calibrate.mjs", "run", "--harness", "pi", "--model", "m", "--cases", "c7", "--work", work, "--dry-run"],
			{ cwd: root, encoding: "utf8", timeout: 300_000 },
		);
		const out = `${r.stdout}${r.stderr}`;
		expect(r.status, out).toBe(0);
		expect(out).toContain("leak check clean");
		const prompt = readFileSync(join(work, "logs", "c7.prompt.txt"), "utf8");
		expect(prompt).toContain("Reviewer: pi, m");
		expect(prompt).not.toContain("Where the spec cites");
		const inputDir = /input: (\S+)/.exec(readFileSync(join(work, "logs", "c7.cmd.txt"), "utf8"))?.[1] as string;
		temps.push(inputDir);
		expect(readFileSync(join(inputDir, "spec.md"), "utf8")).toBe(readCase("c7"));
		const clone = join(work, `base-${key.cases.c7?.ref}`);
		for (const file of ["spec-review/calibration/expected.json", "spec-review/rubric.md"]) {
			const show = spawnSync("git", ["cat-file", "-e", `HEAD:${file}`], { cwd: clone, encoding: "utf8" });
			expect(show.status, `${file} is reachable from the reviewer's clone`).not.toBe(0);
		}
		expect(spawnSync("git", ["remote"], { cwd: clone, encoding: "utf8" }).stdout.trim()).toBe("");
	}, 300_000);

	// The agent is only an isolation gate if it reaches the session. kiro-cli
	// finds a workspace agent in <cwd>/.kiro/agents, so it has to be in the copy
	// the session runs in, and the argv has to name it.
	it("writes the MCP-free agent into the kiro-cli session's own copy and names it in the argv", () => {
		const work = temp();
		const r = spawnSync(
			process.execPath,
			["scripts/calibrate.mjs", "run", "--harness", "kiro-cli", "--model", "m", "--cases", "c4", "--work", work, "--dry-run"],
			{ cwd: root, encoding: "utf8", timeout: 300_000 },
		);
		expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
		const cmd = readFileSync(join(work, "logs", "c4.cmd.txt"), "utf8");
		expect(cmd).toContain("--agent reviewer");
		const sessionDir = /cwd: (\S+)/.exec(cmd)?.[1] as string;
		temps.push(sessionDir);
		const written = JSON.parse(readFileSync(join(sessionDir, ".kiro", "agents", "reviewer.json"), "utf8"));
		expect(written).toEqual(cal.reviewerAgent());
	}, 300_000);

	// countsTowardsShipBar is the whole blob rule's teeth. The runner writes it
	// false; a human flips it after reading score.mjs, and must say why.
	it("writes a non-counting RUN.json and flips it only through finalize, with a reason", () => {
		const dir = join(temp(), "run");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "RUN.json"), `${JSON.stringify({ runId: "x", countsTowardsShipBar: false, whyNot: "not scored" }, null, "\t")}\n`);
		const noWhy = spawnSync(process.execPath, ["scripts/calibrate.mjs", "finalize", dir, "--counts", "true"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(noWhy.status, "a run may not start counting without a reason").toBe(2);
		expect(JSON.parse(readFileSync(join(dir, "RUN.json"), "utf8")).countsTowardsShipBar).toBe(false);
		const ok = spawnSync(
			process.execPath,
			["scripts/calibrate.mjs", "finalize", dir, "--counts", "true", "--why", "score.mjs exits 0 over both passes"],
			{ cwd: root, encoding: "utf8" },
		);
		expect(ok.status, `${ok.stdout}${ok.stderr}`).toBe(0);
		const after = JSON.parse(readFileSync(join(dir, "RUN.json"), "utf8"));
		expect(after.countsTowardsShipBar).toBe(true);
		expect(after.why).toContain("score.mjs");
		expect(after.whyNot, "a counting run keeps no whyNot").toBeUndefined();
	});
});
