/**
 * The Review procedure is referenced by number from three other places, and
 * those references are not checked by anything that runs.
 *
 * `scripts/calibrate.mjs` builds a prompt that says step 1 is already done,
 * that lint's notes are step 3's input, and that the reviewer should begin at
 * step 2. `expected.json`'s `shipBar.blind` quotes step 3 verbatim to explain
 * why the notes are handed over and the result is not. Rubric 4 split the old
 * step 7 in two, which renumbered nothing those three depend on - but the next
 * edit to the procedure can, silently, and the failure mode is a prompt that
 * confidently names the wrong step.
 *
 * So these tests do not grade the procedure's wording. They assert that the
 * claims other files make about it are true of the file as it stands.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { promptFor } from "../scripts/calibrate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rubric = readFileSync(join(root, "spec-review", "rubric.md"), "utf8");
const key = JSON.parse(readFileSync(join(root, "spec-review", "calibration", "expected.json"), "utf8"));

/**
 * The numbered steps of a `## Review procedure` section, as `number -> text`
 * with each step's continuation lines folded in.
 */
function procedureSteps(markdown: string): Map<number, string> {
	const section = markdown.split("## Review procedure")[1] ?? "";
	const body = section.split(/\n## /)[0];
	const steps = new Map<number, string>();
	let current: number | undefined;
	for (const line of body.split("\n")) {
		const started = /^(\d+)\.\s+(.*)$/.exec(line);
		if (started) {
			current = Number(started[1]);
			if (steps.has(current)) throw new Error(`step ${current} appears twice`);
			steps.set(current, started[2]);
			continue;
		}
		if (current !== undefined && /^\s+\S/.test(line)) {
			steps.set(current, `${steps.get(current)} ${line.trim()}`);
			continue;
		}
		if (line.trim() === "") continue;
		current = undefined;
	}
	return steps;
}

const steps = procedureSteps(rubric);

describe("the rubric's Review procedure, as other files describe it", () => {
	// Without this the assertions below would pass on an empty extraction.
	it("extracts the steps it checks", () => {
		expect(steps.size).toBeGreaterThanOrEqual(8);
		expect([...steps.values()].every((s) => s.trim().length > 0)).toBe(true);
		expect([...steps.values()].join(" ").length).toBeGreaterThan(800);
	});

	it("numbers its steps from 1 with no gaps", () => {
		expect([...steps.keys()].sort((a, b) => a - b)).toEqual(
			Array.from({ length: steps.size }, (_, i) => i + 1),
		);
	});

	// The extractor has to be able to report a gap, or the test above is
	// satisfied by a parser that cannot see one.
	it("reports a gap when there is one", () => {
		const planted = "## Review procedure\n\n1. Run lint.\n3. Read the spec.\n";
		expect([...procedureSteps(planted).keys()]).toEqual([1, 3]);
		expect(() => procedureSteps("## Review procedure\n\n1. a\n1. b\n")).toThrow(/twice/);
	});

	it("puts lint at step 1 and its notes at step 3, which is what the prompt claims", () => {
		const prompt = promptFor({
			inputDir: "/in",
			verdictPath: "/in/v.md",
			lintNotesPath: "/in/lint-notes.json",
			reviewerLine: "Reviewer: h, m",
		});
		expect(prompt).toContain("Step 1 is already done");
		expect(prompt).toContain("step 3's input");
		expect(prompt).toContain("Begin at step 2");

		expect(steps.get(1)).toMatch(/\blint\b/i);
		expect(steps.get(3)).toMatch(/\blint\b/i);
		expect(steps.get(3)).toMatch(/\bnotes\b/i);
		// Step 2 is where the reviewer is told to begin, so it must not be the
		// one that runs lint.
		expect(steps.get(2)).not.toMatch(/\bRun lint\b/);
	});

	// shipBar.blind's whole argument rests on step 3 asking for lint's notes,
	// and it quotes the step to make that argument. An edit to the step that
	// leaves the quote behind turns the key's reasoning into a misquote.
	it("still says, word for word, what shipBar.blind quotes it as saying", () => {
		const step3 = steps.get(3)?.replace(/\.$/, "");
		expect(step3, "step 3 did not parse").toBeTruthy();
		expect(key.shipBar.blind as string).toContain(step3 as string);
	});

	it("has a heading for every gate and dimension the key labels", () => {
		const labelled = new Set<string>();
		for (const c of Object.values(key.cases) as { review: { gates: object; dimensions: object } }[]) {
			for (const g of Object.keys(c.review.gates)) labelled.add(g);
			for (const d of Object.keys(c.review.dimensions)) labelled.add(d);
		}
		expect(labelled.size).toBeGreaterThanOrEqual(11);
		for (const name of [...labelled].sort()) {
			expect(rubric, `rubric.md has no ### ${name} heading`).toMatch(
				new RegExp(`^### ${name} `, "m"),
			);
		}
	});

	it("agrees with the key about the rubric number, on every line that states it", () => {
		// exec() returns the first match only, so the header alone was checked and
		// the verdict template's line could drift to any other number unnoticed.
		const stated = [...rubric.matchAll(/^Rubric: (\d+)$/gm)].map((m) => m[1]);
		expect(stated.length, "rubric.md states its number in the header and the verdict template").toBe(2);
		expect(new Set(stated).size, `rubric.md states two different numbers: ${stated.join(", ")}`).toBe(1);
		for (const n of stated) expect(n).toBe(String(key.rubric));
	});
});
