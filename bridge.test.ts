import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import {
	allowedToolNames,
	type CapturedTool,
	DEFAULT_BRIDGE_TOOLS,
	isBridgeablePackage,
	isContainedEntryPath,
	manifestExtensionEntries,
	serveBridgeHttp,
	toJsonSchema,
} from "./bridge.js";

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
