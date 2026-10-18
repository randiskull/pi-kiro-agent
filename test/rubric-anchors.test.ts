/**
 * The rubric's anchors must not quote a calibration case.
 *
 * Review item 7: three anchors were sharpened by copying the exact phrase out of
 * the case they were meant to catch (G1 from c2, G5 from c2, D1 from c6). A case
 * graded by recognising its own text measures nothing, and editing the three is
 * only the easy half: the next person to sharpen an anchor against a case would
 * put it back. This test is the durable half.
 *
 * What counts as a quoted example: a double-quoted or backticked span in
 * spec-review/rubric.md of three or more words. Single words are not examples -
 * banning them would ban the rubric's own vocabulary (it has to be able to say
 * "likely" to describe a hedge) - and a two-word span is too short to be
 * recognisable. Section headings and the negative-control bullet are exempt by
 * shape, not by name: this rubric REQUIRES them of every spec and lint checks
 * for them, so every case necessarily contains them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const casesDir = join(root, "spec-review", "calibration", "cases");

/** A heading, or a `- **Bold` bullet: structure this rubric mandates. */
const STRUCTURAL = /^(#{1,6}\s|-\s\*\*)/;
const MIN_WORDS = 3;
const MIN_CHARS = 8;

interface Span {
	line: number;
	text: string;
	needle: string;
}

/** Every quoted example in `markdown`, with the structural spans dropped. */
function quotedExamples(markdown: string): Span[] {
	const out: Span[] = [];
	for (const re of [/"([^"\n]{1,200})"/g, /`([^`\n]{1,200})`/g]) {
		for (const m of markdown.matchAll(re)) {
			const text = m[1];
			const needle = text.trim().replace(/\.+$/, "").trim();
			if (needle.split(/\s+/).filter(Boolean).length < MIN_WORDS) continue;
			if (needle.length < MIN_CHARS) continue;
			if (STRUCTURAL.test(needle)) continue;
			out.push({ line: markdown.slice(0, m.index).split("\n").length, text, needle });
		}
	}
	return out.sort((a, b) => a.line - b.line);
}

function leaksIn(markdown: string, cases: Map<string, string>): string[] {
	const found: string[] = [];
	for (const span of quotedExamples(markdown)) {
		for (const [name, text] of cases) {
			if (text.toLowerCase().includes(span.needle.toLowerCase())) {
				found.push(`rubric.md:${span.line} quotes ${name}: ${JSON.stringify(span.text)}`);
				break;
			}
		}
	}
	return found;
}

const cases = new Map(
	readdirSync(casesDir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((f) => [f, readFileSync(join(casesDir, f), "utf8")] as const),
);
const rubric = readFileSync(join(root, "spec-review", "rubric.md"), "utf8");

describe("spec-review/rubric.md does not quote the calibration cases", () => {
	it("reads the cases it grades against", () => {
		expect(cases.size).toBe(8);
	});

	// Without this, an extractor that returned nothing would satisfy the
	// assertion below by having nothing to check.
	it("finds quoted examples to check", () => {
		const spans = quotedExamples(rubric);
		expect(spans.length, "no quoted examples found; the extractor is broken, not the rubric clean").toBeGreaterThan(5);
	});

	it("no anchor quotes three or more words of any case", () => {
		expect(leaksIn(rubric, cases)).toEqual([]);
	});

	// The check has to be able to fail. If this ever passes, the matcher is
	// broken and the assertion above is vacuous.
	it("catches an anchor that does quote a case", () => {
		const c6 = cases.get("c6.md");
		expect(c6).toBeDefined();
		const phrase = "The bridge probably holds the loop open";
		expect(c6).toContain(phrase);
		const planted = `### D1\n\n- **Fails:** hedged, for example "${phrase}".\n`;
		const found = leaksIn(planted, cases);
		expect(found).toHaveLength(1);
		expect(found[0]).toContain("c6.md");
	});

	// The structural exemption must exempt structure, not everything. If it
	// swallowed ordinary anchors the test above would pass on a leaking rubric.
	it("exempts structure without exempting anchors", () => {
		const structural = `- **Negative control** and "## Verification plan"`;
		expect(quotedExamples(structural)).toEqual([]);
		const anchor = `- **Fails:** a behaviour left as "pick the lightest option".`;
		expect(quotedExamples(anchor).map((s) => s.needle)).toEqual(["pick the lightest option"]);
	});
});
