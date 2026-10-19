/**
 * score.mjs must enforce shipBar.blobs, because criterion 12 of
 * docs/specs/spec-review-bus.md is its exit code.
 *
 * The rule in spec-review/calibration/expected.json reads: "Every run directory
 * carries RUN.json with the git blob sha of spec-review/rubric.md and of this file
 * as they stood when it was scored, plus the case blobs. A run counts towards the
 * ship bar only when both match the committed blobs at the merge commit. This is
 * what makes a stale run visible instead of plausible."
 *
 * Before this test the scorer read `scoredAgainst.cases` as a list of names and
 * nothing else, so every blob in every RUN.json and `countsTowardsShipBar` itself
 * were inert. The committed consequence was live: scoring the two pass-8 runs,
 * which SCORE.md declares WITHDRAWN and which both record
 * `countsTowardsShipBar: false` over pre-review blobs, printed `30/30`,
 * `cases with a miss: 0` and exited 0. The last test here pins that.
 *
 * The expected shas are taken from `git hash-object`, not recomputed with the same
 * formula the scorer uses, so this also holds that the scorer computes git blob
 * shas rather than some other digest that happens to be self-consistent.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realScorer = join(root, "spec-review", "calibration", "score.mjs");

/** The blob sha git itself would store, as an oracle independent of the scorer. */
function gitBlob(path: string): string {
	return execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim();
}

interface Run {
	exitCode: number;
	out: string;
}

