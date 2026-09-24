import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	allowedToolNames,
	type CapturedTool,
	clearBridgeCache,
	DEFAULT_BRIDGE_TOOLS,
	isBridgeablePackage,
	isContainedEntryPath,
	manifestExtensionEntries,
	serveBridgeHttp,
	toJsonSchema,
	warnOnMissingBridgeTools,
} from "../src/bridge.js";

const FAKE_CTX = { cwd: "/tmp" } as unknown as ExtensionContext;

function makeTool(overrides: Partial<CapturedTool> = {}): CapturedTool {
	return {
		name: "todo",
		description: "Track tasks",
		parameters: { type: "object", properties: { op: { type: "string" } }, required: ["op"] },
		execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
		...overrides,
	};
}

describe("allowedToolNames / toJsonSchema", () => {
	it("uses the default allowlist without an override", () => {
		expect([...allowedToolNames(undefined)].sort()).toEqual([...DEFAULT_BRIDGE_TOOLS].sort());
		expect([...allowedToolNames("todo, advisor ,")].sort()).toEqual(["advisor", "todo"]);
	});

	it("normalizes non-object schemas", () => {
		expect(toJsonSchema(undefined).type).toBe("object");
		expect(toJsonSchema({ type: "object", required: ["x"] })).toMatchObject({ required: ["x"] });
	});
});

describe("manifestExtensionEntries", () => {
	it("prefers pi.extensions over main", () => {
		expect(manifestExtensionEntries({ pi: { extensions: ["./src/index.ts", "./extra.ts"] }, main: "dist/index.js" })).toEqual([
			"./src/index.ts",
			"./extra.ts",
		]);
	});

	it("falls back to main and tolerates junk", () => {
		expect(manifestExtensionEntries({ main: "index.ts" })).toEqual(["index.ts"]);
		expect(manifestExtensionEntries({ pi: { extensions: [42, "./ok.ts"] } })).toEqual(["./ok.ts"]);
		expect(manifestExtensionEntries({})).toEqual([]);
		expect(manifestExtensionEntries(undefined)).toEqual([]);
	});
});

describe("isBridgeablePackage", () => {
	it("accepts only user-scope packages with an install path", () => {
		expect(isBridgeablePackage({ scope: "user", installedPath: "/home/u/.pi/npm/x" })).toBe(true);
	});

	it("rejects project scope — an untrusted repo must not inject a bridge source", () => {
		expect(isBridgeablePackage({ scope: "project", installedPath: "/repo/.pi/npm/x" })).toBe(false);
	});

	it("rejects packages that are not installed", () => {
		expect(isBridgeablePackage({ scope: "user" })).toBe(false);
		expect(isBridgeablePackage({ scope: "user", installedPath: "" })).toBe(false);
	});
});

describe("isContainedEntryPath", () => {
	it("accepts entries inside the install directory, including the directory itself", () => {
		expect(isContainedEntryPath("/home/u/.pi/npm/x", "/home/u/.pi/npm/x/dist/index.js")).toBe(true);
		expect(isContainedEntryPath("/home/u/.pi/npm/x/", "/home/u/.pi/npm/x/index.ts")).toBe(true);
		expect(isContainedEntryPath("/home/u/.pi/npm/x", "/home/u/.pi/npm/x")).toBe(true);
	});

	it("rejects a manifest entry that traverses out of the install directory", () => {
		expect(isContainedEntryPath("/home/u/.pi/npm/x", "/home/u/.pi/npm/x/../../../evil.ts")).toBe(false);
		expect(isContainedEntryPath("/home/u/.pi/npm/x", "/etc/passwd")).toBe(false);
	});

	it("rejects a sibling whose name merely starts with the install path", () => {
		// The reason for comparing against `base + sep` rather than a bare prefix.
		expect(isContainedEntryPath("/home/u/.pi/npm/x", "/home/u/.pi/npm/x-evil/index.js")).toBe(false);
	});
});

