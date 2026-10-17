#!/usr/bin/env node
/**
 * Deterministic half of the spec-review rubric (spec-review/rubric.md). Runs
 * before any reviewer sees a spec, and never judges substance: it checks only
 * what a script can check without being wrong.
 *
 *   node scripts/spec-lint.mjs [--json] [--ref <commit>] [--alias <cited>=<file>]... <spec.md>...
 *
 * Checks, by the rubric id they feed:
 *   structure    header bullets and required sections are present
 *   type         defect specs have Observed failure + Root cause; feature specs have Problem
 *   attribution  ## Attribution names the authoring harness and model ("Spec: <harness>, <model>")
 *   G2           citations resolve: repo paths, commits, § refs, npm scripts, and
 *                probable typos of repo symbols and paths
 *   G3           Verification plan has a "**Negative control" bullet (presence only;
 *                whether it is a real negative control is the reviewer's call)
 *
 * Citations resolve against <ref> (default HEAD), so a spec is linted against the
 * tree it will merge with, and the calibration set against the commit it was
 * labelled on. A citation of another spec (docs/specs/<name>.md) resolves through
 * --alias first, then the working tree, so a spec set that is added together can
 * cite itself.
 *
 * What it deliberately does NOT fail on, and lists instead for the reviewer:
 *   - an identifier that is not in src/, test/ or scripts/ and is not a near miss
 *     of one (a symbol the spec proposes, or one from an external codebase);
 *   - a path outside the repo (home-relative, absolute, or under a top-level
 *     directory the repo does not have), and a gitignored local path;
 *   - placeholders (`<id>`, `...`, `*`);
 *   - a path immediately followed by `(new)`, which the spec says it creates;
 *   - a commit in another repository, written `<owner>/<repo>@<sha>`.
 * Near misses: a symbol fails when it differs from a real identifier only in case,
 * or (8+ characters) by one edit. A digits-only commit is checked only in backticks.
 * A wholly invented symbol with no near miss therefore passes this script. The
 * reviewer's half of G2 exists for exactly that.
 *
 * Exit: 0 every check passed, 1 a check failed, 2 the run could not verify
 * (unknown ref, or commit citations in a shallow clone).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SYMBOL_SCOPE = ["src", "test", "scripts"];

function git(args, { allowFail = false } = {}) {
	const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) {
		if (allowFail) return null;
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

class Unverifiable extends Error {}

/** Lines outside fenced code blocks, with their 1-based line numbers. */
function proseLines(text) {
	const lines = text.split("\n");
	const out = [];
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*```/.test(lines[i])) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) out.push({ n: i + 1, text: lines[i] });
	}
	return out;
}

/** Splits prose into the H1, header bullets, and `## ` sections (with `### ` subsection titles). */
export function parseSpec(text) {
	const prose = proseLines(text);
	const title = prose.find((l) => /^# /.test(l.text))?.text.slice(2).trim() ?? null;
	const header = {};
	const sections = [];
	let current = null;
	let lastKey = null;
	for (const line of prose) {
		const h2 = /^## (.+)$/.exec(line.text);
		if (h2) {
			current = { title: h2[1].trim(), line: line.n, body: [], subsections: [] };
			sections.push(current);
			continue;
		}
		if (!current) {
			const bullet = /^- ([A-Z][\w ]*?):\s*(.*)$/.exec(line.text);
			if (bullet) {
				lastKey = bullet[1];
				header[lastKey] = bullet[2];
			} else if (lastKey && /^\s+\S/.test(line.text)) {
				header[lastKey] += ` ${line.text.trim()}`;
			}
			continue;
		}
		const h3 = /^### (.+)$/.exec(line.text);
		if (h3) current.subsections.push(h3[1].trim());
		current.body.push(line.text);
	}
	return { title, header, sections, prose };
}

const section = (spec, prefix) =>
	spec.sections.find((s) => s.title.toLowerCase().startsWith(prefix.toLowerCase())) ?? null;

const REQUIRED_HEADER = ["Status", "Area", "Related"];
const REQUIRED_SECTIONS = ["Goal", "Scope", "Approach", "Acceptance criteria", "Verification plan", "Risks", "Attribution"];

function checkStructure(spec) {
	const findings = [];
	if (!spec.title) findings.push("no `# ` title line");
	for (const key of REQUIRED_HEADER) if (!(key in spec.header)) findings.push(`header bullet \`- ${key}:\` is missing`);
	if (!Object.keys(spec.header).some((k) => k.startsWith("Target"))) findings.push("header bullet `- Target ...:` is missing");
	for (const name of REQUIRED_SECTIONS) if (!section(spec, name)) findings.push(`section \`## ${name}\` is missing`);
	const scope = section(spec, "Scope");
	if (scope) {
		for (const sub of ["In scope", "Out of scope"]) {
			if (!scope.subsections.some((s) => s.toLowerCase().startsWith(sub.toLowerCase()))) {
				findings.push(`\`## Scope\` has no \`### ${sub}\``);
			}
		}
	}
	return findings;
}

/** "defect" | "feature" | null. A spec with an Observed failure is a defect spec. */
export function specType(spec) {
	if (section(spec, "Observed failure")) return "defect";
	if (section(spec, "Problem")) return "feature";
	return null;
}

function checkType(spec) {
	const type = specType(spec);
	if (type === null) return ["neither `## Observed failure` (defect) nor `## Problem` (feature) is present"];
	if (type === "defect" && !section(spec, "Root cause")) return ["a defect spec needs `## Root cause`"];
	return [];
}

function checkAttribution(spec) {
	const attribution = section(spec, "Attribution");
	if (!attribution) return []; // reported by structure
	return /\bspec:\s*[^,\n]+,\s*\S/i.test(attribution.body.join("\n"))
		? []
		: ["`## Attribution` does not name the authoring harness and model as `Spec: <harness>, <model>`"];
}

function checkNegativeControl(spec) {
	const plan = section(spec, "Verification plan");
	if (!plan) return []; // reported by structure
	return plan.body.some((line) => /^\s*- \*\*Negative control/i.test(line))
		? []
		: ["`## Verification plan` has no `- **Negative control` bullet"];
}

function levenshtein(a, b) {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const next = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = next;
		}
	}
	return row[b.length];
}

