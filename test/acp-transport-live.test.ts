/**
 * Live integration for the ACP transport against a real, authenticated
 * kiro-cli. Skipped unless PI_KIRO_LIVE=1 (needs a seat + network; each turn is
 * a real model call). Uses the REAL node:child_process -- this file installs no
 * mock, unlike test/acp-transport.test.ts where all 36 cases drive a spawn stub.
 *
 *   PI_KIRO_LIVE=1 npx vitest run acp-transport-live.test.ts
 *
 * Why this matters more than the chat transport's live test: README documents
 * that only the ACP transport passes MCP servers through, so GSD on kiro runs
 * on this code path exclusively. Until this file existed, every assertion about
 * it came from a mock.
 *
 * The two turns are one test, not two: turn 2 asserts session REUSE, which only
 * means anything if turn 1 ran in the same process moments earlier.
 */
import { afterAll, describe, expect, it } from "vitest";
import { _acpRegistryKey, _getAcpChildRegistry, _resetAcpChildren, makeStreamViaAcp } from "../src/acp-transport.js";
import { assistant, ctx, drainTurn, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, user, withRealHome } from "./live-support.js";

const streamViaAcp = makeStreamViaAcp({ binaryPath: "kiro-cli" });

describe.skipIf(!LIVE)("live kiro ACP transport", () => {
	withRealHome();
	// Kills the persistent child; without it the worker hangs on its idle timer.
	afterAll(() => {
		_resetAcpChildren();
	});

	it(
		"holds one ACP session across turns, recalls context, and stays seat-billed",
		async () => {
			_resetAcpChildren();
			const registry = _getAcpChildRegistry();
			const key = _acpRegistryKey(process.cwd(), undefined);
			const seed = "Remember this codeword for later: ORBIT-ACP-77. Reply with just OK.";

			const t1 = await drainTurn(streamViaAcp(LIVE_MODEL, ctx([user(seed)]), undefined));
			expect(t1.text.length).toBeGreaterThan(0);
			expect(t1.totalTokens).toBe(0); // seat-billed, no token accounting

			// A persistent child that reached a ready ACP session -- the whole point
			// of this transport, and unobservable through the stream alone.
			const child = registry.get(key);
			expect(child?.ready).toBe(true);
			const sessionId = child?.acpSessionId;
			expect(typeof sessionId).toBe("string");

			const t2 = await drainTurn(
				streamViaAcp(
					LIVE_MODEL,
					ctx([user(seed), assistant(t1.text), user("What was the codeword? Reply with just the codeword.")]),
					undefined,
				),
			);
			expect(t2.text).toContain("ORBIT-ACP-77"); // only answerable from turn 1's context
			expect(t2.totalTokens).toBe(0);

			// Same child, same ACP session id: turn 2 resumed rather than re-spawning.
			// A regression that silently re-spawned per turn would still pass the
			// codeword check (kiro would replay the transcript), so assert identity.
			expect(registry.get(key)?.acpSessionId).toBe(sessionId);
			expect(registry.size).toBe(1);
		},
		LIVE_TIMEOUT_MS,
	);
});
