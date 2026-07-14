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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const BRIDGE_SERVER_NAME = "pi";

/** Sibling extension entry points whose tools are bridgeable. */
const BRIDGE_SOURCES = [
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

let capturePromise: Promise<CapturedTool[]> | undefined;

/**
 * Capture bridgeable tool definitions from sibling extensions. The raw
 * capture is cached for the process lifetime (definitions are closures over
 * each package's module-level state, shared with the live extension
 * instances); the allowlist filter applies per call so backends can differ.
 */
export async function captureBridgeTools(realPi: ExtensionAPI, envOverride?: string): Promise<CapturedTool[]> {
	capturePromise ??= (async () => {
		const sink: CapturedTool[] = [];
		const shim = makeCaptureShim(realPi, sink);
		for (const source of BRIDGE_SOURCES) {
			try {
				const module = (await import(source)) as { default?: (pi: ExtensionAPI) => unknown };
				if (typeof module.default === "function") {
					await module.default(shim);
				}
			} catch {
				// sibling not installed or failed to load — bridge without it
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
	return captured.filter((tool) => allowed.has(tool.name));
}

/** Test hook: reset the capture cache. */
export function clearBridgeCache(): void {
	capturePromise = undefined;
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

/** Build a fresh McpServer serving `tools`; one instance per delegated session. */
export function buildBridgeServer(
	tools: CapturedTool[],
	getCtx: () => ExtensionContext | undefined,
	signal: AbortSignal,
): { instance: McpServer; toolNames: string[] } | undefined {
	if (tools.length === 0) return undefined;

	const instance = new McpServer({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });

	instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: toJsonSchema(tool.parameters),
		})),
	}));

	instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
		try {
			callCounter += 1;
			const result = await tool.execute(
				`ccbridge-${callCounter}`,
				request.params.arguments ?? {},
				signal,
				undefined,
				ctx,
			);
			return { content: toMcpContent(result.content ?? []), isError: result.isError === true };
		} catch (error) {
			return {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				isError: true,
			};
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
	close: () => Promise<void>;
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
): Promise<HttpBridgeHandle | undefined> {
	if (tools.length === 0) return undefined;
	const toolNames = tools.map((tool) => tool.name);

	const token = randomBytes(24).toString("hex");

	// Stateless Streamable-HTTP: a transport instance serves exactly one
	// request, so build a fresh McpServer + transport per POST (the MCP SDK's
	// documented stateless pattern). Tool captures are closures — rebuilding
	// the server per request is cheap and side-effect free.
	const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
		const built = buildBridgeServer(tools, getCtx, signal);
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

	const close = async () => {
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	};
	signal.addEventListener("abort", () => void close(), { once: true });

	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		urlWithToken: `http://127.0.0.1:${address.port}/mcp/${token}`,
		token,
		toolNames,
		close,
	};
}
