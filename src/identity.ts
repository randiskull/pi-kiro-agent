/**
 * Harness identity: every pi-kiro turn identifies as
 *
 *   pi <pi version> via Kiro (kiro-cli <x.y.z>, engine <v2|v3>, <route>) on <model>
 *
 * where <route> is `acp` or `chat/<format>`: which transport served the turn,
 * and on the chat path which wire format, because the format decides what the
 * harness can see at all (see displayTransport).
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
/** Which transport served the turn. ACP is the default; chat is the fallback. */
export const KIRO_TRANSPORTS = ["acp", "chat"] as const;
export type KiroTransport = (typeof KIRO_TRANSPORTS)[number];
/**
 * The chat transport's wire format. Declared here rather than imported from
 * stream-adapter.ts, which imports this module: identity.ts depends on nothing
 * in src/, and a reverse import would make that a cycle. stream-adapter's
 * ChatFormat is an alias of this type, so the two cannot drift.
 */
export const KIRO_CHAT_FORMATS = ["text", "stream-json"] as const;
export type KiroChatFormat = (typeof KIRO_CHAT_FORMATS)[number];

/** stream-adapter.ts spawns `kiro-cli chat --agent-engine v2`. Keep in sync with that argv. */
export const CHAT_ENGINE: KiroEngine = "v2";
/** acp-transport.ts spawns `kiro-cli acp --agent-engine v2`. Keep in sync with that argv. */
export const ACP_ENGINE: KiroEngine = "v2";

export interface IdentityParts {
	/** The HOST pi's version (VERSION from @earendil-works/pi-coding-agent). */
	piVersion?: string;
	/** Bare semver of the kiro-cli binary, e.g. "2.26.1". */
	kiroVersion?: string;
	engine: KiroEngine;
	/** Which transport served the turn. Required: a caller that forgets it
	 * would otherwise silently claim the default route. */
	transport: KiroTransport;
	/** Chat wire format. Omitted on ACP, which has no format to choose. */
	format?: KiroChatFormat;
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

/**
 * The route as shown in the identity line: `acp`, or `chat/<format>`.
 *
 * Worth a slot of its own because the two transports are not
 * interchangeable, and which one is live was previously only visible in a
 * trace file. On ACP, tool arguments and the credit metadata arrive as
 * structured protocol events; on chat/stream-json the same, read from
 * kiro's NDJSON; on chat/text they are scraped out of prose, which is why a
 * session that quietly fell back to text looked like a broken harness rather
 * than a degraded one.
 *
 * A chat turn with no format resolved reads `chat` rather than naming a
 * format that will not be used.
 */
export function displayTransport(transport: KiroTransport, format?: KiroChatFormat): string {
	if (transport === "acp") return "acp";
	return format ? `chat/${format}` : "chat";
}

/**
 * Every route a turn can take, as displayTransport names it. Derived from the
 * lists above, so a new transport or format is a new route without anyone
 * having to remember to add it: route-wide test suites iterate this list.
 */
export const KIRO_ROUTES: readonly string[] = KIRO_TRANSPORTS.flatMap((transport) =>
	transport === "acp" ? [displayTransport(transport)] : KIRO_CHAT_FORMATS.map((format) => displayTransport(transport, format)),
);

export function identityLine(parts: IdentityParts): string {
	const route = displayTransport(parts.transport, parts.format);
	return `pi ${parts.piVersion ?? UNKNOWN} via Kiro (kiro-cli ${parts.kiroVersion ?? UNKNOWN}, engine ${parts.engine}, ${route}) on ${displayModel(parts.model)}`;
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
 *
 * This reports the HOST, not a copy in our node_modules: the package is a peer
 * dependency, and pi's extension loader aliases @earendil-works/pi-coding-agent
 * to its own bundled module, so the import resolves to the running pi.
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
