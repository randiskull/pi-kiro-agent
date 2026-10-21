/**
 * The runner's guards, and the three the PR review of #75 found untested.
 *
 * `test/calibrate.test.ts` holds the units: the prompt, the plan, the verdict
 * check, the agent, the audit. What it did not hold was whether the guards are
 * WIRED - a mutant whose `leakCheck` returned immediately left 32 of 32 passing,
 * because every assertion was about `leakReport`'s return value and none about a
 * call site refusing a run. Nor were the numeric flags, the date, the temp-
 * directory discipline or `finalize`'s refusals covered at all.
 *
 * Everything here drives the script as a subprocess, because "the run is void
 * and nothing was launched" is a property of the process and not of a function.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	aliasPlacements,
	checkedDate,
	PROMPT_FINGERPRINT_INPUT,
	promptFingerprint,
	promptFor,
	positiveInt,
} from "../scripts/calibrate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "scripts", "calibrate.mjs");
const temps: string[] = [];

function temp(): string {
	const d = mkdtempSync(join(tmpdir(), "cal-guard-"));
	temps.push(d);
	return d;
}

afterAll(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A dry run of one case: everything the runner does except launch a model. */
function dryRun(work: string, extra: string[] = [], env: Record<string, string> = {}) {
	const r = spawnSync(
		process.execPath,
		[runner, "run", "--harness", "pi", "--model", "a-model", "--cases", "c7", "--work", work, "--dry-run", ...extra],
		{ cwd: root, encoding: "utf8", env: { ...process.env, ...env } },
	);
	return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("numeric and date flags are checked before anything runs", () => {
	it("rejects a --jobs or --timeout-min that is not a whole number above zero", () => {
		// --jobs abc built Array.from({length: NaN}): zero lanes, exit 0, and in a
		// real run a RUN.json with no verdicts. --timeout-min abc passed NaN to
		// setTimeout, which Node treats as 1ms, killing every session at once.
		for (const bad of ["abc", "0", "-2", "1.5", ""]) {
			expect(() => positiveInt(bad, "jobs"), `positiveInt accepted ${JSON.stringify(bad)}`).toThrow(/whole number above zero/);
		}
		expect(positiveInt("4", "jobs")).toBe(4);
	});

	it("rejects a --date that is not a real yyyy-mm-dd", () => {
		// The date goes into the run id AND the run directory path.
		for (const bad of ["../../x", "2026-13-45", "26-1-1", "2026-02-30", "today"]) {
			expect(() => checkedDate(bad), `checkedDate accepted ${JSON.stringify(bad)}`).toThrow(/real yyyy-mm-dd/);
		}
		expect(checkedDate("2026-10-20")).toBe("2026-10-20");
	});

	it("refuses them at the command line too, with nothing prepared", () => {
		for (const args of [
			["--jobs", "abc"],
			["--timeout-min", "abc"],
			["--date", "../../x"],
		]) {
			const work = temp();
			const r = dryRun(work, args);
			expect(r.code, `${args.join(" ")}: ${r.out}`).toBe(2);
			expect(existsSync(join(work, "sessions")), `${args.join(" ")} prepared a session`).toBe(false);
		}
	});
});

describe("the alias guard", () => {
	it("refuses a path that is absolute, backslashed, drive-lettered or climbing", () => {
		for (const cited of ["/etc/passwd", "C:/x/y.md", "docs\\specs\\x.md", "../../x.md", "docs/../../x.md"]) {
			expect(
				() => aliasPlacements({ sessionDir: "/tmp/s", aliases: [{ cited, target: "t.md" }] }),
				`accepted ${JSON.stringify(cited)}`,
			).toThrow();
		}
	});

	it("places an ordinary repo-relative path inside the session clone", () => {
		const [p] = aliasPlacements({
			sessionDir: "/tmp/s",
			aliases: [{ cited: "docs/specs/x.md", target: "spec-review/calibration/cases/c2.md" }],
		});
		expect(p.to).toBe("/tmp/s/docs/specs/x.md");
	});
});

describe("the prompt fingerprint", () => {
	it("is a stable sha256 of the wording, not of the paths", () => {
		const fp = promptFingerprint();
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
		expect(promptFingerprint(), "not stable across calls").toBe(fp);
		// The point of the placeholders: two runs of a pair use different temp
		// directories and different reviewer lines, and must still record the same
		// wording. A fingerprint over the real paths could never be compared.
		const real = promptFor({
			inputDir: "/tmp/in-aaa",
			verdictPath: "/tmp/in-aaa/verdict.md",
			lintNotesPath: "/tmp/in-aaa/lint-notes.json",
			reviewerLine: "Reviewer: pi, some-model",
		});
		expect(real, "the template is path-independent, so this test proves nothing").not.toBe(promptFor(PROMPT_FINGERPRINT_INPUT));
		expect(promptFor(PROMPT_FINGERPRINT_INPUT)).toContain("<input>");
	});

	it("changes when the wording changes", () => {
		// Without this, a fingerprint that hashed a constant would pass above.
		const a = promptFor(PROMPT_FINGERPRINT_INPUT);
		const b = `${a} And one more instruction.`;
		expect(a).not.toBe(b);
		const sha = (s: string) => execFileSync("git", ["hash-object", "--stdin"], { input: s, encoding: "utf8" }).trim();
		expect(sha(a)).not.toBe(sha(b));
	});

	// The README quotes the prompt, and the quote had drifted by two sentences:
	// a reader of the protocol was reading instructions no session was sent.
	it("is the wording the calibration README quotes", () => {
		const readme = readFileSync(join(root, "spec-review", "calibration", "README.md"), "utf8");
		const blocks = [...readme.matchAll(/(?:^> .*\n)+/gm)].map((m) => m[0]);
		const quoted = blocks
			.map((b) =>
				b
					.split("\n")
					.filter((l) => l.startsWith("> "))
					.map((l) => l.slice(2).trim())
					.join(" "),
			)
			.filter((t) => t.startsWith("Review the implementation spec"));
		expect(quoted.length, "the README no longer quotes the prompt under a > block").toBe(1);
		expect(quoted[0]).toBe(promptFor(PROMPT_FINGERPRINT_INPUT));
	});
});

describe("the leak check is wired, not merely written", () => {
	// This is the gap the review named: every existing assertion was about
	// leakReport's return value, so a leakCheck that returned immediately passed
	// the whole suite. CALIBRATE_ASSUME_LEAK makes every forbidden blob read as
	// reachable; it can only make the runner refuse.
	it("voids the run from the call site, before any session is prepared", () => {
		const work = temp();
		const r = dryRun(work, [], { CALIBRATE_ASSUME_LEAK: "1" });
		expect(r.code, r.out).toBe(2);
		expect(r.out).toContain("LEAK: the key is reachable");
		expect(r.out).toContain("nothing was launched");
		expect(existsSync(join(work, "sessions")), "a session was prepared despite the leak").toBe(false);
	});

	it("passes with the seam off, so the test above is not asserting a broken runner", () => {
		const work = temp();
		const r = dryRun(work);
		expect(r.code, r.out).toBe(0);
		expect(r.out).toContain("leak check clean");
	});

	it("forbids the history of the key, not only its current blob", () => {
		// Both refs this set uses predate expected.json, so the current-blob-only
		// check passed for a reason that is a property of two commit ids. A case
		// added at a later ref would have exposed every older key.
		const work = temp();
		const r = dryRun(work);
		const m = /forbidden blobs checked per clone/.exec(r.out);
		expect(m, r.out).not.toBeNull();
		const count = Number(/prepared\s+\d+ session\(s\), (\d+) forbidden blobs/.exec(r.out)?.[1]);
		const caseCount = Object.keys(
			JSON.parse(readFileSync(join(root, "spec-review", "calibration", "expected.json"), "utf8")).cases,
		).length;
		expect(count, "only the current blobs are forbidden").toBeGreaterThan(caseCount + 1);
	});

	it("leaves no forbidden blob reachable in the clone it built, by blob sha", () => {
		// The e2e test checks `HEAD:<path>` is absent, which is true at any ref
		// older than the file whatever the object database holds. `cat-file -e
		// <blob>` is the question that matters.
		const work = temp();
		expect(dryRun(work).code).toBe(0);
		const clone = readdirSync(work).find((d) => d.startsWith("base-"));
		expect(clone, `no base clone under ${work}`).toBeDefined();
		const cal = join(root, "spec-review", "calibration");
		const blobs = [
			join(cal, "expected.json"),
			...readdirSync(join(cal, "cases")).map((f) => join(cal, "cases", f)),
		].map((p) => execFileSync("git", ["hash-object", p], { encoding: "utf8" }).trim());
		expect(blobs.length).toBeGreaterThan(1);
		for (const sha of blobs) {
			const r = spawnSync("git", ["cat-file", "-e", sha], { cwd: join(work, clone as string), encoding: "utf8" });
			expect(r.status, `blob ${sha.slice(0, 12)} is reachable in the clone`).not.toBe(0);
		}
	});
});

describe("the runner leaves nothing outside --work", () => {
	it("creates no directory in the system temp directory", () => {
		// A full clone per case and an input directory per case were created with
		// mkdtemp in tmpdir() and never removed, so every run and every
		// `npm run verify` left two more behind.
		const before = new Set(readdirSync(tmpdir()));
		const work = mkdtempSync(join(tmpdir(), "cal-guard-work-"));
		try {
			expect(dryRun(work).code).toBe(0);
			const added = readdirSync(tmpdir()).filter((e) => !before.has(e) && e !== require("node:path").basename(work));
			expect(added, `the runner left ${added.join(", ")} in ${tmpdir()}`).toEqual([]);
			expect(existsSync(join(work, "sessions", "c7")), "the session copy is not under --work").toBe(true);
			expect(existsSync(join(work, "inputs", "c7")), "the input directory is not under --work").toBe(true);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("finalize refuses what can never count", () => {
	function runDir(run: Record<string, unknown>): string {
		const d = temp();
		mkdirSync(join(d, "r"), { recursive: true });
		writeFileSync(join(d, "r", "RUN.json"), `${JSON.stringify(run, null, "\t")}\n`);
		return join(d, "r");
	}

	function finalize(dir: string, counts: string) {
		const r = spawnSync(process.execPath, [runner, "finalize", dir, "--counts", counts, "--why", "a reason"], {
			cwd: root,
			encoding: "utf8",
		});
		return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
	}

	const spent = JSON.parse(
		readFileSync(join(root, "spec-review", "calibration", "expected.json"), "utf8"),
	).shipBar.spent as string[];

	it("has a non-empty shipBar.spent to refuse from", () => {
		expect(spent.length).toBeGreaterThan(0);
	});

	it("refuses --counts true on a run recorded as a probe", () => {
		const r = finalize(runDir({ model: "a-fresh-model", probe: true }), "true");
		expect(r.code, r.out).toBe(2);
		expect(r.out).toContain("a probe is never one of the two");
	});

	it("refuses --counts true on a model already in shipBar.spent", () => {
		const r = finalize(runDir({ model: spent[0], probe: false }), "true");
		expect(r.code, r.out).toBe(2);
		expect(r.out).toContain("shipBar.spent");
	});

	it("still allows --counts true on a fresh model, so the refusals are not blanket", () => {
		const dir = runDir({ model: "a-fresh-model", probe: false });
		const r = finalize(dir, "true");
		expect(r.code, r.out).toBe(0);
		expect(JSON.parse(readFileSync(join(dir, "RUN.json"), "utf8")).countsTowardsShipBar).toBe(true);
	});

	it("allows --counts false on a probe, which is how a probe is recorded", () => {
		const r = finalize(runDir({ model: spent[0], probe: true }), "false");
		expect(r.code, r.out).toBe(0);
	});
});

describe("a run on a spent model is a probe whether or not it says so", () => {
	it("says so before preparing anything", () => {
		const spent = JSON.parse(
			readFileSync(join(root, "spec-review", "calibration", "expected.json"), "utf8"),
		).shipBar.spent as string[];
		const work = temp();
		const r = spawnSync(
			process.execPath,
			[runner, "run", "--harness", "pi", "--model", spent[0], "--cases", "c7", "--work", work, "--dry-run"],
			{ cwd: root, encoding: "utf8" },
		);
		expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("probe     yes");
		expect(r.stdout).toContain("shipBar.spent");
	});
});
