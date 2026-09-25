/**
 * MCP bridge core: expose the calling Pi session's tools to delegated runtimes.
 *
 * Upstream Pi's ExtensionAPI exposes tool *schemas* (getAllTools) but not
 * executors, so the bridge captures live ToolDefinitions by invoking each
 * sibling package's extension entry point with a capture shim — a fake
 * ExtensionAPI whose registerTool records the definition and whose other
 * write methods no-op (the real extension instances already registered
 * their commands/hooks in this session; captured tools share module state).
 *
 * Two transports serve the captured tools to delegated sessions:
 *  - buildBridgeServer(): a live McpServer instance for the Claude Agent
 *    SDK's in-process `{type: "sdk", instance}` config.
 *  - serveBridgeHttp(): a loopback Streamable-HTTP MCP endpoint with
 *    bearer-token auth, for subprocess runtimes (kiro-cli inline MCP,
 *    gsd, anything that speaks HTTP MCP).
 *
 * TypeBox parameter schemas are JSON Schema, so they pass through to MCP
 * verbatim — no conversion layer.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { trace } from "./trace.js";

export const BRIDGE_SERVER_NAME = "pi";

/** Sibling extension entry points whose tools are bridgeable. Exported so the
 * live suite can assert every one of them is still locatable through pi's own
 * package registry rather than hard-coding a second copy of the list. */
export const BRIDGE_SOURCES = [
	"@juicesharp/rpiv-ask-user-question",
	"@juicesharp/rpiv-todo",
	"@juicesharp/rpiv-advisor",
	"@tintinweb/pi-subagents",
];

export const DEFAULT_BRIDGE_TOOLS = [
	"ask_user_question",
	"todo",
	"advisor",
	"Agent",
	"get_subagent_result",
	"steer_subagent",
];

export interface CapturedTool {
	name: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }>;
}

const NOOP_METHODS = new Set([
	"registerCommand",
	"registerShortcut",
	"registerFlag",
	"registerMessageRenderer",
	"registerEntryRenderer",
	"registerProvider",
	"unregisterProvider",
	"on",
	"setActiveTools",
	"sendMessage",
	"sendUserMessage",
	"appendEntry",
	"setModel",
	"setThinkingLevel",
]);

function makeCaptureShim(realPi: ExtensionAPI, sink: CapturedTool[]): ExtensionAPI {
	return new Proxy(realPi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (definition: CapturedTool) => {
					sink.push(definition);
				};
			}
			if (typeof prop === "string" && NOOP_METHODS.has(prop)) {
				return () => undefined;
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as ExtensionAPI;
}

/**
 * Tool-name allowlist: `envOverride` (comma-separated) beats the default set.
 * Backends pass their own env var value (e.g. RPIV_CLAUDE_CODE_BRIDGE_TOOLS).
 */
export function allowedToolNames(envOverride: string | undefined): Set<string> {
	if (envOverride && envOverride.trim().length > 0) {
		return new Set(
			envOverride
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name.length > 0),
		);
	}
	return new Set(DEFAULT_BRIDGE_TOOLS);
}

type ExtensionModule = { default?: (pi: ExtensionAPI) => unknown };

/**
 * Extension entry files declared by a package manifest: `pi.extensions`
 * (the pi package convention), falling back to `main`.
 */
export function manifestExtensionEntries(manifest: unknown): string[] {
	if (!manifest || typeof manifest !== "object") return [];
	const pi = (manifest as { pi?: { extensions?: unknown } }).pi;
	if (pi && Array.isArray(pi.extensions)) {
		return pi.extensions.filter((entry): entry is string => typeof entry === "string");
	}
	const main = (manifest as { main?: unknown }).main;
	return typeof main === "string" ? [main] : [];
}

/**
 * A manifest entry is importable only when it resolves INSIDE the package's own
 * install directory. `manifestExtensionEntries` returns whatever strings the
 * manifest lists, so a corrupt (or hostile) user-scope `package.json` naming
 * `../../elsewhere.ts` would otherwise be resolved and imported from outside the
 * install tree. Exploitation already requires a compromised package the user
 * installed themselves, which is why this is defence in depth rather than the
 * primary control (that is `isBridgeablePackage`).
 *
 * Compared against `base + sep`, never a bare prefix: `/pkgs/a-extra` starts
 * with `/pkgs/a` but is a different directory.
 */
