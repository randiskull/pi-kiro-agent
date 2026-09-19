/**
 * ACP session registry — eviction-order regression coverage (L1-09 polish).
 *
 * Prior behavior: overflow evicted the oldest-INSERTED session (`shift()`),
 * regardless of recency of use, so a still-active session could be evicted
 * under churn across many cwds. Fixed to LRU: any touch (a resume-hit in
 * planAcpTurn, or advanceAcpSession) moves a session to the touched end, so
 * eviction always drops the least-recently-touched entry.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	_acpSessionCount,
	_resetAcpSessions,
	advanceAcpSession,
	planAcpTurn,
	recordAcpSession,
} from "../src/acp-session.js";
import type { Message } from "@earendil-works/pi-ai";

function userMsg(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

const MAX_SESSIONS = 64;

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
