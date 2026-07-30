/**
 * GSD workflow-MCP transport tests.
 *
 * The parser fixtures reproduce real kiro-cli 2.15.2 non-interactive output
 * captured during the live transport probe (2026-07-30): the exact
 * "Running tool … (from mcp server: …)" grammar with ⋮-prefixed param lines.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAgentProfile } from "./kiro-bridge.js";
import {
	WORKFLOW_MCP_SERVER_KEY,
	discoverWorkflowMcpServers,
	parseKiroToolUses,
	synthesizeToolCallBlocks,
} from "./workflow-mcp.js";

// Captured (ANSI-stripped) from the live probe: one real gsd tool round-trip.
const PROBE_OUTPUT = `Running tool gsd_milestone_status with the param (from mcp server: gsdworkflow)
 ⋮  {
 ⋮    "milestoneId": "M027"
 ⋮  }
 - Completed in 0.11s
> M027 "AI Orchestration" is fully pending — all 3 slices have no tasks planned.`;

describe("parseKiroToolUses", () => {
	it("parses the live probe capture: name, server, and JSON params", () => {
		const uses = parseKiroToolUses(PROBE_OUTPUT);
		expect(uses).toHaveLength(1);
		expect(uses[0]).toEqual({
			name: "gsd_milestone_status",
			server: "gsdworkflow",
			arguments: { milestoneId: "M027" },
		});
	});

	it("parses multiple invocations including the no-param variant", () => {
		const body = [
			"Running tool gsd_query (from mcp server: gsdworkflow)",
			" - Completed in 0.02s",
			"Running tool gsd_plan_slice with the param (from mcp server: gsdworkflow)",
			' ⋮  { "milestoneId": "M027", "sliceId": "S01" }',
			" - Completed in 1.4s",
			"some working prose",
		].join("\n");
		const uses = parseKiroToolUses(body);
		expect(uses.map((u) => u.name)).toEqual(["gsd_query", "gsd_plan_slice"]);
		expect(uses[0]?.arguments).toEqual({});
		expect(uses[1]?.arguments).toEqual({ milestoneId: "M027", sliceId: "S01" });
	});

	it("degrades unparseable param JSON to {} without dropping the invocation", () => {
		const body = ["Running tool gsd_exec with the param (from mcp server: gsdworkflow)", " ⋮  { truncated…"].join("\n");
		const uses = parseKiroToolUses(body);
		expect(uses).toHaveLength(1);
		expect(uses[0]?.arguments).toEqual({});
	});

	it("returns [] for tool-free output", () => {
		expect(parseKiroToolUses("just a plain answer\nacross lines")).toEqual([]);
	});
});

describe("synthesizeToolCallBlocks", () => {
	it("maps uses onto pi ToolCall blocks with stable unique ids", () => {
		const blocks = synthesizeToolCallBlocks(PROBE_OUTPUT);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			type: "toolCall",
			name: "gsd_milestone_status",
			arguments: { milestoneId: "M027" },
		});
		expect(blocks[0]?.id).toContain("gsd_milestone_status");
	});
});

describe("discoverWorkflowMcpServers", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-kiro-wmcp-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_KIRO_WORKFLOW_MCP;
	});

	function writeConfig(config: unknown): void {
		writeFileSync(join(dir, ".mcp.json"), JSON.stringify(config));
	}

	it("translates a cwd-bearing stdio entry via the sh -c wrapper", () => {
		writeConfig({
			mcpServers: {
				"gsd-workflow": {
					command: "/usr/bin/node",
					args: ["/opt/gsd/mcp/cli.js"],
					cwd: "/projects/my vault",
					env: { GSD_WORKFLOW_PROJECT_ROOT: "/projects/my vault" },
				},
			},
		});
		const servers = discoverWorkflowMcpServers(dir);
		const server = servers?.[WORKFLOW_MCP_SERVER_KEY];
		expect(server).toBeDefined();
		expect(server?.command).toBe("/bin/sh");
		expect(server?.args?.[0]).toBe("-c");
		expect(server?.args?.[1]).toBe("cd '/projects/my vault' && exec '/usr/bin/node' '/opt/gsd/mcp/cli.js'");
		expect(server?.env).toEqual({ GSD_WORKFLOW_PROJECT_ROOT: "/projects/my vault" });
	});

	it("passes through a cwd-less entry unwrapped", () => {
		writeConfig({ mcpServers: { "gsd-workflow": { command: "gsd-mcp", args: ["--stdio"] } } });
		const server = discoverWorkflowMcpServers(dir)?.[WORKFLOW_MCP_SERVER_KEY];
		expect(server).toEqual({ command: "gsd-mcp", args: ["--stdio"], timeout: 30_000 });
	});

	it("walks up to a parent .mcp.json but stops at a .git boundary", () => {
		const nested = join(dir, "sub", "deeper");
		mkdirSync(nested, { recursive: true });
		writeConfig({ mcpServers: { "gsd-workflow": { command: "gsd-mcp" } } });
		expect(discoverWorkflowMcpServers(nested)).toBeDefined();
		// a .git in the subdir marks a different project root — no upward leak
		mkdirSync(join(dir, "sub", ".git"), { recursive: true });
		expect(discoverWorkflowMcpServers(nested)).toBeUndefined();
	});

	it("returns undefined when absent, malformed, or opted out", () => {
		expect(discoverWorkflowMcpServers(dir)).toBeUndefined();
		writeFileSync(join(dir, ".mcp.json"), "{not json");
		expect(discoverWorkflowMcpServers(dir)).toBeUndefined();
		writeConfig({ mcpServers: { "gsd-workflow": { command: "gsd-mcp" } } });
		process.env.PI_KIRO_WORKFLOW_MCP = "off";
		expect(discoverWorkflowMcpServers(dir)).toBeUndefined();
	});
});

describe("writeAgentProfile with workflow servers", () => {
	it("writes a bridge-less profile carrying only the workflow server", () => {
		const profile = writeAgentProfile(undefined, {
			[WORKFLOW_MCP_SERVER_KEY]: { command: "gsd-mcp", args: [] },
		});
		try {
			const written = JSON.parse(require("node:fs").readFileSync(profile.path, "utf8"));
			expect(written.mcpServers[WORKFLOW_MCP_SERVER_KEY]).toEqual({ command: "gsd-mcp", args: [] });
			expect(written.mcpServers.pi).toBeUndefined();
			expect(written.tools).toEqual(["*"]);
		} finally {
			profile.remove();
		}
	});

	it("merges bridge + workflow servers in one profile", () => {
		const profile = writeAgentProfile(
			{ urlWithToken: "http://127.0.0.1:1/mcp/tok", token: "tok", close: async () => {} } as never,
			{ [WORKFLOW_MCP_SERVER_KEY]: { command: "gsd-mcp", args: [] } },
		);
		try {
			const written = JSON.parse(require("node:fs").readFileSync(profile.path, "utf8"));
			expect(written.mcpServers.pi).toEqual({ type: "http", url: "http://127.0.0.1:1/mcp/tok" });
			expect(written.mcpServers[WORKFLOW_MCP_SERVER_KEY]).toBeDefined();
		} finally {
			profile.remove();
		}
	});
});
