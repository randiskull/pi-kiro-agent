/**
 * Incremental-context session manager for the kiro provider.
 *
 * kiro-cli has no prompt caching, so re-serializing the whole Pi conversation
 * every turn makes a long GSD session (~1M tokens) hang. kiro-cli does persist
 * a resumable session (`--resume-id` / `--list-sessions`), so this module
 * tracks, per logical Pi conversation, the kiro session that mirrors it and
 * sends only the DELTA.
 *
 * Pi's `Context` carries no conversation id, so identity is anchored on the
 * hash of the sent message prefix. That doubles as divergence detection: Pi's
 * context is mutable (it compacts/edits/truncates) while a kiro session is
 * append-only, so a prefix-hash mismatch means the session MUST NOT be resumed.
 * Any mismatch, doubt or capture failure falls back to a full fresh send.
 *
 * Sessions are per-cwd; capture is by snapshot-diff (exactly one new session in
 * the cwd after a fresh spawn), so a concurrent creation makes the diff
 * ambiguous and falls back instead of mis-capturing.
 */

import { execFile } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import { hashMessages } from "./message-hash.js";
import { hasSystemMessage } from "./system-prompt.js";

// Re-exported so existing importers (and the collision test) keep their import
// site; the implementation now lives in message-hash.ts, shared with acp-session.
export { hashMessages };

/** Master switch — set PI_KIRO_RESUME=off to force the legacy full-send path. */
export function resumeEnabled(): boolean {
	return process.env.PI_KIRO_RESUME !== "off";
}

interface KiroSession {
	sessionId: string;
	cwd: string;
	/** number of Pi messages already mirrored into the kiro session. */
	sentMessageCount: number;
	/** hash of messages[0..sentMessageCount] — the append anchor / divergence guard. */
	prefixHash: string;
}

// Small registry (one entry per live conversation). Matched by content, not key,
// because Pi gives us no conversation id. Capped to bound memory; stale/diverged
// sessions simply never match again.
const MAX_SESSIONS = 64;
const sessions: KiroSession[] = [];

export interface TurnPlan {
	mode: "fresh" | "resume";
	/** set iff mode === "resume". */
	resumeId?: string;
	/** delta start index: 0 for fresh (send everything), sentMessageCount for resume. */
	deltaStart: number;
}

/** Stable, thinking-insensitive text of one message's content (for hashing)
 * and the deterministic sequence hash both live in message-hash.ts (shared with
 * acp-session.ts). hashMessages is re-exported above. */

/**
 * Decide how to run this turn. Returns `resume` only when a tracked session in
 * this cwd is a verified pure-append prefix of `messages` AND the delta carries
 * genuinely new (non-assistant) input; otherwise `fresh`.
 */
export function planTurn(cwd: string, messages: Message[]): TurnPlan {
	if (!resumeEnabled()) return { mode: "fresh", deltaStart: 0 };
	// Most-recent first so the newest matching session wins.
	for (let i = sessions.length - 1; i >= 0; i--) {
		const session = sessions[i];
		if (session.cwd !== cwd) continue;
		if (messages.length < session.sentMessageCount) continue; // shorter than sent ⇒ truncated/diverged
		if (hashMessages(messages.slice(0, session.sentMessageCount)) !== session.prefixHash) continue; // prefix changed
		const delta = messages.slice(session.sentMessageCount);
		// A system message in the delta is a mid-conversation prompt or tool
		// update (pi >= 0.86). The delta prompt has no slot for it and the
		// resumed kiro session still holds the OLD prompt, so re-send in full.
		if (hasSystemMessage(delta)) return { mode: "fresh", deltaStart: 0 };
		// Nothing new but assistant echoes ⇒ no incremental turn to send; re-send full.
		if (!delta.some((message) => message.role !== "assistant")) return { mode: "fresh", deltaStart: 0 };
		return { mode: "resume", resumeId: session.sessionId, deltaStart: session.sentMessageCount };
	}
	return { mode: "fresh", deltaStart: 0 };
}

function upsert(session: KiroSession): void {
	const existing = sessions.findIndex((s) => s.sessionId === session.sessionId);
	if (existing >= 0) {
		sessions[existing] = session;
	} else {
		sessions.push(session);
		if (sessions.length > MAX_SESSIONS) sessions.shift();
	}
}

export interface ListedSession {
	sessionId: string;
	updatedAt?: string;
}

/** Lists kiro sessions for `cwd`. Injected so tests can fake it. */
export type ListSessionsFn = (cwd: string) => Promise<ListedSession[]>;

/** Default lister via `kiro-cli chat --list-sessions --format json`. Never throws. */
export function makeListSessions(binaryPath: string | undefined): ListSessionsFn {
	return (cwd) =>
		new Promise((resolve) => {
			execFile(
				binaryPath ?? "kiro-cli",
				["chat", "--list-sessions", "--format", "json"],
				{ cwd, timeout: 10_000, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
				(error, stdout) => {
					if (error) return resolve([]);
					try {
						const parsed = JSON.parse(stdout) as Array<{ cwd?: string; sessions?: ListedSession[] }>;
						if (!Array.isArray(parsed)) return resolve([]);
						const entry = parsed.length === 1 ? parsed[0] : parsed.find((e) => e.cwd === cwd);
						resolve(entry?.sessions ?? []);
					} catch {
						resolve([]);
					}
				},
			);
		});
}

/** Session ids present in `cwd` right now — snapshot before a fresh spawn. */
export async function snapshotSessions(cwd: string, list: ListSessionsFn): Promise<Set<string>> {
	const listed = await list(cwd).catch(() => [] as ListedSession[]);
	return new Set(listed.map((session) => session.sessionId));
}

/**
 * After a successful FRESH spawn, capture the session kiro just created and record
 * it. Capture is unambiguous only when exactly one new session appeared since the
 * pre-spawn snapshot — otherwise we return undefined and record nothing (the next
 * turn re-sends full). Returns the captured session id, or undefined on fallback.
 */
export async function recordFreshSession(
	cwd: string,
	messages: Message[],
	preSnapshot: Set<string>,
	list: ListSessionsFn,
): Promise<string | undefined> {
	if (!resumeEnabled()) return undefined;
	const after = await list(cwd).catch(() => [] as ListedSession[]);
	const created = after.filter((session) => !preSnapshot.has(session.sessionId));
	if (created.length !== 1) return undefined; // 0 = not persisted / list failed; >1 = concurrent race
	const sessionId = created[0].sessionId;
	upsert({ sessionId, cwd, sentMessageCount: messages.length, prefixHash: hashMessages(messages) });
	return sessionId;
}

/** After a successful RESUME spawn, advance the session to cover `messages`. */
export function advanceSession(sessionId: string, messages: Message[]): void {
	const session = sessions.find((s) => s.sessionId === sessionId);
	if (!session) return;
	session.sentMessageCount = messages.length;
	session.prefixHash = hashMessages(messages);
}

/** Forget a session (e.g. a resume spawn failed — assume it is unusable). */
export function dropSession(sessionId: string): void {
	const index = sessions.findIndex((s) => s.sessionId === sessionId);
	if (index >= 0) sessions.splice(index, 1);
}

/** Test hook: clear all tracked sessions. */
export function _resetSessions(): void {
	sessions.length = 0;
}
