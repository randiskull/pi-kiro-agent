import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkKiroReadiness, clearKiroReadinessCache, parseWhoami } from "./readiness.js";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecHandler = (args: string[]) => { error?: boolean; stdout?: string };

const execState = vi.hoisted(() => ({
	handler: undefined as ExecHandler | undefined,
	calls: [] as string[][],
}));

vi.mock("node:child_process", () => ({
	execFile: (_command: string, args: string[], _options: unknown, callback: ExecCallback) => {
		execState.calls.push(args);
		const result = execState.handler?.(args) ?? { error: true };
		callback(result.error ? new Error("exec failed") : null, result.stdout ?? "", "");
	},
}));

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

	it("caches until forced", async () => {
		execState.handler = (args) => (args[0] === "--version" ? { stdout: "kiro-cli 2.12.1" } : { stdout: "Logged in" });
		await checkKiroReadiness();
		const after = execState.calls.length;
		await checkKiroReadiness();
		expect(execState.calls.length).toBe(after);
		await checkKiroReadiness(true);
		expect(execState.calls.length).toBeGreaterThan(after);
	});
});
