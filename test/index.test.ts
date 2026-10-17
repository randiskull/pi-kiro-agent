/**
 * Registration lifecycle regression tests.
 *
 * The host drops dynamically registered providers on session resets (/new,
 * /resume, fork, reload) while the extension module — and its `registered`
 * flag — survive. These tests pin the fix: registration must not be gated on
 * module-local state, and a session_start event must re-register.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meteringDiagnostic } from "../src/metering.js";

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
	// index.ts imports this for the identity line's route slot. "0.0.0-test"
	// is below the stream-json floor, so text is what the real one returns here.
	chatFormat: vi.fn(() => "text"),
}));
// Mocked so transport selection is observable: which factory index.ts calls IS
// the assertion, and the real ACP transport must not spawn anything.
vi.mock("../src/acp-transport.js", () => ({
	makeStreamViaAcp: vi.fn(() => vi.fn()),
}));
vi.mock("../src/bridge.js", () => ({
	captureBridgeTools: vi.fn(async () => []),
	serveBridgeHttp: vi.fn(),
	setBridgeNotice: vi.fn(),
}));
vi.mock("../src/kiro-bridge.js", () => ({
	bridgeEnabled: vi.fn(() => false),
	sweepStaleAgentProfiles: vi.fn(() => 0),
}));
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
		runCommandWith: async (name: string, ctx: unknown, args = "") => {
			await commands.get(name)?.handler(args, ctx);
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
		// These tests read the deps makeStreamViaKiro was called with, so they
		// need the chat transport NAMED. Unset means ACP now.
		process.env.PI_KIRO_TRANSPORT = "chat";
	});
	afterEach(() => {
		delete process.env.PI_KIRO_TRANSPORT;
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

	it("sweeps stale agent profiles at activation, and a sweep failure never breaks activation", async () => {
		const piKiro = await loadExtension();
		const { sweepStaleAgentProfiles } = await import("../src/kiro-bridge.js");
		const sweepMock = vi.mocked(sweepStaleAgentProfiles);
		sweepMock.mockImplementationOnce(() => {
			throw new Error("readdir exploded");
		});
		const fake = makeFakePi();
		await piKiro(fake.pi);
		expect(sweepMock).toHaveBeenCalledTimes(1);
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
		// /kiro must upsert unconditionally: gating on the stale `registered`
		// flag reported success while the host registry held nothing.
		await fake.runCommand("kiro");
		expect(fake.registerProvider).toHaveBeenCalledTimes(2);
	});

	it("/kiro notify level reflects THIS call's outcome, not the `registered` flag", async () => {
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

	it("pins each session's bridge to that session's own ctx, not whichever session wrote latestCtx last", async () => {
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
		// (docs/design/acp-transport.md §5e.3). With a one-shot capture, session
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
		// Name the chat transport: the touch test reads getBridge off the deps
		// makeStreamViaKiro was called with, and ACP is the default, so an unset
		// variable leaves that mock uncalled. Also keeps the suite hermetic to
		// the launching shell.
		process.env.PI_KIRO_TRANSPORT = "chat";
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

describe("credit status line", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_KIRO_CREDIT_USD;
	});

	const uiCtx = (setStatus: ReturnType<typeof vi.fn>) => ({
		hasUI: true,
		model: { provider: "kiro", id: "auto" },
		ui: { setStatus, notify: vi.fn() },
		sessionManager: { getSessionId: () => "credit-session" },
	});
	/**
	 * A finished turn as the host delivers it, with the transport's metering
	 * record attached. Both transports attach one on EVERY turn, so an unpriced
	 * turn is a record with no credits, not a missing record.
	 */
	const turnEnd = (credits: number | undefined, provider = "kiro") => ({
		type: "message_end",
		message: {
			role: "assistant",
			provider,
			content: [],
			diagnostics: [meteringDiagnostic({ credits, source: credits === undefined ? "chat-text" : "acp", precision: "exact" })],
		},
	});

	it("accumulates each turn's credits into its own status slot, with the projected dollars", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		await fake.emit("message_end", turnEnd(1.5), uiCtx(setStatus));
		// The identity line owns the "kiro" key; credits must not overwrite it.
		expect(setStatus).toHaveBeenLastCalledWith("kiro-credits", "▸ 1.50 credits ~$0.03");
		await fake.emit("message_end", turnEnd(0.5), uiCtx(setStatus));
		expect(setStatus).toHaveBeenLastCalledWith("kiro-credits", "▸ 2.00 credits ~$0.04 (last 0.500)");
	});

	it("ignores a non-kiro turn and a kiro turn that reported no figure", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		await fake.emit("message_end", turnEnd(1.5), uiCtx(setStatus));
		setStatus.mockClear();
		// Another provider's spend is not kiro's, and a turn with no figure must not
		// even redraw: a redraw would count it as a turn and add a bogus "(last)".
		await fake.emit("message_end", turnEnd(99, "anthropic"), uiCtx(setStatus));
		await fake.emit("message_end", turnEnd(undefined), uiCtx(setStatus));
		await fake.emit("message_end", { type: "message_end", message: { role: "user", content: "hi" } }, uiCtx(setStatus));
		expect(setStatus).not.toHaveBeenCalled();
		// The earlier total survives untouched.
		await fake.emit("message_end", turnEnd(0.5), uiCtx(setStatus));
		expect(setStatus).toHaveBeenLastCalledWith("kiro-credits", "▸ 2.00 credits ~$0.04 (last 0.500)");
	});

	it("an unpriced turn before the first priced one adds no \"(last)\"", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		await fake.emit("message_end", turnEnd(undefined), uiCtx(setStatus));
		await fake.emit("message_end", turnEnd(1.5), uiCtx(setStatus));
		expect(setStatus).toHaveBeenLastCalledWith("kiro-credits", "▸ 1.50 credits ~$0.03");
	});

	it("a new session clears the slot and starts the tally over", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		await fake.emit("message_end", turnEnd(1.5), uiCtx(setStatus));
		setStatus.mockClear();
		await fake.emit("session_start", { type: "session_start", reason: "new" }, uiCtx(setStatus));
		expect(setStatus).toHaveBeenCalledWith("kiro-credits", undefined);
		setStatus.mockClear();
		await fake.emit("message_end", turnEnd(0.5), uiCtx(setStatus));
		// 0.500, not 2.00: the previous session's 1.5 credits did not carry over.
		expect(setStatus).toHaveBeenLastCalledWith("kiro-credits", "▸ 0.500 credits ~$0.01");
	});

	it("an explicit PI_KIRO_CREDIT_USD=0 shows credits with no dollar figure", async () => {
		process.env.PI_KIRO_CREDIT_USD = "0";
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		await fake.emit("message_end", turnEnd(1.5), uiCtx(setStatus));
		expect(setStatus).toHaveBeenLastCalledWith("kiro-credits", "▸ 1.50 credits");
		delete process.env.PI_KIRO_CREDIT_USD;
	});

	it("a headless host never has setStatus called at all", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		await fake.emit("message_end", turnEnd(1.5), { hasUI: false, ui: { setStatus, notify: vi.fn() } });
		expect(setStatus).not.toHaveBeenCalled();
	});
});

