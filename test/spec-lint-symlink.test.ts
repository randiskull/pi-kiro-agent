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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * What the assertions read when the linter could not verify (exit 2). Empty
 * rather than undefined, so a fatal fails the first test below on its status
 * and stderr instead of failing all three on a property of undefined.
 */
const UNVERIFIED: LintResult = { pass: false, checks: [], notes: { local: [], external: [] } };

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

/** A git repository at `repo` with `src/bridge.ts` and `package.json` committed. */
function fixtureRepo(repo: string): void {
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
}

/** spec-lint's answer, at HEAD, for `docs/specs/sym.md` citing `cites`. */
function lintFixture(repo: string, cites: string): { status: number | null; stderr: string; result: LintResult } {
	mkdirSync(join(repo, "docs", "specs"), { recursive: true });
	writeFileSync(join(repo, "docs", "specs", "sym.md"), spec(cites));
	const run = spawnSync(process.execPath, [linter, "--json", "--ref", "HEAD", "docs/specs/sym.md"], {
		cwd: repo,
		encoding: "utf8",
	});
	const result = run.status === 2 ? UNVERIFIED : ((JSON.parse(run.stdout) as LintResult[])[0] ?? UNVERIFIED);
	return { status: run.status, stderr: run.stderr, result };
}

/** A path component longer than any filesystem allows (ENAMETOOLONG). */
const TOO_LONG = `plain/${"x".repeat(300)}.md`;

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
		fixtureRepo(repo);
		symlinkSync(outside, join(repo, "linked"));
		// The control: the same file, under a real directory instead of a link.
		mkdirSync(join(repo, "plain", "research"), { recursive: true });
		writeFileSync(join(repo, "plain", "research", "note.md"), "# a note\n");
		({ status, stderr, result } = lintFixture(
			repo,
			`Reads \`linked/research/note.md\`, \`plain/research/note.md\`, \`../outside/research/note.md\`, \`${TOO_LONG}\` and \`src/nope.ts\`.`,
		));
	});

	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	it("runs to a verdict rather than giving up (exit 0 or 1, never 2)", () => {
		expect(stderr, "spec-lint could not verify the fixture repository").toBe("");
		expect([0, 1], stderr).toContain(status);
	});

	it("lists the path below the symlink as local, and does not fail on it", () => {
		expect(result.notes.local).toContain("linked/research/note.md");
		expect(result.notes.external).not.toContain("linked/research/note.md");
		expect(result.checks.find((c) => c.id === "G2")?.findings.join("\n")).not.toContain("linked/");
	});

	// A path that climbs out of the repository reaches the same code and is not
	// this case: whatever sits above the repository root, it is not the author's
	// tree inside it. Its route to `external`: underSymlink() stops at `..`, git
	// check-ignore declines a path outside the repository (non-zero, read as not
	// ignored), `..` is not a top-level directory and is no typo of one, so
	// resolvePath() ends at its closing external note.
	it("does not call a path above the repository root local", () => {
		expect(result.notes.local).not.toContain("../outside/research/note.md");
		expect(result.notes.external).toContain("../outside/research/note.md");
	});

	// lstat answers ENAMETOOLONG for it. That means nothing can be there, like
	// ENOENT: an odd citation still gets its ordinary answer, and does not stop
	// the whole spec as unverifiable (the exit 2 the first test rules out).
	it("treats a component too long to exist as absent, not as unverifiable", () => {
		expect(result.notes.local).not.toContain(TOO_LONG);
		expect(result.notes.external).toContain(TOO_LONG);
	});

	// Without this, "every path is local" would pass the assertion above.
	it("still reports a missing path under a real directory (negative control)", () => {
		const g2 = result.checks.find((c) => c.id === "G2")?.findings.join("\n") ?? "";
		expect(g2).toContain("src/nope.ts");
		expect(result.notes.local).not.toContain("plain/research/note.md");
		expect(result.notes.external).toContain("plain/research/note.md");
	});
});

// root ignores directory permissions, so the condition cannot be built as root;
// Windows has no POSIX mode bits to remove.
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!canLock)("spec-lint on a citation it cannot look below", () => {
	const scratch = mkdtempSync(join(tmpdir(), "spec-lint-locked-"));
	const repo = join(scratch, "repo");
	const locked = join(repo, "locked");
	let run: ReturnType<typeof lintFixture>;

	beforeAll(() => {
		fixtureRepo(repo);
		mkdirSync(join(locked, "inner"), { recursive: true });
		writeFileSync(join(locked, "inner", "note.md"), "# a note\n");
		chmodSync(locked, 0o000);
		run = lintFixture(repo, "Reads `locked/inner/note.md`.");
	});

	afterAll(() => {
		chmodSync(locked, 0o755);
		rmSync(scratch, { recursive: true, force: true });
	});

	// lstat answers EACCES below `locked/`: whether `inner` is a symlink is not
	// known, so neither "local" nor "external" is an answer. A guess here would
	// read as a verdict; exit 2 says the spec was not verified, and names why.
	it("stops as unverifiable (exit 2), naming the path and the error", () => {
		expect(run.status).toBe(2);
		expect(run.stderr).toContain("locked/inner/note.md");
		expect(run.stderr).toContain("EACCES");
	});
});
