/**
 * ACP session manager for the kiro ACP transport.
 *
 * Tracks, per logical Pi conversation (keyed by (cwd, sessionKey)), the kiro
 * ACP session that mirrors it. Identity is anchored on the hash of the sent
 * message prefix, the same divergence-detection mechanism as session-manager.ts
 * but without the snapshot-diff capture: session/new returns the sessionId.
 *
 * `sessionKey` scopes sessions within a cwd; the ACP transport passes the
 * acpSessionId, which is already unique. The child PROCESS registry
 * (acp-transport.ts) is keyed separately, per (cwd, conversationKey); this map
 * is unaffected, since acpSessionIds never collide across children.
 */

import type { Message } from "@earendil-works/pi-ai";
import { hashMessages } from "./message-hash.js";
import { hasSystemMessage } from "./system-prompt.js";

// Re-exported so this module's import surface is unchanged; the shared
// implementation lives in message-hash.ts.
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

// ─── Registry ─────────────────────────────────────────────────────────────────

/** Move a tracked session to the touched (most-recently-used) end of `sessions`. */
function touch(sessionId: string): void {
	const index = sessions.findIndex((s) => s.sessionId === sessionId);
	if (index >= 0 && index !== sessions.length - 1) {
		const [session] = sessions.splice(index, 1);
		sessions.push(session);
	}
}

function upsert(session: AcpSession): void {
	// LRU, not FIFO [L1-09 polish]: an existing entry is removed then re-pushed
	// to the touched end, so eviction below always drops the least-recently-
	// touched session, not merely the oldest-inserted one.
	const existing = sessions.findIndex((s) => s.sessionId === session.sessionId);
	if (existing >= 0) sessions.splice(existing, 1);
	sessions.push(session);
	if (sessions.length > MAX_SESSIONS) sessions.shift();
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
		// A system message in the delta is a mid-conversation prompt or tool
		// update (pi >= 0.86). The delta prompt has no slot for it and the
		// resumed kiro session still holds the OLD prompt, so re-send in full.
		if (hasSystemMessage(delta)) return { mode: "fresh", deltaStart: 0 };
		if (!delta.some((m) => m.role !== "assistant")) return { mode: "fresh", deltaStart: 0 };
		touch(session.sessionId); // LRU: resuming counts as use [L1-09 polish]
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
	touch(acpSessionId); // LRU: advancing counts as use [L1-09 polish]
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
