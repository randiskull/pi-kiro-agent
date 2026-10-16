import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HttpBridgeHandle } from "../src/bridge.js";
import { describe, expect, it } from "vitest";
import {
	agentProfilesDir,
	bridgeEnabled,
	disableInheritedResources,
	writeAgentProfile,
} from "../src/kiro-bridge.js";

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

	// `resources: []` is the documented opt-out and does NOT work on kiro-cli
	// 2.32.0: a custom agent reports identical context usage with the key absent
	// or empty, because the default-resource loader is additive and ignores the
	// per-agent field. The key is kept as declared intent so the profile stops
	// inheriting for free if that is fixed; disableInheritedResources() is what
	// actually recovers the tokens. Assert the key is PRESENT and empty:
	// `toEqual([])` alone would also be satisfied by a missing key reading as
	// undefined on some matchers, so the `in` check is the real gate.
	it("declares an empty resources list, kiro's documented inheritance opt-out", () => {
		const profile = writeAgentProfile(HANDLE);
		const parsed = JSON.parse(readFileSync(profile.path, "utf8"));
		expect("resources" in parsed).toBe(true);
		expect(parsed.resources).toEqual([]);
		profile.remove();
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

describe("disableInheritedResources", () => {
	// `resources: []` on the profile does NOT opt out (same context usage to
	// three decimals with the key absent or empty, kiro-cli 2.32.0 engine v2):
	// the default-resource loader is additive and ignores the per-agent field.
	// The workspace-scoped setting is the lever that works, 6.430% -> 3.409% of
	// a 1M window, so these tests gate the file we write and -- more important
	// because it lands in the user's own project -- that we put it back.
	const mkws = () => mkdtempSync(join(tmpdir(), "pi-kiro-ws-"));
	const settings = (ws: string) => join(ws, ".kiro", "settings", "cli.json");

	it("sets the key at workspace scope and leaves a clean project clean", () => {
		const ws = mkws();
		const handle = disableInheritedResources(ws);
		expect(handle).toBeDefined();
		expect(handle?.path).toBe(settings(ws));
		expect(JSON.parse(readFileSync(settings(ws), "utf8"))).toEqual({
			"chat.disableInheritingDefaultResources": true,
		});
		handle?.restore();
		// A project that had no .kiro must not be left holding an empty one.
		expect(existsSync(join(ws, ".kiro"))).toBe(false);
		handle?.restore(); // idempotent
		rmSync(ws, { recursive: true, force: true });
	});

	it("restores a pre-existing settings file byte for byte", () => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		// Deliberately odd formatting: a re-serialized round trip would fail this.
		const before = '{\n  "chat.defaultModel":  "claude-sonnet-4-5",\n  "mcp.loadedBefore": true\n}\n';
		writeFileSync(path, before, "utf8");
		const handle = disableInheritedResources(ws);
		expect(handle).toBeDefined();
		const during = JSON.parse(readFileSync(path, "utf8"));
		expect(during["chat.disableInheritingDefaultResources"]).toBe(true);
		expect(during["chat.defaultModel"]).toBe("claude-sonnet-4-5");
		expect(during["mcp.loadedBefore"]).toBe(true);
		handle?.restore();
		expect(readFileSync(path, "utf8")).toBe(before);
		rmSync(ws, { recursive: true, force: true });
	});

	// An explicit value is a decision the user made. Overriding `false` would be
	// the worst case: they asked for inheritance and we would silently remove it.
	it.each([true, false])("never overrides an explicit user value (%s)", (value) => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		const before = `${JSON.stringify({ "chat.disableInheritingDefaultResources": value })}\n`;
		writeFileSync(path, before, "utf8");
		expect(disableInheritedResources(ws)).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(before);
		rmSync(ws, { recursive: true, force: true });
	});

	it("leaves a settings file it cannot parse untouched", () => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ not json", "utf8");
		expect(disableInheritedResources(ws)).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe("{ not json");
		rmSync(ws, { recursive: true, force: true });
	});

	it("honors the off switch", () => {
		const ws = mkws();
		process.env.PI_KIRO_WORKSPACE_SETTINGS = "off";
		expect(disableInheritedResources(ws)).toBeUndefined();
		expect(existsSync(join(ws, ".kiro"))).toBe(false);
		delete process.env.PI_KIRO_WORKSPACE_SETTINGS;
		rmSync(ws, { recursive: true, force: true });
	});

	// The finally block cannot run on SIGKILL. Left unrecovered, the user's own
	// interactive kiro sessions in that project silently lose every steering
	// file and skill, with nothing pointing at pi as the cause.
	it("recovers a setting stranded by a dead pid, restoring the original bytes", () => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		const before = `${JSON.stringify({ "chat.defaultModel": "claude-sonnet-4-5" })}\n`;
		writeFileSync(path, before, "utf8");
		// A genuinely finished process, so the pid is known-dead rather than guessed.
		const dead = spawnSync(process.execPath, ["-e", ""]).pid as number;
		expect(dead).toBeGreaterThan(0);
		writeFileSync(path, `${JSON.stringify({ "chat.disableInheritingDefaultResources": true })}\n`, "utf8");
		writeFileSync(
			join(dirname(path), ".pi-kiro-settings-restore.json"),
			`${JSON.stringify({ pid: dead, original: before })}\n`,
			"utf8",
		);
		const handle = disableInheritedResources(ws);
		// The stale value was rolled back first, so this call saw the real file
		// and set the key itself rather than reading its own leftover as a user choice.
		expect(handle).toBeDefined();
		const during = JSON.parse(readFileSync(path, "utf8"));
		expect(during["chat.defaultModel"]).toBe("claude-sonnet-4-5");
		handle?.restore();
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(existsSync(join(dirname(path), ".pi-kiro-settings-restore.json"))).toBe(false);
		rmSync(ws, { recursive: true, force: true });
	});

	it("leaves a sentinel from a live pid alone", () => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		const sentinel = join(dirname(path), ".pi-kiro-settings-restore.json");
		// process.pid is skipped as self, so use the parent: alive and not us.
		const livePid = process.ppid;
		writeFileSync(path, `${JSON.stringify({ "chat.disableInheritingDefaultResources": true })}\n`, "utf8");
		writeFileSync(sentinel, `${JSON.stringify({ pid: livePid, original: null })}\n`, "utf8");
		// Key already present and the owner is mid-turn: change nothing.
		expect(disableInheritedResources(ws)).toBeUndefined();
		expect(existsSync(sentinel)).toBe(true);
		rmSync(ws, { recursive: true, force: true });
	});

	it("keeps a settings dir the user also uses", () => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		const sibling = join(dirname(path), "mcp.json");
		writeFileSync(sibling, "{}\n", "utf8");
		const handle = disableInheritedResources(ws);
		handle?.restore();
		expect(existsSync(path)).toBe(false);
		expect(existsSync(sibling)).toBe(true);
		rmSync(ws, { recursive: true, force: true });
	});
});
