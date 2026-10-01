/**
 * Harness identity: every pi-kiro turn identifies as
 *
 *   pi <pi version> via Kiro (kiro-cli <x.y.z>, engine <v2|v3>) on <model>
 *
 * Layer 1 (deterministic): pi-kiro renders this line itself (status bar, /kiro,
 * trace). Layer 2 (measured): the same line goes to the model at the top of
 * every prompt in an <identity> block, so its self-report matches. Whether a
 * given model actually obeys is measured by the live identity eval
 * (test/identity-live.test.ts), not assumed. Spec: pi-mode-spec.md "Identity
 * contract".
 *
 * Every value comes from a real source; nothing here is a hardcoded version.
 */

import { createRequire } from "node:module";

export type KiroEngine = "v2" | "v3";
export type KiroAuth = "login" | "api-key";

/** kiro-cli chat is spawned without --agent-engine, so it runs kiro's default (v2). */
export const CHAT_ENGINE: KiroEngine = "v2";
/** acp-transport.ts spawns `kiro-cli acp --agent-engine v2`. Keep in sync with that argv. */
export const ACP_ENGINE: KiroEngine = "v2";

export interface IdentityParts {
	/** The HOST pi's version (VERSION from @earendil-works/pi-coding-agent). */
	piVersion?: string;
	/** Bare semver of the kiro-cli binary, e.g. "2.26.1". */
	kiroVersion?: string;
	engine: KiroEngine;
	/** pi model id for the turn (the kiro model id, or "auto"). */
	model: string;
}

const UNKNOWN = "unknown";

interface PackageJson {
	name?: string;
	version?: string;
}

let pkgCache: PackageJson | undefined;
function pkg(): PackageJson {
	if (!pkgCache) {
		try {
			pkgCache = createRequire(import.meta.url)("../package.json") as PackageJson;
		} catch {
			pkgCache = {};
		}
	}
	return pkgCache;
}

/** This plugin's package name (sent as ACP clientInfo.name). */
export function pluginName(): string {
	return pkg().name ?? "pi-kiro-agent";
}

/** This plugin's package version (sent as ACP clientInfo.version, shown in /kiro). */
export function pluginVersion(): string {
	return pkg().version ?? UNKNOWN;
}

/** "kiro-cli 2.26.1" -> "2.26.1"; undefined when no version is present. */
export function parseKiroVersion(raw: string | undefined): string | undefined {
	const match = raw?.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
	return match?.[0];
}

/**
 * Which kiro-cli auth is in effect. KIRO_API_KEY wins over a login (kiro's own
 * precedence: KAS checks it before any --auth mode). Presence only: the value
 * is never read beyond a non-empty check.
 */
export function authMethod(env: NodeJS.ProcessEnv = process.env): KiroAuth {
	return env.KIRO_API_KEY?.trim() ? "api-key" : "login";
}

/**
 * The model as shown in the identity line. pi's "auto" is not a model: the chat
 * transport then omits --model and kiro picks (its default or its router), and
 * kiro does not report which model served the turn.
 */
export function displayModel(modelId: string): string {
	return modelId === "auto" ? "auto (selected by kiro)" : modelId;
}

export function identityLine(parts: IdentityParts): string {
	return `pi ${parts.piVersion ?? UNKNOWN} via Kiro (kiro-cli ${parts.kiroVersion ?? UNKNOWN}, engine ${parts.engine}) on ${displayModel(parts.model)}`;
}

/** Layer 2: the block placed at the top of every prompt sent to kiro. */
export function identityBlock(line: string): string {
	return [
		"<identity>",
		`You are pi, a coding agent harness, running through the user's Kiro subscription. This session is: ${line}.`,
		`When asked who or what you are, or which model you are, answer with exactly: ${line}`,
		"</identity>",
	].join("\n");
}

let piVersionPromise: Promise<string | undefined> | undefined;

/**
 * Resolve the host pi's VERSION once. Dynamic import so a host without the
 * export (or a test harness without pi installed) degrades to "unknown"
 * instead of failing activation.
 */
export function resolvePiVersion(
	load: () => Promise<{ VERSION?: unknown }> = () => import("@earendil-works/pi-coding-agent"),
): Promise<string | undefined> {
	if (!piVersionPromise) {
		piVersionPromise = load()
			.then((mod) => (typeof mod.VERSION === "string" && mod.VERSION.trim() ? mod.VERSION.trim() : undefined))
			.catch(() => undefined);
	}
	return piVersionPromise;
}

/** Test seam: forget the memoized pi version. */
export function _resetPiVersionForTest(): void {
	piVersionPromise = undefined;
}

const REDACTED = "[REDACTED:KIRO_API_KEY]";

/**
 * Remove the KIRO_API_KEY value from text bound for traces or error messages.
 * Values shorter than 8 chars are not treated as secrets (a replace on a short
 * string would shred unrelated text).
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
	const key = env.KIRO_API_KEY?.trim();
	if (!key || key.length < 8 || !text.includes(key)) return text;
	return text.split(key).join(REDACTED);
}