describe("bridge advisories", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const advisoryCtx = (hasUI: boolean, notify: ReturnType<typeof vi.fn>, sessionId: string) => ({
		hasUI,
		model: { provider: "kiro", id: "auto" },
		ui: { notify, setStatus: vi.fn() },
		sessionManager: { getSessionId: () => sessionId },
	});

	it("reach the user through ctx.ui.notify under a UI host, and stderr only when headless", async () => {
		// A raw stderr write under the TUI is painted into the chrome above the
		// prompt and STAYS there for the rest of the session, so a mount-time
		// advisory read as a permanent banner (measured 2026-10-17, pi 1.3.0).
		const { setBridgeNotice } = await import("../src/bridge.js");
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const notice = vi.mocked(setBridgeNotice).mock.calls.at(-1)?.[0];
		expect(notice).toBeTypeOf("function");

		const notify = vi.fn();
		const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await fake.emit("before_provider_request", {}, advisoryCtx(true, notify, "advisory-ui"));
		notice?.("[pi-kiro] bridge: tool `x` was requested");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("tool `x`"), "warning");
		expect(stderr).not.toHaveBeenCalled();

		notify.mockClear();
		await fake.emit("before_provider_request", {}, advisoryCtx(false, notify, "advisory-headless"));
		notice?.("[pi-kiro] bridge: headless advisory");
		expect(notify).not.toHaveBeenCalled();
		expect(stderr).toHaveBeenCalledWith("[pi-kiro] bridge: headless advisory");
		stderr.mockRestore();
	});
});

