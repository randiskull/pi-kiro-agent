/**
 * End-to-end extension load against the real Pi host.
 *
 * Every other test imports src/index.ts directly through a hand-rolled fake
 * `pi`. That leaves a whole class of defect invisible: nothing checks that the
 * PUBLISHED package is loadable by Pi at all. The entry point is a path string
 * in package.json ("pi": { "extensions": [...] }) and "files" is an allowlist,
 * so a typo in either -- or a module that never made it into the tarball --
 * passes tsc, passes every unit test, and first fails when a user runs
 * `pi install pi-kiro-agent`.
 *
 * Pi's resolver makes that failure quiet rather than loud. When the manifest
 * entry does not exist on disk it falls back to a root index.ts / index.js, and
 * failing that it scans one level of subdirectories for the same. So a package
 * laid out as src/index.ts is loaded by convention even with a broken manifest
 * -- verified by mutation: corrupting pi.extensions still loads the extension
 * and still registers the provider. That is why the manifest is asserted
 * directly below rather than inferred from a successful load: the forgiving
 * path hides the defect until the layout changes or another host reads the
 * manifest strictly (`pi install` resolves packages through PackageManager,
 * which has no such fallback).
 *
 * This test closes the gap without a Kiro seat:
 *   1. `npm pack` -- the exact tarball `npm publish` would upload.
 *   2. extract it, so the fixture is the published file set and nothing else:
 *      no node_modules, no test/, no repo-only files.
 *   3. link in the runtime dependencies the published manifest DECLARES, and
 *      only those (see linkDeclaredDependencies below).
 *   4. hand that directory to Pi's public `discoverAndLoadExtensions`, which
 *      reads the pi manifest and loads the entry with jiti exactly as the CLI
 *      does, including resolving `@earendil-works/pi-ai` through the loader's
 *      virtual modules.
 *
 * Readiness is satisfied by a stub `kiro-cli` on PATH, so provider registration
 * is exercised with no credentials, no network and no model call. A real
 * delegated turn still needs a seat: that is stream-adapter-live.test.ts, gated
 * on PI_KIRO_LIVE=1.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

const repoRoot = resolve(__dirname, "..");

/**
 * Stands in for an installed, logged-in kiro-cli. Only the three probes the
 * activation path makes are answered (readiness.ts: --version, then whoami;
 * models.ts: chat --list-models). Anything else exits non-zero, so a new
 * subprocess call added to activation surfaces here instead of passing
 * silently against a permissive stub.
 */
const KIRO_STUB = [
	"#!/bin/sh",
	'case "$*" in',
	'  --version) echo "kiro-cli 0.0.0-e2e" ;;',
	'  whoami*) echo "Logged in as e2e@example.invalid" ;;',
	'  "chat --list-models --format json --no-interactive")',
	'    echo \'{"models":[{"model_id":"auto","context_window_tokens":200000}]}\' ;;',
	'  *) echo "kiro-cli stub: unexpected invocation: $*" >&2; exit 64 ;;',
	"esac",
	"",
].join("\n");

/**
 * Give the extracted package a node_modules containing exactly the runtime
 * dependencies its own manifest declares, symlinked to the copies npm already
 * resolved for this repo.
 *
 * `pi install` gets these from npm; linking instead keeps the test offline and
 * on the locked versions. It also turns the dependency block into an assertion:
 * anything the module graph imports that is NOT declared in "dependencies" is
 * absent here and fails the load, which is how a devDependency accidentally
 * relied on at runtime would be caught. (Peer deps are excluded on purpose --
 * the pi packages are supplied by the host, and the loader's virtual modules
 * serve them.)
 */
function linkDeclaredDependencies(packageDir: string, dependencies: Record<string, string>): void {
	for (const name of Object.keys(dependencies)) {
		const linkPath = join(packageDir, "node_modules", name);
		mkdirSync(dirname(linkPath), { recursive: true });
		symlinkSync(join(repoRoot, "node_modules", name), linkPath, "dir");
	}
}

// npm pack + tar + a jiti load of the whole module graph. Slower than a unit
// test by design; still hermetic and offline.
const E2E_TIMEOUT_MS = 120_000;

// The stub is a POSIX shell script and the extract step shells out to tar.
// CI is ubuntu-latest; skip rather than pretend on Windows.
const suite = process.platform === "win32" ? describe.skip : describe;

suite("published package loads in a real pi host", () => {
	let workDir: string;
	let packageDir: string;
	let manifest: { pi?: { extensions?: string[] }; dependencies?: Record<string, string> };
	let originalPath: string | undefined;
	let result: LoadExtensionsResult;

	beforeAll(async () => {
		workDir = mkdtempSync(join(tmpdir(), "pi-kiro-e2e-"));

		// 1. The real tarball. --pack-destination keeps it out of the repo.
		const packOutput = execFileSync("npm", ["pack", "--pack-destination", workDir], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		const tarball = packOutput.trim().split("\n").at(-1);
		expect(tarball, "npm pack printed no tarball name").toBeTruthy();

		// 2. Extract. npm tarballs root everything under package/.
		execFileSync("tar", ["-xzf", join(workDir, tarball as string), "-C", workDir]);
		packageDir = join(workDir, "package");

		// 3. Runtime deps, per the PUBLISHED manifest rather than the repo's.
		manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		linkDeclaredDependencies(packageDir, manifest.dependencies ?? {});

		// 4. A logged-in kiro-cli, first on PATH.
		const binDir = join(workDir, "bin");
		mkdirSync(binDir);
		const stubPath = join(binDir, "kiro-cli");
		writeFileSync(stubPath, KIRO_STUB);
		chmodSync(stubPath, 0o755);
		originalPath = process.env.PATH;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;

		// Empty cwd and agent dir so the only extension Pi can find is ours;
		// $HOME is already redirected to a throwaway dir by test-setup.ts.
		const cwd = join(workDir, "cwd");
		const agentDir = join(workDir, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);

		result = await discoverAndLoadExtensions([packageDir], cwd, agentDir);
	}, E2E_TIMEOUT_MS);

	afterAll(() => {
		if (originalPath !== undefined) process.env.PATH = originalPath;
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("loads exactly one extension, with no load errors", () => {
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
	});

	it("ships the entry point its manifest declares, and loads that one", () => {
		// Two separate claims, because a successful load does not imply either.
		// (a) the declared entry is actually inside the tarball -- the "files"
		// allowlist could omit it while it still exists in the repo; and
		// (b) the entry Pi loaded is that one, not a convention-discovered
		// namesake.
		const entries = manifest.pi?.extensions ?? [];
		expect(entries).toHaveLength(1);
		const declared = resolve(packageDir, entries[0]);
		expect(existsSync(declared), `${entries[0]} is declared but not published`).toBe(true);
		expect(result.extensions[0].resolvedPath).toBe(declared);
	});

	it("registers the kiro provider from the published file set", () => {
		// Proves the module graph reachable from the entry is complete under
		// the files allowlist and the declared dependencies.
		const registered = result.runtime.pendingProviderRegistrations.map((entry) => entry.name);
		expect(registered).toContain("kiro");
	});

	it("registers both slash commands", () => {
		const commands = [...result.extensions[0].commands.keys()];
		expect(commands).toContain("kiro");
		expect(commands).toContain("kiro-subagents");
	});
});
