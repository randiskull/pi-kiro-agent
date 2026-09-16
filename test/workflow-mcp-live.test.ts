/**
 * Live integration for the GSD workflow-MCP path: a project's gsd-workflow MCP
 * server discovered from .mcp.json, translated into a kiro agent profile,
 * mounted on a real delegated turn, and its tool calls recovered from kiro's
 * output as pi ToolCall blocks. Skipped unless PI_KIRO_LIVE=1.
 *
 *   PI_KIRO_LIVE=1 npx vitest run workflow-mcp-live.test.ts
 *
 * Those ToolCall blocks are the contract that matters: GSD counts them in
 * snapshotUnitActivity, so a unit that really did call gsd_* but produced no
 * blocks trips GSD's zero-tool-call guard and gets salvaged. test/workflow-mcp.
 * test.ts pins the parser against fixture strings; only this file proves the
 * blocks come back from a server that actually ran.
 *
 * Hermetic by construction. The obvious fixture -- copying a real GSD project's
 * .mcp.json -- is not: its gsd-workflow entry pins cwd and
 * GSD_WORKFLOW_PROJECT_ROOT to absolute paths, so a copied config still drives
 * the original project (and GSD_PERSIST_WRITE_GATE_STATE=1 means it writes).
 * This fixture therefore points both at a throwaway root.
 *
 * NODE_OPTIONS is deliberately omitted. Real GSD projects set a TS-stripping
 * loader there that redirects the server's dist imports to sibling src/*.ts
 * files; a released @opengsd/gsd-pi ships no src/ for its mcp-server package, so
 * that config cannot start at all (ERR_MODULE_NOT_FOUND on cli-errors.ts).
 * Without it the released server starts and serves its tools.
 *
 * Read-only tool under test: gsd_doctor. Never a gsd_plan_* / gsd_*_save, which
 * would mutate the fixture project's workflow state.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _resetSessions } from "../src/session-manager.js";
import { makeStreamViaKiro } from "../src/stream-adapter.js";
import {
	_resetWorkflowMcpNoticesForTest,
	discoverWorkflowMcpServers,
	parseKiroToolUses,
	WORKFLOW_MCP_CONFIG_NAME,
	WORKFLOW_MCP_SERVER_KEY,
} from "../src/workflow-mcp.js";
import { ctx, drainTurn, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, user, withRealHome } from "./live-support.js";

const GSD_ROOT = "/opt/homebrew/lib/node_modules/@opengsd/gsd-pi";
const GSD_MCP_CLI = join(GSD_ROOT, "packages", "mcp-server", "dist", "cli.js");
const HAVE_GSD = existsSync(GSD_MCP_CLI);
const NODE_BIN = process.execPath;

let fixtureDir = "";

/** A .mcp.json whose gsd-workflow entry runs the released server on a throwaway root. */
function writeFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-kiro-gsdfix-"));
	const config = {
		mcpServers: {
			[WORKFLOW_MCP_CONFIG_NAME]: {
				command: NODE_BIN,
				args: [GSD_MCP_CLI],
				cwd: dir,
				env: {
					GSD_CLI_PATH: join(GSD_ROOT, "dist", "loader.js"),
					GSD_BIN_PATH: join(GSD_ROOT, "dist", "loader.js"),
					GSD_WORKFLOW_PROJECT_ROOT: dir,
				},
			},
		},
	};
	writeFileSync(join(dir, ".mcp.json"), JSON.stringify(config, null, 2), "utf8");
	return dir;
}

