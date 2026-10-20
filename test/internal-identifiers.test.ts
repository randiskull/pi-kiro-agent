/**
 * Internal identifiers must not reach the tracked tree.
 *
 * This repository is published. The rubric's own reviewer rule is to name only
 * publicly available harnesses and models, and the same applies to the tooling
 * prose around it: an internal agent name or an internal MCP package scope is
 * not a secret, so `scripts/secret-scan.mjs` passes on it and gitleaks would
 * too, and it still should not ship.
 *
 * The patterns are assembled from fragments on purpose. A guard that spells the
 * banned string out matches itself, and then it has to exempt its own path,
 * which is the one file nobody rechecks. Built this way the guard scans itself
 * like every other tracked file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each pattern is built from pieces so this file contains none of them. */
const BANNED: { what: string; re: RegExp }[] = [
	{ what: "the internal agent-name prefix", re: new RegExp("amzn" + "-", "i") },
	{ what: "the internal MCP package scope", re: new RegExp("@" + "builder" + "-mcp", "i") },
	{ what: "the internal workspace-search tool", re: new RegExp("Workspace" + "Search") },
];

function trackedTextFiles(): string[] {
	const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
	return out
		.split("\0")
		.filter((p) => p.length > 0)
		.filter((p) => !/\.(png|jpg|jpeg|gif|ico|woff2?|bundle)$/i.test(p))
		.filter((p) => p !== "package-lock.json");
}

describe("internal identifiers stay out of the tracked tree", () => {
	const files = trackedTextFiles();

	it("has a file list to scan", () => {
		// A per-file loop over an empty list passes while measuring nothing.
		expect(files.length, "git ls-files returned nothing").toBeGreaterThan(100);
		expect(files, "this guard must scan itself").toContain("test/internal-identifiers.test.ts");
	});

	it("matches the strings it is meant to catch", () => {
		// Without this, a typo in a fragment makes every assertion below vacuous.
		const samples = [
			"kiro-cli's default agent is `amzn" + "-builder`",
			"`@" + "builder" + "-mcp/Workspace" + "Search` ran in the session",
		];
		for (const { what, re } of BANNED) {
			expect(
				samples.some((s) => re.test(s)),
				`the pattern for ${what} matches no known-bad sample`,
			).toBe(true);
		}
	});

	it("finds none of them in any tracked file", () => {
		const hits: string[] = [];
		for (const rel of files) {
			let text: string;
			try {
				text = readFileSync(resolve(repoRoot, rel), "utf8");
			} catch {
				continue; // deleted in the working tree; CI scans the committed tree
			}
			const lines = text.split("\n");
			for (const { what, re } of BANNED) {
				lines.forEach((line, i) => {
					if (re.test(line)) hits.push(`${rel}:${i + 1} (${what})`);
				});
			}
		}
		expect(hits, "internal identifiers in the tracked tree").toEqual([]);
	});
});
