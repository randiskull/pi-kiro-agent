/**
 * Registration lifecycle regression tests.
 *
 * The host drops dynamically registered providers on session resets (/new,
 * /resume, fork, reload) while the extension module — and its `registered`
 * flag — survive. These tests pin the fix: registration must not be gated on
 * module-local state, and a session_start event must re-register.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/readiness.js", () => ({
	checkKiroReadiness: vi.fn(async () => ({
		ready: true,
		binaryPath: "kiro-cli",
		version: "kiro-cli 0.0.0-test",
		authed: true,
		detail: "Kiro CLI kiro-cli 0.0.0-test",
	})),
	clearKiroReadinessCache: vi.fn(),
}));
vi.mock("../src/models.js", () => ({
	KIRO_PROVIDER: "kiro",
	DEFAULT_SUBAGENT_MODEL: "kiro/auto",
	FALLBACK_MODELS: [{ id: "auto" }],
	fetchKiroModels: vi.fn(async () => [{ id: "auto" }]),
}));
vi.mock("../src/stream-adapter.js", () => ({
	makeStreamViaKiro: vi.fn(() => vi.fn()),
}));
vi.mock("../src/bridge.js", () => ({
	captureBridgeTools: vi.fn(async () => []),
	serveBridgeHttp: vi.fn(),
}));
vi.mock("../src/kiro-bridge.js", () => ({ bridgeEnabled: vi.fn(() => false) }));
vi.mock("../src/subagent-wiring.js", () => ({
	wireSubagents: vi.fn(() => ({ changed: [], skipped: [] })),
}));
// Mocked so activation tests never scan (or reap on) the real process table.
vi.mock("../src/orphan-reaper.js", () => ({
	reapOrphanedKiroChildren: vi.fn(() => ({ scanned: 0, reaped: 0 })),
	registerChildForCleanup: vi.fn(),
	unregisterChildForCleanup: vi.fn(),
}));

type Handler = (event: unknown, ctx?: unknown) => void;

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const registerProvider = vi.fn();
	return {
		pi: {
			on: (name: string, fn: Handler) => {
				handlers.set(name, [...(handlers.get(name) ?? []), fn]);
			},
			registerProvider,
			registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands.set(name, def);
			},
		},
		emit: async (name: string, event: unknown = {}, ctx?: unknown) => {
			for (const fn of handlers.get(name) ?? []) fn(event, ctx);
			// registration on session_start is fire-and-forget — let it settle
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		runCommand: async (name: string, args = "") => {
			const ctx = { ui: { notify: vi.fn() } };
			await commands.get(name)?.handler(args, ctx);
			return ctx;
		},
		registerProvider,
	};
}

async function loadExtension() {
	vi.resetModules();
	const mod = await import("../src/index.js");
	return mod.default as (pi: unknown) => Promise<void>;
}

describe("provider registration lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers the provider at activation", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		expect(fake.registerProvider).toHaveBeenCalledTimes(1);
		expect(fake.registerProvider).toHaveBeenCalledWith("kiro", expect.objectContaining({ authMode: "externalCli" }));
	});

	it("runs the orphan reaper at activation, and a reaper failure never breaks activation", async () => {
		// Load first: loadExtension resets modules, so the mock instance must be
		// grabbed from the same registry generation index.js imports from.
		const piKiro = await loadExtension();
		const { reapOrphanedKiroChildren } = await import("../src/orphan-reaper.js");
		const reapMock = vi.mocked(reapOrphanedKiroChildren);
		reapMock.mockImplementationOnce(() => {
			throw new Error("ps exploded");
		});
		const fake = makeFakePi();
		await piKiro(fake.pi);
		expect(reapMock).toHaveBeenCalledTimes(1);
		expect(fake.registerProvider).toHaveBeenCalledTimes(1);
	});

	it("re-registers on session_start — the /new regression", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		expect(fake.registerProvider).toHaveBeenCalledTimes(1);
		// /new: host has dropped the provider; module state survives.
		await fake.emit("session_start", { type: "session_start", reason: "new" });
		expect(fake.registerProvider).toHaveBeenCalledTimes(2);
		// /resume behaves the same
		await fake.emit("session_start", { type: "session_start", reason: "resume" });
		expect(fake.registerProvider).toHaveBeenCalledTimes(3);
	});

	it("/kiro re-registers even when the module already registered once", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		expect(fake.registerProvider).toHaveBeenCalledTimes(1);
		// Previously: /kiro cleared the readiness cache but no-oped on the
		// stale `registered` flag, reporting success while the host registry
		// had nothing. It must now upsert unconditionally.
		await fake.runCommand("kiro");
		expect(fake.registerProvider).toHaveBeenCalledTimes(2);
	});

	it("/kiro notify level reflects THIS call's outcome, not the lingering `registered` flag [L0-03]", async () => {
		const piKiro = await loadExtension();
		const { checkKiroReadiness } = await import("../src/readiness.js");
		const readinessMock = vi.mocked(checkKiroReadiness);
		const fake = makeFakePi();
		await piKiro(fake.pi);
		// First /kiro: ready, registers, notify level "info".
		let ctx = await fake.runCommand("kiro");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("registered"), "info");
		// Bug scenario: the module-global `registered` flag is still true from
		// the successful call above (its set-points are untouched by design —
		// it's an "ever registered" throttle hint, not a per-call result). A
		// later probe that comes back NOT ready must still notify "error", not
		// read the stale flag and render "info".
		readinessMock.mockResolvedValueOnce({
			ready: false,
			binaryPath: undefined,
			version: undefined,
			authed: false,
			detail: "kiro-cli not found on PATH",
		});
		ctx = await fake.runCommand("kiro");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("NOT registered"), "error");
	});

	it("pins each session's bridge to that session's own ctx, not whichever session wrote latestCtx last [L0-04]", async () => {
		const piKiro = await loadExtension();
		const { bridgeEnabled } = await import("../src/kiro-bridge.js");
		vi.mocked(bridgeEnabled).mockReturnValue(true);
		const { serveBridgeHttp } = await import("../src/bridge.js");
		const serveMock = vi.mocked(serveBridgeHttp);
		const { makeStreamViaKiro } = await import("../src/stream-adapter.js");
		const fake = makeFakePi();
		await piKiro(fake.pi);

		// The real deps object index.ts built and wired deps.getBridge onto —
		// captured as the argument makeStreamViaKiro (mocked) was called with.
		const deps = vi.mocked(makeStreamViaKiro).mock.calls[0]?.[0] as {
			getBridge?: (signal: AbortSignal) => Promise<unknown>;
		};

		const ctxA = { sessionManager: { getSessionId: () => "session-A" } };
		const ctxB = { sessionManager: { getSessionId: () => "session-B" } };

		// Session A's turn: before_provider_request fires (its onPayload) and
		// THEN it calls getBridge — capturing session-A as this bridge's origin.
		await fake.emit("before_provider_request", {}, ctxA);
		await deps.getBridge?.(new AbortController().signal);
		const getterA = serveMock.mock.calls[0]?.[1] as () => unknown;
		expect(getterA).toBeDefined();

		// Session B's turn interleaves afterward — overwrites the module-global
		// latestCtx / sessionCtxMap entry with session-B's ctx.
		await fake.emit("before_provider_request", {}, ctxB);

		// Session A's already-created bridge must still resolve session-A's own
		// ctx at call time, not session-B's, even though B wrote most recently.
		// Before the fix this read a single `latestCtx` global and would have
		// returned ctxB here — a bridged tool call from A's turn misrouted to B.
		expect(getterA()).toBe(ctxA);
	});
});