export function isContainedEntryPath(base: string, target: string): boolean {
	const root = resolvePath(base);
	const resolved = resolvePath(target);
	if (resolved === root) return true;
	return resolved.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * A configured package is bridgeable only when pi installed it at USER scope.
 * Project-scope packages come from the current repo's `.pi/settings.json` — an
 * untrusted cloned repo could point at attacker-controlled entry files — so
 * they are never a bridge source regardless of pi's trust decision.
 */
export function isBridgeablePackage(pkg: { scope: string; installedPath?: string }): boolean {
	return pkg.scope === "user" && typeof pkg.installedPath === "string" && pkg.installedPath.length > 0;
}

/**
 * Locate `source` through pi's package registry and import its extension
 * entry files. Bare-specifier imports only resolve when the sibling shares a
 * node_modules tree with this package (monorepo dev); a standalone install
 * (git:/npm:) has no such tree, so walk the packages pi itself has installed
 * — pi's jiti loader handles the TS entry files.
 *
 * Trust boundary: only USER-scope packages are considered. Constructing the
 * SettingsManager with projectTrusted:false mirrors pi's untrusted-project
 * default (its `create` defaults the flag to true), and the explicit
 * scope !== "user" skip is belt-and-suspenders — together they ensure a
 * cloned repo's project-scope `.pi/settings.json` can never inject a package
 * whose entry file we then execute. Trusting a project is pi's decision, made
 * through its own prompt; the bridge never widens it.
 */
async function importViaPiRegistry(source: string): Promise<ExtensionModule[]> {
	const host = await import("@earendil-works/pi-coding-agent");
	const agentDir = host.getAgentDir();
	const settingsManager = host.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
	const packageManager = new host.DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager });
	for (const pkg of packageManager.listConfiguredPackages()) {
		if (!isBridgeablePackage(pkg) || !pkg.installedPath) continue;
		let manifest: unknown;
		try {
			manifest = JSON.parse(readFileSync(resolvePath(pkg.installedPath, "package.json"), "utf8"));
		} catch {
			continue;
		}
		if ((manifest as { name?: unknown }).name !== source) continue;
		const modules: ExtensionModule[] = [];
		for (const entry of manifestExtensionEntries(manifest)) {
			const entryPath = resolvePath(pkg.installedPath, entry);
			// Never import an entry that escaped the package's install directory.
			if (!isContainedEntryPath(pkg.installedPath, entryPath)) continue;
			try {
				modules.push((await import(pathToFileURL(entryPath).href)) as ExtensionModule);
			} catch {
				// entry failed to load — skip it, keep the rest
			}
		}
		if (modules.length > 0) return modules;
	}
	return [];
}

/** Import a bridge source: bare specifier first, pi package registry second. */
async function importBridgeModules(source: string): Promise<ExtensionModule[]> {
	try {
		return [(await import(source)) as ExtensionModule];
	} catch {
		// not resolvable from our own node_modules — try pi's registry
	}
	try {
		return await importViaPiRegistry(source);
	} catch {
		return [];
	}
}

let capturePromise: Promise<CapturedTool[]> | undefined;

/**
 * Capture bridgeable tool definitions from sibling extensions. The raw capture is
 * cached for the process lifetime; the allowlist filter applies per call so
 * backends can differ.
 *
 * The captured definitions are closures over module-level state belonging to a
 * SECOND instance of each package -- NOT the live instance pi is running. pi's
 * extension loader creates jiti with `moduleCache: false`
 * (coding-agent/src/core/extensions/loader.ts), so an import here always
 * re-evaluates the entry file into a fresh module graph. There is no specifier
 * that would reach pi's own instance, and pi exposes no way to invoke a
 * registered tool by name, so this is structural rather than a choice.
 *
 * Consequence, and the reason this is spelled out: a bridged tool only behaves
 * correctly if it is self-contained or keys its cross-instance state globally. A
 * tool relying on module-level state that pi's instance populates -- from a slash
 * command, or a lifecycle handler the capture never receives -- reads a cold copy,
 * and the divergence is silent because each instance stays internally consistent.
 * See docs/design/acp-transport.md section 5f for the two cases found in the field
 * and the fix pattern (`globalThis[Symbol.for(...)]`).
 */
