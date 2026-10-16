import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { BRIDGE_SOURCES, captureSourceTools, DEFAULT_BRIDGE_TOOLS } from "../src/bridge.js";
import { bridgedToolName, bridgePrefixFor, displayToolName } from "../src/tool-names.js";

describe("bridgePrefixFor / bridgedToolName", () => {
	it("prefixes every rpiv package rpiv_ and pi-subagents subagents_", () => {
		expect(BRIDGE_SOURCES.map(bridgePrefixFor)).toEqual(["rpiv_", "rpiv_", "rpiv_", "subagents_"]);
	});

	it("derives other packages from the unscoped name minus pi-, sanitized", () => {
		expect(bridgePrefixFor("pi-chassis")).toBe("chassis_");
		expect(bridgePrefixFor("@acme/Pi-Tools.Extra")).toBe("pi_tools_extra_");
		expect(bridgePrefixFor("@acme/pi-web.tools")).toBe("web_tools_");
	});

	it("keeps the tool's own case and never double-prefixes", () => {
		expect(bridgedToolName("@tintinweb/pi-subagents", "Agent")).toBe("subagents_Agent");
		expect(bridgedToolName("@juicesharp/rpiv-todo", "todo")).toBe("rpiv_todo");
		expect(bridgedToolName("@juicesharp/rpiv-todo", "rpiv_todo")).toBe("rpiv_todo");
	});

	it("the default allowlist is the prefixed form of the six default tools", () => {
		expect(DEFAULT_BRIDGE_TOOLS).toEqual([
			"rpiv_ask_user_question",
			"rpiv_todo",
			"rpiv_advisor",
			"subagents_Agent",
			"subagents_get_subagent_result",
			"subagents_steer_subagent",
		]);
	});
});

describe("displayToolName", () => {
	it("prefixes kiro built-ins (no server) kiro_", () => {
		expect(displayToolName("read", undefined)).toBe("kiro_read");
		expect(displayToolName("shell", "")).toBe("kiro_shell");
	});

	it("leaves bridged names as exposed, since the bridge already prefixed them", () => {
		expect(displayToolName("rpiv_todo", "pi")).toBe("rpiv_todo");
	});

	it("prefixes the gsd workflow server gsd_, without doubling", () => {
		expect(displayToolName("doctor", "gsdworkflow")).toBe("gsd_doctor");
		expect(displayToolName("gsd_doctor", "gsdworkflow")).toBe("gsd_doctor");
	});

	it("prefixes any other server with its sanitized name", () => {
		expect(displayToolName("x", "other")).toBe("other_x");
		expect(displayToolName("query", "My-DB")).toBe("my_db_query");
		expect(displayToolName("kiro_read", undefined)).toBe("kiro_read");
	});
});

describe("captureSourceTools", () => {
	const realPi = {} as ExtensionAPI;
	const registering =
		(...names: string[]) =>
		({
			default: (pi: ExtensionAPI) => {
				for (const name of names) {
					pi.registerTool({ name, description: name, parameters: {}, execute: async () => ({ content: [] }) } as never);
				}
			},
		}) as never;

	it("attributes each tool to the source that registered it, even when two sources run in one capture", async () => {
		const rpiv = await captureSourceTools(realPi, "@juicesharp/rpiv-todo", [registering("todo")]);
		const subagents = await captureSourceTools(realPi, "@tintinweb/pi-subagents", [registering("Agent", "get_subagent_result")]);
		expect(rpiv.map((tool) => [tool.name, tool.source, tool.originalName])).toEqual([
			["rpiv_todo", "@juicesharp/rpiv-todo", "todo"],
		]);
		expect(subagents.map((tool) => [tool.name, tool.source, tool.originalName])).toEqual([
			["subagents_Agent", "@tintinweb/pi-subagents", "Agent"],
			["subagents_get_subagent_result", "@tintinweb/pi-subagents", "get_subagent_result"],
		]);
	});

	it("a module that throws still lets the source's other modules register", async () => {
		const broken = {
			default: () => {
				throw new Error("boom");
			},
		} as never;
		const tools = await captureSourceTools(realPi, "@juicesharp/rpiv-advisor", [broken, registering("advisor")]);
		expect(tools.map((tool) => tool.name)).toEqual(["rpiv_advisor"]);
	});
});
