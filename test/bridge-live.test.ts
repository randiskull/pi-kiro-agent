/**
 * Live integration for the MCP bridge: a tool this pi process owns, reachable
 * inside a delegated kiro run as @pi/<tool>. Skipped unless PI_KIRO_LIVE=1.
 *
 *   PI_KIRO_LIVE=1 npx vitest run bridge-live.test.ts
 *
 * test/bridge.test.ts covers the manifest helpers and schema conversion but
 * never touches pi's package registry and never starts the HTTP server, so
 * until this file existed neither the discovery path nor the round trip
 * (profile -> kiro mounts loopback MCP -> model invokes -> call lands back
 * in-process) had any coverage.
 *
 * Split three ways on purpose, because the three parts fail for different
 * reasons and only one of them is pi-kiro's:
 *  1. discovery -- pi-kiro's own logic over the packages really installed
 *     under ~/.pi/agent. Deterministic; a failure here is a real defect.
 *  2. capture -- importing each sibling's TS entry, which only works inside a
 *     real pi host process (see the comment on the capture test). Asserted as
 *     "degrades, never throws" rather than "yields tools", which is the
 *     shipped contract.
 *  3. the round trip -- driven by a SYNTHETIC tool, so it proves the transport
 *     wiring end to end without inheriting (2)'s host dependency. The bridge
 *     does not care where a CapturedTool came from.
 *
 * Requires @juicesharp/rpiv-{todo,advisor,ask-user-question} and
 * @tintinweb/pi-subagents installed at user scope (pi install ...).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, it } from "vitest";
import {
	BRIDGE_SOURCES,
	type CapturedTool,
	captureBridgeTools,
	clearBridgeCache,
	isBridgeablePackage,
	isContainedEntryPath,
	manifestExtensionEntries,
	serveBridgeHttp,
} from "../src/bridge.js";
import { _resetSessions } from "../src/session-manager.js";
import { makeStreamViaKiro } from "../src/stream-adapter.js";
import { ctx, drainTurn, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, user, withRealHome } from "./live-support.js";

/**
 * The capture shim proxies over the host's real ExtensionAPI, so a sibling
 * extension that reaches for a method the shim neither no-ops nor forwards
 * would throw -- and captureBridgeTools swallows that, dropping the tool
 * silently. This stand-in therefore answers every method the shim knows about;
 * a missing tool below is a real finding, not a gap in this fake.
 */
const FAKE_PI = {
	registerTool: () => undefined,
	registerCommand: () => undefined,
	registerShortcut: () => undefined,
	registerFlag: () => undefined,
	registerMessageRenderer: () => undefined,
	registerEntryRenderer: () => undefined,
	registerProvider: () => undefined,
	unregisterProvider: () => undefined,
	on: () => undefined,
	setActiveTools: () => undefined,
	sendMessage: () => undefined,
	sendUserMessage: () => undefined,
	appendEntry: () => undefined,
	setModel: () => undefined,
	setThinkingLevel: () => undefined,
	getAllTools: () => [],
} as unknown as ExtensionAPI;

const FAKE_CTX = { cwd: process.cwd() } as unknown as ExtensionContext;

const PROBE_TOOL = "pi_kiro_live_probe";

/**
 * A CapturedTool built here rather than imported from a sibling. serveBridgeHttp
 * takes the array it is given, so this exercises exactly the same server, schema
 * conversion, auth and execute path a real captured tool would take -- while
 * keeping the round-trip test independent of whether a sibling's TS entry can be
 * imported in this process.
 */
function makeProbeTool(record: (params: unknown) => void): CapturedTool {
	return {
		name: PROBE_TOOL,
		description: "Record a marker string. Pass the marker verbatim as the 'marker' property.",
		parameters: {
			type: "object",
			properties: { marker: { type: "string", description: "the marker to record" } },
			required: ["marker"],
		},
		execute: async (_id, params) => {
			record(params);
			return { content: [{ type: "text", text: "recorded" }] };
		},
	};
}