describe("serveBridgeHttp", () => {
	it("returns undefined with no tools", async () => {
		const handle = await serveBridgeHttp([], () => FAKE_CTX, new AbortController().signal);
		expect(handle).toBeUndefined();
	});

	it("serves MCP over loopback HTTP with bearer auth", async () => {
		const tool = makeTool();
		const controller = new AbortController();
		const handle = await serveBridgeHttp([tool], () => FAKE_CTX, controller.signal);
		if (!handle) throw new Error("expected handle");
		try {
			expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

			// Unauthorized without the token
			const raw = await fetch(handle.url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			});
			expect(raw.status).toBe(401);

			// Full MCP round-trip with the token
			const client = new Client({ name: "test-client", version: "1.0.0" });
			await client.connect(
				new StreamableHTTPClientTransport(new URL(handle.url), {
					requestInit: { headers: { Authorization: `Bearer ${handle.token}` } },
				}),
			);
			const listed = await client.listTools();
			expect(listed.tools.map((entry) => entry.name)).toEqual(["todo"]);
			const result = await client.callTool({ name: "todo", arguments: { op: "list" } });
			expect(result.isError ?? false).toBe(false);
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
			const execute = tool.execute as ReturnType<typeof vi.fn>;
			expect(execute.mock.calls[0]?.[4]).toBe(FAKE_CTX);
			await client.close();
		} finally {
			await handle.close();
		}
	});

	it("close() is idempotent", async () => {
		// The handle's owner closes it explicitly AND the signal's own listener
		// fires close() on abort, so a double close is routine rather than
		// exceptional. Both calls must share one shutdown instead of issuing a
		// second httpServer.close() that resolves off an ERR_SERVER_NOT_RUNNING.
		const handle = await serveBridgeHttp([makeTool()], () => FAKE_CTX, new AbortController().signal);
		if (!handle) throw new Error("expected handle");
		const first = handle.close();
		expect(handle.close()).toBe(first);
		await expect(first).resolves.toBeUndefined();
		await expect(handle.close()).resolves.toBeUndefined();
	});

	it("tears down on abort", async () => {
		const controller = new AbortController();
		const handle = await serveBridgeHttp([makeTool()], () => FAKE_CTX, controller.signal);
		if (!handle) throw new Error("expected handle");
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expect(
			fetch(handle.url, { method: "POST", body: "{}" }).then((response) => response.status),
		).rejects.toThrow();
	});
});

describe("warnOnMissingBridgeTools", () => {
	// A requested tool no loaded extension provides used to fail silently at mount
	// and opaquely much later: kiro simply never saw the tool, and the only symptom
	// was the delegated model reaching for something else, or a bare
	// `Tool <name> not found` from pi's dispatcher with nothing pointing at the
	// bridge. These tests pin the mount-time warning that names the real cause.

	function spyOnStderr() {
		return vi.spyOn(console, "error").mockImplementation(() => undefined);
	}

	beforeEach(() => {
		// The warning is once-per-process, so the dedupe set has to be reset or
		// whichever test ran first would silence the rest.
		clearBridgeCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names a single missing tool in the singular", () => {
		const spy = spyOnStderr();
		warnOnMissingBridgeTools(new Set(["todo", "advisor"]), [{ name: "todo" }]);
		expect(spy).toHaveBeenCalledTimes(1);
		const message = String(spy.mock.calls[0]?.[0]);
		expect(message).toContain("`advisor`");
		expect(message).toContain("tool `advisor` was requested");
		expect(message).not.toContain("tools `advisor`");
		// The operator needs to know what DID make it through, to tell "one
		// extension failed" apart from "nothing loaded at all".
		expect(message).toContain("Bridged: todo.");
	});

	it("names several missing tools in the plural", () => {
		const spy = spyOnStderr();
		warnOnMissingBridgeTools(new Set(["todo", "advisor", "Agent"]), [{ name: "todo" }]);
		expect(spy).toHaveBeenCalledTimes(1);
		const message = String(spy.mock.calls[0]?.[0]);
		expect(message).toContain("`advisor`");
		expect(message).toContain("`Agent`");
		expect(message).toContain("were requested");
		expect(message).toContain("they will be absent");
	});

	it("reports (none) when nothing at all was bridged", () => {
		// The all-missing case is the one worth distinguishing: it means extension
		// loading itself failed, not that one package is stale.
		const spy = spyOnStderr();
		warnOnMissingBridgeTools(new Set(["todo"]), []);
		expect(String(spy.mock.calls[0]?.[0])).toContain("Bridged: (none).");
	});

	it("stays silent when every requested tool is present", () => {
		const spy = spyOnStderr();
		warnOnMissingBridgeTools(new Set(["todo", "advisor"]), [{ name: "todo" }, { name: "advisor" }]);
		expect(spy).not.toHaveBeenCalled();
	});

	it("stays silent when an extra tool is bridged beyond the allow-list", () => {
		// Bridging MORE than was asked for is not a defect, so it must not warn.
		const spy = spyOnStderr();
		warnOnMissingBridgeTools(new Set(["todo"]), [{ name: "todo" }, { name: "advisor" }]);
		expect(spy).not.toHaveBeenCalled();
	});

	it("warns once per tool, not once per mount", () => {
		// Every ACP child mounts its own bridge, so an unguarded warning would
		// repeat on each spawn and drown the log it is meant to draw attention to.
		const spy = spyOnStderr();
		warnOnMissingBridgeTools(new Set(["todo", "advisor"]), [{ name: "todo" }]);
		warnOnMissingBridgeTools(new Set(["todo", "advisor"]), [{ name: "todo" }]);
		warnOnMissingBridgeTools(new Set(["todo", "advisor"]), [{ name: "todo" }]);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("still reports a newly missing tool after an earlier one was reported", () => {
		// Deduping per NAME rather than per call means a second, different failure
		// is not swallowed by the first.
		const spy = spyOnStderr();
		warnOnMissingBridgeTools(new Set(["advisor"]), []);
		warnOnMissingBridgeTools(new Set(["advisor", "Agent"]), []);
		expect(spy).toHaveBeenCalledTimes(2);
		const second = String(spy.mock.calls[1]?.[0]);
		expect(second).toContain("`Agent`");
		expect(second).not.toContain("`advisor`");
	});
});
