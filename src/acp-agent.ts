/**
 * Which kiro agent an ACP child runs.
 *
 * With no `--agent`, `kiro-cli acp` runs whatever `chat.defaultAgent` names,
 * and that agent brings its own MCP servers, the global `mcp.json`, and every
 * inherited steering file and skill. Built-in agents keep inheriting even
 * with `chat.disableInheritingDefaultResources` set. None of it is pi's: pi
 * hands kiro the caller's prompt and context and mounts its own tools through
 * session/new. Measured on kiro-cli 2.32.0, Opus 5.5, a one-line prompt,
 * server-reported context (probes/acp-probe-p7-preamble.mjs):
 *
 *   user's default agent, inheriting       ~101,600 tokens   1.25 credits
 *   kiro_default, inheritance disabled     ~110,000 tokens   1.35 credits
 *   lean agent below, inheritance disabled  ~10,800 tokens   0.047 credits
 *   same agent with no tools (the floor)     ~6,900 tokens   0.032 credits
 *
 * The floor is almost all server-side preamble, which no client setting
 * reaches.
 *
 * So by default each child runs a pi-owned agent with the native tools a coding
 * delegate needs (see acpNativeTools), written by the same writer as the chat transport's
 * profile and under the same pid-tagged name, so the activation sweep removes
 * it if pi dies before the child is torn down. It carries no bridge token: MCP
 * servers mounted through session/new (the pi bridge, gsd-workflow) are
 * offered to the model whether or not `tools` names them
 * (probes/acp-probe-p8-lean-agent.mjs).
 *
 * PI_KIRO_ACP_AGENT selects otherwise:
 *   unset, "" or "lean"  the lean agent (default)
 *   "default"            no --agent: the user's default agent
 *   any other value      that agent, from the user's own kiro config
 */
import { utimesSync } from "node:fs";
import { writeAgentProfile } from "./kiro-bridge.js";

/**
 * kiro's native tools a delegated coding turn keeps. Everything else kiro ships
 * (web_search, use_aws, todo_list, knowledge, code, introspect, use_subagent,
 * session, report_issue, dummy) is left out: 28 KB of schemas on 2.32.0,
 * roughly 7,000 tokens a turn,
 * for tools pi either has itself or a delegate rarely needs.
 * PI_KIRO_ACP_AGENT=default brings them back. web_fetch stays because it is
 * small (~250 tokens) and "read this URL" is a common delegated ask. kiro's
 * shell tool is execute_cmd on Windows (crates/agent/src/agent/tools/execute_cmd);
 * that spelling is read from the 2.32.0 binary, not run on Windows.
 */
export function acpNativeTools(platform: NodeJS.Platform = process.platform): string[] {
	return ["fs_read", "fs_write", platform === "win32" ? "execute_cmd" : "execute_bash", "grep", "glob", "web_fetch"];
}

export const ACP_NATIVE_TOOLS: readonly string[] = acpNativeTools();

export type AcpAgentChoice = { kind: "lean" } | { kind: "default" } | { kind: "named"; name: string };

export function acpAgentChoice(env: NodeJS.ProcessEnv = process.env): AcpAgentChoice {
	const raw = env.PI_KIRO_ACP_AGENT?.trim();
	if (!raw || raw === "lean") return { kind: "lean" };
	if (raw === "default") return { kind: "default" };
	return { kind: "named", name: raw };
}

export interface AcpAgentLaunch {
	/** Extra argv for `kiro-cli acp`. */
	args: string[];
	/**
	 * Whether the child should start with inherited resources disabled. Only for
	 * the lean agent: built-in agents ignore the setting, and a user's own agent
	 * may rely on what it inherits.
	 */
	disableInheritance: boolean;
	/** Remove anything written for this launch. Idempotent, never throws. */
	cleanup: () => void;
	/**
	 * Mark what was written as in use. The activation sweep ages a live pid's
	 * profile out by mtime, a limit sized for per-turn chat profiles, while an
	 * ACP child keeps its profile as long as it lives. Never throws.
	 */
	touch: () => void;
}

const noop = (): void => undefined;

export function prepareAcpAgent(choice: AcpAgentChoice = acpAgentChoice()): AcpAgentLaunch {
	const userDefault: AcpAgentLaunch = { args: [], disableInheritance: false, cleanup: noop, touch: noop };
	if (choice.kind === "default") return userDefault;
	if (choice.kind === "named") return { ...userDefault, args: ["--agent", choice.name] };
	let profile: ReturnType<typeof writeAgentProfile>;
	try {
		profile = writeAgentProfile(undefined, undefined, {
			tools: ACP_NATIVE_TOOLS,
			description:
				"Throwaway pi-kiro-agent ACP delegate (auto-generated per child; safe to delete): native coding tools only, nothing inherited.",
		});
	} catch (error) {
		// A read-only HOME, or a ~/.kiro that is a file: run the turn on the
		// user's default agent rather than not at all.
		console.error(
			`[pi-kiro] could not write the lean ACP agent profile (${error instanceof Error ? error.message : String(error)}); this turn runs on your default kiro agent. Set PI_KIRO_ACP_AGENT=default to stop trying.`,
		);
		return userDefault;
	}
	return {
		args: ["--agent", profile.name],
		disableInheritance: true,
		cleanup: () => {
			try {
				profile.remove();
			} catch {
				// a leftover is swept at the next activation
			}
		},
		touch: () => {
			try {
				const now = new Date();
				utimesSync(profile.path, now, now);
			} catch {
				// gone already; kiro has read it
			}
		},
	};
}