/** Everything the citation check needs to know about the tree at `ref`, loaded once. */
function loadTree(ref) {
	if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }) === null) {
		throw new Unverifiable(`ref ${ref} does not resolve to a commit`);
	}
	const files = git(["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean);
	const fileSet = new Set(files);
	const dirSet = new Set();
	for (const f of files) {
		const parts = f.split("/");
		for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
	}
	const top = new Set(files.map((f) => f.split("/")[0]));
	const basenames = new Map();
	for (const f of files) {
		const base = f.split("/").pop();
		basenames.set(base, [...(basenames.get(base) ?? []), f]);
	}
	const shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
	const pkg = fileSet.has("package.json") ? JSON.parse(git(["show", `${ref}:package.json`])) : {};
	const designHeadings = files
		.filter((f) => /^docs\/design\/.+\.md$/.test(f))
		.flatMap((f) => git(["show", `${ref}:${f}`]).split("\n").filter((l) => /^#{1,6} /.test(l)));
	let identifiers = null; // loaded on first need: most specs never miss a symbol
	const loadIdentifiers = () => {
		identifiers ??= new Set(
			(git(["grep", "-h", "-o", "-I", "-E", "[_A-Za-z][_A-Za-z0-9]{6,}", ref, "--", ...SYMBOL_SCOPE], { allowFail: true }) ?? "")
				.split("\n")
				.filter(Boolean)
				.map((l) => l.slice(l.lastIndexOf(":") + 1)),
		);
		return identifiers;
	};
	return { ref, fileSet, dirSet, top, basenames, shallow, scripts: pkg.scripts ?? {}, designHeadings, identifiers: loadIdentifiers };
}

const PATH_EXT = /\.(ts|mjs|js|cjs|json|md|ya?ml|sh|jsonl|txt)$/;

/** Classifies one inline-code token. Returns null when it is not a citation at all. */
export function classifyToken(token) {
	const t = token.trim();
	if (!t) return null;
	const npm = /^npm (?:run )?([\w:-]+)$/.exec(t);
	if (npm) return { kind: "npm", name: npm[1] === "test" ? "test" : npm[1] };
	if (/\s/.test(t)) return null; // commands, code fragments, prose
	if (/[<>*]|\.\.\./.test(t)) return t.includes("/") || PATH_EXT.test(t) ? { kind: "placeholder", value: t } : null;
	const call = /^(_?[A-Za-z]\w*)\(.*\)$/.exec(t);
	if (call && !t.includes(".")) return { kind: "symbol", name: call[1] };
	if (/^_?[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+$/.test(t)) return { kind: "symbol", name: t };
	if (/^\/[\w-]+$/.test(t)) return null; // a slash command (`/kiro`), not a path
	if (t.includes("/") || PATH_EXT.test(t)) {
		const path = t.replace(/:\d+(?::\d+)?$/, "").replace(/\/$/, "");
		if (t.startsWith("~") || t.startsWith("/")) return { kind: "external", value: t };
		if (!path.includes("/") && !PATH_EXT.test(path)) return null;
		return { kind: "path", value: path, raw: t };
	}
	return null;
}

const COMMIT = /(?<![\w./-])([0-9a-f]{7,40})(?![\w/-])/g;
const SECTION_REF = /§\s?(\d+[a-z]?(?:\.\d+)*)/g;

function checkCitations(spec, tree, aliases) {
	const failures = [];
	const notes = { external: [], local: [], proposed: [], unresolvedSymbols: [], placeholders: [] };
	const seen = new Set();
	const note = (list, value) => {
		if (!notes[list].includes(value)) notes[list].push(value);
	};
	for (const line of spec.prose) {
		for (const match of line.text.matchAll(/`([^`]+)`/g)) {
			const token = match[1];
			if (seen.has(token)) continue;
			seen.add(token);
			const c = classifyToken(token);
			if (!c) continue;
			const at = `line ${line.n}`;
			if (c.kind === "npm") {
				if (!(c.name in tree.scripts)) failures.push(`${at}: \`${token}\` names no package.json script "${c.name}"`);
			} else if (c.kind === "placeholder") {
				note("placeholders", c.value);
			} else if (c.kind === "external") {
				note("external", c.value);
			} else if (c.kind === "symbol") {
				resolveSymbol(c.name, token, at, tree, failures, notes);
			} else if (c.kind === "path") {
				// `path` (new) declares a file the spec creates. Per token, so it can
				// never excuse a different citation on the same line.
				const rest = line.text.slice(match.index + match[0].length);
				if (/^\s*\(new\)/.test(rest)) note("proposed", c.value);
				else resolvePath(c.value, token, at, tree, aliases, failures, note);
			}
		}
		for (const m of line.text.matchAll(COMMIT)) {
			const sha = m[1];
			// A digits-only run is usually a number (a date, a port, a count), so it
			// is a commit only when it is written as code. A hex run needs a letter.
			const ticked = line.text[m.index - 1] === "`" && line.text[m.index + sha.length] === "`";
			if (!/\d/.test(sha) || (!/[a-f]/.test(sha) && !ticked) || seen.has(`sha:${sha}`)) continue;
			seen.add(`sha:${sha}`);
			// `<owner>/<repo>@<sha>` cites another repository's history, which this
			// clone cannot check: listed for the reviewer, never failed.
			if (line.text[m.index - 1] === "@") {
				const repo = /([\w.-]+\/[\w.-]+)@$/.exec(line.text.slice(0, m.index));
				note("external", `${repo ? repo[1] : "?"}@${sha}`);
				continue;
			}
			if (git(["cat-file", "-e", `${sha}^{commit}`], { allowFail: true }) !== null) continue;
			if (tree.shallow) throw new Unverifiable(`commit ${sha} is not present and the clone is shallow; fetch full history`);
			failures.push(`line ${line.n}: commit ${sha} does not exist`);
		}
		for (const m of line.text.matchAll(SECTION_REF)) {
			const id = m[1].replace(/\.$/, "");
			if (seen.has(`sec:${id}`)) continue;
			seen.add(`sec:${id}`);
			const heading = new RegExp(`^#{1,6} ${id.replace(/\./g, "\\.")}(?:[.\\s]|$)`);
			if (!tree.designHeadings.some((h) => heading.test(h))) {
				failures.push(`line ${line.n}: §${id} matches no heading in docs/design/*.md`);
			}
		}
	}
	return { failures, notes };
}

function resolveSymbol(name, token, at, tree, failures, notes) {
	const exact = git(["grep", "-q", "-w", "-e", name, tree.ref, "--", ...SYMBOL_SCOPE], { allowFail: true });
	if (exact !== null) return;
	const near = git(["grep", "-h", "-o", "-i", "-w", "-e", name, tree.ref, "--", ...SYMBOL_SCOPE], { allowFail: true });
	const variants = [...new Set((near ?? "").split("\n").filter(Boolean).map((l) => l.slice(l.lastIndexOf(":") + 1)))];
	// One edit away (a dropped, doubled, swapped-in or wrong letter) from a real
	// identifier of 8 or more characters. Shorter names are too dense for one edit
	// to mean a typo, and a NEW name one edit from an existing one is confusing
	// enough to deserve the failure.
	if (variants.length === 0 && name.length >= 8) {
		variants.push(...[...tree.identifiers()].filter((id) => Math.abs(id.length - name.length) <= 1 && levenshtein(id, name) === 1));
	}
	if (variants.length > 0) {
		failures.push(`${at}: \`${token}\` is not in ${SYMBOL_SCOPE.join("/")}; probable typo of ${variants.map((v) => `\`${v}\``).join(", ")}`);
	} else if (!notes.unresolvedSymbols.includes(name)) {
		notes.unresolvedSymbols.push(name);
	}
}

function resolvePath(path, token, at, tree, aliases, failures, note) {
	if (aliases.has(path)) {
		if (!existsSync(aliases.get(path))) failures.push(`${at}: \`${token}\` aliases to ${aliases.get(path)}, which does not exist`);
		return;
	}
	if (tree.fileSet.has(path) || tree.dirSet.has(path)) return;
	if (/^docs\/specs\/[^/]+\.md$/.test(path) && existsSync(path)) return; // a sibling in the same change
	// Before the top-level check: a gitignored file under a tracked directory (a
	// local log, a tfvars) is provenance on the author's machine, not a broken path.
	if (git(["check-ignore", "--no-index", "-q", path], { allowFail: true }) !== null) {
		note("local", path);
		return;
	}
	const first = path.split("/")[0];
	if (path.includes("/") && tree.top.has(first)) {
		failures.push(`${at}: \`${token}\` does not exist at ${tree.ref}`);
		return;
	}
	const base = path.split("/").pop();
	if (!path.includes("/")) {
		const aliased = [...aliases.keys()].some((k) => k.split("/").pop() === base);
		if (aliased || tree.basenames.has(base) || existsSync(`docs/specs/${base}`)) return;
		note("external", path);
		return;
	}
	const typo = [...tree.top].find((t) => t !== first && levenshtein(t, first) <= 2);
	if (typo && (tree.basenames.get(base) ?? []).some((f) => f.startsWith(`${typo}/`))) {
		failures.push(`${at}: \`${token}\` does not exist; probable typo of \`${typo}/\` (${tree.basenames.get(base).find((f) => f.startsWith(`${typo}/`))})`);
		return;
	}
	note("external", path);
}

