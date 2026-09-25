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
		// mockReturnValueOnce (not mockReturnValue): self-scopes to this test's
		// single getBridge call so the `true` cannot leak to a later-appended
		// test — vi.clearAllMocks() clears call history, not the implementation.
		vi.mocked(bridgeEnabled).mockReturnValueOnce(true);
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

	it("re-points a child-scoped bridge at the session that is current now [rebindOrigin]", async () => {
		// The pin above is right for a bridge that dies with its session. An ACP
		// bridge does not: kiro learns its URL once, at session/new, and cannot be
		// told a new one, so one bridge serves every session on the child
		// (docs/design/acp-transport.md SS5e.3). With a one-shot capture, session
		// two and everything after it kept resolving session ONE's ctx -- and kept
		// resolving it, because the LRU still holds that entry, so the latestCtx
		// fallback never fired either. resolveSession therefore calls rebindOrigin
		// at every session start.
		const piKiro = await loadExtension();
		const { bridgeEnabled } = await import("../src/kiro-bridge.js");
		vi.mocked(bridgeEnabled).mockReturnValue(true);
		const { serveBridgeHttp } = await import("../src/bridge.js");
		const serveMock = vi.mocked(serveBridgeHttp);
		const { makeStreamViaKiro } = await import("../src/stream-adapter.js");
		const fake = makeFakePi();
		await piKiro(fake.pi);

		const deps = vi.mocked(makeStreamViaKiro).mock.calls[0]?.[0] as {
			getBridge?: (signal: AbortSignal) => Promise<{ rebindOrigin?: () => void } | undefined>;
		};
		// A real handle, so getBridge returns one to rebind. The L0-04 test above
		// leaves serveBridgeHttp resolving undefined.
		serveMock.mockResolvedValueOnce({
			url: "http://127.0.0.1:1/mcp",
			urlWithToken: "http://127.0.0.1:1/mcp/tok",
			token: "tok",
			toolNames: ["todo"],
			close: async () => undefined,
		} as never);

		const ctxA = { sessionManager: { getSessionId: () => "session-A" } };
		const ctxB = { sessionManager: { getSessionId: () => "session-B" } };

		await fake.emit("before_provider_request", {}, ctxA);
		const handle = await deps.getBridge?.(new AbortController().signal);
		const getter = serveMock.mock.calls.at(-1)?.[1] as () => unknown;
		expect(getter).toBeDefined();
		// Named explicitly: an absent rebindOrigin would make the call below a
		// silent no-op via optional chaining.
		expect(typeof handle?.rebindOrigin).toBe("function");

		// A second session starts on the same child.
		await fake.emit("before_provider_request", {}, ctxB);
		expect(getter()).toBe(ctxA); // still pinned until the rebind
		handle?.rebindOrigin?.();
		expect(getter()).toBe(ctxB);
	});
});


describe("session ctx map is bounded [L0-04 leak]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Force the chat transport deterministically: on this branch (segment 1)
		// test-setup.ts does not yet scrub PI_KIRO_TRANSPORT (that lands with
		// c6c9a42 in a later segment), and index.ts selects makeStreamViaAcp when
		// it is "acp" — leaving makeStreamViaKiro (the mock the touch test reads
		// getBridge from) uncalled. Keep this suite hermetic to the launching shell.
		delete process.env.PI_KIRO_TRANSPORT;
	});

	const ctxFor = (id: string) => ({ sessionManager: { getSessionId: () => id } });

	it("never retains more than the cap, however many sessions fire", async () => {
		const piKiro = await loadExtension();
		const { _sessionCtxCount } = await import("../src/index.js");
		const fake = makeFakePi();
		await piKiro(fake.pi);

		// 200 distinct sessions each fire before_provider_request. Pre-fix this
		// grew the map to 200 (one ExtensionContext retained per session id, for
		// the life of the process, never pruned); bounded it caps at 64.
		for (let i = 0; i < 200; i++) {
			await fake.emit("before_provider_request", {}, ctxFor(`session-${i}`));
		}
		expect(_sessionCtxCount()).toBe(64);
	});

	it("a ctx with no sessionManager does not throw and is not retained", async () => {
		const piKiro = await loadExtension();
		const { _sessionCtxCount } = await import("../src/index.js");
		const fake = makeFakePi();
		await piKiro(fake.pi);

		// The set-sites guard on ctx?.sessionManager?.getSessionId() — a ctx
		// missing sessionManager must not throw inside the event handler (which
		// would also skip maybeSelfHeal on before_provider_request).
		await expect(fake.emit("before_provider_request", {}, {})).resolves.toBeUndefined();
		await expect(fake.emit("context", {}, undefined)).resolves.toBeUndefined();
		expect(_sessionCtxCount()).toBe(0);
	});

	it("touch-on-use keeps an in-flight session's ctx off the eviction front", async () => {
		const piKiro = await loadExtension();
		const { bridgeEnabled } = await import("../src/kiro-bridge.js");
		vi.mocked(bridgeEnabled).mockReturnValueOnce(true);
		const { serveBridgeHttp } = await import("../src/bridge.js");
		const serveMock = vi.mocked(serveBridgeHttp);
		const { makeStreamViaKiro } = await import("../src/stream-adapter.js");
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const deps = vi.mocked(makeStreamViaKiro).mock.calls[0]?.[0] as {
			getBridge?: (signal: AbortSignal) => Promise<unknown>;
		};

		const ctxA = ctxFor("session-A");
		// A's turn: before_provider_request records A, then getBridge pins A as
		// this bridge's origin. A is now the oldest (least-recently-used) entry.
		await fake.emit("before_provider_request", {}, ctxA);
		await deps.getBridge?.(new AbortController().signal);
		const getterA = serveMock.mock.calls[0]?.[1] as () => unknown;

		// Churn from 63 other sessions fills the map to the cap; A sits at the
		// eviction front.
		for (let i = 0; i < 63; i++) {
			await fake.emit("before_provider_request", {}, ctxFor(`other-${i}`));
		}
		// A bridged tool call resolves A's ctx. This READ must count as a touch,
		// moving A to the MRU end. (Without touch-on-use A would be the next
		// eviction victim and the assertion below would fall back to the wrong
		// ctx.)
		expect(getterA()).toBe(ctxA);

		// One more session overflows the cap and evicts the true LRU entry — no
		// longer A, because the read above touched it.
		await fake.emit("before_provider_request", {}, ctxFor("overflow"));
		expect(getterA()).toBe(ctxA);
	});
});
