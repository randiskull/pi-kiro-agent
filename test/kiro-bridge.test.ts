import { existsSync, readFileSync } from "node:fs";
import type { HttpBridgeHandle } from "../src/bridge.js";
import { describe, expect, it } from "vitest";
import { agentProfilesDir, bridgeEnabled, writeAgentProfile } from "../src/kiro-bridge.js";

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
