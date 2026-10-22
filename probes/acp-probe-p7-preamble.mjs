#!/usr/bin/env node
/**
 * P7: how much of a delegated turn's context is fixed overhead, and where it
 * comes from.
 *
 * Sends the same one-line prompt through `kiro-cli acp` under three agent
 * configurations and records the server-reported context usage
 * (`_kiro.dev/metadata.contextUsagePercentage`) and credits
 * (`meteringUsage`). Each run starts a fresh child in a fresh temp directory
 * whose workspace settings disable inherited default resources, so steering
 * and skills on this machine do not leak into the numbers.
 *
 *   floor      custom agent, tools [], resources [], no MCP servers
 *   all-tools  custom agent, tools ["*"]  (the chat transport's profile shape)
 *   lean       custom agent, the lean ACP tool set (fs_read, fs_write,
 *              execute_bash, grep, glob, web_fetch)
 *   *-inherit  same, but without disabling inherited default resources
 *   kiro_default  the built-in default agent
 *   user-default  no --agent: whatever `chat.defaultAgent` names on this
 *                 machine, which is what the ACP transport runs today
 *
 * The floor is the server preamble plus kiro's client-side agent prompt plus
 * the prompt itself. Subtracting floor from the others isolates tool schemas.
 *
 * Usage: node probes/acp-probe-p7-preamble.mjs [--model claude-opus-5.5] [--rounds 3] [--only floor,lean] [--set-model]
 * Billed: one short turn per config per round.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : dflt;
};
const MODEL = opt("model", "claude-opus-5.5");
const ROUNDS = Number(opt("rounds", "3"));
// --set-model: start on the user's default model and switch with session/set_model,
// the way the ACP transport does, instead of passing --model at spawn.
const SET_MODEL = argv.includes("--set-model");
const PROMPT = "Reply with the single word OK.";
const WINDOW_TOKENS = 1_000_000;
const TURN_TIMEOUT_MS = 120_000;

const agentsDir = join(homedir(), ".kiro", "agents");

function writeAgent(name, tools) {
	mkdirSync(agentsDir, { recursive: true });
	const path = join(agentsDir, `${name}.json`);
	writeFileSync(
		path,
		`${JSON.stringify({ name, description: "pi-kiro-agent P7 probe (safe to delete)", tools, allowedTools: tools, resources: [], mcpServers: {} }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	return path;
}

function runOnce(agent, inherit = false) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-kiro-p7-"));
	if (!inherit) {
		mkdirSync(join(cwd, ".kiro", "settings"), { recursive: true });
		writeFileSync(join(cwd, ".kiro", "settings", "cli.json"), `${JSON.stringify({ "chat.disableInheritingDefaultResources": true })}\n`);
	}
	const args = ["acp", "--trust-all-tools", "--agent-engine", "v2", ...(SET_MODEL ? [] : ["--model", MODEL])];
	if (agent) args.push("--agent", agent);
	const child = spawn("kiro-cli", args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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
			// Agent-to-client request (permission, fs): answer empty so nothing hangs.
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
			return;
		}
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
		}
	});
	const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS);
	const done = (async () => {
		const init = await request("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: "pi-kiro-p7-probe", version: "0.1.0" },
		});
		if (init.error) throw new Error(`initialize: ${init.error.message}`);
		const sess = await request("session/new", { cwd, mcpServers: [] });
		if (sess.error) throw new Error(`session/new: ${sess.error.message}`);
		const sessionId = sess.result.sessionId;
		if (SET_MODEL) {
			const set = await request("session/set_model", { sessionId, modelId: MODEL });
			if (set.error) throw new Error(`session/set_model: ${set.error.message}`);
		}
		const resp = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: PROMPT }] });
		if (resp.error) throw new Error(`session/prompt: ${resp.error.message}`);
		// The final metadata notification can trail the prompt reply slightly.
		await new Promise((r) => setTimeout(r, 1500));
		return { context, credits, reply: text.trim().slice(0, 40) };
	})();
	return done
		.catch((err) => ({ error: `${err.message}${stderr ? ` | ${stderr.trim().slice(-300)}` : ""}` }))
		.finally(() => {
			clearTimeout(timer);
			child.kill("SIGTERM");
			rmSync(cwd, { recursive: true, force: true });
		});
}

const median = (xs) => {
	const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
	if (!s.length) return undefined;
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const tag = `pi-kiro-p7-${process.pid}`;
const LEAN_TOOLS = ["fs_read", "fs_write", "execute_bash", "grep", "glob", "web_fetch"];
const configs = [
	{ label: "floor", agent: `${tag}-floor`, tools: [] },
	{ label: "all-tools", agent: `${tag}-all`, tools: ["*"] },
	{ label: "lean", agent: `${tag}-lean`, tools: LEAN_TOOLS },
	{ label: "lean-inherit", agent: `${tag}-lean`, tools: LEAN_TOOLS, inherit: true },
	{ label: "kiro_default", agent: "kiro_default", builtin: true },
	{ label: "user-default", agent: undefined },
	{ label: "user-default-inherit", agent: undefined, inherit: true },
];
const only = opt("only", "").split(",").filter(Boolean);
if (only.length) configs.splice(0, configs.length, ...configs.filter((c) => only.includes(c.label)));
const written = [...new Map(configs.filter((c) => c.agent && !c.builtin).map((c) => [c.agent, c])).values()].map((c) => writeAgent(c.agent, c.tools));

const results = {};
try {
	for (let r = 0; r < ROUNDS; r++) {
		for (const c of configs) {
			const out = await runOnce(c.agent, c.inherit);
			(results[c.label] ??= []).push(out);
			process.stderr.write(`[p7] round ${r + 1} ${c.label}: ${JSON.stringify(out)}\n`);
		}
	}
} finally {
	for (const p of written) rmSync(p, { force: true });
}

const summary = {
	model: MODEL,
	rounds: ROUNDS,
	prompt: PROMPT,
	measuredAt: new Date().toISOString(),
	configs: Object.fromEntries(
		Object.entries(results).map(([label, runs]) => {
			const ctx = median(runs.map((x) => x.context));
			return [
				label,
				{
					medianContextPercent: ctx,
					approxTokensIf1MWindow: ctx === undefined ? undefined : Math.round((ctx / 100) * WINDOW_TOKENS),
					medianCredits: median(runs.map((x) => x.credits)),
					runs,
				},
			];
		}),
	),
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
