/**
 * Env-gated JSONL trace, off by default.
 *
 * Set PI_KIRO_TRACE to a file path and every prompt sent to kiro and every
 * bridged tool invocation is appended as one JSON object per line. Unset, every
 * function here is a no-op with no filesystem access.
 *
 * This exists because the agent narration in a kiro turn is not a log: it has
 * repeatedly claimed tool results that the raw results contradict. Questions
 * like "was the bridged tool called once or twice, and was the prompt resent"
 * are not answerable from a transcript, only from the wire.
 *
 * Tracing must never break a turn: every write is wrapped and failures are
 * swallowed.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let resolvedTarget: string | null | undefined;

function target(): string | null {
	if (resolvedTarget !== undefined) return resolvedTarget;
	const raw = process.env.PI_KIRO_TRACE?.trim();
	if (!raw) {
		resolvedTarget = null;
		return resolvedTarget;
	}
	try {
		mkdirSync(dirname(raw), { recursive: true });
		resolvedTarget = raw;
	} catch {
		resolvedTarget = null;
	}
	return resolvedTarget;
}

/** Whether tracing is on. Callers use this to skip building expensive fields. */
export function traceEnabled(): boolean {
	return target() !== null;
}

/** Append one event. Silent no-op when PI_KIRO_TRACE is unset. */
export function trace(event: string, fields: Record<string, unknown> = {}): void {
	const path = target();
	if (!path) return;
	try {
		const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...fields });
		appendFileSync(path, line + "\n", "utf8");
	} catch {
		// never let observability break the turn
	}
}

/** Test seam: forget the memoized target so a changed env var is re-read. */
export function resetTraceTarget(): void {
	resolvedTarget = undefined;
}
