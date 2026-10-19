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
 *   lean agent below, inheritance disabled  ~10,500 tokens   0.046 credits
 *   same agent with no tools (the floor)     ~6,900 tokens   0.032 credits
 *
 * The floor is almost all server-side preamble, which no client setting
 * reaches.
 *
 * So by default each child runs a pi-owned agent with the five native tools a
 * coding delegate needs, written by the same writer as the chat transport's
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
import { writeAgentProfile } from "./kiro-bridge.js";

export const ACP_NATIVE_TOOLS = ["fs_read", "fs_write", "execute_bash", "grep", "glob"] as const;

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
}

export function prepareAcpAgent(choice: AcpAgentChoice = acpAgentChoice()): AcpAgentLaunch {
	if (choice.kind === "default") return { args: [], disableInheritance: false, cleanup: () => undefined };
	if (choice.kind === "named") {
		return { args: ["--agent", choice.name], disableInheritance: false, cleanup: () => undefined };
	}
	const profile = writeAgentProfile(undefined, undefined, {
		tools: ACP_NATIVE_TOOLS,
		description:
			"Throwaway pi-kiro-agent ACP delegate (auto-generated per child; safe to delete): native coding tools only, nothing inherited.",
	});
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
	};
}
