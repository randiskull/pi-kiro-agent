/**
 * Live integration for the chat transport's stream-json reader against a
 * real, authenticated kiro-cli. Skipped unless PI_KIRO_LIVE=1 (each turn is a
 * real model call on LIVE_MODEL). Real node:child_process, real $HOME.
 *
 *   PI_KIRO_LIVE=1 npx vitest run stream-json-live.test.ts
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CapturedTool, serveBridgeHttp } from "../src/bridge.js";
import { _resetSessions } from "../src/session-manager.js";
import { makeStreamViaKiro } from "../src/stream-adapter.js";
import { ctx, drainTurn, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, type LiveTurn, user, withRealHome } from "./live-support.js";

const FAKE_CTX = { cwd: process.cwd() } as unknown as ExtensionContext;
const PROBE_TOOL = "pi_kiro_live_probe";

/** Every toolCall row drawn mid-turn, by id (last state wins). */
function rows(turn: LiveTurn): Array<{ name: string; arguments: Record<string, unknown> }> {
	const byId = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	for (const event of turn.events) {
		const partial = (event as { partial?: { content: Array<{ type: string; id?: string }> } }).partial;
		for (const block of partial?.content ?? []) {
			if (block.type === "toolCall") byId.set(String(block.id), structuredClone(block) as never);
		}
	}
	return [...byId.values()];
}

describe.skipIf(!LIVE)("live stream-json chat transport", () => {
	withRealHome();
	const saved = process.env.PI_KIRO_CHAT_FORMAT;
	beforeAll(() => {
		process.env.PI_KIRO_CHAT_FORMAT = "stream-json";
	});
	afterAll(() => {
		if (saved === undefined) delete process.env.PI_KIRO_CHAT_FORMAT;
		else process.env.PI_KIRO_CHAT_FORMAT = saved;
	});

	it(
		"a built-in read surfaces as one kiro_read row with its real arguments, and the answer is the sentinel span",
		async () => {
			_resetSessions();
			const turn = await drainTurn(
				makeStreamViaKiro({ binaryPath: "kiro-cli" })(
					LIVE_MODEL,
					ctx([user("Use your own file-read tool to read package.json, then reply with only the value of its name field.")]),
					undefined,
				),
			);
			expect(turn.text.trim()).toBe("pi-kiro-agent");
			const reads = rows(turn).filter((row) => row.name === "kiro_read");
			expect(reads.length).toBeGreaterThanOrEqual(1);
			expect(JSON.stringify(reads[0]?.arguments)).toContain("package.json");
			expect(turn.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
		},
		LIVE_TIMEOUT_MS,
	);

	it(
		"a bridged MCP tool's row carries its real arguments (no text-scrape {})",
		async () => {
			_resetSessions();
			const invocations: unknown[] = [];
			const tool: CapturedTool = {
				name: PROBE_TOOL,
				description: "Record a marker string. Pass the marker verbatim as the 'marker' property.",
				parameters: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
				execute: async (_id, params) => {
					invocations.push(params);
					return { content: [{ type: "text", text: "recorded" }] };
				},
			};
			const controller = new AbortController();
			try {
				const turn = await drainTurn(
					makeStreamViaKiro({
						binaryPath: "kiro-cli",
						getBridge: async () => serveBridgeHttp([tool], () => FAKE_CTX, controller.signal),
					})(
						LIVE_MODEL,
						ctx([user(`Use the @pi/${PROBE_TOOL} tool to record the marker SJ-LIVE-7. Call the tool, then reply DONE.`)]),
						undefined,
					),
				);
				expect(JSON.stringify(invocations)).toContain("SJ-LIVE-7");
				const probeRows = rows(turn).filter((row) => row.name === PROBE_TOOL);
				expect(probeRows).toHaveLength(1);
				expect(probeRows[0]?.arguments).toMatchObject({ marker: "SJ-LIVE-7" });
			} finally {
				controller.abort();
			}
		},
		LIVE_TIMEOUT_MS,
	);
});