describe("identity Layer 1: status bar, /kiro, deps.kiroVersion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	afterEach(() => {
		delete process.env.PI_KIRO_TRANSPORT;
	});

	const kiroCtx = (setStatus: ReturnType<typeof vi.fn>, model: { provider: string; id: string } | undefined) => ({
		hasUI: true,
		model,
		ui: { setStatus, notify: vi.fn() },
		sessionManager: { getSessionId: () => "identity-session" },
	});

	it("hands the transport the parsed kiro-cli version from readiness", async () => {
		const piKiro = await loadExtension();
		const { makeStreamViaKiro } = await import("../src/stream-adapter.js");
		process.env.PI_KIRO_TRANSPORT = "chat";
		await piKiro(makeFakePi().pi);
		const deps = vi.mocked(makeStreamViaKiro).mock.calls[0]?.[0] as { kiroVersion?: string };
		expect(deps.kiroVersion).toBe("0.0.0-test");
	});

	it("shows the identity line in the status bar for a kiro model, clears it for any other", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		await fake.emit("before_provider_request", {}, kiroCtx(setStatus, { provider: "kiro", id: "claude-sonnet-4.5" }));
		await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
		const [key, text] = setStatus.mock.calls.at(-1) as [string, string];
		expect(key).toBe("kiro");
		expect(text).toMatch(/^pi \S+ via Kiro \(kiro-cli 0\.0\.0-test, engine v2, acp\) on claude-sonnet-4\.5$/);

		setStatus.mockClear();
		await fake.emit("before_provider_request", {}, kiroCtx(setStatus, { provider: "anthropic", id: "claude" }));
		expect(setStatus).toHaveBeenCalledWith("kiro", undefined);
	});

	it("updates the status bar on /model, from the selected model, before any provider request", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		// ctx.model still names the OLD model: the handler must use event.model.
		const ctx = kiroCtx(setStatus, { provider: "anthropic", id: "claude" });
		await fake.emit("model_select", { type: "model_select", model: { provider: "kiro", id: "claude-opus-4.8" }, source: "set" }, ctx);
		await vi.waitFor(() => expect(setStatus).toHaveBeenCalled());
		expect(setStatus.mock.calls.at(-1)?.[1]).toMatch(/ on claude-opus-4\.8$/);

		await fake.emit("model_select", { type: "model_select", model: { provider: "anthropic", id: "claude" }, source: "set" }, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("kiro", undefined);
	});

	it("a slow identity line for an earlier kiro model never overwrites a later switch away", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const setStatus = vi.fn();
		const ctx = kiroCtx(setStatus, undefined);
		// Both fire before the first line resolves (it awaits resolvePiVersion).
		void fake.emit("model_select", { type: "model_select", model: { provider: "kiro", id: "auto" }, source: "set" }, ctx);
		void fake.emit("model_select", { type: "model_select", model: { provider: "anthropic", id: "claude" }, source: "set" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(setStatus).toHaveBeenCalledTimes(1);
		expect(setStatus).toHaveBeenLastCalledWith("kiro", undefined);
	});

	it("/kiro reports plugin version, auth method and the identity line", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await piKiro(fake.pi);
		const { pluginName, pluginVersion } = await import("../src/identity.js");
		const notify = vi.fn();
		const ctx = { ...kiroCtx(vi.fn(), { provider: "kiro", id: "auto" }), ui: { setStatus: vi.fn(), notify } };
		await fake.runCommandWith("kiro", ctx);
		const message = notify.mock.calls[0]?.[0] as string;
		expect(message).toContain(`${pluginName()} ${pluginVersion()}, auth: login`);
		expect(message).toMatch(/identity: pi \S+ via Kiro \(kiro-cli 0\.0\.0-test, engine v2, acp\) on auto \(selected by kiro\)/);
	});
});

