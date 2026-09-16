/**
 * Route pi-subagents agent profiles onto the kiro provider by rewriting the
 * `model:` frontmatter field in ~/.pi/agent/agents/*.md. Generic: wires every
 * discovered agent file (or an explicit name list) — no assumptions about
 * which agent pack (rpiv, custom, …) is installed. `off` only acts on a model
 * line that points at kiro, so other providers' routing is never touched.
 *
 * `on` never destroys a pre-existing value: if the agent already named a
 * non-kiro model, that value is stashed in a `pi-kiro-prev-model:` field and
 * `off` puts it back. Only when there was no model line to begin with does
 * `off` remove the line outright, which is the correct restore in that case.
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

/** Frontmatter field holding the value `on` displaced, so `off` can restore it. */
const PREV_MODEL_KEY = "pi-kiro-prev-model";

function fieldValue(line: string): string {
	return line.slice(line.indexOf(":") + 1).trim();
}

function rewriteFrontmatterModel(source: string, model: string | undefined): string | undefined {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return undefined;
	const lines = match[1].split(/\r?\n/);
	const modelLineIndex = lines.findIndex((line) => /^model\s*:/.test(line));
	const prevLineIndex = lines.findIndex((line) =>
		new RegExp(`^${PREV_MODEL_KEY}\\s*:`).test(line),
	);

	if (model === undefined) {
		if (modelLineIndex === -1 || !lines[modelLineIndex].includes(`${KIRO_PROVIDER}/`)) {
			return undefined;
		}
		if (prevLineIndex === -1) {
			lines.splice(modelLineIndex, 1);
		} else {
			// Restore what `on` displaced. Assign before splicing so the stash
			// index stays valid even when it sits above the model line.
			lines[modelLineIndex] = `model: ${fieldValue(lines[prevLineIndex])}`;
			lines.splice(prevLineIndex, 1);
		}
	} else {
		const newLine = `model: ${model}`;
		if (modelLineIndex === -1) {
			lines.push(newLine);
		} else if (lines[modelLineIndex].trim() === newLine) {
			return undefined;
		} else {
			const displaced = lines[modelLineIndex];
			lines[modelLineIndex] = newLine;
			// Stash a non-kiro value once: a second `on` must not overwrite the
			// original with an intermediate kiro model.
			if (prevLineIndex === -1 && !displaced.includes(`${KIRO_PROVIDER}/`)) {
				lines.splice(modelLineIndex + 1, 0, `${PREV_MODEL_KEY}: ${fieldValue(displaced)}`);
			}
		}
	}
	return source.replace(match[0], `---\n${lines.join("\n")}\n---`);
}

/**
 * Point agents at `model` (e.g. "kiro/auto"), or undo kiro routing when `model`
 * is undefined — restoring a stashed previous model where there is one. `only`
 * restricts to the named agents; otherwise every *.md in the agents dir is a
 * candidate.
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