export async function captureBridgeTools(realPi: ExtensionAPI, envOverride?: string): Promise<CapturedTool[]> {
	capturePromise ??= (async () => {
		const sink: CapturedTool[] = [];
		const shim = makeCaptureShim(realPi, sink);
		for (const source of BRIDGE_SOURCES) {
			for (const module of await importBridgeModules(source)) {
				try {
					if (typeof module.default === "function") {
						await module.default(shim);
					}
				} catch {
					// sibling failed to initialize — bridge without it
				}
			}
		}
		const seen = new Set<string>();
		return sink.filter((tool) => {
			if (seen.has(tool.name)) return false;
			seen.add(tool.name);
			return true;
		});
	})();
	const captured = await capturePromise;
	const allowed = allowedToolNames(envOverride);
	const bridged = captured.filter((tool) => allowed.has(tool.name));
	warnOnMissingBridgeTools(allowed, bridged);
	return bridged;
}

/** Names already reported missing, so the warning fires once per process. */
const warnedMissingTools = new Set<string>();

/**
 * Warn at MOUNT time about a requested tool that no loaded extension provides.
 *
 * Without this the failure is deferred and opaque: the tool is simply absent from
 * the bridge, kiro never learns it exists, and the only symptom is the delegated
 * model calling something else or (for a tool pi does not register either) a bare
 * `Tool <name> not found` arriving from pi's own dispatcher with no hint that the
 * bridge was the missing link. Naming it here points at the real cause -- usually
 * an extension that failed to load, or a typo in PI_KIRO_BRIDGE_TOOLS.
 *
 * Advisory only. A partial bridge is still useful, so this never throws.
 */
