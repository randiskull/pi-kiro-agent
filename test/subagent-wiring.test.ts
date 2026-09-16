import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { agentsDir, wireSubagents } from "../src/subagent-wiring.js";

const AGENT_BODY = (front: string) => `---\nname: agent\n${front}---\n\nBody.\n`;

describe("wireSubagents", () => {
	beforeEach(() => {
		mkdirSync(agentsDir(), { recursive: true });
		for (const agent of ["locator", "analyzer", "verifier"]) {
			writeFileSync(`${agentsDir()}/${agent}.md`, AGENT_BODY(""), "utf8");
		}
	});

	it("wires every discovered agent and is idempotent", () => {
		const first = wireSubagents("kiro/auto");
		expect(first.changed.sort()).toEqual(["analyzer", "locator", "verifier"]);
		expect(readFileSync(`${agentsDir()}/locator.md`, "utf8")).toContain("model: kiro/auto");
		expect(wireSubagents("kiro/auto").changed).toHaveLength(0);
	});

	it("restricts to a name list and reports missing agents", () => {
		const result = wireSubagents("kiro/auto", ["locator", "ghost"]);
		expect(result.changed).toEqual(["locator"]);
		expect(result.skipped).toContain("ghost");
		expect(readFileSync(`${agentsDir()}/analyzer.md`, "utf8")).not.toContain("model:");
	});

	it("off removes only kiro model lines", () => {
		writeFileSync(`${agentsDir()}/locator.md`, AGENT_BODY("model: kiro/auto\n"), "utf8");
		writeFileSync(`${agentsDir()}/analyzer.md`, AGENT_BODY("model: other/model\n"), "utf8");
		const result = wireSubagents(undefined);
		expect(result.changed).toEqual(["locator"]);
		expect(readFileSync(`${agentsDir()}/analyzer.md`, "utf8")).toContain("model: other/model");
	});

	it("stashes a displaced non-kiro model and restores it on off", () => {
		writeFileSync(`${agentsDir()}/locator.md`, AGENT_BODY("model: other/model\n"), "utf8");
		expect(wireSubagents("kiro/auto").changed).toContain("locator");
		const wired = readFileSync(`${agentsDir()}/locator.md`, "utf8");
		expect(wired).toContain("model: kiro/auto");
		expect(wired).toContain("pi-kiro-prev-model: other/model");

		expect(wireSubagents(undefined).changed).toContain("locator");
		const restored = readFileSync(`${agentsDir()}/locator.md`, "utf8");
		expect(restored).toContain("model: other/model");
		expect(restored).not.toContain("pi-kiro-prev-model");
		expect(restored).not.toContain("kiro/auto");
	});

	it("off removes the line when on had nothing to displace", () => {
		wireSubagents("kiro/auto", ["locator"]);
		expect(wireSubagents(undefined, ["locator"]).changed).toEqual(["locator"]);
		const restored = readFileSync(`${agentsDir()}/locator.md`, "utf8");
		expect(restored).not.toContain("model:");
		expect(restored).toContain("name: agent");
	});

	it("a second on does not overwrite the stashed original", () => {
		writeFileSync(`${agentsDir()}/locator.md`, AGENT_BODY("model: other/model\n"), "utf8");
		wireSubagents("kiro/auto", ["locator"]);
		wireSubagents("kiro/claude-sonnet-5", ["locator"]);
		const wired = readFileSync(`${agentsDir()}/locator.md`, "utf8");
		expect(wired).toContain("model: kiro/claude-sonnet-5");
		expect(wired).toContain("pi-kiro-prev-model: other/model");

		wireSubagents(undefined, ["locator"]);
		expect(readFileSync(`${agentsDir()}/locator.md`, "utf8")).toContain("model: other/model");
	});

	it("restores a stash that sits above the model line", () => {
		writeFileSync(
			`${agentsDir()}/locator.md`,
			AGENT_BODY("pi-kiro-prev-model: other/model\nmodel: kiro/auto\n"),
			"utf8",
		);
		expect(wireSubagents(undefined, ["locator"]).changed).toEqual(["locator"]);
		const restored = readFileSync(`${agentsDir()}/locator.md`, "utf8");
		expect(restored).toContain("model: other/model");
		expect(restored).not.toContain("pi-kiro-prev-model");
	});

	it("off with a name list leaves other agents wired", () => {
		wireSubagents("kiro/auto");
		const result = wireSubagents(undefined, ["locator"]);
		expect(result.changed).toEqual(["locator"]);
		expect(readFileSync(`${agentsDir()}/analyzer.md`, "utf8")).toContain("model: kiro/auto");
		expect(readFileSync(`${agentsDir()}/locator.md`, "utf8")).not.toContain("model:");
	});

	it("skips files without frontmatter", () => {
		writeFileSync(`${agentsDir()}/locator.md`, "no frontmatter\n", "utf8");
		expect(wireSubagents("kiro/auto").skipped).toContain("locator");
	});
});