function runScorer(scorer: string, dirs: string[]): Run {
	try {
		const out = execFileSync("node", [scorer, ...dirs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { exitCode: 0, out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return { exitCode: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

const VERDICT = `spec-review verdict for spec.md blob irrelevant
Reviewer: other, test-fixture
Outcome: pass

## Gates

- G1 pass
- G2 pass
- G3 pass
- G4 pass
- G5 pass

## Dimensions

- D1 4
- D2 4
- D3 4
- D4 4
- D5 4
- D6 4

## Findings

- [D1] nothing of substance; this fixture exists to exercise the blob check.
`;

const EXPECTED_KEY = {
	rubric: 99,
	ref: "0000000",
	cases: {
		f1: {
			source: "fixture",
			review: { outcome: "pass", gates: { G1: "pass", G2: "pass", G3: "pass", G4: "pass", G5: "pass" } },
		},
	},
	shipBar: { blobs: "fixture copy of the real rule" },
};

/**
 * A self-contained tree with the same shape score.mjs resolves against: it reads
 * expected.json, ../rubric.md and cases/ relative to its own directory, so the
 * scorer is copied in rather than pointed at a fixture.
 */
function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "spec-review-score-"));
	const calib = join(dir, "spec-review", "calibration");
	mkdirSync(join(calib, "cases"), { recursive: true });
	mkdirSync(join(calib, "runs", "r1"), { recursive: true });
	writeFileSync(join(dir, "spec-review", "rubric.md"), "# Fixture rubric\n\nRubric 99.\n");
	writeFileSync(join(calib, "expected.json"), `${JSON.stringify(EXPECTED_KEY, null, "\t")}\n`);
	writeFileSync(join(calib, "cases", "f1.md"), "# Fixture case f1\n\nNothing to review.\n");
	writeFileSync(join(calib, "runs", "r1", "f1.verdict.md"), VERDICT);
	copyFileSync(realScorer, join(calib, "score.mjs"));
	const truth = {
		rubric: gitBlob(join(dir, "spec-review", "rubric.md")),
		expected: gitBlob(join(calib, "expected.json")),
		f1: gitBlob(join(calib, "cases", "f1.md")),
	};
	const writeRun = (scoredAgainst: unknown, counts: unknown) => {
		const body: Record<string, unknown> = { runId: "r1", harness: "other", model: "test-fixture" };
		if (scoredAgainst !== undefined) body.scoredAgainst = scoredAgainst;
		if (counts !== undefined) body.countsTowardsShipBar = counts;
		writeFileSync(join(calib, "runs", "r1", "RUN.json"), `${JSON.stringify(body, null, "\t")}\n`);
	};
	const score = () => runScorer(join(calib, "score.mjs"), [join(calib, "runs", "r1")]);
	const honest = () => ({ rubric: truth.rubric, expected: truth.expected, cases: { f1: truth.f1 } });
	return { dir, calib, truth, writeRun, score, honest };
}

const fixtures: string[] = [];
function fixture() {
	const f = makeFixture();
	fixtures.push(f.dir);
	return f;
}

afterAll(() => {
	for (const d of fixtures) rmSync(d, { recursive: true, force: true });
});

describe("score.mjs enforces shipBar.blobs", () => {
	// Without this the exit-1 assertions below would all pass on a scorer that
	// can never exit 0, which proves nothing about the blob check.
	it("exits 0 on a run that records matching blobs and claims to count", () => {
		const f = fixture();
		f.writeRun(f.honest(), true);
		const r = f.score();
		expect(r.out).toContain("blobs: match");
		expect(r.out).toContain("the run counts");
		expect(r.exitCode, r.out).toBe(0);
	});

	it("fails a run whose case blob does not match the case here", () => {
		const f = fixture();
		const against = f.honest();
		against.cases.f1 = "0".repeat(40);
		f.writeRun(against, true);
		const r = f.score();
		expect(r.exitCode, r.out).toBe(1);
		expect(r.out).toContain("cases/f1.md");
		expect(r.out).toContain(f.truth.f1.slice(0, 12));
		expect(r.out).toContain("do not count");
	});

	it("fails a run whose rubric blob does not match the rubric here", () => {
		const f = fixture();
		const against = { ...f.honest(), rubric: "1".repeat(40) };
		f.writeRun(against, true);
		const r = f.score();
		expect(r.exitCode, r.out).toBe(1);
		expect(r.out).toContain("spec-review/rubric.md");
		expect(r.out).toContain(f.truth.rubric.slice(0, 12));
	});

	it("fails a run whose answer-key blob does not match the key here", () => {
		const f = fixture();
		const against = { ...f.honest(), expected: "2".repeat(40) };
		f.writeRun(against, true);
		const r = f.score();
		expect(r.exitCode, r.out).toBe(1);
		expect(r.out).toContain("expected.json");
		expect(r.out).toContain(f.truth.expected.slice(0, 12));
	});

	// The shape the mutation probe exercised: a run asserting it counts over blobs
	// it was not scored against. It has to be named as a contradiction, not merely
	// skipped, because that is the one a reader would otherwise believe.
	it("calls out countsTowardsShipBar: true over stale blobs as a contradiction", () => {
		const f = fixture();
		const against = { ...f.honest(), rubric: "3".repeat(40) };
		f.writeRun(against, true);
		const r = f.score();
		expect(r.exitCode, r.out).toBe(1);
		expect(r.out).toContain("STALE");
		expect(r.out).toContain("countsTowardsShipBar: true");
	});

	it("fails a run that declares countsTowardsShipBar false even with matching blobs", () => {
		const f = fixture();
		f.writeRun(f.honest(), false);
		const r = f.score();
		expect(r.exitCode, r.out).toBe(1);
		expect(r.out).toContain("countsTowardsShipBar is not true");
	});

	it("fails a run that records no blob for a case in the key", () => {
		const f = fixture();
		f.writeRun({ rubric: f.truth.rubric, expected: f.truth.expected, cases: {} }, true);
		const r = f.score();
		expect(r.exitCode, r.out).toBe(1);
		expect(r.out).toContain("no blob recorded for f1");
	});

	it("fails a run with no scoredAgainst, and one with no RUN.json", () => {
		const noneRecorded = fixture();
		noneRecorded.writeRun(undefined, true);
		const a = noneRecorded.score();
		expect(a.exitCode, a.out).toBe(1);
		expect(a.out).toContain("no scoredAgainst");

		const noRunJson = fixture();
		rmSync(join(noRunJson.calib, "runs", "r1", "RUN.json"), { force: true });
		const b = noRunJson.score();
		expect(b.exitCode, b.out).toBe(1);
		expect(b.out).toContain("no RUN.json");
	});

	// A tidier fixture than the repository would let the defect live here. These
	// are the real committed runs, and the pair below is the one that scored 30/30
	// with zero misses and exit 0 before the blob check existed.
	it("fails every committed run, which all record countsTowardsShipBar: false", () => {
		const runs = join(root, "spec-review", "calibration", "runs");
		const names = [
			"2026-10-17-r1-other-claude-opus-5-5",
			"2026-10-17-r1-other-gpt-6-astra",
			"2026-10-17-r1-kiro-cli-claude-sonnet-5",
			"2026-10-17-r1-gsd-us-anthropic-claude-fable-5-1",
			"2026-10-17-r1-kiro-cli-gpt-5-6-sol",
		];
		for (const name of names) {
			const run = JSON.parse(readFileSync(join(runs, name, "RUN.json"), "utf8"));
			expect(run.countsTowardsShipBar, `${name} is expected to be a non-counting run`).toBe(false);
			const r = runScorer(realScorer, [join(runs, name)]);
			expect(r.exitCode, `${name}\n${r.out}`).toBe(1);
			expect(r.out).toContain("do not count");
		}
	});

	it("fails the withdrawn pass-8 pair, which reaches 30/30 and no miss", () => {
		const runs = join(root, "spec-review", "calibration", "runs");
		const r = runScorer(realScorer, [
			join(runs, "2026-10-17-r1-other-claude-opus-5-5"),
			join(runs, "2026-10-17-r1-other-gpt-6-astra"),
		]);
		// The transcript is unchanged: the pair really does agree on everything and
		// miss nothing. Only the exit, and the reason, are different.
		expect(r.out).toContain("gate agreement: 30/30");
		expect(r.out).toContain("cases with a miss: 0");
		expect(r.out).toContain("runs that do not count: 2/2");
		expect(r.exitCode, r.out).toBe(1);
	});
});
