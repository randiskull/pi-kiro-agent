/**
 * GSD workflow-MCP transport tests.
 *
 * The parser fixtures reproduce real kiro-cli 2.15.2 non-interactive output
 * captured during the live transport probe (2026-07-30): the exact
 * "Running tool … (from mcp server: …)" grammar with ⋮-prefixed param lines.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAgentProfile } from "../src/kiro-bridge.js";
import {
	WORKFLOW_MCP_SERVER_KEY,
	_resetWorkflowMcpNoticesForTest,
	createToolUseStreamParser,
	discoverWorkflowMcpServers,
	parseKiroToolUses,
	synthesizeToolCallBlocks,
	synthesizeWorkflowMcpEntry,
} from "../src/workflow-mcp.js";

// Captured (ANSI-stripped) from the live probe: one real gsd tool round-trip.
const PROBE_OUTPUT = `Running tool gsd_milestone_status with the param (from mcp server: gsdworkflow)
 ⋮  {
 ⋮    "milestoneId": "M027"
 ⋮  }
 - Completed in 0.11s
> M027 "AI Orchestration" is fully pending — all 3 slices have no tasks planned.`;

/**
 * Captured (ANSI-stripped) from kiro-cli 2.21.4 running the SAME tool. The
 * grammar changed: server and tool are fused as `@server/tool`, the order is
 * reversed relative to the legacy line, and no ⋮ param block follows — the next
 * line is a status line, so arguments degrade to {}. The two `[tool] Reading`
 * / `[tool] Searching` lines are built-in tools, which the new format renders
 * as prose with NO tool name: they are unparseable by design and must not
 * produce phantom uses.
 */
const COMPACT_OUTPUT = `I'll run the GSD health check.
[tool] Reading note.txt:1
[tool] Running: @gsdworkflow/gsd_doctor
[tool] status: Completed
DONE`;

/**
 * discoverWorkflowMcpServers writes an audit line to stderr whenever it mounts a
 * command sourced from a project `.mcp.json` (see announceFileSourcedEntry).
 * Capture it file-wide: the tests that assert on it read the spy, and the many
 * tests that merely exercise that path stay quiet. Nothing else in this module
 * writes to console.error, so nothing real is being hidden. The notice is
 * once-per-config-path for the life of the process, hence the reset.
 */
beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	_resetWorkflowMcpNoticesForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

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

	it("parses the compact kiro-cli 2.21 grammar, un-fusing server and tool", () => {
		const uses = parseKiroToolUses(COMPACT_OUTPUT);
		expect(uses).toEqual([{ name: "gsd_doctor", server: "gsdworkflow", arguments: {} }]);
	});

	it("does not invent uses for built-in tools, which the compact format renders without a name", () => {
		const body = ["[tool] Reading note.txt:1", "[tool] Searching for 'gsd'", "[tool] status: Completed"].join("\n");
		expect(parseKiroToolUses(body)).toEqual([]);
	});

	it("accepts both grammars in one body — an older kiro-cli must keep working", () => {
		const body = [
			"Running tool gsd_query (from mcp server: gsdworkflow)",
			" - Completed in 0.02s",
			"[tool] Running: @gsdworkflow/gsd_doctor",
			"[tool] status: Completed",
		].join("\n");
		expect(parseKiroToolUses(body).map((u) => `${u.server}/${u.name}`)).toEqual([
			"gsdworkflow/gsd_query",
			"gsdworkflow/gsd_doctor",
		]);
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

describe("synthesizeToolCallBlocks id uniqueness", () => {
	// GSD derives a workflow idempotency key from the ToolCall id
	// (`pi:gsd_task_complete:<id>`) and rejects a completion whose key already
	// belongs to another canonical operation. A bare positional id restarts at 0
	// each response, so `kiro-mcp-0-gsd_task_complete` collides across sessions
	// and every later completion throws — the work succeeds but is never
	// recorded. Observed in the wild: ordinals 0-7,9,11 consumed in one project,
	// leaving two finished tasks permanently uncloseable.
	const bodyFor = (arg: string) =>
		`Running tool gsd_task_complete with the param (from mcp server: gsdworkflow)\n ⋮  {\n ⋮    "taskId": "${arg}"\n ⋮  }`;

	it("does not collide across different response bodies", () => {
		const a = synthesizeToolCallBlocks(bodyFor("T05"));
		const b = synthesizeToolCallBlocks(bodyFor("T02"));
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
		expect(a[0]?.id).not.toBe(b[0]?.id);
	});

	it("is replay-stable — the same body yields the same ids", () => {
		const body = bodyFor("T05");
		expect(synthesizeToolCallBlocks(body).map((c) => c.id))
			.toEqual(synthesizeToolCallBlocks(body).map((c) => c.id));
	});

	it("still disambiguates repeated tool names within one response", () => {
		const body = `${bodyFor("T01")}\n${bodyFor("T02")}`;
		const ids = synthesizeToolCallBlocks(body).map((c) => c.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("keeps the kiro-mcp prefix and tool name in the id", () => {
		const id = synthesizeToolCallBlocks(bodyFor("T05"))[0]?.id ?? "";
		expect(id.startsWith("kiro-mcp-")).toBe(true);
		expect(id.endsWith("-gsd_task_complete")).toBe(true);
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

	it("announces a file-sourced command on stderr, once per config path", () => {
		writeConfig({ mcpServers: { "gsd-workflow": { command: "gsd-mcp" } } });
		expect(discoverWorkflowMcpServers(dir)).toBeDefined();
		expect(console.error).toHaveBeenCalledTimes(1);
		const line = vi.mocked(console.error).mock.calls[0]?.[0] as string;
		expect(line).toContain(join(dir, ".mcp.json"));
		expect(line).toContain("--trust-all-tools");
		expect(line).toContain("PI_KIRO_WORKFLOW_MCP=off");
		// Discovery runs once per turn — the audit line must not repeat every turn.
		expect(discoverWorkflowMcpServers(dir)).toBeDefined();
		expect(console.error).toHaveBeenCalledTimes(1);
	});

	it("announces nothing when there is no entry to mount or discovery is off", () => {
		expect(discoverWorkflowMcpServers(dir)).toBeUndefined();
		writeConfig({ mcpServers: { "gsd-workflow": { command: "gsd-mcp" } } });
		process.env.PI_KIRO_WORKFLOW_MCP = "off";
		expect(discoverWorkflowMcpServers(dir)).toBeUndefined();
		expect(console.error).not.toHaveBeenCalled();
	});

	it(".git file (linked worktree) does not stop the .mcp.json walk", () => {
		// Layout: dir/parent/.mcp.json and dir/parent/worktree/.git (FILE)
		const parent = join(dir, "parent");
		const worktree = join(parent, "worktree");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(parent, ".mcp.json"),
			JSON.stringify({ mcpServers: { "gsd-workflow": { command: "gsd-mcp" } } }),
		);
		// .git as a FILE (linked worktree) — must NOT stop the walk
		writeFileSync(join(worktree, ".git"), "gitdir: ../../.git/worktrees/test\n");
		expect(discoverWorkflowMcpServers(worktree)).toBeDefined();
	});

	it(".git directory still stops the .mcp.json walk", () => {
		// Layout: dir/parent/.mcp.json and dir/parent/sub/.git (DIRECTORY)
		const parent = join(dir, "parent");
		const sub = join(parent, "sub");
		mkdirSync(join(sub, ".git"), { recursive: true });
		writeFileSync(
			join(parent, ".mcp.json"),
			JSON.stringify({ mcpServers: { "gsd-workflow": { command: "gsd-mcp" } } }),
		);
		// .git as a DIRECTORY — must stop the walk (sub is a different project)
		expect(discoverWorkflowMcpServers(sub)).toBeUndefined();
	});
});

/**
 * Zero-config synthesis: a GSD project with no `.mcp.json` must still get the
 * gsd-workflow server, or a delegated kiro turn can write files but can never
 * call gsd_task_complete (task row stuck `pending`, hand reconcile).
 *
 * The fixture reproduces the real install layout: a `gsd` symlink on PATH
 * pointing into `<install>/dist/loader.js`, the workflow server at
 * `<install>/packages/mcp-server/dist/cli.js`, and the LIVE extension copies
 * under the agent dir (`$GSD_HOME/agent/extensions/gsd/…`).
 */
describe("synthesizeWorkflowMcpEntry", () => {
	let root: string;
	let projectDir: string;
	let installRoot: string;
	let serverCli: string;
	let gsdBin: string;
	let gsdHome: string;
	let env: NodeJS.ProcessEnv;

	function touch(path: string, body = "// fixture\n"): void {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, body);
	}

	beforeEach(() => {
		// realpath the tmpdir: on macOS /var is a symlink to /private/var, and
		// install-root resolution realpaths the gsd binary.
		root = realpathSync(mkdtempSync(join(tmpdir(), "pi-kiro-synth-")));
		projectDir = join(root, "project");
		installRoot = join(root, "lib", "node_modules", "@opengsd", "gsd-pi");
		serverCli = join(installRoot, "packages", "mcp-server", "dist", "cli.js");
		gsdHome = join(root, "gsdhome");
		gsdBin = join(root, "bin", "gsd");

		mkdirSync(join(projectDir, ".gsd"), { recursive: true });
		touch(serverCli);
		touch(join(installRoot, "dist", "loader.js"));
		mkdirSync(join(root, "bin"), { recursive: true });
		symlinkSync(join(installRoot, "dist", "loader.js"), gsdBin);
		touch(join(gsdHome, "agent", "extensions", "gsd", "tools", "workflow-tool-executors.js"));
		touch(join(gsdHome, "agent", "extensions", "gsd", "bootstrap", "write-gate.js"));

		env = { PATH: join(root, "bin"), GSD_HOME: gsdHome };
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("synthesizes a complete entry for a GSD project with no .mcp.json", () => {
		const entry = synthesizeWorkflowMcpEntry(projectDir, env);
		expect(entry).toEqual({
			command: process.execPath,
			args: [serverCli],
			cwd: projectDir,
			env: {
				GSD_CLI_PATH: gsdBin,
				GSD_BIN_PATH: gsdBin,
				GSD_WORKFLOW_EXECUTORS_MODULE: join(gsdHome, "agent", "extensions", "gsd", "tools", "workflow-tool-executors.js"),
				GSD_WORKFLOW_WRITE_GATE_MODULE: join(gsdHome, "agent", "extensions", "gsd", "bootstrap", "write-gate.js"),
				GSD_PERSIST_WRITE_GATE_STATE: "1",
				GSD_WORKFLOW_PROJECT_ROOT: projectDir,
			},
		});
	});

	it("finds the project root from a nested cwd and from a milestone worktree", () => {
		const nested = join(projectDir, "src", "deep");
		mkdirSync(nested, { recursive: true });
		expect(synthesizeWorkflowMcpEntry(nested, env)?.cwd).toBe(projectDir);
		// A worktree cwd must resolve to the real project root, not the worktree.
		const worktree = join(projectDir, ".gsd", "worktrees", "M038", "pkg");
		mkdirSync(worktree, { recursive: true });
		expect(synthesizeWorkflowMcpEntry(worktree, env)?.cwd).toBe(projectDir);
	});

	it("returns undefined for a non-GSD project", () => {
		const plain = join(root, "plain");
		mkdirSync(plain, { recursive: true });
		expect(synthesizeWorkflowMcpEntry(plain, env)).toBeUndefined();
	});

	it("stops at a .git boundary rather than leaking to a parent .gsd", () => {
		const inner = join(projectDir, "vendored");
		mkdirSync(join(inner, ".git"), { recursive: true });
		expect(synthesizeWorkflowMcpEntry(inner, env)).toBeUndefined();
	});

	it(".git file (linked worktree) does not stop GSD project root discovery", () => {
		// Layout: projectDir/.gsd/ (project marker) and projectDir/sub/.git (FILE)
		const sub = join(projectDir, "sub");
		mkdirSync(sub, { recursive: true });
		// .git as a FILE (linked worktree) — must NOT stop the upward walk
		writeFileSync(join(sub, ".git"), "gitdir: ../../.git/worktrees/test\n");
		const entry = synthesizeWorkflowMcpEntry(sub, env);
		expect(entry).toBeDefined();
		expect(entry?.cwd).toBe(projectDir);
	});

	it("returns undefined when the gsd install is unresolvable", () => {
		expect(synthesizeWorkflowMcpEntry(projectDir, { PATH: join(root, "nowhere") })).toBeUndefined();
		// gsd on PATH but no workflow server built in the install
		rmSync(serverCli, { force: true });
		expect(synthesizeWorkflowMcpEntry(projectDir, env)).toBeUndefined();
	});

	it("honors GSD_CLI_PATH ahead of PATH", () => {
		const entry = synthesizeWorkflowMcpEntry(projectDir, { GSD_CLI_PATH: gsdBin, GSD_HOME: gsdHome, PATH: "" });
		expect(entry?.args).toEqual([serverCli]);
		expect(entry?.env?.GSD_CLI_PATH).toBe(gsdBin);
	});

	it("supports a GSD dev checkout that ships the server in-tree", () => {
		const checkout = join(root, "checkout");
		mkdirSync(join(checkout, ".gsd"), { recursive: true });
		touch(join(checkout, "packages", "mcp-server", "dist", "cli.js"));
		const entry = synthesizeWorkflowMcpEntry(checkout, { PATH: "", GSD_HOME: gsdHome });
		expect(entry?.args).toEqual([join(checkout, "packages", "mcp-server", "dist", "cli.js")]);
		expect(entry?.env?.GSD_CLI_PATH).toBeUndefined();
	});

	it("prefers the live agent-dir extension copy over the install-tree copy", () => {
		touch(join(installRoot, "dist", "resources", "extensions", "gsd", "tools", "workflow-tool-executors.js"));
		const entry = synthesizeWorkflowMcpEntry(projectDir, env);
		expect(entry?.env?.GSD_WORKFLOW_EXECUTORS_MODULE).toBe(
			join(gsdHome, "agent", "extensions", "gsd", "tools", "workflow-tool-executors.js"),
		);
	});

	it("still synthesizes when the extension modules are unresolvable, omitting those vars", () => {
		rmSync(join(gsdHome, "agent"), { recursive: true, force: true });
		const entry = synthesizeWorkflowMcpEntry(projectDir, env);
		expect(entry?.args).toEqual([serverCli]);
		expect(entry?.env?.GSD_WORKFLOW_EXECUTORS_MODULE).toBeUndefined();
		expect(entry?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE).toBeUndefined();
		expect(entry?.env?.GSD_WORKFLOW_PROJECT_ROOT).toBe(projectDir);
	});

	describe("via discoverWorkflowMcpServers", () => {
		it("wraps the synthesized entry through the same sh -c cwd translation", () => {
			const server = discoverWorkflowMcpServers(projectDir, env)?.[WORKFLOW_MCP_SERVER_KEY];
			expect(server?.command).toBe("/bin/sh");
			expect(server?.args?.[1]).toBe(`cd '${projectDir}' && exec '${process.execPath}' '${serverCli}'`);
			expect(server?.timeout).toBe(30_000);
			expect(server?.env?.GSD_WORKFLOW_PROJECT_ROOT).toBe(projectDir);
		});

		it("lets an explicit .mcp.json entry win over synthesis", () => {
			writeFileSync(
				join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { "gsd-workflow": { command: "explicit-gsd-mcp" } } }),
			);
			const server = discoverWorkflowMcpServers(projectDir, env)?.[WORKFLOW_MCP_SERVER_KEY];
			expect(server).toEqual({ command: "explicit-gsd-mcp", args: [], timeout: 30_000 });
		});

		it("falls back to synthesis when .mcp.json is malformed or lacks the entry", () => {
			writeFileSync(join(projectDir, ".mcp.json"), "{not json");
			expect(discoverWorkflowMcpServers(projectDir, env)).toBeDefined();
			writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
			expect(discoverWorkflowMcpServers(projectDir, env)).toBeDefined();
		});

		it("announces nothing for a synthesized entry (no project-supplied command)", () => {
			expect(discoverWorkflowMcpServers(projectDir, env)).toBeDefined();
			expect(console.error).not.toHaveBeenCalled();
		});

		it("respects PI_KIRO_WORKFLOW_MCP=off for synthesized entries too", () => {
			expect(discoverWorkflowMcpServers(projectDir, { ...env, PI_KIRO_WORKFLOW_MCP: "off" })).toBeUndefined();
		});
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

describe("createToolUseStreamParser (live progress)", () => {
	it("detects tool-use lines fed in arbitrary chunk splits", () => {
		const parser = createToolUseStreamParser();
		expect(parser.feed("working prose\nRunning tool gsd_plan_sl")).toEqual([]);
		expect(parser.feed("ice with the param (from mcp server: gsdworkflow)\n")).toEqual([
			{ name: "gsd_plan_slice", server: "gsdworkflow" },
		]);
		expect(parser.feed("Running tool fs_read (from mcp server: pi)\nmore prose\n")).toEqual([
			{ name: "fs_read", server: "pi" },
		]);
	});

	it("ignores non-tool lines and incomplete trailing lines", () => {
		const parser = createToolUseStreamParser();
		expect(parser.feed("just text\npartial Running tool nope")).toEqual([]);
	});

	it("detects the compact grammar mid-stream and ignores its status/built-in lines", () => {
		const parser = createToolUseStreamParser();
		expect(parser.feed("I'll check.\n[tool] Reading note.txt:1\n[tool] Running: @gsdwo")).toEqual([]);
		expect(parser.feed("rkflow/gsd_doctor\n[tool] status: Completed\n")).toEqual([
			{ name: "gsd_doctor", server: "gsdworkflow" },
		]);
	});
});
