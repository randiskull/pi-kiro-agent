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

export interface KiroReadiness {
	ready: boolean;
	binaryPath: string | undefined;
	version: string | undefined;
	/** true = logged in, false = logged out, undefined = indeterminate */
	authed: boolean | undefined;
	detail: string;
}

let cached: { at: number; value: KiroReadiness } | undefined;

function run(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
			resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});
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
	let binary: { path: string; version: string } | undefined;
	for (const candidate of candidates()) {
		const result = await run(candidate, ["--version"], VERSION_TIMEOUT_MS);
		if (result.ok && result.stdout.trim().length > 0) {
			binary = { path: candidate, version: result.stdout.trim().split("\n")[0] ?? "" };
			break;
		}
	}
	let value: KiroReadiness;
	if (!binary) {
		value = {
			ready: false,
			binaryPath: undefined,
			version: undefined,
			authed: undefined,
			detail: "Kiro CLI not found on PATH. Install it (https://kiro.dev/docs/cli/) and run `kiro-cli login`.",
		};
	} else {
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
	}
	cached = { at: Date.now(), value };
	return value;
}

export function clearKiroReadinessCache(): void {
	cached = undefined;
}
