/**
 * Tests for acp-session.ts — planAcpTurn, recordAcpSession, advanceAcpSession.
 *
 * Includes a regression test that pins the fact that planAcpTurn is NOT gated
 * on PI_KIRO_RESUME. The flag only affects the chat transport (stream-adapter.ts
 * via session-manager.ts:resumeEnabled()). The ACP transport always uses its own
 * divergence detection and must continue to resume on pure-append sequences even
 * when PI_KIRO_RESUME is set to "off".
 *
 * Also covers session-registry eviction ORDER (L1-09 polish). Prior behavior:
 * overflow evicted the oldest-INSERTED session (`shift()`), regardless of
 * recency of use, so a still-active session could be evicted under churn across
 * many cwds. Fixed to LRU: any touch (a resume-hit in planAcpTurn, or
 * advanceAcpSession) moves a session to the touched end, so eviction always
 * drops the least-recently-touched entry.
 */

import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_acpSessionCount,
	_resetAcpSessions,
	advanceAcpSession,
	planAcpTurn,
	recordAcpSession,
} from "../src/acp-session.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const cwd = "/test/cwd";
const key = "test-session-key";

const user = (text: string): Message =>
	({ role: "user", content: text, timestamp: 0 }) as unknown as Message;
const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as Message;

// The LRU-eviction tests use the real Message content shape (an array of parts)
// rather than the cast above, since they exercise prefix comparison directly.
function userMsg(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

const MAX_SESSIONS = 64;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("planAcpTurn", () => {
	beforeEach(() => {
		_resetAcpSessions();
		delete process.env.PI_KIRO_RESUME;
	});

	afterEach(() => {
		delete process.env.PI_KIRO_RESUME;
	});

	it("returns fresh for a first turn (no recorded session)", () => {
		const plan = planAcpTurn(cwd, key, [user("hello")]);
		expect(plan.mode).toBe("fresh");
		expect(plan.deltaStart).toBe(0);
		expect(plan.acpSessionId).toBeUndefined();
	});

	it("returns resume for a pure-append sequence", () => {
		const messages = [user("turn one")];
		recordAcpSession(cwd, key, "acp-sess-1", messages);

		const next = [...messages, assistant("reply one"), user("turn two")];
		const plan = planAcpTurn(cwd, key, next);
		expect(plan.mode).toBe("resume");
		expect(plan.acpSessionId).toBe("acp-sess-1");
		expect(plan.deltaStart).toBe(messages.length);
	});

	it("returns fresh when the prefix diverges (compaction / edit)", () => {
		const messages = [user("original")];
		recordAcpSession(cwd, key, "acp-sess-2", messages);

		// Prefix replaced — diverged.
		const diverged = [user("completely different"), user("turn two")];
		const plan = planAcpTurn(cwd, key, diverged);
		expect(plan.mode).toBe("fresh");
		expect(plan.deltaStart).toBe(0);
	});

	// ─── Regression: PI_KIRO_RESUME independence ────────────────────────────────

	it("PI_KIRO_RESUME=off does NOT suppress planAcpTurn resume (chat flag has no effect on ACP)", () => {
		// Simulate PI_KIRO_RESUME=off, which the chat transport uses to force
		// full-context re-sends. planAcpTurn must be completely unaffected.
		process.env.PI_KIRO_RESUME = "off";

		const messages = [user("turn one")];
		recordAcpSession(cwd, key, "acp-sess-resume", messages);

		const next = [...messages, assistant("reply one"), user("turn two")];
		const plan = planAcpTurn(cwd, key, next);

		// Must still return 'resume' — PI_KIRO_RESUME=off is a chat-transport-only flag.
		expect(plan.mode).toBe("resume");
		expect(plan.acpSessionId).toBe("acp-sess-resume");
		expect(plan.deltaStart).toBe(messages.length);
	});

	it("PI_KIRO_RESUME=off does NOT suppress planAcpTurn fresh (diverged prefix still detected)", () => {
		process.env.PI_KIRO_RESUME = "off";

		const messages = [user("original")];
		recordAcpSession(cwd, key, "acp-sess-fresh", messages);

		const diverged = [user("compacted summary"), user("turn two")];
		const plan = planAcpTurn(cwd, key, diverged);

		// Must still return 'fresh' — divergence detection is unaffected.
		expect(plan.mode).toBe("fresh");
		expect(plan.deltaStart).toBe(0);
	});

	// ─── advanceAcpSession ───────────────────────────────────────────────────────

	it("advanceAcpSession updates the session anchor so turn 3 resumes from the correct delta", () => {
		const turn1 = [user("t1")];
		recordAcpSession(cwd, key, "acp-sess-adv", turn1);

		const turn2Messages = [...turn1, assistant("a1"), user("t2")];
		advanceAcpSession("acp-sess-adv", turn2Messages);

		const turn3Messages = [...turn2Messages, assistant("a2"), user("t3")];
		const plan = planAcpTurn(cwd, key, turn3Messages);
		expect(plan.mode).toBe("resume");
		expect(plan.deltaStart).toBe(turn2Messages.length);
	});

	it("returns fresh when the delta contains only assistant messages (nothing new to send)", () => {
		const messages = [user("hello")];
		recordAcpSession(cwd, key, "acp-sess-nouser", messages);

		// Only an assistant message added — no new user input.
		const appendedAssistant = [...messages, assistant("reply")];
		const plan = planAcpTurn(cwd, key, appendedAssistant);
		expect(plan.mode).toBe("fresh");
	});
});

describe("acp-session LRU eviction", () => {
	beforeEach(() => {
		_resetAcpSessions();
	});

	it("evicts the least-recently-touched session, not the oldest-inserted one", () => {
		// Fill to capacity: session 0 is oldest-inserted.
		for (let i = 0; i < MAX_SESSIONS; i++) {
			recordAcpSession(`/cwd-${i}`, `key-${i}`, `session-${i}`, [userMsg("hi")]);
		}
		expect(_acpSessionCount()).toBe(MAX_SESSIONS);

		// Touch session-0 (the oldest-inserted) via a resume-hit, so it's no
		// longer the least-recently-used entry.
		const messages = [userMsg("hi"), userMsg("more")];
		const plan = planAcpTurn("/cwd-0", "key-0", messages);
		expect(plan.mode).toBe("resume");

		// One more insert pushes past capacity. Under the old FIFO behavior
		// this would evict session-0 (oldest-inserted). Under LRU it evicts
		// session-1 instead (never touched, now the least-recently-used).
		recordAcpSession("/cwd-new", "key-new", "session-new", [userMsg("hi")]);
		expect(_acpSessionCount()).toBe(MAX_SESSIONS);

		const session0Plan = planAcpTurn("/cwd-0", "key-0", messages);
		expect(session0Plan.mode).toBe("resume"); // survived — was touched

		const session1Plan = planAcpTurn("/cwd-1", "key-1", [userMsg("hi")]);
		expect(session1Plan.mode).toBe("fresh"); // evicted — never touched
	});

	it("advanceAcpSession also counts as a touch", () => {
		for (let i = 0; i < MAX_SESSIONS; i++) {
			recordAcpSession(`/cwd-${i}`, `key-${i}`, `session-${i}`, [userMsg("hi")]);
		}
		// Advance session-0 (the oldest-inserted) instead of resuming it.
		advanceAcpSession("session-0", [userMsg("hi"), userMsg("more")]);

		recordAcpSession("/cwd-new", "key-new", "session-new", [userMsg("hi")]);
		expect(_acpSessionCount()).toBe(MAX_SESSIONS);

		// A real (non-assistant) delta beyond the advanced prefix — otherwise
		// planAcpTurn itself returns "fresh" for an empty delta, independent of LRU.
		const session0Plan = planAcpTurn("/cwd-0", "key-0", [
			userMsg("hi"),
			userMsg("more"),
			userMsg("even more"),
		]);
		expect(session0Plan.mode).toBe("resume"); // survived — advancing touched it
	});
});
