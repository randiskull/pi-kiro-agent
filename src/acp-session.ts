/**
 * ACP session manager for the kiro ACP transport.
 *
 * Tracks, per logical Pi conversation (keyed by (cwd, sessionKey) pair), the
 * kiro ACP session that mirrors it. Identity is anchored on the hash of the
 * sent message prefix — the same divergence-detection mechanism as
 * session-manager.ts, but without the snapshot-diff capture: ACP gives us
 * the sessionId directly from session/new.
 *
 * `sessionKey` is a caller-chosen secondary key used to scope sessions within
 * a cwd. The ACP transport passes the acpSessionId as the sessionKey (it is
 * already unique, so no collision is possible). The parameter was formerly
 * named `agentName`, which was misleading — it is not a literal agent name.
 *
 * Note: the child PROCESS registry (acp-transport.ts) is separately keyed per
 * (cwd, conversationKey) so the parent conversation and each subagent get their
 * own kiro child. This session map is unaffected by that keying — acpSessionIds
 * are globally unique, so the shared `sessions` array never collides across
 * children.
 */

import type { Message } from "@earendil-works/pi-ai";
import { hashMessages } from "./message-hash.js";

// Re-exported so this module's import surface is unchanged; the implementation
// (formerly duplicated verbatim from session-manager.ts) now lives in the shared
// message-hash.ts, so the two transports cannot silently diverge.
export { hashMessages };

interface AcpSession {
	sessionId: string;
	cwd: string;
	sessionKey: string;
	/** Number of Pi messages already mirrored into the ACP session. */
	sentMessageCount: number;
	/** SHA-256 of messages[0..sentMessageCount] — append anchor / divergence guard. */
	prefixHash: string;
}

const MAX_SESSIONS = 64;
const sessions: AcpSession[] = [];

export interface AcpTurnPlan {
	mode: "fresh" | "resume";
	/** ACP sessionId — set iff mode === "resume". */
	acpSessionId?: string;
	/** Delta start index: 0 for fresh (send full context), sentMessageCount for resume. */
	deltaStart: number;
}

// ─── Hash helpers ─────────────────────────────────────────────────────────────
// messageText/messageKey/hashMessages moved to the shared message-hash.ts (see
// the re-export at the top of this file). Previously duplicated verbatim here.


// ─── Registry ─────────────────────────────────────────────────────────────────

function upsert(session: AcpSession): void {
	const existing = sessions.findIndex((s) => s.sessionId === session.sessionId);
	if (existing >= 0) {
		sessions[existing] = session;
	} else {
		sessions.push(session);
		if (sessions.length > MAX_SESSIONS) sessions.shift();
	}
}

// ─── Public surface ───────────────────────────────────────────────────────────

/**
 * Decide how to handle this turn.
 *
 * Returns `resume` only when an existing ACP session for this (cwd, sessionKey)
 * pair is a verified pure-append prefix of `messages` AND the delta carries
 * genuinely new (non-assistant) input. Otherwise returns `fresh`.
 */
export function planAcpTurn(cwd: string, sessionKey: string, messages: Message[]): AcpTurnPlan {
	for (let i = sessions.length - 1; i >= 0; i--) {
		const session = sessions[i];
		if (session.cwd !== cwd || session.sessionKey !== sessionKey) continue;
		if (messages.length < session.sentMessageCount) continue; // truncated/diverged
		if (hashMessages(messages.slice(0, session.sentMessageCount)) !== session.prefixHash) continue; // prefix changed
		const delta = messages.slice(session.sentMessageCount);
		if (!delta.some((m) => m.role !== "assistant")) return { mode: "fresh", deltaStart: 0 };
		return { mode: "resume", acpSessionId: session.sessionId, deltaStart: session.sentMessageCount };
	}
	return { mode: "fresh", deltaStart: 0 };
}

/**
 * Record a newly created ACP session (from session/new response).
 * Called after session/new returns the sessionId.
 */
export function recordAcpSession(
	cwd: string,
	sessionKey: string,
	acpSessionId: string,
	messages: Message[],
): void {
	upsert({
		sessionId: acpSessionId,
		cwd,
		sessionKey,
		sentMessageCount: messages.length,
		prefixHash: hashMessages(messages),
	});
}

/** Advance the session anchor after a successful delta turn. */
export function advanceAcpSession(acpSessionId: string, messages: Message[]): void {
	const session = sessions.find((s) => s.sessionId === acpSessionId);
	if (!session) return;
	session.sentMessageCount = messages.length;
	session.prefixHash = hashMessages(messages);
}

/** Forget a session (e.g. child crashed — session is unusable). */
export function dropAcpSession(acpSessionId: string): void {
	const index = sessions.findIndex((s) => s.sessionId === acpSessionId);
	if (index >= 0) sessions.splice(index, 1);
}

/** Test hook: clear all tracked ACP sessions. */
export function _resetAcpSessions(): void {
	sessions.length = 0;
}

/** Test hook: number of ACP sessions currently tracked (drop-on-death checks). */
export function _acpSessionCount(): number {
	return sessions.length;
}
