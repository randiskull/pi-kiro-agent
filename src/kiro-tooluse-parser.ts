/**
 * kiro-cli tool-use line parser.
 *
 * parseKiroToolUses(body): extract MCP tool invocations from kiro's
 * non-interactive output. Two grammars are accepted because kiro-cli changed
 * format in 2.21: the legacy "Running tool X with the param (from mcp
 * server: Y)" followed by ⋮-prefixed JSON param lines, and the compact
 * "[tool] Running: @Y/X" with no param block (arguments degrade to {}).
 *
 * synthesizeToolCallBlocks(body): map those uses onto pi `ToolCall` content
 * blocks, which is what GSD's snapshotUnitActivity counts for the zero-tool-call
 * guard. stopReason does NOT make them safe: pi's agent loop dispatches on the
 * PRESENCE of toolCall blocks and only skips a message whose stopReason is
 * "error" or "aborted", so a block left on a "stop" message is re-executed.
 * reconcileToolCalls therefore tags every block produced here with
 * LIVE_TOOL_ID_PREFIX and the done/error push sites send a filtered copy (M001,
 * docs/design/acp-transport.md §5h).
 *
 * Split out of the original workflow-mcp.ts (L3-03): this half is pure
 * output-parsing with no dependency on GSD's install layout or `.mcp.json`.
 * See workflow-mcp-discovery.ts for the sibling half that resolves the
 * gsd-workflow MCP server entry itself.
 */

import { createHash } from "node:crypto";
import type { ToolCall } from "@earendil-works/pi-ai";

/** One MCP tool invocation parsed from kiro's non-interactive output. */
export interface KiroToolUse {
	name: string;
	server: string;
	arguments: Record<string, unknown>;
}

// "Running tool gsd_plan_slice with the param (from mcp server: gsdworkflow)"
// "Running tool fs_read (from mcp server: pi)"           ← no-param variant
const TOOL_USE_LINE = /^\s*Running tool (\S+)(?: with the param)? \(from mcp server: ([^)]+)\)\s*$/;
// Param continuation lines: " ⋮  { …json… }"
const PARAM_LINE = /^\s*⋮\s?(.*)$/;
// "[tool] Running: @gsdworkflow/gsd_doctor" — the compact form kiro-cli emits as
// of 2.21. Server and tool are FUSED and in the opposite order to the line
// above, and no ⋮ param block follows (the next line is "[tool] status: ..."),
// so arguments degrade to {}. Both grammars are accepted because the legacy one
// is what every recorded probe transcript in docs/ and probes/ contains, and a
// user on an older kiro-cli must keep working. Built-in tools are NOT parseable
// in this form at all: they print a prose description ("[tool] Reading note.txt:1")
// with no tool name, which is why only the @server/tool shape is matched here.
const MCP_TOOL_LINE = /^\s*\[tool\]\s+Running:\s+@([^/\s]+)\/(\S+)\s*$/;

/**
 * Match either tool-use grammar kiro has emitted. Returning a normalized
 * {name, server} keeps the two capture-group orders from leaking into callers.
 */
function matchToolUseLine(line: string): { name: string; server: string } | undefined {
	const legacy = line.match(TOOL_USE_LINE);
	if (legacy) return { name: legacy[1] ?? "", server: legacy[2] ?? "" };
	const compact = line.match(MCP_TOOL_LINE);
	if (compact) return { name: compact[2] ?? "", server: compact[1] ?? "" };
	return undefined;
}

/**
 * Parse MCP tool invocations out of kiro's cleaned non-interactive output.
 * Param JSON is best-effort: an unparseable block degrades to {} rather than
 * dropping the invocation (the count is what the host needs most).
 */
export function parseKiroToolUses(body: string): KiroToolUse[] {
	const uses: KiroToolUse[] = [];
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const use = matchToolUseLine(lines[i] ?? "");
		if (!use) continue;
		const paramPieces: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const param = lines[j]?.match(PARAM_LINE);
			if (!param) break;
			paramPieces.push(param[1] ?? "");
		}
		i = j - 1;
		let args: Record<string, unknown> = {};
		if (paramPieces.length > 0) {
			try {
				const parsed: unknown = JSON.parse(paramPieces.join("\n"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					args = parsed as Record<string, unknown>;
				}
			} catch {
				// keep {} — the invocation still counts
			}
		}
		uses.push({ ...use, arguments: args });
	}
	return uses;
}


/**
 * Incremental tool-use detector for LIVE progress feedback: feed raw
 * (ANSI-stripped) stdout chunks as they stream and get back tool-use starts
 * the moment kiro prints them — so the host can surface "⚙ gsd_plan_slice"
 * mid-turn instead of a bare spinner. Arguments are NOT parsed here (the ⋮
 * param block may still be streaming); the end-of-turn
 * `synthesizeToolCallBlocks` pass remains the authoritative reconciliation
 * and replaces live placeholder blocks with fully-parsed ones.
 */
export function createToolUseStreamParser(): { feed(text: string): Array<Pick<KiroToolUse, "name" | "server">> } {
	let pending = "";
	return {
		feed(text: string) {
			pending += text;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			const uses: Array<Pick<KiroToolUse, "name" | "server">> = [];
			for (const line of lines) {
				const use = matchToolUseLine(line);
				if (use) uses.push(use);
			}
			return uses;
		},
	};
}

/**
 * Map parsed tool uses onto pi ToolCall content blocks for the final
 * AssistantMessage. The host counts and renders them (GSD's zero-tool-call guard
 * reads exactly these blocks), but it does NOT treat stopReason "stop" as a
 * do-not-dispatch marker: execution already happened inside kiro via MCP, so the
 * caller must tag these with LIVE_TOOL_ID_PREFIX and strip them from the message
 * pi finally sees, or pi runs every one of them again (M001).
 *
 * The id must be GLOBALLY unique, not merely unique within one response.
 * GSD derives a workflow idempotency key from it
 * (`pi:gsd_task_complete:<id>`) and rejects a completion whose key already
 * belongs to another canonical operation. A bare positional `kiro-mcp-<index>`
 * restarts at 0 on every response, so the low ordinals are consumed almost
 * immediately and every later `gsd_task_complete` throws
 * "Task completion idempotency identity belongs to a different canonical
 * operation" — the task's work succeeds but can never be recorded. The
 * claude-code provider avoids this by emitting random `tooluse_*` ids.
 *
 * The digest of the response body is mixed in so ids stay REPLAY-STABLE:
 * parsing the same body twice yields the same ids (so a genuine replay is
 * still recognized as one), while different bodies — and therefore different
 * sessions — never collide.
 */
export function synthesizeToolCallBlocks(body: string): ToolCall[] {
	const bodyDigest = createHash("sha256").update(body).digest("hex").slice(0, 16);
	return parseKiroToolUses(body).map((use, index) => ({
		type: "toolCall",
		id: `kiro-mcp-${bodyDigest}-${index}-${use.name}`,
		name: use.name,
		// Parsed from JSON text, so every value is already JSON; pi >= 0.86 types
		// ToolCall.arguments as JsonObject rather than Record<string, unknown>.
		arguments: use.arguments as ToolCall["arguments"],
	}));
}
