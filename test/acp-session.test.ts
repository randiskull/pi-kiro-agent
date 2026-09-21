/**
 * Tests for acp-session.ts — planAcpTurn, recordAcpSession, advanceAcpSession.
 *
 * Includes a regression test that pins the fact that planAcpTurn is NOT gated
 * on PI_KIRO_RESUME. The flag only affects the chat transport (stream-adapter.ts
 * via session-manager.ts:resumeEnabled()). The ACP transport always uses its own
 * divergence detection and must continue to resume on pure-append sequences even
 * when PI_KIRO_RESUME is set to "off".
 */

import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