describe("kiro/router registration (opt-in virtual model)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_KIRO_ROUTER;
	});

	function withVirtual() {
		const fake = makeFakePi();
		const registerVirtualModel = vi.fn();
		return { fake, registerVirtualModel, pi: { ...fake.pi, registerVirtualModel } };
	}

	it("registers kiro/router beside the physical models, and again on session_start", async () => {
		const piKiro = await loadExtension();
		const { fake, registerVirtualModel, pi } = withVirtual();
		await piKiro(pi);
		expect(registerVirtualModel).toHaveBeenCalledTimes(1);
		const def = registerVirtualModel.mock.calls[0]?.[0] as { provider: string; id: string; thinkingLevels: string[]; route: unknown };
		expect(def.provider).toBe("kiro");
		expect(def.id).toBe("router");
		expect(def.thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
		expect(typeof def.route).toBe("function");
		// The provider itself is unchanged: kiro/auto stays the physical default.
		expect(fake.registerProvider).toHaveBeenCalledWith("kiro", expect.objectContaining({ models: [{ id: "auto" }] }));
		await fake.emit("session_start", { type: "session_start", reason: "new" });
		expect(registerVirtualModel).toHaveBeenCalledTimes(2);
	});

	it("routes through ctx.modelRegistry", async () => {
		const piKiro = await loadExtension();
		const { registerVirtualModel, pi } = withVirtual();
		await piKiro(pi);
		const def = registerVirtualModel.mock.calls[0]?.[0] as { route: (r: unknown, ctx: unknown) => { model: { id: string } } };
		const haiku = { provider: "kiro", id: "claude-haiku-4.5", contextWindow: 200_000 };
		const ctx = {
			modelRegistry: {
				find: (provider: string, id: string) => (provider === "kiro" && id === "claude-haiku-4.5" ? haiku : undefined),
				hasConfiguredAuth: () => true,
			},
		};
		const route = def.route({ reason: "user", thinkingLevel: "low", messages: [] }, ctx);
		expect(route.model).toBe(haiku);
	});

	it("the route closure reads PI_KIRO_ROUTER_FALLBACK and PI_KIRO_ROUTER_COOLDOWN_MS", async () => {
		const saved = { fb: process.env.PI_KIRO_ROUTER_FALLBACK, cd: process.env.PI_KIRO_ROUTER_COOLDOWN_MS };
		process.env.PI_KIRO_ROUTER_FALLBACK = "anthropic";
		process.env.PI_KIRO_ROUTER_COOLDOWN_MS = "1234";
		const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
		try {
			const piKiro = await loadExtension();
			const { registerVirtualModel, pi } = withVirtual();
			await piKiro(pi);
			const def = registerVirtualModel.mock.calls[0]?.[0] as {
				route: (r: unknown, ctx: unknown) => { model: { provider: string; id: string }; state?: { fallbackUntil?: number } };
			};
			const kiroSonnet = { provider: "kiro", id: "claude-sonnet-5.5", contextWindow: 1_000_000 };
			// Bedrock is listed first by default and has credentials: only the env order skips it.
			const bedrock = { provider: "amazon-bedrock", id: "us.anthropic.claude-sonnet-5", contextWindow: 1_000_000 };
			const anthropic = { provider: "anthropic", id: "claude-sonnet-5-5", contextWindow: 1_000_000 };
			const catalog = [kiroSonnet, bedrock, anthropic];
			const ctx = {
				modelRegistry: {
					find: (provider: string, id: string) => catalog.find((m) => m.provider === provider && m.id === id),
					hasConfiguredAuth: () => true,
				},
			};
			const failed = {
				model: kiroSonnet,
				thinkingLevel: "medium",
				message: { role: "assistant", stopReason: "error", errorMessage: "503", provider: "kiro", content: [] },
			};
			const route = def.route({ reason: "retry", thinkingLevel: "medium", messages: [], failed }, ctx);
			expect(route.model).toBe(anthropic);
			expect(route.state?.fallbackUntil).toBe(5_000 + 1234);
		} finally {
			now.mockRestore();
			if (saved.fb === undefined) delete process.env.PI_KIRO_ROUTER_FALLBACK;
			else process.env.PI_KIRO_ROUTER_FALLBACK = saved.fb;
			if (saved.cd === undefined) delete process.env.PI_KIRO_ROUTER_COOLDOWN_MS;
			else process.env.PI_KIRO_ROUTER_COOLDOWN_MS = saved.cd;
		}
	});

	it("is not registered on hosts without registerVirtualModel (pi < 1.0)", async () => {
		const piKiro = await loadExtension();
		const fake = makeFakePi();
		await expect(piKiro(fake.pi)).resolves.toBeUndefined();
		expect(fake.registerProvider).toHaveBeenCalledTimes(1);
	});

	it("PI_KIRO_ROUTER=off skips it", async () => {
		process.env.PI_KIRO_ROUTER = "off";
		try {
			const piKiro = await loadExtension();
			const { registerVirtualModel, pi } = withVirtual();
			await piKiro(pi);
			expect(registerVirtualModel).not.toHaveBeenCalled();
		} finally {
			delete process.env.PI_KIRO_ROUTER;
		}
	});

	it("never hides a physical kiro model that has the router's id", async () => {
		const piKiro = await loadExtension();
		const { fetchKiroModels } = await import("../src/models.js");
		vi.mocked(fetchKiroModels).mockResolvedValueOnce([{ id: "auto" }, { id: "router" }] as never);
		const { registerVirtualModel, pi } = withVirtual();
		await piKiro(pi);
		expect(registerVirtualModel).not.toHaveBeenCalled();
	});
});


