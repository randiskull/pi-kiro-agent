/**
 * One temp directory per RUN to hold every per-file throwaway $HOME, removed when
 * the run ends.
 *
 * test-setup.ts gives each test file its own fake $HOME (see the reasoning there).
 * Cleaning those up from inside a worker does not work: an afterAll is skipped for
 * a file whose every test is skipped, which is all five live files without
 * PI_KIRO_LIVE=1, and a process-exit handler never fires because vitest terminates
 * its workers rather than letting them exit. Both were tried; the first leaked 5
 * dirs per run and the second leaked all 19.
 *
 * globalSetup runs in the main vitest process and its teardown is guaranteed, so
 * the reliable move is to make the per-file homes children of one run-scoped
 * directory and delete that. Scoping to this run also means a concurrent run's
 * directories are never touched, which a prefix sweep over $TMPDIR could not
 * promise.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Workers read this to place their own fake $HOME inside the run-scoped dir. */
export const TEST_HOME_ROOT_ENV = "PI_KIRO_TEST_HOME_ROOT";

/**
 * Removes git's own environment variables from `env`, returning the names it
 * removed.
 *
 * git exports GIT_DIR (with GIT_INDEX_FILE, GIT_PREFIX and friends) to the hooks
 * it runs, and this repository's pre-push hook runs the whole suite. git obeys
 * GIT_DIR over the working directory, so a test that shells out to git inside a
 * temp directory acts on the repository being pushed instead:
 * test/spec-lint-symlink.test.ts did exactly that, and its `git init`, `add` and
 * `commit` put the fixture's two files over src/bridge.ts and package.json on the
 * branch, while `init` through a WORKTREE's git directory also wrote
 * core.bare = true into the config the main checkout shares. The suite still
 * passed; only a later test linting at HEAD caught it.
 *
 * Called once here, so every worker inherits an env without them, and again per
 * child by the fixtures that spawn git, which is the call the regression test in
 * test/spec-lint-symlink.test.ts kills. A test that needs one of these sets it on
 * the child itself.
 */
export function stripGitEnv(env: NodeJS.ProcessEnv): string[] {
	const removed = Object.keys(env).filter((key) => key.startsWith("GIT_"));
	for (const key of removed) delete env[key];
	return removed;
}

let root: string | undefined;

export function setup(): void {
	stripGitEnv(process.env);
	root = mkdtempSync(join(tmpdir(), "pi-kiro-test-homes-"));
	// Forked workers inherit process.env, so this reaches test-setup.ts.
	process.env[TEST_HOME_ROOT_ENV] = root;
}

export function teardown(): void {
	if (!root) return;
	if (!root.startsWith(tmpdir()) || !root.includes("pi-kiro-test-homes-")) return;
	rmSync(root, { recursive: true, force: true });
	root = undefined;
}
