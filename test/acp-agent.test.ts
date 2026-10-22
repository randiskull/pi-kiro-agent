import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACP_NATIVE_TOOLS, acpNativeTools, prepareAcpAgent } from "../src/acp-agent.js";

describe("prepareAcpAgent", () => {
	const savedHome = process.env.HOME;
	afterEach(() => {
		process.env.HOME = savedHome;
	});

	// A read-only HOME (a container, CI) or a ~/.kiro that is a file: before the
	// lean agent, ACP never wrote there, so it must not now cost the turn.
	it("falls back to the default agent, with a warning, when the profile cannot be written", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-kiro-home-"));
		writeFileSync(join(home, ".kiro"), "not a directory", "utf8");
		process.env.HOME = home;
		const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const launch = prepareAcpAgent({ kind: "lean" });
		expect(launch.args).toEqual([]);
		expect(launch.disableInheritance).toBe(false);
		expect(() => launch.cleanup()).not.toThrow();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("PI_KIRO_ACP_AGENT"));
		rmSync(home, { recursive: true, force: true });
	});
});

describe("acpNativeTools", () => {
	// kiro's shell tool is execute_cmd on Windows (crates/agent/src/agent/tools/execute_cmd).
	it("names the shell tool for the platform", () => {
		expect(acpNativeTools("darwin")).toContain("execute_bash");
		expect(acpNativeTools("linux")).toContain("execute_bash");
		expect(acpNativeTools("win32")).toContain("execute_cmd");
		expect(acpNativeTools("win32")).not.toContain("execute_bash");
	});

	it("keeps web_fetch, and ACP_NATIVE_TOOLS is this platform's set", () => {
		expect(acpNativeTools("linux")).toContain("web_fetch");
		expect([...ACP_NATIVE_TOOLS]).toEqual(acpNativeTools(process.platform));
	});
});