export function warnOnMissingBridgeTools(allowed: Set<string>, bridged: Array<{ name: string }>): void {
	const present = new Set(bridged.map((tool) => tool.name));
	const missing = [...allowed].filter((name) => !present.has(name) && !warnedMissingTools.has(name));
	if (missing.length === 0) return;
	for (const name of missing) warnedMissingTools.add(name);
	console.error(
		`[pi-kiro] bridge: ${missing.length === 1 ? "tool" : "tools"} ${missing.map((n) => `\`${n}\``).join(", ")} ` +
		`${missing.length === 1 ? "was" : "were"} requested but no loaded extension provides ${missing.length === 1 ? "it" : "them"}; ` +
		`${missing.length === 1 ? "it" : "they"} will be absent from the bridge. ` +
		`Check that the providing extension loaded, or adjust PI_KIRO_BRIDGE_TOOLS. ` +
		`Bridged: ${[...present].sort().join(", ") || "(none)"}.`,
	);
}

/** Test hook: reset the capture cache. */
export function clearBridgeCache(): void {
	capturePromise = undefined;
	inFlightSingleFlight.clear();
	orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS;
	singleFlightCeilingMs = DEFAULT_SINGLE_FLIGHT_CEILING_MS;
	warnedMissingTools.clear();
}

/** Strip TypeBox symbol keys; guarantee an object-typed JSON schema. */
export function toJsonSchema(parameters: unknown): Record<string, unknown> {
	try {
		const schema = JSON.parse(JSON.stringify(parameters ?? {}));
		if (schema && typeof schema === "object" && schema.type === "object") return schema;
		return { type: "object", properties: {}, ...(schema && typeof schema === "object" ? schema : {}) };
	} catch {
		return { type: "object", properties: {} };
	}
}

function toMcpContent(content: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const mapped: Array<Record<string, unknown>> = [];
	for (const block of content) {
		if (block.type === "text") {
			mapped.push({ type: "text", text: String(block.text ?? "") });
		} else if (block.type === "image") {
			mapped.push({
				type: "image",
				data: String(block.data ?? ""),
				mimeType: String(block.mimeType ?? "image/png"),
			});
		}
	}
	return mapped.length > 0 ? mapped : [{ type: "text", text: "(no content)" }];
}

let callCounter = 0;

/**
 * Tools that block on a human answering. Measured on the wire: kiro's MCP HTTP
 * client abandons a bridged call at about 126 seconds and reports a transport
 * error, and nothing here cancelled the queued question -- so kiro's retry
 * stacked ANOTHER question on the same user. One @pi/ask_user_question was
 * re-issued at 02:32:44, 02:34:50 and 02:37:07, and all three resolved to a
 * real answer hours later. Any question a human thought about for longer than
 * that window was asked again, once per window.
 */
const SINGLE_FLIGHT_TOOLS = new Set(["ask_user_question"]);

/** What a single-flight tool is currently holding, and whether its caller left. */
type InFlightEntry = {
	callId: string;
	startedAt: number;
	/** When the caller abandoned the call; undefined while the caller is still waiting. */
	abortedAt?: number;
};

/** In-flight entry per single-flight tool name. Empty when nothing is pending. */
const inFlightSingleFlight = new Map<string, InFlightEntry>();

/**
 * How long a call whose caller has left keeps blocking its successors.
 *
 * The block itself is correct: the pi-side question is still on screen, so
 * admitting a second call would stack a second overlay on the same user. But
 * the slot is released in a finally, and ask_user_question cannot be cancelled
 * (its execute ignores the signal it is handed), so the finally does not run
 * until the user answers. A user who never answers would leave the tool
 * refusing for the rest of the process. Cap the block instead of trusting the
 * tool to unwind: past the grace window the old overlay is treated as
 * abandoned and a fresh question is allowed through.
 */
const DEFAULT_ORPHAN_GRACE_MS = 5 * 60_000;
let orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS;

/**
 * Hard ceiling on how long ONE call may hold the slot, measured from startedAt
 * rather than from an abort.
 *
 * The grace window above keys off abortedAt, which onAbort only stamps when an
 * abort actually reaches us. A caller that abandons a call WITHOUT aborting --
 * a reset connection, a client that simply stops reading, an SDK path that does
 * not surface cancellation -- leaves abortedAt undefined forever, and since
 * ask_user_question also ignores the signal it is handed, the finally that
 * would free the slot never runs either. The slot was then unreleasable for the
 * life of the process: every later ask_user_question from every child refused.
 *
 * Measured from startedAt so it bounds that case without shortening the abort
 * case, which stays governed by the grace window: kiro abandons a bridged call
 * at about 120s, so the longest legitimate hold is that plus the grace window,
 * comfortably inside this.
 */
const DEFAULT_SINGLE_FLIGHT_CEILING_MS = 15 * 60_000;
let singleFlightCeilingMs = DEFAULT_SINGLE_FLIGHT_CEILING_MS;

/** Test hook: shorten the orphan grace window so the release path is testable. */
export function setSingleFlightOrphanGraceMs(ms: number): void {
	orphanGraceMs = ms;
}

/** Test hook: shorten the hard ceiling so the no-abort release path is testable. */
export function setSingleFlightCeilingMs(ms: number): void {
	singleFlightCeilingMs = ms;
}

/** Build a fresh McpServer serving `tools`; one instance per delegated session. */
export function buildBridgeServer(
	tools: CapturedTool[],
	getCtx: () => ExtensionContext | undefined,
	signal: AbortSignal,
): { instance: McpServer; toolNames: string[] } | undefined {
	if (tools.length === 0) return undefined;

	const instance = new McpServer({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });

	instance.server.setRequestHandler(ListToolsRequestSchema, () => {
		// Traced because a tools/list is the only moment kiro learns what the
		// bridge serves: a tool missing HERE explains a later "Tool <name> not
		// found" that otherwise looks like a call-time failure, and a second
		// tools/list reveals a second mount of the same bridge.
		trace("bridge.list", { tools: tools.map((tool) => tool.name) });
		return {
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: toJsonSchema(tool.parameters),
			})),
		};
	});

	instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const tool = tools.find((candidate) => candidate.name === request.params.name);
		if (!tool) {
			return {
				content: [{ type: "text", text: `Unknown bridged tool: ${request.params.name}` }],
				isError: true,
			};
		}
		const ctx = getCtx();
		if (!ctx) {
			return {
				content: [
					{
						type: "text",
						text: "No active Pi session context is available to execute this tool. Report this to the user instead of retrying.",
					},
				],
				isError: true,
			};
		}
		// Refuse a second blocking call while one is still pending, rather than
		// queueing it. The caller cannot see that its earlier call is still live
		// (its HTTP request already timed out), so left unguarded it retries and
		// the user is asked again. Arg-hash dedupe would not catch this: kiro
		// rewords the question on each retry.
		const singleFlight = SINGLE_FLIGHT_TOOLS.has(tool.name);
		if (singleFlight) {
			const pending = inFlightSingleFlight.get(tool.name);
			if (pending !== undefined) {
				const orphanedForMs = pending.abortedAt === undefined ? undefined : Date.now() - pending.abortedAt;
				const heldForMs = Date.now() - pending.startedAt;
				// Two independent releases. "grace" is the caller-left case and is the
				// common one. "ceiling" covers a call no abort ever arrived for, which
				// leaves abortedAt undefined and would otherwise hold the slot for the
				// life of the process -- see DEFAULT_SINGLE_FLIGHT_CEILING_MS.
				const releaseReason =
					orphanedForMs !== undefined && orphanedForMs >= orphanGraceMs
						? "grace"
						: heldForMs >= singleFlightCeilingMs
							? "ceiling"
							: undefined;
				if (releaseReason !== undefined) {
					// Caller gone, grace spent: stop blocking. The old call may still
					// resolve later; its finally will not touch this slot (see below).
					trace("bridge.orphan.release", {
						tool: tool.name,
						releasedCallId: pending.callId,
						orphanedForMs,
						heldForMs,
						reason: releaseReason,
					});
					inFlightSingleFlight.delete(tool.name);
				} else {
					trace("bridge.reject.inflight", {
						tool: tool.name,
						blockedBy: pending.callId,
						pendingForMs: heldForMs,
						orphanedForMs,
					});
					return {
						content: [
							{
								type: "text",
								text: `A ${tool.name} call (${pending.callId}) is already on the user's screen. This connection timed out, so its answer cannot be returned to you -- but the question is still displayed and asking again would stack a second one on the same user. Do not retry ${tool.name}; continue without an answer, or state what you need and stop.`,
							},
						],
						isError: true,
					};
				}
			}
		}
		callCounter += 1;
		const callId = `ccbridge-${callCounter}`;
		const startedAt = Date.now();
		if (singleFlight) inFlightSingleFlight.set(tool.name, { callId, startedAt });
		// Trace the invocation, not the narration: a double-executed tool (the
		// same @pi/ask_user_question asked twice) is only distinguishable from a
		// model that chose to call it twice by counting the calls that actually
		// arrived here.
		trace("bridge.call", { callId, tool: tool.name, args: request.params.arguments ?? {}, singleFlight });
		// extra.signal fires when the CALLER cancels or drops the connection.
		// Passing only the bridge-lifetime signal meant a call whose caller had
		// already given up kept running, holding a question in the user's queue
		// that nothing would ever collect. Union the two so a bridge shutdown
		// still cancels as well.
		const execSignal = extra?.signal ? AbortSignal.any([signal, extra.signal]) : signal;
		const onAbort = () => {
			// Stamp the abort rather than releasing the slot now: the question is
			// still on the user's screen, so an immediate retry must still be
			// refused. This only starts the clock on the grace window.
			const entry = inFlightSingleFlight.get(tool.name);
			if (entry?.callId === callId) entry.abortedAt = Date.now();
			trace("bridge.abort", {
				callId,
				tool: tool.name,
				ms: Date.now() - startedAt,
				byCaller: extra?.signal?.aborted === true,
			});
		};
		execSignal.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await tool.execute(callId, request.params.arguments ?? {}, execSignal, undefined, ctx);
			const isError = result.isError === true;
			const content = toMcpContent(result.content ?? []);
			trace("bridge.result", { callId, tool: tool.name, isError, ms: Date.now() - startedAt, content });
			return { content, isError };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			trace("bridge.throw", { callId, tool: tool.name, ms: Date.now() - startedAt, message });
			return {
				content: [{ type: "text", text: message }],
				isError: true,
			};
		} finally {
			execSignal.removeEventListener("abort", onAbort);
			// Only if the slot is still ours. An orphan released past its grace
			// window can resolve after a successor has claimed the slot, and
			// deleting unconditionally would unblock a live question.
			if (singleFlight && inFlightSingleFlight.get(tool.name)?.callId === callId) {
				inFlightSingleFlight.delete(tool.name);
			}
		}
	});

	return { instance, toolNames: tools.map((tool) => tool.name) };
}

