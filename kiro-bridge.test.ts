import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpBridgeHandle } from "./bridge.js";
import { describe, expect, it } from "vitest";
import { agentProfilesDir, bridgeEnabled, sweepStaleAgentProfiles, writeAgentProfile } from "./kiro-bridge.js";

const HANDLE: HttpBridgeHandle = {
	url: "http://127.0.0.1:5555/mcp",
	urlWithToken: "http://127.0.0.1:5555/mcp/secret123",
	token: "secret123",
	toolNames: ["todo", "Agent"],
	close: async () => undefined,
};

describe("writeAgentProfile", () => {
	it("writes a throwaway profile with the tokenized bridge URL and removes it", () => {
		const profile = writeAgentProfile(HANDLE);
		expect(profile.path.startsWith(agentProfilesDir())).toBe(true);
		expect(profile.name).toMatch(/^pi-kiro-bridge-\d+-\d+$/);
		const parsed = JSON.parse(readFileSync(profile.path, "utf8"));
		expect(parsed.name).toBe(profile.name);
		expect(parsed.mcpServers.pi).toEqual({ type: "http", url: HANDLE.urlWithToken });
		expect(parsed.tools).toEqual(["*"]);
		expect(parsed.allowedTools).toEqual(["*"]);
		profile.remove();
		expect(existsSync(profile.path)).toBe(false);
		profile.remove(); // idempotent
	});

	it("issues unique names per call", () => {
		const first = writeAgentProfile(HANDLE);
		const second = writeAgentProfile(HANDLE);
		expect(first.name).not.toBe(second.name);
		first.remove();
		second.remove();
	});
});

describe("bridgeEnabled", () => {
	it("defaults on and honors the off switch", () => {
		delete process.env.PI_KIRO_BRIDGE;
		expect(bridgeEnabled()).toBe(true);
		process.env.PI_KIRO_BRIDGE = "off";
		expect(bridgeEnabled()).toBe(false);
		delete process.env.PI_KIRO_BRIDGE;
	});
});

describe("writeAgentProfile — file mode 0o600", () => {
	it("writes the profile file with mode 0o600 (not world-readable)", () => {
		const profile = writeAgentProfile(HANDLE);
		try {
			const mode = statSync(profile.path).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			profile.remove();
		}
	});
});

describe("writeAgentProfile — remove() deletes .bak backup files", () => {
	it("deletes .bak and .bak.<n> variants alongside the profile", () => {
		const profile = writeAgentProfile(HANDLE);
		// Simulate the .bak files that kiro-cli v3 engine start creates.
		const bakPath = `${profile.path}.bak`;
		const bak1Path = `${profile.path}.bak.1`;
		writeFileSync(bakPath, '{"fake":true}', { encoding: "utf8", mode: 0o600 });
		writeFileSync(bak1Path, '{"fake":true}', { encoding: "utf8", mode: 0o600 });
		profile.remove();
		expect(existsSync(profile.path)).toBe(false);
		expect(existsSync(bakPath)).toBe(false);
		expect(existsSync(bak1Path)).toBe(false);
	});
});

describe("sweepStaleAgentProfiles", () => {
	it("removes dead-pid and own-pid profiles, leaves non-matching files alone", () => {
		const dir = agentProfilesDir();
		// Write a profile for a dead pid (99999999 is practically never alive).
		const deadPid = 99999999;
		const deadName = `pi-kiro-bridge-${deadPid}-9999`;
		const deadPath = join(dir, `${deadName}.json`);
		// Write a profile for the current process pid (also stale at activation).
		// Use a large counter suffix to avoid colliding with in-flight profiles.
		const livePidName = `pi-kiro-bridge-${process.pid}-88888`;
		const livePidPath = join(dir, `${livePidName}.json`);
		// Write a decoy file that must NOT be swept (doesn't match the pattern).
		const decoyPath = join(dir, "code-reviewer.json");
		const decoyExistedBefore = existsSync(decoyPath);
		try {
			writeFileSync(deadPath, '{"name":"dead"}', { encoding: "utf8", mode: 0o600 });
			writeFileSync(livePidPath, '{"name":"live"}', { encoding: "utf8", mode: 0o600 });
			if (!decoyExistedBefore) {
				writeFileSync(decoyPath, '{"name":"decoy"}', { encoding: "utf8", mode: 0o600 });
			}
			const result = sweepStaleAgentProfiles();
			// The dead-pid file must be removed.
			expect(existsSync(deadPath)).toBe(false);
			// The current-pid file is also swept (activation = no turn in flight).
			expect(existsSync(livePidPath)).toBe(false);
			// Decoy file must not be touched.
			expect(existsSync(decoyPath)).toBe(true);
			// At least the dead-pid and live-pid profiles were scanned.
			expect(result.scanned).toBeGreaterThanOrEqual(2);
			expect(result.swept).toBeGreaterThanOrEqual(1);
		} finally {
			// Cleanup in case any assertion failed.
			rmSync(deadPath, { force: true });
			rmSync(livePidPath, { force: true });
			if (!decoyExistedBefore) {
				rmSync(decoyPath, { force: true });
			}
		}
	});
});
