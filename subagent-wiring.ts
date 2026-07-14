/**
 * Route pi-subagents agent profiles onto the kiro provider by rewriting the
 * `model:` frontmatter field in ~/.pi/agent/agents/*.md. Generic: wires every
 * discovered agent file (or an explicit name list) — no assumptions about
 * which agent pack (rpiv, custom, …) is installed. `off` removes the model
 * line only when it points at kiro, so other providers' routing is never
 * touched.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KIRO_PROVIDER } from "./models.js";

export function agentsDir(): string {
	return join(homedir(), ".pi", "agent", "agents");
}

interface RewriteResult {
	changed: string[];
	skipped: string[];
}

function rewriteFrontmatterModel(source: string, model: string | undefined): string | undefined {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return undefined;
	const lines = match[1].split(/\r?\n/);
	const modelLineIndex = lines.findIndex((line) => /^model\s*:/.test(line));

	if (model === undefined) {
		if (modelLineIndex === -1 || !lines[modelLineIndex].includes(`${KIRO_PROVIDER}/`)) {
			return undefined;
		}
		lines.splice(modelLineIndex, 1);
	} else {
		const newLine = `model: ${model}`;
		if (modelLineIndex === -1) {
			lines.push(newLine);
		} else if (lines[modelLineIndex].trim() === newLine) {
			return undefined;
		} else {
			lines[modelLineIndex] = newLine;
		}
	}
	return source.replace(match[0], `---\n${lines.join("\n")}\n---`);
}

/**
 * Point agents at `model` (e.g. "kiro/auto"), or remove kiro routing when
 * `model` is undefined. `only` restricts to the named agents; otherwise every
 * *.md in the agents dir is a candidate.
 */
export function wireSubagents(model: string | undefined, only?: string[]): RewriteResult {
	const dir = agentsDir();
	const changed: string[] = [];
	const skipped: string[] = [];
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".md"));
	} catch {
		return { changed, skipped: only ?? [] };
	}
	const wanted = only?.map((name) => (name.endsWith(".md") ? name : `${name}.md`));
	for (const file of wanted ?? files) {
		const agent = file.replace(/\.md$/, "");
		if (!files.includes(file)) {
			skipped.push(agent);
			continue;
		}
		const path = join(dir, file);
		const rewritten = rewriteFrontmatterModel(readFileSync(path, "utf8"), model);
		if (rewritten === undefined) {
			skipped.push(agent);
			continue;
		}
		writeFileSync(path, rewritten, "utf8");
		changed.push(agent);
	}
	return { changed, skipped };
}