export interface HttpBridgeHandle {
	/** Loopback MCP endpoint, e.g. http://127.0.0.1:53412/mcp (use with the Authorization header). */
	url: string;
	/**
	 * Endpoint with the token embedded in the path, for clients whose MCP
	 * config can't set custom headers (kiro-cli v2 http servers). Loopback +
	 * unguessable path segment gives equivalent secrecy to the header form.
	 */
	urlWithToken: string;
	/** Per-session bearer token required on every request. */
	token: string;
	toolNames: string[];
	/** Optional `reason` is diagnostic only; it lands in the `bridge.close` trace. */
	close: (reason?: string) => Promise<void>;
	/**
	 * Re-point this bridge's ExtensionContext lookup at whatever session is
	 * current now.
	 *
	 * Only a CHILD-scoped bridge needs it. The owner captures an origin session
	 * id when the bridge is mounted so a concurrent session cannot steal its tool
	 * calls [L0-04]; that capture is correct for a bridge that dies with its
	 * session, but an ACP bridge outlives every session on its child, so without
	 * a rebind the second and later sessions run their bridged tools against the
	 * FIRST session's ctx. Supplied by whoever built the handle (src/index.ts),
	 * optional so the per-turn chat-transport bridge can ignore it.
	 */
	rebindOrigin?: () => void;
}

