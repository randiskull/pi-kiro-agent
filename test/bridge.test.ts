import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	allowedToolNames,
	bridgeMaxBodyBytes,
	type CapturedTool,
	clearBridgeCache,
	DEFAULT_BRIDGE_MAX_BODY_BYTES,
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

	it("returns 401 with a wrong-length token (guards the length-mismatch fast path)", async () => {
		const controller = new AbortController();
		const handle = await serveBridgeHttp([makeTool()], () => FAKE_CTX, controller.signal);
		if (!handle) throw new Error("expected handle");
		try {
			// "wrongtoken" is far shorter than the 48-char hex Bearer value
			const res = await fetch(handle.url, {
				method: "POST",
				headers: { "content-type": "application/json", Authorization: "Bearer wrongtoken" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			});
			expect(res.status).toBe(401);
		} finally {
			await handle.close();
		}
	});

	it("returns 401 with a same-length-but-wrong token (guards the timingSafeEqual path)", async () => {
		const controller = new AbortController();
		const handle = await serveBridgeHttp([makeTool()], () => FAKE_CTX, controller.signal);
		if (!handle) throw new Error("expected handle");
		try {
			// Construct a same-byte-length but wrong bearer value: "Bearer " + zeros of same length as the real token
			const wrongBearer = `Bearer ${"0".repeat(Buffer.byteLength(handle.token))}`;
			const res = await fetch(handle.url, {
				method: "POST",
				headers: { "content-type": "application/json", Authorization: wrongBearer },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			});
			expect(res.status).toBe(401);
		} finally {
			await handle.close();
		}
	});
});

describe("bridge request body limit", () => {
	// MCP SDK 1.30.1 began refusing request bodies over 4 MiB with a 413, before
	// any bridge code runs. A bridged tool that takes a binary (base64, so 4/3
	// inflation) hits that at ~3 MiB of payload. These tests pin the explicit,
	// larger ceiling and the warning that makes a refusal visible on our side.
	const ENV = "PI_KIRO_BRIDGE_MAX_BODY_BYTES";
	const MIB = 1024 * 1024;
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedEnv = process.env[ENV];
		delete process.env[ENV];
		clearBridgeCache();
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env[ENV];
		else process.env[ENV] = savedEnv;
		clearBridgeCache();
		vi.restoreAllMocks();
	});

	function rawToolsCall(url: string, token: string, op: string): Promise<Response> {
		return fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "todo", arguments: { op } },
			}),
		});
	}

	it("defaults well above the SDK's 4 MiB and honours a valid override", () => {
		expect(DEFAULT_BRIDGE_MAX_BODY_BYTES).toBeGreaterThan(4 * MIB);
		expect(bridgeMaxBodyBytes()).toBe(DEFAULT_BRIDGE_MAX_BODY_BYTES);
		process.env[ENV] = "2048";
		expect(bridgeMaxBodyBytes()).toBe(2048);
	});

	it("falls back to the default on an unusable override", () => {
		for (const bad of ["", "0", "-5", "abc"]) {
			process.env[ENV] = bad;
			expect(bridgeMaxBodyBytes()).toBe(DEFAULT_BRIDGE_MAX_BODY_BYTES);
		}
	});

	it("delivers a tools/call larger than the SDK's 4 MiB default to the tool", async () => {
		// Fails if maxRequestBodySize is dropped from the transport: the SDK's own
		// 4 MiB default would refuse this body before the tool is entered.
		const tool = makeTool();
		const handle = await serveBridgeHttp([tool], () => FAKE_CTX, new AbortController().signal);
		if (!handle) throw new Error("expected handle");
		const client = new Client({ name: "test-client", version: "1.0.0" });
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(handle.url), {
					requestInit: { headers: { Authorization: `Bearer ${handle.token}` } },
				}),
			);
			const big = "A".repeat(5 * MIB);
			const result = await client.callTool({ name: "todo", arguments: { op: big } });
			expect(result.isError ?? false).toBe(false);
			const execute = tool.execute as ReturnType<typeof vi.fn>;
			expect(execute).toHaveBeenCalledTimes(1);
			expect((execute.mock.calls[0]?.[1] as { op: string }).op.length).toBe(big.length);
		} finally {
			await client.close();
			await handle.close();
		}
	});

	it("refuses a body over the configured ceiling without entering the tool, and warns once", async () => {
		process.env[ENV] = "1024";
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const tool = makeTool();
		const handle = await serveBridgeHttp([tool], () => FAKE_CTX, new AbortController().signal);
		if (!handle) throw new Error("expected handle");
		try {
			const first = await rawToolsCall(handle.url, handle.token, "B".repeat(4096));
			expect(first.status).toBe(413);
			const second = await rawToolsCall(handle.url, handle.token, "B".repeat(4096));
			expect(second.status).toBe(413);
			expect(tool.execute).not.toHaveBeenCalled();

			// Once per process, not once per refusal: a retrying client must not
			// flood the log the warning is meant to draw attention to.
			const warnings = spy.mock.calls.map((call) => String(call[0])).filter((m) => m.includes(ENV));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("larger than 1024 bytes");

			// A body under the ceiling still goes through on the same bridge.
			const small = await rawToolsCall(handle.url, handle.token, "ok");
			expect(small.status).toBe(200);
		} finally {
			await handle.close();
		}
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
