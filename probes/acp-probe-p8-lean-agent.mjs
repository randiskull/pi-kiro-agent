#!/usr/bin/env node
/**
 * P8: can the ACP transport run a lean, pi-owned agent without losing the
 * bridge, and when does kiro read the resource-inheritance setting?
 *
 * Cases (one billed turn each, Opus 5.5 by default):
 *
 *   mcp-allowed    lean agent whose `tools` names "@probe"; a stdio MCP server
 *                  named "probe" is mounted through session/new.mcpServers,
 *                  the way the ACP transport mounts the pi bridge. The model
 *                  is asked to call probe's `echo` tool.
 *   mcp-unlisted   same, but `tools` does not name "@probe".
 *   setting-at-*   which moments the workspace settings file disabling
 *                  inheritance is present: at spawn, at session/new, at
 *                  session/prompt. Shows when kiro reads it.
 *   second-session  setting present only at spawn, then two sessions on the
 *                  one child: does the second keep it?
 *   agent-dir      lean agent read from KIRO_AGENT_CONFIG_DIR (a temp dir)
 *                  instead of ~/.kiro/agents.
 *   record         KIRO_RECORD_API_REQUESTS_PATH set: report the `origin`
 *                  values and the size of what kiro-cli actually sends.
 *
 * Usage: node probes/acp-probe-p8-lean-agent.mjs [--model claude-opus-5.5] [--only a,b] [--cwd dir]
 *   --cwd runs every case in that directory instead of a fresh empty one; the
 *   cases write and remove <dir>/.kiro/settings/cli.json, so use a scratch checkout.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : dflt;
};
const MODEL = opt("model", "claude-opus-5.5");
const only = opt("only", "").split(",").filter(Boolean);
const FIXED_CWD = opt("cwd", undefined);
const LEAN_TOOLS = ["fs_read", "fs_write", "execute_bash", "grep", "glob"];
const TURN_TIMEOUT_MS = 180_000;
const scratch = mkdtempSync(join(tmpdir(), "pi-kiro-p8-"));

// A minimal stdio MCP server with one tool. Lives in the scratch dir, outside the repo.
const echoServer = join(scratch, "echo-mcp.mjs");
writeFileSync(
	echoServer,
	`import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
	let m; try { m = JSON.parse(l); } catch { return; }
	if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } } });
	else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo the given text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
	else if (m.method === "tools/call") out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ECHO:" + (m.params?.arguments?.text ?? "") }] } });
	else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
);

function writeAgent(dir, name, tools) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.json`);
	writeFileSync(path, `${JSON.stringify({ name, description: "pi-kiro-agent P8 probe (safe to delete)", tools, allowedTools: tools, resources: [], mcpServers: {} }, null, "\t")}\n`, { mode: 0o600 });
	return path;
}

function settingsPath(cwd) {
	return join(cwd, ".kiro", "settings", "cli.json");
}
function setInheritDisabled(cwd, on) {
	const p = settingsPath(cwd);
	if (on) {
		mkdirSync(join(cwd, ".kiro", "settings"), { recursive: true });
		writeFileSync(p, `${JSON.stringify({ "chat.disableInheritingDefaultResources": true })}\n`);
	} else rmSync(p, { force: true });
}

async function runCase({ agent, env = {}, mcp = false, prompt, settingAtSpawn = true, settingAtNew = true, settingAtPrompt = true, sessions = 1 }) {
	const cwd = FIXED_CWD ?? mkdtempSync(join(scratch, "cwd-"));
	setInheritDisabled(cwd, settingAtSpawn);
	const args = ["acp", "--trust-all-tools", "--agent-engine", "v2", "--model", MODEL, "--agent", agent];
	const child = spawn("kiro-cli", args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr += d.toString();
	});
	let id = 0;
	const pending = new Map();
	const request = (method, params) =>
		new Promise((resolve) => {
			id += 1;
			pending.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	let context;
	let credits;
	let text = "";
	const toolCalls = [];
	const serversReady = [];
	createInterface({ input: child.stdout }).on("line", (line) => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.id !== undefined && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
			return;
		}
		if (msg.id !== undefined && msg.method) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
			return;
		}
		if (msg.method === "_kiro.dev/mcp/server_initialized") serversReady.push(msg.params?.serverName);
		if (msg.method === "_kiro.dev/metadata") {
			const p = msg.params ?? {};
			if (p.contextUsagePercentage !== undefined) context = p.contextUsagePercentage;
			if (Array.isArray(p.meteringUsage) && p.turnDurationMs !== undefined) {
				credits = p.meteringUsage.reduce((n, m) => n + (Number(m.value) || 0), 0);
			}
		}
		if (msg.method === "session/update") {
			const u = msg.params?.update;
			if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text;
			if (u?.sessionUpdate === "tool_call") toolCalls.push(u.title ?? u.toolCallId);
		}
	});
	const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS);
	try {
		const init = await request("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: "pi-kiro-p8-probe", version: "0.1.0" },
		});
		if (init.error) throw new Error(`initialize: ${init.error.message}`);
		const mcpServers = mcp ? [{ name: "probe", command: process.execPath, args: [echoServer], env: [] }] : [];
		const perSession = [];
		for (let n = 0; n < sessions; n++) {
			setInheritDisabled(cwd, settingAtNew);
			const sess = await request("session/new", { cwd, mcpServers });
			if (sess.error) throw new Error(`session/new: ${sess.error.message}`);
			if (mcp) {
				const t0 = Date.now();
				while (!serversReady.includes("probe") && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 200));
			}
			setInheritDisabled(cwd, settingAtPrompt);
			const resp = await request("session/prompt", { sessionId: sess.result.sessionId, prompt: [{ type: "text", text: prompt }] });
			if (resp.error) throw new Error(`session/prompt: ${resp.error.message}`);
			await new Promise((r) => setTimeout(r, 1500));
			perSession.push({ context, credits });
		}
		return {
			context,
			approxTokens: context === undefined ? undefined : Math.round(context * 10_000),
			credits,
			toolCalls,
			serversReady,
			reply: text.trim().slice(0, 80),
			...(sessions > 1 ? { perSession } : {}),
		};
	} catch (err) {
		return { error: `${err.message}${stderr ? ` | ${stderr.trim().slice(-300)}` : ""}` };
	} finally {
		clearTimeout(timer);
		child.kill("SIGTERM");
		setInheritDisabled(cwd, false);
		for (const d of [join(cwd, ".kiro", "settings"), join(cwd, ".kiro")]) {
			try {
				rmdirSync(d);
			} catch {
				// not empty, or not ours
			}
		}
	}
}

/** Summarize recorded requests without echoing their content: origins, sizes, top-level keys. */
function summarizeRecordings(dir) {
	if (!existsSync(dir)) return { recorded: false };
	const files = [];
	const walk = (d) => {
		for (const e of readdirSync(d)) {
			const p = join(d, e);
			if (statSync(p).isDirectory()) walk(p);
			else files.push(p);
		}
	};
	if (statSync(dir).isDirectory()) walk(dir);
	else files.push(dir);
	const origins = {};
	const sizes = [];
	const shapes = new Set();
	for (const f of files) {
		const raw = readFileSync(f, "utf8");
		sizes.push(raw.length);
		for (const m of raw.matchAll(/"origin"\s*:\s*"?([A-Za-z_]+)"?/gi)) origins[m[1]] = (origins[m[1]] ?? 0) + 1;
		try {
			const j = JSON.parse(raw);
			shapes.add(Object.keys(j).join(","));
			const uim = j.user_input_message ?? j.userInputMessage;
			if (uim) {
				shapes.add(`user_input_message: ${Object.keys(uim).join(",")}`);
				for (const k of Object.keys(uim)) if (/origin/i.test(k)) origins[`${k}=${JSON.stringify(uim[k])}`] = 1;
				const ctx = uim.user_input_message_context ?? uim.userInputMessageContext;
				if (ctx) shapes.add(`context: ${Object.keys(ctx).map((k) => `${k}(${JSON.stringify(ctx[k]).length}B)`).join(",")}`);
			}
		} catch {
			shapes.add("(not one JSON document)");
		}
	}
	return { recorded: true, files: files.length, origins, bytes: sizes, shapes: [...shapes] };
}