/**
 * A bridge that OUTLIVES the session which mounted it, so rebinding is not
 * optional. Used for the child-scoped ACP bridge.
 *
 * The base type leaves `rebindOrigin` optional for the per-turn chat-transport
 * bridge, which has nothing to rebind. That optionality is a hazard on the ACP
 * path: every call site there reads `bridge?.rebindOrigin?.()`, so a refactor
 * that dropped the field from the handle would compile, run, emit no warning,
 * and silently restore the stale-ctx defect this type exists to prevent. Making
 * it required here turns that regression into a type error.
 */
export interface ChildScopedHttpBridgeHandle extends HttpBridgeHandle {
	rebindOrigin: () => void;
}

/**
 * Serve the bridged tools over Streamable-HTTP MCP on a loopback ephemeral
 * port, for subprocess runtimes that can't hold an in-process instance.
 * Stateless transport: every POST is handled independently, which suits
 * short-lived delegated sessions. Closes with the delegated turn.
 */
export async function serveBridgeHttp(
	tools: CapturedTool[],
	getCtx: () => ExtensionContext | undefined,
	signal: AbortSignal,
	getCallSignal?: () => AbortSignal,
): Promise<HttpBridgeHandle | undefined> {
	if (tools.length === 0) return undefined;
	const toolNames = tools.map((tool) => tool.name);

	const token = randomBytes(24).toString("hex");

	// Stateless Streamable-HTTP: a transport instance serves exactly one
	// request, so build a fresh McpServer + transport per POST (the MCP SDK's
	// documented stateless pattern). Tool captures are closures — rebuilding
	// the server per request is cheap and side-effect free.
	const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
		// `signal` is the server's LIFETIME; getCallSignal() is the cancellation
		// signal handed to each bridged tool.execute. Under ACP these differ: the
		// URL is a property of the kiro CHILD (it learns the port once, at
		// session/new, and has no way to learn a new one), while cancellation is
		// per-SESSION, because a session reset has to cancel calls in flight. Before
		// they were split, a session reset closed the server and opened a new one on
		// a new ephemeral port, stranding kiro on the closed one for the rest of the
		// conversation -- see docs/design/acp-transport.md §5e.3. Resolved per
		// request, not captured, so a reset mid-turn still cancels correctly.
		const built = buildBridgeServer(tools, getCtx, getCallSignal?.() ?? signal);
		if (!built) {
			res.writeHead(500).end();
			return;
		}
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		res.on("close", () => {
			void transport.close().catch(() => undefined);
		});
		await built.instance.connect(transport);
		await transport.handleRequest(req, res);
	};

	const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const auth = req.headers.authorization ?? "";
		const path = (req.url ?? "").split("?")[0];
		const authorized = auth === `Bearer ${token}` || path === `/mcp/${token}`;
		if (!authorized) {
			res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		handleMcp(req, res).catch(() => {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", resolve);
	});
	const address = httpServer.address() as AddressInfo;
	// Mount/close are traced because a bridged tool failing with a bare
	// "error sending request for url" is indistinguishable, from the kiro side,
	// between a bridge that never came up, one that was torn down early, and a
	// client still holding a previous session's port. The port is the join key.
	trace("bridge.serve", { port: address.port, tools: toolNames });

	// Idempotent: the owner closes the handle explicitly AND the signal's own
	// listener fires on abort, so close() is routinely called twice for one
	// server. Memoizing the shutdown promise makes the second call await the
	// first instead of issuing a redundant httpServer.close() whose callback
	// receives ERR_SERVER_NOT_RUNNING.
	let closed: Promise<void> | undefined;
	// `reason` is diagnostic only and optional, so this still satisfies the
	// handle's `close: () => Promise<void>` contract for owners that pass nothing.
	const close = (reason?: string) => {
		if (!closed) {
			trace("bridge.close", { port: address.port, reason: reason ?? "owner" });
			closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
		return closed;
	};
	signal.addEventListener("abort", () => void close("signal-abort"), { once: true });

	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		urlWithToken: `http://127.0.0.1:${address.port}/mcp/${token}`,
		token,
		toolNames,
		close,
	};
}
