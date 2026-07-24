/**
 * Readiness probes for the local Kiro CLI.
 *
 * Ready = `kiro-cli --version` succeeds AND `kiro-cli whoami` reports a
 * logged-in identity. IdC/enterprise seats additionally need a profile
 * selected (a missing profile surfaces at request time as a
 * "profileArn is required" ValidationException — detected downstream by the
 * stream adapter and reported with the `kiro-cli profile` remedy).
 *
 * Compliance: we never touch Kiro credentials; all model traffic is
 * performed by the official kiro-cli under the user's own entitlement.
 */

import { execFile } from "node:child_process";

const VERSION_TIMEOUT_MS = 5_000;
const WHOAMI_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30_000;
/**
 * A cold binary (bun spin-up, config/update checks) can blow the --version
 * timeout. That is transient, so retry with short backoff before concluding the
 * CLI is absent — only a persistent ENOENT means genuinely-not-installed.
 */
const VERSION_PROBE_ATTEMPTS = 3;
const VERSION_RETRY_BACKOFF_MS = 300;

export interface KiroReadiness {
	ready: boolean;
	binaryPath: string | undefined;
	version: string | undefined;
	/** true = logged in, false = logged out, undefined = indeterminate */
	authed: boolean | undefined;
	detail: string;
	/**
	 * true when this result is a transient probe failure (a cold-start --version
	 * timeout) rather than a definitive verdict. Transient results are NOT cached,
	 * so the next probe re-runs and registration self-heals without a manual /kiro.
	 */
	transient?: boolean;
}

let cached: { at: number; value: KiroReadiness } | undefined;

interface RunResult {
	ok: boolean;
	/** killed by the timeout — a cold/slow binary, not an absent one. */
	timedOut: boolean;
	/** spawn ENOENT — the binary is genuinely not on PATH. */
	notFound: boolean;
	stdout: string;
	stderr: string;
}

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
			const err = error as (Error & { killed?: boolean; signal?: string; code?: string | number }) | null;
			const timedOut = err != null && (err.killed === true || err.signal === "SIGTERM");
			const notFound = err != null && err.code === "ENOENT";
			resolve({ ok: err == null, timedOut, notFound, stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function candidates(): string[] {
	return process.platform === "win32" ? ["kiro-cli.exe", "kiro-cli"] : ["kiro-cli"];
}

export function parseWhoami(stdout: string, stderr: string): boolean | undefined {
	const text = `${stdout}\n${stderr}`;
	if (/not\s+logged\s*in|logged\s*out|no\s+active|please\s+log\s*in/i.test(text)) return false;
	if (/logged\s*in/i.test(text)) return true;
	return undefined;
}

export async function checkKiroReadiness(force = false): Promise<KiroReadiness> {
	if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return cached.value;
	}
	// Probe for the binary. Retry a --version timeout (transient cold start) before
	// concluding the CLI is absent; an ENOENT is definitive, so fail fast on it.
	let binary: { path: string; version: string } | undefined;
	let versionTimedOut = false;
	outer: for (const candidate of candidates()) {
		for (let attempt = 0; attempt < VERSION_PROBE_ATTEMPTS; attempt++) {
			const result = await run(candidate, ["--version"], VERSION_TIMEOUT_MS);
			if (result.ok && result.stdout.trim().length > 0) {
				binary = { path: candidate, version: result.stdout.trim().split("\n")[0] ?? "" };
				break outer;
			}
			if (result.notFound) break; // candidate absent — no retry, try the next candidate
			if (result.timedOut) {
				versionTimedOut = true;
				if (attempt + 1 < VERSION_PROBE_ATTEMPTS) await delay(VERSION_RETRY_BACKOFF_MS * (attempt + 1));
				continue; // cold start — back off and retry the same candidate
			}
			break; // other failure (non-zero exit / empty output) — try the next candidate
		}
	}

	let value: KiroReadiness;
	if (binary) {
		const whoami = await run(binary.path, ["whoami"], WHOAMI_TIMEOUT_MS);
		const authed = parseWhoami(whoami.stdout, whoami.stderr);
		const ready = authed !== false;
		value = {
			ready,
			binaryPath: binary.path,
			version: binary.version,
			authed,
			detail: ready
				? `Kiro CLI ${binary.version}${authed === undefined ? " (auth state indeterminate — proceeding)" : ""}`
				: "Kiro CLI found but not logged in. Run `kiro-cli login` (and `kiro-cli profile` on IdC seats).",
		};
	} else if (versionTimedOut) {
		// Probed but the CLI never answered in time. Report it as a cold-start delay
		// (NOT "missing", which would send users to the wrong remedy) and mark it
		// transient so it is not cached — the next probe re-runs.
		value = {
			ready: false,
			binaryPath: undefined,
			version: undefined,
			authed: undefined,
			detail: `Kiro CLI did not respond within ${VERSION_TIMEOUT_MS / 1000}s (x${VERSION_PROBE_ATTEMPTS} attempts) — cold start? Will retry.`,
			transient: true,
		};
	} else {
		value = {
			ready: false,
			binaryPath: undefined,
			version: undefined,
			authed: undefined,
			detail: "Kiro CLI not found on PATH. Install it (https://kiro.dev/docs/cli/) and run `kiro-cli login`.",
		};
	}

	// Cache only definitive outcomes. A transient timeout is left uncached so the
	// next call re-probes instead of latching a false "not found".
	if (!value.transient) {
		cached = { at: Date.now(), value };
	}
	return value;
}

export function clearKiroReadinessCache(): void {
	cached = undefined;
}
