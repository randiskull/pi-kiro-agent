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

let root: string | undefined;

export function setup(): void {
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