const tag = `pi-kiro-p8-${process.pid}`;
const homeAgents = join(homedir(), ".kiro", "agents");
const altAgents = join(scratch, "agents");
const OK = "Reply with the single word OK.";
const ECHO = "Call the echo tool with text hi, then reply with exactly what it returned.";
const written = [
	writeAgent(homeAgents, `${tag}-mcp`, [...LEAN_TOOLS, "@probe"]),
	writeAgent(homeAgents, `${tag}-lean`, LEAN_TOOLS),
	writeAgent(altAgents, `${tag}-alt`, LEAN_TOOLS),
];
const recordDir = join(scratch, "record");

const cases = {
	"mcp-allowed": () => runCase({ agent: `${tag}-mcp`, mcp: true, prompt: ECHO }),
	"mcp-unlisted": () => runCase({ agent: `${tag}-lean`, mcp: true, prompt: ECHO }),
	"setting-at-spawn-and-new": () => runCase({ agent: `${tag}-lean`, prompt: OK, settingAtSpawn: true, settingAtNew: true, settingAtPrompt: false }),
	"setting-at-spawn-only": () => runCase({ agent: `${tag}-lean`, prompt: OK, settingAtSpawn: true, settingAtNew: false, settingAtPrompt: false }),
	"setting-at-new-only": () => runCase({ agent: `${tag}-lean`, prompt: OK, settingAtSpawn: false, settingAtNew: true, settingAtPrompt: false }),
	"second-session": () => runCase({ agent: `${tag}-lean`, prompt: OK, settingAtSpawn: true, settingAtNew: false, settingAtPrompt: false, sessions: 2 }),
	"setting-at-prompt": () => runCase({ agent: `${tag}-lean`, prompt: OK, settingAtSpawn: false, settingAtNew: false, settingAtPrompt: true }),
	"agent-dir": () => runCase({ agent: `${tag}-alt`, prompt: OK, env: { KIRO_AGENT_CONFIG_DIR: altAgents } }),
	record: async () => {
		const out = await runCase({ agent: `${tag}-lean`, prompt: OK, env: { KIRO_RECORD_API_REQUESTS_PATH: recordDir } });
		return { ...out, recording: summarizeRecordings(recordDir) };
	},
};

const results = { model: MODEL, measuredAt: new Date().toISOString(), cases: {} };
try {
	for (const [name, fn] of Object.entries(cases)) {
		if (only.length && !only.includes(name)) continue;
		results.cases[name] = await fn();
		process.stderr.write(`[p8] ${name}: ${JSON.stringify(results.cases[name])}\n`);
	}
} finally {
	for (const p of written) rmSync(p, { force: true });
	rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
