/**
 * Live integration for the default chat transport against a real, authenticated
 * kiro-cli. Skipped unless PI_KIRO_LIVE=1 (needs a seat + network; each turn is
 * a real model call). Uses the REAL node:child_process (this file installs no
 * mock), and the developer's REAL $HOME -- see live-support.ts/withRealHome for
 * why that matters and what it writes.
 *
 *   PI_KIRO_LIVE=1 npx vitest run stream-adapter-live.test.ts
 */
import { describe, expect, it } from "vitest";
import { _resetSessions } from "../src/session-manager.js";
import { makeStreamViaKiro } from "../src/stream-adapter.js";
import { assistant, ctx, drainTurn, LIVE, LIVE_MODEL, LIVE_TIMEOUT_MS, user, withRealHome } from "./live-support.js";

const streamViaKiro = makeStreamViaKiro({ binaryPath: "kiro-cli" });

describe.skipIf(!LIVE)("live kiro resume", () => {
	withRealHome();

	it(
		"turn 2 resumes the session, recalls turn-1 context, and stays seat-billed",
		async () => {
			_resetSessions();
			const seed = "Remember this codeword for later: ZEBRA-LIVE-42. Reply with just OK.";

			const t1 = await drainTurn(streamViaKiro(LIVE_MODEL, ctx([user(seed)]), undefined));
			expect(t1.text.length).toBeGreaterThan(0);
			expect(t1.totalTokens).toBe(0); // seat-billed, no token accounting

			const t2 = await drainTurn(
				streamViaKiro(
					LIVE_MODEL,
					ctx([user(seed), assistant(t1.text), user("What was the codeword? Reply with just the codeword.")]),
					undefined,
				),
			);
			expect(t2.text).toContain("ZEBRA-LIVE-42"); // only answerable from turn 1's context
			expect(t2.totalTokens).toBe(0);
		},
		LIVE_TIMEOUT_MS,
	);
});