export function lintSpec(file, { ref = "HEAD", aliases = new Map(), tree } = {}) {
	const spec = parseSpec(readFileSync(file, "utf8"));
	const t = tree ?? loadTree(ref);
	const { failures, notes } = checkCitations(spec, t, aliases);
	const checks = [
		{ id: "structure", findings: checkStructure(spec) },
		{ id: "type", findings: checkType(spec) },
		{ id: "attribution", findings: checkAttribution(spec) },
		{ id: "G2", findings: failures },
		{ id: "G3", findings: checkNegativeControl(spec) },
	].map((c) => ({ ...c, pass: c.findings.length === 0 }));
	return { spec: file, type: specType(spec), pass: checks.every((c) => c.pass), checks, notes };
}

function main(argv) {
	const files = [];
	const aliases = new Map();
	let ref = "HEAD";
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--ref") ref = argv[++i];
		else if (arg === "--alias") {
			const [cited, actual] = (argv[++i] ?? "").split("=");
			if (!cited || !actual) throw new Unverifiable("--alias wants <cited-path>=<file>");
			aliases.set(cited, actual);
		} else files.push(arg);
	}
	if (files.length === 0) throw new Unverifiable("usage: spec-lint.mjs [--json] [--ref <commit>] [--alias <cited>=<file>]... <spec.md>...");
	const tree = loadTree(ref);
	const results = files.map((file) => lintSpec(file, { ref, aliases, tree }));
	if (json) {
		process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
	} else {
		for (const r of results) {
			console.log(`${r.pass ? "PASS" : "FAIL"} ${r.spec} (${r.type ?? "untyped"} spec, ref ${ref})`);
			for (const c of r.checks) for (const f of c.findings) console.log(`  [${c.id}] ${f}`);
			for (const [list, values] of Object.entries(r.notes)) {
				if (values.length) console.log(`  note ${list}: ${values.join(", ")}`);
			}
		}
	}
	return results.every((r) => r.pass) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(`spec-lint: ${error.message}`);
		process.exitCode = error instanceof Unverifiable ? 2 : 1;
	}
}
