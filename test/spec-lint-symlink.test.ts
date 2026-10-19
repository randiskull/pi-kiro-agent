/**
 * A cited path below a symlink is the author's own tree, not a broken citation.
 *
 * git refuses to answer any question about such a path ("beyond a symbolic
 * link"), and `git check-ignore` says so with a fatal, whose exit status is
 * non-zero exactly like "not ignored": read by exit status alone, a developer
 * who links a working directory into the repo (`.gsd` -> a project directory
 * elsewhere) saw real files reported as unresolved citations.
 *
 * Built on its own throwaway repository, because the condition cannot exist in
 * this repository's own checkout on CI: the two cited paths below differ in
 * nothing but whether their parent directory is a symlink.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const linter = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "spec-lint.mjs");

interface Check {
	id: string;
	pass: boolean;
	findings: string[];
}
interface LintResult {
	pass: boolean;
	checks: Check[];
	notes: Record<string, string[]>;
}

/** A spec of the shape spec-lint expects, citing `cites` in its goal. */
function spec(cites: string): string {
	return [
		"# Implementation Spec: symlinked citation",
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

describe("spec-lint on a citation below a symlink", () => {
	const scratch = mkdtempSync(join(tmpdir(), "spec-lint-symlink-"));
	const repo = join(scratch, "repo");
	const outside = join(scratch, "outside");
	let result: LintResult;
	let status: number | null;
	let stderr: string;

	beforeAll(() => {
		// A directory outside the repository, linked in under a name git tracks
		// nothing at: `linked/note.md` is a real file no ref contains.
		mkdirSync(join(outside, "research"), { recursive: true });
		writeFileSync(join(outside, "research", "note.md"), "# a note\n");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "bridge.ts"), "export function serveBridgeHttp(): void {}\n");
		writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "fixture", scripts: { verify: "true" } }, null, 2)}\n`);
		const git = (...args: string[]) => {
			const run = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
			if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
		};
		git("init", "-q", "-b", "main");
		git("-c", "user.email=t@example.com", "-c", "user.name=Test", "add", "src/bridge.ts", "package.json");
		git("-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "fixture");
		symlinkSync(outside, join(repo, "linked"));
		// The control: the same file, under a real directory instead of a link.
		mkdirSync(join(repo, "plain", "research"), { recursive: true });
		writeFileSync(join(repo, "plain", "research", "note.md"), "# a note\n");
		mkdirSync(join(repo, "docs", "specs"), { recursive: true });
		writeFileSync(
			join(repo, "docs", "specs", "sym.md"),
			spec("Reads `linked/research/note.md`, `plain/research/note.md` and `src/nope.ts`."),
		);

		const run = spawnSync(process.execPath, [linter, "--json", "--ref", "HEAD", "docs/specs/sym.md"], {
			cwd: repo,
			encoding: "utf8",
		});
		status = run.status;
		stderr = run.stderr;
		result = status === 2 ? ({} as LintResult) : (JSON.parse(run.stdout) as LintResult[])[0];
	});

	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	it("runs to a verdict rather than giving up (exit 0 or 1, never 2)", () => {
		expect(stderr).toBe("");
		expect([0, 1]).toContain(status);
	});

	it("lists the path below the symlink as local, and does not fail on it", () => {
		expect(result.notes.local).toContain("linked/research/note.md");
		expect(result.notes.external).not.toContain("linked/research/note.md");
		expect(result.checks.find((c) => c.id === "G2")?.findings.join("\n")).not.toContain("linked/");
	});

	// Without this, "every path is local" would pass the assertion above.
	it("still reports a missing path under a real directory (negative control)", () => {
		const g2 = result.checks.find((c) => c.id === "G2")?.findings.join("\n") ?? "";
		expect(g2).toContain("src/nope.ts");
		expect(result.notes.local).not.toContain("plain/research/note.md");
		expect(result.notes.external).toContain("plain/research/note.md");
	});
});
