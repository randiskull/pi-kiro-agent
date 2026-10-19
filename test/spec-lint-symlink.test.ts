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
import { stripGitEnv } from "./global-setup.js";

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

/**
 * The environment for anything run against a fixture repository: this one
 * without git's GIT_* variables. A git hook (this repository's pre-push runs the
 * suite) exports GIT_DIR, and git obeys it over the working directory, so an
 * inherited GIT_DIR sent the fixture's `git init`, `add` and `commit` into the
 * repository being pushed, committing the fixture's files over its own.
 */
function fixtureEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	stripGitEnv(env);
	return env;
}

/** A git repository at `repo` with `src/bridge.ts` and `package.json` committed. */
function fixtureRepo(repo: string): void {
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "bridge.ts"), "export function serveBridgeHttp(): void {}\n");
	writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "fixture", scripts: { verify: "true" } }, null, 2)}\n`);
	const git = (...args: string[]) => {
		const run = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: fixtureEnv() });
		if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
	};
	git("init", "-q", "-b", "main");
	git("-c", "user.email=t@example.com", "-c", "user.name=Test", "add", "src/bridge.ts", "package.json");
	git("-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "fixture");
}

/**
 * spec-lint's answer, at HEAD, for `docs/specs/sym.md` citing `cites`.
 *
 * One spec per fixture repository: a second call on the same repo overwrites it,
 * which is why each describe below builds its own. Nothing lints the directory as
 * a whole, so a leftover file could not reach another describe's result anyway.
 */
function lintFixture(repo: string, cites: string): { status: number | null; stderr: string; result: LintResult } {
	mkdirSync(join(repo, "docs", "specs"), { recursive: true });
	writeFileSync(join(repo, "docs", "specs", "sym.md"), spec(cites));
	const run = spawnSync(process.execPath, [linter, "--json", "--ref", "HEAD", "docs/specs/sym.md"], {
		cwd: repo,
		encoding: "utf8",
		env: fixtureEnv(),
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

// Run under a git hook, GIT_DIR names the repository being pushed, and in a
// worktree it names that worktree's git directory, whose config is the main
// checkout's. Before the fixture dropped GIT_*, this suite (still passing)
// committed its fixture over the pushed branch's src/bridge.ts and package.json,
// and its `git init` re-initialised the repository and recorded it as bare, so
// the main checkout stopped working as one. The decoy is laid out the same way:
// a main checkout with a worktree, and GIT_DIR naming the worktree.
// The one place the GIT_* filter is implemented, so the end-to-end decoy below
// and the per-file strip in global-setup.ts cannot drift apart.
describe("stripGitEnv", () => {
	it("removes every GIT_* variable, names them, and leaves the rest alone", () => {
		const env: NodeJS.ProcessEnv = {
			GIT_DIR: "/decoy/.git",
			GIT_INDEX_FILE: "/decoy/.git/index",
			GIT_CONFIG_GLOBAL: "/dev/null",
			PATH: "/bin",
			HOME: "/home/t",
		};
		expect(stripGitEnv(env).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_DIR", "GIT_INDEX_FILE"]);
		expect(env).toEqual({ PATH: "/bin", HOME: "/home/t" });
	});
});

describe("spec-lint fixtures ignore an inherited GIT_DIR", () => {
	const scratch = mkdtempSync(join(tmpdir(), "spec-lint-gitdir-"));
	const decoy = join(scratch, "decoy");
	const worktree = join(scratch, "decoy-wt");
	const git = (cwd: string, ...args: string[]) =>
		spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], {
			cwd,
			encoding: "utf8",
			env: fixtureEnv(),
		}).stdout.trim();
	let before: string;
	let after: string;
	let bareAfter: string;
	let run: ReturnType<typeof lintFixture>;

	beforeAll(() => {
		fixtureRepo(decoy);
		git(decoy, "worktree", "add", "-q", "-b", "pushed", worktree);
		// Unlike the fixture's, so a leaked `add` and `commit` would succeed and
		// move HEAD, rather than find nothing to commit and fail on that instead.
		writeFileSync(join(worktree, "src", "bridge.ts"), "// the decoy's own file\n");
		git(worktree, "commit", "-qam", "decoy");
		before = git(worktree, "rev-parse", "HEAD");
		const saved = process.env.GIT_DIR;
		process.env.GIT_DIR = git(worktree, "rev-parse", "--absolute-git-dir");
		try {
			const repo = join(scratch, "repo");
			fixtureRepo(repo);
			run = lintFixture(repo, "Reads `src/nope.ts`.");
		} finally {
			if (saved === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = saved;
		}
		after = git(worktree, "rev-parse", "HEAD");
		bareAfter = git(decoy, "config", "--get", "core.bare");
	});

	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	it("commits nothing to the branch GIT_DIR names", () => {
		expect(after).toBe(before);
	});

	it("leaves the main checkout of the repository GIT_DIR names non-bare", () => {
		expect(bareAfter).toBe("false");
	});

	it("lints the fixture, not the repository GIT_DIR names", () => {
		expect([0, 1], run.stderr).toContain(run.status);
		expect(run.result.checks.find((c) => c.id === "G2")?.findings.join("\n")).toContain("src/nope.ts");
	});
});
