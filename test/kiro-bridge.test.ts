import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HttpBridgeHandle } from "../src/bridge.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	_setSettingsWriterForTest,
	agentProfilesDir,
	bridgeEnabled,
	disableInheritedResources,
	sweepStaleAgentProfiles,
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

	// A kiro-cli v3-engine start converts every top-level ~/.kiro/agents/*.json
	// and saves the original, tokenized bridge URL included, as <name>.json.bak,
	// then .bak.1, .bak.2 on later conversions (kiro-cli 2.32.0 / KAS 0.66.43).
	it("removes the backups kiro writes beside the profile, and only this profile's", () => {
		const profile = writeAgentProfile(HANDLE);
		const sibling = writeAgentProfile(HANDLE);
		const dir = agentProfilesDir();
		for (const suffix of [".bak", ".bak.1", ".bak.12"]) {
			writeFileSync(`${profile.path}${suffix}`, "original", "utf8");
			writeFileSync(`${sibling.path}${suffix}`, "original", "utf8");
		}
		// Same pid, a counter that shares a prefix: `-1` must not take `-12`'s files.
		const prefixTwin = join(dir, `${profile.name}2.json.bak`);
		writeFileSync(prefixTwin, "original", "utf8");

		profile.remove();
		const left = readdirSync(dir);
		expect(left.filter((entry) => entry.startsWith(`${profile.name}.`))).toEqual([]);
		expect(left).toEqual(expect.arrayContaining([`${sibling.name}.json`, `${sibling.name}.json.bak`, `${sibling.name}.json.bak.1`]));
		expect(existsSync(prefixTwin)).toBe(true);

		sibling.remove();
		rmSync(prefixTwin);
	});

	it.skipIf(process.platform === "win32")("writes the profile owner-only, because it carries the bridge token", () => {
		const profile = writeAgentProfile(HANDLE);
		expect(statSync(profile.path).mode & 0o777).toBe(0o600);
		profile.remove();
	});

	// The counter restarts at 1 in every process, so a reused pid lands on a dead
	// predecessor's name. Its file must not keep its old mode or its backups.
	it.skipIf(process.platform === "win32")("replaces a predecessor's file under the same name, backups included", () => {
		const probe = writeAgentProfile(HANDLE);
		probe.remove();
		const [, pid, n] = /^pi-kiro-bridge-(\d+)-(\d+)$/.exec(probe.name) ?? [];
		const next = join(agentProfilesDir(), `pi-kiro-bridge-${pid}-${Number(n) + 1}.json`);
		writeFileSync(next, "{}", { mode: 0o644 });
		chmodSync(next, 0o644);
		writeFileSync(`${next}.bak`, "old token", "utf8");

		const profile = writeAgentProfile(HANDLE);
		expect(profile.path).toBe(next);
		expect(statSync(next).mode & 0o777).toBe(0o600);
		expect(existsSync(`${next}.bak`)).toBe(false);
		profile.remove();
	});

	it("takes a narrower tool list and a description, for the ACP lean agent", () => {
		const profile = writeAgentProfile(undefined, undefined, { tools: ["fs_read", "grep"], description: "lean" });
		const parsed = JSON.parse(readFileSync(profile.path, "utf8"));
		expect(parsed.tools).toEqual(["fs_read", "grep"]);
		expect(parsed.allowedTools).toEqual(["fs_read", "grep"]);
		expect(parsed.description).toBe("lean");
		expect(parsed.mcpServers).toEqual({});
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

describe("sweepStaleAgentProfiles", () => {
	const deadPid = (): number => {
		const child = spawnSync(process.execPath, ["-e", "0"]);
		if (typeof child.pid !== "number") throw new Error("no pid from spawnSync");
		return child.pid;
	};
	const seed = (dir: string, pid: number, n: number): string[] => {
		const files = [`pi-kiro-bridge-${pid}-${n}.json`, `pi-kiro-bridge-${pid}-${n}.json.bak`, `pi-kiro-bridge-${pid}-${n}.json.bak.2`];
		for (const file of files) writeFileSync(join(dir, file), "{}", "utf8");
		return files;
	};

	it("removes a dead pi's profiles and backups, and leaves a live one's mid-turn files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-kiro-agents-"));
		const dead = seed(dir, deadPid(), 1);
		// process.ppid is a live process that is not this one: another pi mid-turn.
		const live = seed(dir, process.ppid, 4);
		const foreign = ["code-reviewer.json", "code-reviewer.json.bak", "pi-kiro-bridge-notes.json"];
		for (const file of foreign) writeFileSync(join(dir, file), "{}", "utf8");

		expect(sweepStaleAgentProfiles(dir)).toBe(dead.length);
		expect(readdirSync(dir).sort()).toEqual([...live, ...foreign].sort());
		rmSync(dir, { recursive: true, force: true });
	});

	// Pids are reused. At activation nothing in this process is mid-turn, so a file
	// carrying our own pid belongs to a dead predecessor; and a live pid on a file
	// older than any turn can run is an unrelated process that inherited the pid.
	it("treats this process's own pid, and a live pid on an ancient file, as stale", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-kiro-agents-"));
		const own = seed(dir, process.pid, 7);
		const ancient = seed(dir, process.ppid, 9);
		const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		for (const file of ancient) utimesSync(join(dir, file), longAgo, longAgo);

		expect(sweepStaleAgentProfiles(dir)).toBe(own.length + ancient.length);
		expect(readdirSync(dir)).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	// Age is judged per FILE, never per pid: a live pid can own both an ancient
	// leftover (from a dead process whose pid it inherited) and its own profile
	// for the turn it is running now. Deciding once per pid from whichever file
	// is listed first would delete that live profile mid-turn.
	it("ages each file on its own, so a live pid's current profile survives its ancient namesake", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-kiro-agents-"));
		const ancient = seed(dir, process.ppid, 1);
		const current = seed(dir, process.ppid, 2);
		const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		for (const file of ancient) utimesSync(join(dir, file), longAgo, longAgo);

		expect(sweepStaleAgentProfiles(dir)).toBe(ancient.length);
		expect(readdirSync(dir).sort()).toEqual([...current].sort());
		rmSync(dir, { recursive: true, force: true });
	});

	it("is a no-op on a missing directory", () => {
		expect(sweepStaleAgentProfiles(join(tmpdir(), "pi-kiro-no-such-dir", "agents"))).toBe(0);
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

	// test-setup.ts turns the mechanism off for the whole suite.
	beforeEach(() => {
		delete process.env.PI_KIRO_WORKSPACE_SETTINGS;
	});

	// ACP children of one pi (a parent and the subagents it fans out) can start
	// together in one cwd. The first holder's key must not read as the user's
	// own value to the rest, and must stay until the last of them is done.
	it("shares one hold between concurrent holders, and restores when the last releases", () => {
		const ws = mkws();
		const first = disableInheritedResources(ws);
		const second = disableInheritedResources(ws);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		first?.restore();
		expect(JSON.parse(readFileSync(settings(ws), "utf8"))).toEqual({ "chat.disableInheritingDefaultResources": true });
		first?.restore(); // idempotent: does not release the second holder's share
		expect(existsSync(settings(ws))).toBe(true);
		second?.restore();
		expect(existsSync(join(ws, ".kiro"))).toBe(false);
		rmSync(ws, { recursive: true, force: true });
	});

	// <home>/.kiro/settings/cli.json is kiro's GLOBAL settings file, not a workspace's.
	it("never writes kiro's global settings when the cwd is the home directory", () => {
		const before = existsSync(settings(homedir())) ? readFileSync(settings(homedir()), "utf8") : undefined;
		expect(disableInheritedResources(homedir())).toBeUndefined();
		const after = existsSync(settings(homedir())) ? readFileSync(settings(homedir()), "utf8") : undefined;
		expect(after).toBe(before);
	});

	// The open truncates before the write can fail (ENOSPC, EIO), and once the
	// sentinel exists it holds the only copy of the user's bytes.
	it("puts the user's file back when the write fails after truncating it", () => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		const before = `${JSON.stringify({ "chat.defaultModel": "claude-sonnet-4-5" })}\n`;
		writeFileSync(path, before, "utf8");
		const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
		_setSettingsWriterForTest((p) => {
			writeFileSync(p, "", "utf8");
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		});
		try {
			expect(disableInheritedResources(ws)).toBeUndefined();
		} finally {
			_setSettingsWriterForTest(undefined);
		}
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(existsSync(join(dirname(path), ".pi-kiro-settings-restore.json"))).toBe(false);
		expect(warn).toHaveBeenCalled();
		rmSync(ws, { recursive: true, force: true });
	});

	it("leaves no empty .kiro behind when the write fails in a project that had none", () => {
		const ws = mkws();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		_setSettingsWriterForTest(() => {
			throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
		});
		try {
			expect(disableInheritedResources(ws)).toBeUndefined();
		} finally {
			_setSettingsWriterForTest(undefined);
		}
		expect(existsSync(join(ws, ".kiro"))).toBe(false);
		rmSync(ws, { recursive: true, force: true });
	});

	// Another pi's reap treats a live pid's sentinel as stale once its ts is
	// older than any turn can run, so a hold kept alive by joiners must look fresh.
	it("refreshes the sentinel's timestamp when a holder joins", () => {
		const ws = mkws();
		const sentinel = join(dirname(settings(ws)), ".pi-kiro-settings-restore.json");
		const first = disableInheritedResources(ws);
		const record = JSON.parse(readFileSync(sentinel, "utf8"));
		writeFileSync(sentinel, `${JSON.stringify({ ...record, ts: 1 })}\n`, "utf8");
		const second = disableInheritedResources(ws);
		const joined = JSON.parse(readFileSync(sentinel, "utf8"));
		expect(joined.ts).toBeGreaterThan(Date.now() - 60_000);
		expect(joined.original).toBe(record.original);
		second?.restore();
		first?.restore();
		expect(existsSync(join(ws, ".kiro"))).toBe(false);
		rmSync(ws, { recursive: true, force: true });
	});

	// process.cwd() returns the real path, so HOME reached through a symlink
	// (or, on macOS, spelled in another case) must still count as home.
	it("treats a symlink to the home directory as home", () => {
		const link = join(mkws(), "home-link");
		symlinkSync(homedir(), link);
		const before = existsSync(settings(homedir())) ? readFileSync(settings(homedir()), "utf8") : undefined;
		expect(disableInheritedResources(link)).toBeUndefined();
		const after = existsSync(settings(homedir())) ? readFileSync(settings(homedir()), "utf8") : undefined;
		expect(after).toBe(before);
	});

	it.skipIf(process.platform !== "darwin")("treats the home directory spelled in another case as home, on macOS", () => {
		expect(disableInheritedResources(homedir().toUpperCase())).toBeUndefined();
	});

	// A read-only checkout, or a `.kiro` that is a file: lose the saving, keep the turn.
	it("fails open when the settings file cannot be written", () => {
		const ws = mkws();
		writeFileSync(join(ws, ".kiro"), "not a directory", "utf8");
		const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(() => disableInheritedResources(ws)).not.toThrow();
		expect(disableInheritedResources(ws)).toBeUndefined();
		expect(readFileSync(join(ws, ".kiro"), "utf8")).toBe("not a directory");
		expect(warn).toHaveBeenCalled();
		rmSync(ws, { recursive: true, force: true });
	});

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

	// Concurrent turns in one cwd (pi-subagents fan-out) share a pid, so the pid
	// alone cannot tell a live in-process owner from a stale leftover.
	it("a second turn in the same process does not restore the first turn's live change", () => {
		const ws = mkws();
		const path = settings(ws);
		const first = disableInheritedResources(ws);
		expect(first).toBeDefined();
		const second = disableInheritedResources(ws);
		// The key is ours, not the user's, so the second shares the change...
		expect(second).toBeDefined();
		// ...and the first's change and sentinel survived the second's reap pass.
		expect(JSON.parse(readFileSync(path, "utf8"))["chat.disableInheritingDefaultResources"]).toBe(true);
		expect(existsSync(join(dirname(path), ".pi-kiro-settings-restore.json"))).toBe(true);
		second?.restore();
		expect(existsSync(join(dirname(path), ".pi-kiro-settings-restore.json"))).toBe(true);
		first?.restore();
		expect(existsSync(join(ws, ".kiro"))).toBe(false);
		rmSync(ws, { recursive: true, force: true });
	});

	it("keeps an edit made to the settings file mid-turn, taking back only our key", () => {
		const ws = mkws();
		const path = settings(ws);
		const handle = disableInheritedResources(ws);
		writeFileSync(
			path,
			`${JSON.stringify({ "chat.disableInheritingDefaultResources": true, "chat.defaultModel": "claude-sonnet-4-5" })}\n`,
			"utf8",
		);
		handle?.restore();
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "chat.defaultModel": "claude-sonnet-4-5" });
		rmSync(ws, { recursive: true, force: true });
	});

	it("leaves the file alone when our key was changed mid-turn", () => {
		const ws = mkws();
		const path = settings(ws);
		const handle = disableInheritedResources(ws);
		const theirs = `${JSON.stringify({ "chat.disableInheritingDefaultResources": false })}\n`;
		writeFileSync(path, theirs, "utf8");
		handle?.restore();
		expect(readFileSync(path, "utf8")).toBe(theirs);
		rmSync(ws, { recursive: true, force: true });
	});

	// pids are reused: a dead owner's pid recycled by an unrelated live process
	// must not keep the setting stranded forever.
	it("reaps a sentinel whose pid is alive but which is older than any turn", () => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		const written = `${JSON.stringify({ "chat.disableInheritingDefaultResources": true })}\n`;
		writeFileSync(path, written, "utf8");
		const sentinel = join(dirname(path), ".pi-kiro-settings-restore.json");
		const old = Date.now() - 24 * 60 * 60 * 1000;
		writeFileSync(sentinel, `${JSON.stringify({ pid: process.ppid, ts: old, original: null, written })}\n`, "utf8");
		const handle = disableInheritedResources(ws);
		// Rolled back first, so this turn found a clean project and set the key itself.
		expect(handle).toBeDefined();
		handle?.restore();
		expect(existsSync(join(ws, ".kiro"))).toBe(false);
		rmSync(ws, { recursive: true, force: true });
	});

	it("leaves a fresh sentinel from a live pid alone", () => {
		const ws = mkws();
		const path = settings(ws);
		mkdirSync(dirname(path), { recursive: true });
		const written = `${JSON.stringify({ "chat.disableInheritingDefaultResources": true })}\n`;
		writeFileSync(path, written, "utf8");
		const sentinel = join(dirname(path), ".pi-kiro-settings-restore.json");
		writeFileSync(sentinel, `${JSON.stringify({ pid: process.ppid, ts: Date.now(), original: null, written })}\n`, "utf8");
		expect(disableInheritedResources(ws)).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(written);
		expect(existsSync(sentinel)).toBe(true);
		rmSync(ws, { recursive: true, force: true });
	});

	// chmod does not stop root, so the failure cannot be provoked there.
	it.skipIf(process.getuid?.() === 0)(
		"a restore that fails warns, keeps the sentinel, and the next turn retries it",
		() => {
			const ws = mkws();
			const path = settings(ws);
			mkdirSync(dirname(path), { recursive: true });
			const before = `${JSON.stringify({ "chat.defaultModel": "claude-sonnet-4-5" })}\n`;
			writeFileSync(path, before, "utf8");
			const sentinel = join(dirname(path), ".pi-kiro-settings-restore.json");
			const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				const handle = disableInheritedResources(ws);
				chmodSync(path, 0o444);
				handle?.restore();
				expect(warn).toHaveBeenCalledTimes(1);
				expect(String(warn.mock.calls[0]?.[0])).toContain(`could not restore ${path}`);
				expect(JSON.parse(readFileSync(sentinel, "utf8"))).toMatchObject({ pid: null, original: before });

				chmodSync(path, 0o644);
				const next = disableInheritedResources(ws);
				// The orphaned sentinel was retried first: the file was back to the
				// user's bytes before this turn set the key again.
				next?.restore();
				expect(readFileSync(path, "utf8")).toBe(before);
				expect(existsSync(sentinel)).toBe(false);
			} finally {
				warn.mockRestore();
				rmSync(ws, { recursive: true, force: true });
			}
		},
	);

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
