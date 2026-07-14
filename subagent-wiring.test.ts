import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { agentsDir, wireSubagents } from "./subagent-wiring.js";

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

	it("skips files without frontmatter", () => {
		writeFileSync(`${agentsDir()}/locator.md`, "no frontmatter\n", "utf8");
		expect(wireSubagents("kiro/auto").skipped).toContain("locator");
	});
});
