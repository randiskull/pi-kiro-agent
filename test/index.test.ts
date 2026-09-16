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
vi.mock("../src/kiro-bridge.js", () => ({ bridgeEnabled: () => false }));
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
		emit: async (name: string, event: unknown = {}) => {
			for (const fn of handlers.get(name) ?? []) fn(event);
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
});
