/**
 * Env-gated JSONL trace, off by default.
 *
 * Set PI_KIRO_TRACE to a file path and every prompt sent to kiro and every
 * bridged tool invocation is appended as one JSON object per line. Unset, every
 * function here is a no-op with no filesystem access. Tracing must never break
 * a turn: every write is wrapped and failures are swallowed.
 *
 * TREAT THE OUTPUT AS SENSITIVE. The events carry the FULL prompt text sent to
 * kiro and the RAW arguments of every bridged tool call. The file is created
 * 0600 inside a 0700 parent; *.jsonl is gitignored, because
 * scripts/secret-scan.mjs scans git-tracked files only and cannot see an
 * untracked trace in the repo; prefer a path outside the checkout entirely.
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
		// 0700: a trace holds full prompts, so neither the directory this creates
		// nor the file below should be readable by other local users.
		mkdirSync(dirname(raw), { recursive: true, mode: 0o700 });
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
		// mode applies on CREATE only; an existing file keeps its permissions.
		appendFileSync(path, line + "\n", { encoding: "utf8", mode: 0o600 });
	} catch {
		// never let observability break the turn
	}
}

/** Test seam: forget the memoized target so a changed env var is re-read. */
export function resetTraceTarget(): void {
	resolvedTarget = undefined;
}