describe.skipIf(!LIVE)("live MCP bridge", () => {
	withRealHome();

	const controllers: AbortController[] = [];
	afterAll(() => {
		for (const controller of controllers) controller.abort();
		clearBridgeCache();
	});

	it("locates every bridge source through pi's package registry, entries contained", async () => {
		const host = await import("@earendil-works/pi-coding-agent");
		const agentDir = host.getAgentDir();
		const settingsManager = host.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
		const packageManager = new host.DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager });

		// Mirror importViaPiRegistry's own walk: user scope only, name read from
		// the installed manifest (the package objects carry no name).
		const byName = new Map<string, string>();
		for (const pkg of packageManager.listConfiguredPackages()) {
			if (!isBridgeablePackage(pkg) || !pkg.installedPath) continue;
			try {
				const manifest = JSON.parse(readFileSync(resolvePath(pkg.installedPath, "package.json"), "utf8"));
				if (typeof manifest.name === "string") byName.set(manifest.name, pkg.installedPath);
			} catch {
				// unreadable manifest -- the same skip the product makes
			}
		}
		expect(byName.size, "no user-scope packages found under " + agentDir).toBeGreaterThan(0);

		for (const source of BRIDGE_SOURCES) {
			const installedPath = byName.get(source);
			expect(installedPath, source + " not installed at user scope (pi install " + source + ")").toBeDefined();
			if (!installedPath) continue;
			const manifest = JSON.parse(readFileSync(resolvePath(installedPath, "package.json"), "utf8"));
			const entries = manifestExtensionEntries(manifest);
			expect(entries.length, source + " manifest declares no extension entry").toBeGreaterThan(0);
			for (const entry of entries) {
				const entryPath = resolvePath(installedPath, entry);
				expect(existsSync(entryPath), source + " entry missing: " + entryPath).toBe(true);
				// The containment guard must PASS for legitimate entries; bridge.test.ts
				// covers the escaping cases.
				expect(isContainedEntryPath(installedPath, entryPath), entryPath).toBe(true);
			}
		}
	}, 60_000);

	/**
	 * captureBridgeTools imports each sibling's TypeScript entry and runs its
	 * default export. Those entries import @earendil-works/pi-tui and friends as
	 * bare specifiers, resolved against the AMBIENT host's module tree -- present
	 * when pi itself is running, absent under vitest, where ~/.pi/agent/npm has no
	 * pi-tui. So the honest assertion is the shipped contract: capture degrades to
	 * [] and never throws ("sibling failed to initialize -- bridge without it").
	 * Asserting non-empty here would only be satisfiable by faking the host, which
	 * would test the fake. The round trip below covers what capture feeds.
	 */
	it("capture degrades gracefully instead of throwing when siblings cannot be imported", async () => {
		const agentDir = (await import("@earendil-works/pi-coding-agent")).getAgentDir();
		const tuiResolvable = existsSync(join(agentDir, "npm", "node_modules", "@earendil-works", "pi-tui"));

		clearBridgeCache();
		const names = (await captureBridgeTools(FAKE_PI)).map((tool) => tool.name);
		expect(Array.isArray(names)).toBe(true);
		expect(new Set(names).size, "captured names must be deduped").toBe(names.length);
		if (tuiResolvable) {
			// The siblings' peer deps are present, so capture is expected to work.
			expect(names, "pi-tui is resolvable, so the siblings should have loaded").toContain("rpiv_todo");
		}
	}, 60_000);

	it("serves a bridged tool over authenticated loopback MCP", async () => {
		const controller = new AbortController();
		controllers.push(controller);
		const handle = await serveBridgeHttp([makeProbeTool(() => undefined)], () => FAKE_CTX, controller.signal);
		expect(handle).toBeDefined();
		if (!handle) return;

		// Unauthenticated request is refused before reaching the MCP layer.
		const denied = await fetch(handle.url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		expect(denied.status).toBe(401);

		// A real MCP client handshake, not a hand-rolled POST: this is the exact
		// path kiro's inline http server takes.
		const client = new Client({ name: "pi-kiro-probe", version: "0.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
			requestInit: { headers: { authorization: "Bearer " + handle.token } },
		});
		try {
			await client.connect(transport);
			const listed = (await client.listTools()).tools;
			expect(listed.map((tool) => tool.name)).toEqual(handle.toolNames);
			// Schemas must survive the TypeBox -> JSON Schema hop or kiro rejects them.
			for (const tool of listed) {
				expect(tool.inputSchema.type, tool.name + " input schema").toBe("object");
			}
			// And the call must reach execute through the server, not just list.
			const called = await client.callTool({ name: PROBE_TOOL, arguments: { marker: "MCP-CLIENT-CHECK" } });
			expect(JSON.stringify(called.content)).toContain("recorded");
		} finally {
			await client.close();
			await handle.close();
		}
	}, 60_000);

	// Model-behaviour dependent: asserts the delegated run COULD and DID reach a
	// bridged tool. A failure here means either the mount/transport broke or the
	// model declined to call the tool -- the failure message carries kiro's own
	// words so the two are distinguishable.
	it(
		"a delegated kiro turn calls a bridged tool back into this process",
		async () => {
			_resetSessions();
			const invocations: unknown[] = [];
			const tools = [makeProbeTool((params) => invocations.push(params))];

			const controller = new AbortController();
			controllers.push(controller);
			const streamViaKiro = makeStreamViaKiro({
				binaryPath: "kiro-cli",
				getBridge: async () => serveBridgeHttp(tools, () => FAKE_CTX, controller.signal),
			});

			const turn = await drainTurn(
				streamViaKiro(
					LIVE_MODEL,
					ctx([
						user(
							"Use the @pi/" +
								PROBE_TOOL +
								" tool to record the marker LIVE-BRIDGE-CHECK. " +
								"Call the tool, do not just describe it. Then reply with the single word DONE.",
						),
					]),
					undefined,
				),
			);

			expect(
				invocations.length,
				"the delegated run never reached the bridge; kiro said: " + turn.text,
			).toBeGreaterThan(0);
			expect(JSON.stringify(invocations)).toContain("LIVE-BRIDGE-CHECK");
			expect(turn.totalTokens).toBe(0);
		},
		LIVE_TIMEOUT_MS,
	);
});
