import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkKiroReadiness, clearKiroReadinessCache, parseWhoami } from "../src/readiness.js";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
// `error`: true = generic non-zero exit, "timeout" = killed by timeout (SIGTERM),
// "enoent" = binary absent (spawn ENOENT).
type ExecHandler = (args: string[]) => { error?: boolean | "timeout" | "enoent"; stdout?: string };

const execState = vi.hoisted(() => ({
	handler: undefined as ExecHandler | undefined,
	calls: [] as string[][],
}));

vi.mock("node:child_process", () => ({
	execFile: (_command: string, args: string[], _options: unknown, callback: ExecCallback) => {
		execState.calls.push(args);
		const result = execState.handler?.(args) ?? { error: true };
		let error: (Error & { killed?: boolean; signal?: string; code?: string }) | null = null;
		if (result.error === "timeout") {
			error = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
		} else if (result.error === "enoent") {
			error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
		} else if (result.error) {
			error = new Error("exec failed");
		}
		callback(error, result.stdout ?? "", "");
	},
}));

const versionCalls = () => execState.calls.filter((call) => call[0] === "--version").length;

describe("parseWhoami", () => {
	it("classifies whoami output", () => {
		expect(parseWhoami("Logged in with IAM Identity Center (https://x)", "")).toBe(true);
		expect(parseWhoami("Not logged in", "")).toBe(false);
		expect(parseWhoami("???", "")).toBeUndefined();
	});
});

describe("checkKiroReadiness", () => {
	beforeEach(() => {
		clearKiroReadinessCache();
		execState.handler = undefined;
		execState.calls = [];
	});

	it("is not ready when the binary is missing", async () => {
		execState.handler = () => ({ error: true });
		const readiness = await checkKiroReadiness();
		expect(readiness.ready).toBe(false);
		expect(readiness.detail).toContain("not found");
	});

	it("is ready when whoami reports a login", async () => {
		execState.handler = (args) =>
			args[0] === "--version" ? { stdout: "kiro-cli 2.12.1\n" } : { stdout: "Logged in with IAM Identity Center" };
		const readiness = await checkKiroReadiness();
		expect(readiness).toMatchObject({ ready: true, authed: true, version: "kiro-cli 2.12.1" });
	});

	it("is not ready when logged out, ready-with-warning when indeterminate", async () => {
		execState.handler = (args) =>
			args[0] === "--version" ? { stdout: "kiro-cli 2.12.1" } : { stdout: "Not logged in" };
		expect((await checkKiroReadiness()).ready).toBe(false);
		clearKiroReadinessCache();
		execState.handler = (args) => (args[0] === "--version" ? { stdout: "kiro-cli 2.12.1" } : { stdout: "???" });
		const indeterminate = await checkKiroReadiness();
		expect(indeterminate.ready).toBe(true);
		expect(indeterminate.detail).toContain("indeterminate");
	});

	it("treats a logged-out whoami as indeterminate (ready) when KIRO_API_KEY is set", async () => {
		process.env.KIRO_API_KEY = "ksk_readiness_0123456789"; // secret-scan:allow (fake test key)
		try {
			execState.handler = (args) =>
				args[0] === "--version" ? { stdout: "kiro-cli 2.26.1" } : { stdout: "Not logged in" };
			const readiness = await checkKiroReadiness();
			expect(readiness).toMatchObject({ ready: true, authed: undefined, version: "kiro-cli 2.26.1" });
			expect(readiness.detail).toContain("auth: KIRO_API_KEY");
			expect(readiness.detail).not.toContain("ksk_readiness");
		} finally {
			delete process.env.KIRO_API_KEY;
		}
	});

	it("still reports a real login as authed when KIRO_API_KEY is set", async () => {
		process.env.KIRO_API_KEY = "ksk_readiness_0123456789"; // secret-scan:allow (fake test key)
		try {
			execState.handler = (args) =>
				args[0] === "--version" ? { stdout: "kiro-cli 2.26.1" } : { stdout: "Logged in with Builder ID" };
			expect(await checkKiroReadiness()).toMatchObject({ ready: true, authed: true });
		} finally {
			delete process.env.KIRO_API_KEY;
		}
	});

	it("caches until forced", async () => {
		execState.handler = (args) => (args[0] === "--version" ? { stdout: "kiro-cli 2.12.1" } : { stdout: "Logged in" });
		await checkKiroReadiness();
		const after = execState.calls.length;
		await checkKiroReadiness();
		expect(execState.calls.length).toBe(after);
		await checkKiroReadiness(true);
		expect(execState.calls.length).toBeGreaterThan(after);
	});

	it("retries a --version timeout, then succeeds (no false 'not found')", async () => {
		let attempts = 0;
		execState.handler = (args) => {
			if (args[0] === "--version") {
				attempts += 1;
				return attempts === 1 ? { error: "timeout" } : { stdout: "kiro-cli 2.14.0" };
			}
			return { stdout: "Logged in with IAM Identity Center" };
		};
		const readiness = await checkKiroReadiness();
		expect(readiness).toMatchObject({ ready: true, authed: true, version: "kiro-cli 2.14.0" });
		expect(attempts).toBeGreaterThanOrEqual(2); // retried past the timeout
	});

	it("treats a persistent --version timeout as transient, not 'not found', and does not cache it", async () => {
		execState.handler = (args) => (args[0] === "--version" ? { error: "timeout" } : { stdout: "" });
		const first = await checkKiroReadiness();
		expect(first.ready).toBe(false);
		expect(first.transient).toBe(true);
		expect(first.detail).not.toContain("not found");
		expect(first.detail).toMatch(/cold start|did not respond|retry/i);
		expect(versionCalls()).toBe(3); // retried up to the attempt cap

		// Not latched: with no force, the next call re-probes and recovers.
		const callsBefore = execState.calls.length;
		execState.handler = (args) => (args[0] === "--version" ? { stdout: "kiro-cli 2.14.0" } : { stdout: "Logged in" });
		const second = await checkKiroReadiness();
		expect(execState.calls.length).toBeGreaterThan(callsBefore);
		expect(second).toMatchObject({ ready: true, version: "kiro-cli 2.14.0" });
	});

	it("fails fast and caches on ENOENT (binary genuinely absent)", async () => {
		execState.handler = (args) => (args[0] === "--version" ? { error: "enoent" } : { stdout: "" });
		const first = await checkKiroReadiness();
		expect(first.ready).toBe(false);
		expect(first.transient).toBeFalsy();
		expect(first.detail).toContain("not found");
		expect(versionCalls()).toBe(1); // no retry on a definitive ENOENT

		// Definitive → cached: a subsequent call does not re-probe.
		const callsAfter = execState.calls.length;
		await checkKiroReadiness();
		expect(execState.calls.length).toBe(callsAfter);
	});

	it("caches a definitive logged-out result with the login remedy", async () => {
		execState.handler = (args) =>
			args[0] === "--version" ? { stdout: "kiro-cli 2.14.0" } : { stdout: "Not logged in" };
		const first = await checkKiroReadiness();
		expect(first.ready).toBe(false);
		expect(first.authed).toBe(false);
		expect(first.transient).toBeFalsy();
		expect(first.detail).toContain("not logged in");
		const callsAfter = execState.calls.length;
		await checkKiroReadiness();
		expect(execState.calls.length).toBe(callsAfter); // cached, no re-probe
	});
});