describe("transport selection: ACP is the default, chat is the fallback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_KIRO_TRANSPORT;
	});
	afterEach(() => {
		delete process.env.PI_KIRO_TRANSPORT;
	});

	/** Which factory index.ts handed registerProvider, by call count. */
	async function selectedTransport(): Promise<"acp" | "chat" | "none"> {
		const piKiro = await loadExtension();
		await piKiro(makeFakePi().pi);
		const { makeStreamViaAcp } = await import("../src/acp-transport.js");
		const { makeStreamViaKiro } = await import("../src/stream-adapter.js");
		const acp = vi.mocked(makeStreamViaAcp).mock.calls.length;
		const chat = vi.mocked(makeStreamViaKiro).mock.calls.length;
		if (acp > 0 && chat === 0) return "acp";
		if (chat > 0 && acp === 0) return "chat";
		return "none";
	}

	it("uses ACP when PI_KIRO_TRANSPORT is unset", async () => {
		expect(await selectedTransport()).toBe("acp");
	});

	it("uses ACP when it is named explicitly", async () => {
		process.env.PI_KIRO_TRANSPORT = "acp";
		expect(await selectedTransport()).toBe("acp");
	});

	it("falls back to the chat transport only when chat is named", async () => {
		process.env.PI_KIRO_TRANSPORT = "chat";
		expect(await selectedTransport()).toBe("chat");
	});

	it("tolerates surrounding whitespace rather than reading it as a typo", async () => {
		process.env.PI_KIRO_TRANSPORT = "  chat  ";
		expect(await selectedTransport()).toBe("chat");
	});

	// A typo must not silently downgrade the session to the scrape path, which
	// is the whole reason the default moved. Two values, because one would not
	// distinguish "unknown keeps the default" from "anything but chat is ACP":
	// the second is a near-miss of the fallback's own name.
	for (const value of ["sse", "Chat"]) {
		it(`keeps ACP for an unrecognized value (${value})`, async () => {
			process.env.PI_KIRO_TRANSPORT = value;
			expect(await selectedTransport()).toBe("acp");
		});
	}

	it("says so in the identity line: the route slot names the live transport", async () => {
		const { currentIdentityLine } = await import("../src/index.js");
		const piKiro = await loadExtension();
		await piKiro(makeFakePi().pi);
		expect(await currentIdentityLine("claude-sonnet-4.5")).toContain(", acp) on claude-sonnet-4.5");

		process.env.PI_KIRO_TRANSPORT = "chat";
		// The format is part of the route: on the chat path the answer is scraped
		// out of prose below the stream-json floor, and the line has to say which.
		expect(await currentIdentityLine("claude-sonnet-4.5")).toContain(", chat/text) on claude-sonnet-4.5");
	});
});
