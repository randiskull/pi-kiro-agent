/**
 * Live command coverage: /kiro and /kiro-subagents driven through the handlers
 * the extension really registers, with nothing mocked. Skipped unless
 * PI_KIRO_LIVE=1 -- readiness spawns the real kiro-cli.
 *
 *   PI_KIRO_LIVE=1 npx vitest run command-coverage-live.test.ts
 *
 * test/index.test.ts covers the registration lifecycle but mocks readiness,
 * models, wiring and the transports, so it can never catch a real kiro-cli that
 * changed its --version, whoami or --list-models output. Nothing here makes a
 * model call: readiness and model discovery are CLI probes, so this file is
 * live but free.
 *
 * /kiro-subagents runs against a SEEDED THROWAWAY HOME, never the developer's.
 * That is not tidiness. "off" is global and it DELETES the model line rather
 * than restoring what was there before, so running it against a real ~/.pi
 * strips kiro routing from every agent at once with nothing to revert to (on
 * this machine: 15 agents on kiro/claude-sonnet-5). The last test in this file
 * asserts the real agents dir was not touched.
 *
 * That throwaway HOME is also where a real kiro-cli gets spawned, because
 * registering the extension probes the model list (src/models.ts). kiro-cli keeps
 * its seat under $HOME in two stores -- the login keychain's kirocli:odic:* items
 * and Library/Application Support/kiro-cli/data.sqlite3 -- so an unseeded fake
 * HOME made it mint a NEW Identity Center device registration on every live run,
 * fail to persist it (a fake HOME has no login keychain for /usr/bin/security to
 * open), and open a browser to authenticate the new one. Every assertion in this
 * file passed anyway, which is why it went unnoticed until pid ancestry caught it
 * on 2026-09-15. Both stores are symlinked in now: only .pi/agent/agents ever
 * needed isolating here, never the seat. The last test asserts the registration
 * was not recreated, so this cannot go quiet again.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import piKiro from "../src/index.js";
import { LIVE, liveTempDir, withRealHome } from "./live-support.js";

interface Notice {
	message: string;
	level: string;
}
interface CommandDef {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function makeHost() {
	const commands = new Map<string, CommandDef>();
	const providers: Array<{ name: string; config: ProviderConfig }> = [];
	const notices: Notice[] = [];
	const pi = {
		on: () => undefined,
		registerTool: () => undefined,
		registerCommand: (name: string, def: CommandDef) => {
			commands.set(name, def);
		},
		registerProvider: (name: string, config: ProviderConfig) => {
			providers.push({ name, config });
		},
		unregisterProvider: () => undefined,
		setActiveTools: () => undefined,
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, level: string) => {
				notices.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, commands, providers, notices };
}

const AGENT = (front: string) => "---\nname: live-fixture\n" + front + "---\n\nFixture body.\n";

describe.skipIf(!LIVE)("live /kiro command", () => {
	withRealHome();

	it("registers the provider off a real kiro-cli probe and reports it", async () => {
		const host = makeHost();
		await piKiro(host.pi);
		const kiro = host.commands.get("kiro");
		expect(kiro, "extension registered no /kiro command").toBeDefined();
		expect(kiro?.description).toContain("Kiro");
		if (!kiro) return;

		await kiro.handler("", host.ctx);

		const last = host.notices.at(-1);
		expect(last?.level, "readiness failed: " + last?.message).toBe("info");
		expect(last?.message).toContain("kiro provider registered");
		// Proves the summary came from a real binary, not a fallback string.
		expect(last?.message).toMatch(/kiro-cli \d+\.\d+\.\d+/);

		const registration = host.providers.at(-1);
		expect(registration?.name).toBe("kiro");
		const config = registration?.config as (ProviderConfig & { authMode?: string }) | undefined;
		// GSD gates flat-rate routing and its external-CLI transport on exactly
		// these two fields; losing either makes a seat-billed CLI look metered.
		expect(config?.authMode).toBe("externalCli");
		expect(config?.baseUrl).toBe("local://kiro-cli");
		expect(typeof config?.streamSimple).toBe("function");
		// Models came from a real "chat --list-models" call.
		expect(Array.isArray(config?.models)).toBe(true);
		expect((config?.models ?? []).length).toBeGreaterThan(0);
		for (const model of config?.models ?? []) expect(typeof model.id).toBe("string");
	}, 120_000);

	it("PI_KIRO_TRANSPORT=acp swaps in the ACP transport", async () => {
		const before = process.env.PI_KIRO_TRANSPORT;
		try {
			process.env.PI_KIRO_TRANSPORT = "acp";
			const acpHost = makeHost();
			await piKiro(acpHost.pi);
			const acpConfig = acpHost.providers.at(-1)?.config as ProviderConfig | undefined;
			expect((acpConfig?.streamSimple as { name?: string } | undefined)?.name).toBe("streamViaAcp");

			delete process.env.PI_KIRO_TRANSPORT;
			const chatHost = makeHost();
			await piKiro(chatHost.pi);
			const chatConfig = chatHost.providers.at(-1)?.config as ProviderConfig | undefined;
			expect((chatConfig?.streamSimple as { name?: string } | undefined)?.name).toBe("streamViaKiro");
		} finally {
			if (before === undefined) delete process.env.PI_KIRO_TRANSPORT;
			else process.env.PI_KIRO_TRANSPORT = before;
		}
	}, 120_000);
});

describe.skipIf(!LIVE)("live /kiro-subagents command", () => {
	const realAgents = join(userInfo().homedir, ".pi", "agent", "agents");
	let realBefore: string[] = [];
	let tempHome = "";
	let agentsPath = "";
	let targetSeed = "";
	let registrationBefore = "";
	const redirected = { home: process.env.HOME, userProfile: process.env.USERPROFILE };

	/**
	 * kiro-cli's seat lives under $HOME, and the model probe spawns a real kiro-cli
	 * that inherits the seeded HOME. Without these two symlinks it sees itself as
	 * logged out and re-registers the device with Identity Center. The globalSetup
	 * teardown's rmSync unlinks symlinks rather than deleting through them
	 * (verified against a sacrificial directory), so the real stores are safe.
	 */
	function seedSeat(home: string): void {
		const real = userInfo().homedir;
		const support = join(real, "Library", "Application Support", "kiro-cli");
		if (existsSync(support)) {
			mkdirSync(join(home, "Library", "Application Support"), { recursive: true });
			symlinkSync(support, join(home, "Library", "Application Support", "kiro-cli"));
		}
		const keychains = join(real, "Library", "Keychains");
		if (existsSync(keychains)) {
			mkdirSync(join(home, "Library"), { recursive: true });
			symlinkSync(keychains, join(home, "Library", "Keychains"));
		}
	}

	/**
	 * Creation date of the kiro device-registration keychain item. Read without -w
	 * and without -g so no secret is ever fetched, and with the real HOME pinned:
	 * test-setup.ts has already redirected $HOME by the time this runs, which would
	 * hide the login keychain from /usr/bin/security and turn every read into a
	 * false "absent".
	 */
	function registrationCdat(): string {
		if (process.platform !== "darwin") return "";
		try {
			const out = execFileSync("/usr/bin/security", ["find-generic-password", "-s", "kirocli:odic:device-registration"], {
				encoding: "utf8",
				env: { ...process.env, HOME: userInfo().homedir },
				stdio: ["ignore", "pipe", "ignore"],
			});
			return /"cdat"<timedate>=\S+\s+"([^"]+)"/.exec(out)?.[1] ?? "";
		} catch {
			return "";
		}
	}

	function snapshotReal(): string[] {
		if (!existsSync(realAgents)) return [];
		return readdirSync(realAgents)
			.filter((file) => file.endsWith(".md"))
			.sort()
			.map((file) => {
				const stat = statSync(join(realAgents, file));
				return file + ":" + stat.size + ":" + stat.mtimeMs;
			});
	}

	beforeAll(() => {
		realBefore = snapshotReal();
		registrationBefore = registrationCdat();
		tempHome = liveTempDir("pi-kiro-cmdhome-");
		agentsPath = join(tempHome, ".pi", "agent", "agents");
		mkdirSync(agentsPath, { recursive: true });
		seedSeat(tempHome);
		targetSeed = AGENT("");
		writeFileSync(join(agentsPath, "live-target.md"), targetSeed, "utf8");
		writeFileSync(join(agentsPath, "live-bystander.md"), AGENT("model: other/model\n"), "utf8");
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterAll(() => {
		process.env.HOME = redirected.home;
		process.env.USERPROFILE = redirected.userProfile;
	});

	it("on then off round-trips the frontmatter and spares other providers", async () => {
		const host = makeHost();
		await piKiro(host.pi);
		const command = host.commands.get("kiro-subagents");
		expect(command, "extension registered no /kiro-subagents command").toBeDefined();
		if (!command) return;

		expect(command.getArgumentCompletions?.("o")?.map((item) => item.value)).toContain("off");

		const target = join(agentsPath, "live-target.md");
		const bystander = join(agentsPath, "live-bystander.md");

		await command.handler("on kiro/auto live-target", host.ctx);
		expect(host.notices.at(-1)?.level, host.notices.at(-1)?.message).toBe("info");
		expect(host.notices.at(-1)?.message).toContain("1 agent(s) now use kiro/auto");
		expect(readFileSync(target, "utf8")).toContain("model: kiro/auto");
		// Name-restricted: the bystander must not even be considered.
		expect(readFileSync(bystander, "utf8")).toContain("model: other/model");

		await command.handler("off", host.ctx);
		expect(host.notices.at(-1)?.message).toContain("Removed kiro routing from 1 agent(s)");
		// Byte-identical to the seed: off is a true inverse here, which is only
		// true because the seed had no model line to begin with.
		expect(readFileSync(target, "utf8")).toBe(targetSeed);
		expect(readFileSync(bystander, "utf8")).toContain("model: other/model");

		await command.handler("sideways", host.ctx);
		expect(host.notices.at(-1)?.level).toBe("error");
		await command.handler("on openai/gpt-4o", host.ctx);
		expect(host.notices.at(-1)?.level).toBe("error");
	}, 120_000);

	it("did not mint a new kiro device registration", () => {
		// An unseeded fake HOME makes kiro-cli register a new device with Identity
		// Center and hand the fresh client_secret to /usr/bin/security on the command
		// line, where any process can read it. No other assertion in this file fails
		// when that happens, so this is the only guard on it.
		expect(registrationBefore.length, "no device registration to compare against; guard is vacuous").toBeGreaterThan(0);
		expect(registrationCdat(), "kiro re-registered under the seeded HOME: the seat symlinks are not working").toBe(
			registrationBefore,
		);
	});

	it("never touched the developer's real agents dir", () => {
		expect(snapshotReal()).toEqual(realBefore);
		// And the real dir is genuinely there to be damaged, so the guard is not vacuous.
		expect(realBefore.length, "no real agents dir found; guard is vacuous").toBeGreaterThan(0);
	});
});