describe.skipIf(!LIVE || !HAVE_GSD)("live GSD workflow MCP", () => {
	withRealHome();

	beforeAll(() => {
		_resetWorkflowMcpNoticesForTest();
		fixtureDir = writeFixture();
	});

	it("translates the project's gsd-workflow entry for a kiro agent profile", () => {
		const servers = discoverWorkflowMcpServers(fixtureDir);
		expect(servers, "no workflow server discovered in " + fixtureDir).toBeDefined();
		const entry = servers?.[WORKFLOW_MCP_SERVER_KEY];
		expect(entry, "expected key " + WORKFLOW_MCP_SERVER_KEY).toBeDefined();
		// kiro's mcpServers schema has no `cwd` field, so a cwd-bearing entry is
		// honored by wrapping it in `/bin/sh -c "cd <cwd> && exec <cmd> <args>"`.
		// Asserting the wrapper (not the node binary) is what actually pins the
		// translation kiro receives.
		expect(entry?.command).toBe("/bin/sh");
		expect(entry?.args?.[0]).toBe("-c");
		const script = entry?.args?.[1] ?? "";
		expect(script).toContain(fixtureDir);
		expect(script).toContain(NODE_BIN);
		expect(script).toContain(GSD_MCP_CLI);
		expect(entry?.timeout).toBeGreaterThan(0);
		// The file entry must win outright -- a synthesized fallback here would mean
		// the real project config was silently ignored.
		expect(entry?.env?.GSD_WORKFLOW_PROJECT_ROOT).toBe(fixtureDir);
	});

	it("that translated entry starts a real server that serves gsd tools", async () => {
		const entry = discoverWorkflowMcpServers(fixtureDir)?.[WORKFLOW_MCP_SERVER_KEY];
		expect(entry).toBeDefined();
		if (!entry) return;

		// Launch exactly what we would hand kiro, so a translation defect that kiro
		// would reject fails here instead of costing a model turn to find.
		const client = new Client({ name: "pi-kiro-probe", version: "0.0.0" });
		const transport = new StdioClientTransport({
			command: entry.command,
			args: entry.args,
			cwd: fixtureDir,
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(entry.env ?? {}) },
		});
		try {
			await client.connect(transport);
			const names = (await client.listTools()).tools.map((tool) => tool.name);
			expect(names).toContain("gsd_doctor");
			expect(names.filter((name) => name.startsWith("gsd_")).length).toBeGreaterThan(10);
		} finally {
			await client.close();
		}
	}, 120_000);

	// Model-behaviour dependent: the model has to choose to call the tool. What is
	// under test is everything after that choice -- kiro mounting the server from
	// our profile, and the adapter turning its output back into ToolCall blocks.
	it(
		"a delegated turn calls gsd_doctor and it comes back as a pi ToolCall block",
		async () => {
			// The transport reads process.cwd() for discovery, so the turn has to run
			// from the fixture. Requires a forks pool (vitest default); the threads
			// pool has no process.chdir.
			if (typeof process.chdir !== "function") return;
			const originalCwd = process.cwd();
			process.chdir(fixtureDir);
			try {
				_resetSessions();
				const streamViaKiro = makeStreamViaKiro({ binaryPath: "kiro-cli" });
				const turn = await drainTurn(
					streamViaKiro(
						LIVE_MODEL,
						ctx([
							user(
								"Call the gsd_doctor tool now to check this project's GSD health. " +
									"Call the tool, do not describe it, and do not call any other tool. " +
									"Then reply with the single word DONE.",
							),
						]),
						undefined,
					),
				);

				const toolCalls = turn.content.filter((block) => block.type === "toolCall");
				expect(
					toolCalls.length,
					"no ToolCall blocks synthesized; GSD would salvage this unit. kiro said: " + turn.text,
				).toBeGreaterThan(0);
				expect(toolCalls.map((block) => ("name" in block ? block.name : ""))).toContain("gsd_doctor");
				// Same invocation, seen through the parser the host relies on.
				expect(parseKiroToolUses("Running tool gsd_doctor (from mcp server: gsdworkflow)")).toHaveLength(1);
				expect(turn.totalTokens).toBe(0);
			} finally {
				process.chdir(originalCwd);
			}
		},
		LIVE_TIMEOUT_MS,
	);

	afterAll(() => {
		_resetWorkflowMcpNoticesForTest();
	});
});
