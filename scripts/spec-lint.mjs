#!/usr/bin/env node
/**
 * Deterministic half of the spec-review rubric (spec-review/rubric.md). Runs
 * before any reviewer sees a spec, and never judges substance: it checks only
 * what a script can check without being wrong.
 *
 *   node scripts/spec-lint.mjs [--json] [--ref <commit>] [--alias <cited>=<file>]... <spec.md>...
 *
 * Checks, by the rubric id they feed:
 *   structure    header bullets (with values) and required sections are present,
 *                each required section once
 *   type         defect specs have Observed failure + Root cause; feature specs have Problem
 *   attribution  ## Attribution names the authoring harness and model ("Spec: <harness>, <model>")
 *   G2           citations resolve: repo paths, commits, § refs, npm scripts, and
 *                probable typos of repo symbols and paths
 *   G3           Verification plan has a "**Negative control" bullet with content
 *                (presence only; whether it is a real negative control is the
 *                reviewer's call)
 *
 * The spec is read as CommonMark is, as far as these checks care: fenced blocks
 * (``` or ~~~, closed by the same character at least as long) and HTML comments
 * are not prose, so a heading or citation inside one counts for nothing.
 *
 * Citations resolve against <ref> (default HEAD), so a spec is linted against the
 * tree it will merge with, and the calibration set against the commit it was
 * labelled on. A cited commit must be an ancestor of <ref>, not merely present
 * in this clone. A citation of another spec (docs/specs/<name>.md) resolves
 * through --alias first, then the working tree, so a spec set that is added
 * together can cite itself. Paths resolve from the repository root, whatever
 * directory the script is run from.
 *
 * What it deliberately does NOT fail on, and lists instead for the reviewer:
 *   - an identifier that is not in src/, test/ or scripts/ and is not a near miss
 *     of one (a symbol the spec proposes, or one from an external codebase);
 *   - a path outside the repo (home-relative, absolute, or under a top-level
 *     directory the repo does not have), and a gitignored local path;
 *   - placeholders (`<id>`, `...`, `*`);
 *   - a path immediately followed by `(new)`, which the spec says it creates;
 *   - a commit in another repository, written `<owner>/<repo>@<sha>` or as a
 *     `<owner>/<repo>/commit/<sha>` URL.
 * Near misses: a symbol fails when it differs from a real identifier only in case,
 * or (8+ characters) by one edit. A hex run is a commit when it has both a digit
 * and a letter; a digits-only or letters-only run is one only in backticks.
 * Commits inside fenced blocks (logs, output) are not checked.
 * A wholly invented symbol with no near miss therefore passes this script. The
 * reviewer's half of G2 exists for exactly that.
 *
 * Symbols are looked up in src/, test/ and scripts/ EXCEPT this script and its
 * test, which spell typos on purpose: they would otherwise make every typo they
 * test resolve as a real word once merged.
 *
 * Exit: 0 every check passed, 1 a check failed, 2 the run could not verify
 * (unknown ref, unreadable spec, bad arguments, commit citations in a shallow
 * clone, or any internal error). 1 always means a finding, never a crash.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SYMBOL_SCOPE = ["src", "test", "scripts", ":(exclude)scripts/spec-lint.mjs", ":(exclude)test/spec-lint.test.ts"];
const SYMBOL_SCOPE_LABEL = "src/test/scripts";
/** A spec is prose: anything this large is not one, and is not worth a regex pass. */
const MAX_SPEC_BYTES = 512 * 1024;

class Unverifiable extends Error {}

let repoRoot = null;
/** The repository root, so git and the working-tree checks never depend on the cwd. */
function root() {
	if (repoRoot === null) {
		const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
		if (top.status !== 0) throw new Unverifiable("not inside a git repository");
		repoRoot = top.stdout.trim();
	}
	return repoRoot;
}

function git(args, { allowFail = false, env } = {}) {
	const result = spawnSync("git", args, {
		cwd: root(),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: env ? { ...process.env, ...env } : process.env,
	});
	if (result.status !== 0) {
		if (allowFail) return null;
		throw new Unverifiable(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
	}
	return result.stdout;
}

/** lstat errors that mean nothing can be at that component, so it is not a link. */
const ABSENT = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/**
 * True when a component of `path` under the repository root is a symlink. git
 * declines every question about such a path ("beyond a symbolic link"), so the
 * answer is read off the filesystem instead of off git's message, which is not
 * stable across versions. A component that does not exist is not a symlink, and
 * neither is a path that climbs out of the repository. A component the linter
 * cannot look at (a directory it may not search) is neither answer, so it is
 * unverifiable rather than a guess.
 */
function underSymlink(path) {
	let at = root();
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		// A path that climbs out of the repository is not this case, whatever sits
		// above the root: git declines it for being outside the repository, and that
		// falls through to an `external` note, which is the right answer for it.
		if (part === "..") return false;
		at = join(at, part);
		try {
			if (lstatSync(at).isSymbolicLink()) return true;
		} catch (error) {
			// Nothing there, or nothing that could be there (a file used as a
			// directory, a name too long to exist): not a link. A cited path that is
			// merely odd must still reach its G2 finding, not stop the whole spec.
			if (ABSENT.has(error.code)) return false;
			throw new Unverifiable(`cannot tell whether \`${path}\` is below a symlink: ${error.code ?? error.message} at ${at}`);
		}
	}
	return false;
}

/** git's exit status alone, for commands whose answer is the status. */
function gitStatus(args) {
	return spawnSync("git", args, { cwd: root(), encoding: "utf8" }).status;
}

/**
 * Lines that are prose: outside fenced blocks and HTML comments, with their
 * 1-based line numbers. A comment's lines are dropped, and text after a comment
 * closes on the same line is kept.
 */
function proseLines(text) {
	const lines = text.split("\n");
	const out = [];
	let fence = null; // { char, length } while inside a fenced block
	let inComment = false;
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (fence) {
			const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
			if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
			continue;
		}
		if (!inComment) {
			const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
				fence = { char: open[1][0], length: open[1].length };
				continue;
			}
		}
		let kept = "";
		while (line.length > 0) {
			if (inComment) {
				const end = line.indexOf("-->");
				if (end === -1) {
					line = "";
					break;
				}
				inComment = false;
				line = line.slice(end + 3);
			} else {
				const start = line.indexOf("<!--");
				if (start === -1) {
					kept += line;
					break;
				}
				kept += line.slice(0, start);
				inComment = true;
				line = line.slice(start + 4);
			}
		}
		if (kept.trim() || !inComment) out.push({ n: i + 1, text: kept });
	}
	return out;
}

/** Splits prose into the H1, header bullets, and `## ` sections (with `### ` subsection titles). */
export function parseSpec(text) {
	const prose = proseLines(text.replace(/\r\n?/g, "\n"));
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

/**
 * A title names `name` when it is `name`, or `name` followed by a space or
 * punctuation ("Risks and notes", "Scope (v1)"). A longer word that merely
 * starts with it ("Goalposts", "Approaching") does not.
 */
const titled = (title, name) => {
	const t = title.toLowerCase();
	const n = name.toLowerCase();
	return t === n || (t.startsWith(n) && /^[\s:.,;(—–-]/.test(t.slice(n.length)));
};
const sectionsNamed = (spec, name) => spec.sections.filter((s) => titled(s.title, name));
const section = (spec, name) => sectionsNamed(spec, name)[0] ?? null;

const REQUIRED_HEADER = ["Status", "Area", "Related"];
const REQUIRED_SECTIONS = ["Goal", "Scope", "Approach", "Acceptance criteria", "Verification plan", "Risks", "Attribution"];
/** A value that only holds a place for one. */
const PLACEHOLDER_VALUE = /^(?:|tbd|todo|tba|n\/a|none|\?+|-+|\.{3}|…|<[^>]*>)$/i;

function checkStructure(spec) {
	const findings = [];
	if (!spec.title) findings.push("no `# ` title line");
	for (const key of REQUIRED_HEADER) {
		if (!(key in spec.header)) findings.push(`header bullet \`- ${key}:\` is missing`);
		else if (!spec.header[key].trim()) findings.push(`header bullet \`- ${key}:\` has no value`);
	}
	const target = Object.keys(spec.header).find((k) => /^Target\b/.test(k));
	if (!target) findings.push("header bullet `- Target ...:` is missing");
	else if (!spec.header[target].trim()) findings.push(`header bullet \`- ${target}:\` has no value`);
	for (const name of REQUIRED_SECTIONS) {
		const found = sectionsNamed(spec, name);
		if (found.length === 0) findings.push(`section \`## ${name}\` is missing`);
		else if (found.length > 1) findings.push(`section \`## ${name}\` appears ${found.length} times (lines ${found.map((s) => s.line).join(", ")})`);
	}
	const scope = section(spec, "Scope");
	if (scope) {
		for (const sub of ["In scope", "Out of scope"]) {
			if (!scope.subsections.some((s) => titled(s, sub))) findings.push(`\`## Scope\` has no \`### ${sub}\``);
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

/**
 * `Spec: <harness>, <model>` on one line, both parts real values. Parsed with
 * indexOf rather than one regex: a backtracking pattern over an attribution line
 * is quadratic on a long run of spaces, and the spec is untrusted input.
 */
export function parseAttribution(line) {
	const at = line.search(/\bspec:/i);
	if (at === -1) return null;
	const rest = line.slice(at + "spec:".length);
	const comma = rest.indexOf(",");
	if (comma === -1) return null;
	const harness = rest.slice(0, comma).trim();
	const model = rest.slice(comma + 1).trim().replace(/\.$/, "").trim();
	if (PLACEHOLDER_VALUE.test(harness) || PLACEHOLDER_VALUE.test(model)) return null;
	return { harness, model };
}

function checkAttribution(spec) {
	const attribution = section(spec, "Attribution");
	if (!attribution) return []; // reported by structure
	return attribution.body.some((line) => parseAttribution(line) !== null)
		? []
		: ["`## Attribution` does not name the authoring harness and model as `Spec: <harness>, <model>`"];
}

function checkNegativeControl(spec) {
	const plan = section(spec, "Verification plan");
	if (!plan) return []; // reported by structure
	const start = plan.body.findIndex((line) => /^\s*[-*+] \*\*Negative control\b/i.test(line));
	if (start === -1) return ["`## Verification plan` has no `- **Negative control` bullet"];
	// The bullet with its continuation lines (indented, up to a blank line or the
	// next bullet). The bold label alone, or a label and a placeholder, is not a control.
	const indent = /^\s*/.exec(plan.body[start])[0].length;
	let bullet = plan.body[start];
	for (let i = start + 1; i < plan.body.length; i++) {
		const next = plan.body[i];
		if (!next.trim() || /^\s*[-*+] /.test(next) || /^\s*/.exec(next)[0].length <= indent) break;
		bullet += ` ${next.trim()}`;
	}
	const content = bullet.replace(/^\s*[-*+] /, "").replace(/\*\*/g, "").replace(/^negative control\b[^.:]*[.:]?/i, "").trim();
	return PLACEHOLDER_VALUE.test(content.replace(/[.:]$/, "")) ? ["the `- **Negative control` bullet in `## Verification plan` has no content"] : [];
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

/** Levenshtein that counts swapping two adjacent letters as one edit (`scr` for `src`). */
function damerau(a, b) {
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 0; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
		}
	}
	return d[a.length][b.length];
}

/** Everything the citation check needs to know about the tree at `ref`, loaded once. */
function loadTree(ref) {
	if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw new Unverifiable(`--ref wants a commit, got ${JSON.stringify(ref)}`);
	if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }) === null) {
		throw new Unverifiable(`ref ${ref} does not resolve to a commit`);
	}
	const files = git(["ls-tree", "-r", "--full-tree", "--name-only", ref]).split("\n").filter(Boolean);
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
	let pkg = {};
	if (fileSet.has("package.json")) {
		try {
			pkg = JSON.parse(git(["show", `${ref}:package.json`]));
		} catch (error) {
			throw new Unverifiable(`package.json at ${ref} does not parse: ${error.message}`);
		}
	}
	const designHeadings = files
		.filter((f) => /^docs\/design\/.+\.md$/.test(f))
		.flatMap((f) =>
			proseLines(git(["show", `${ref}:${f}`]).replace(/\r\n?/g, "\n"))
				.map((l) => /^#{1,6} (.*)$/.exec(l.text)?.[1])
				.filter((h) => h !== undefined),
		);
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
/** `npm <x>` subcommands that run a package.json script of the same name. */
const NPM_SCRIPT_ALIASES = new Set(["test", "t", "start", "stop", "restart"]);
const SYMBOL_SHAPES = [
	/^_?[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+$/, // camelCase
	/^_?[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/, // PascalCase with at least two humps
	/^_?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/, // SCREAMING_SNAKE
	/^_?[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, // snake_case
];
const isSymbolShaped = (t) => SYMBOL_SHAPES.some((re) => re.test(t));

/** Classifies one inline-code token. Returns null when it is not a citation at all. */
export function classifyToken(token) {
	const t = token.trim();
	if (!t) return null;
	// `npm run <x>` and `npm run-script <x>` name a script, flags after it or not;
	// `npm test` and its siblings do too. Any other `npm <cmd>` is npm's own.
	const npmRun = /^npm (?:run|run-script) ([\w:.-]+)(?:\s.*)?$/.exec(t);
	if (npmRun) return { kind: "npm", name: npmRun[1] };
	const npmAlias = /^npm ([\w-]+)(?:\s.*)?$/.exec(t);
	if (npmAlias) return NPM_SCRIPT_ALIASES.has(npmAlias[1]) ? { kind: "npm", name: npmAlias[1] === "t" ? "test" : npmAlias[1] } : null;
	// A call cites its callee, whatever its arguments: `fn(a, b)`, `obj.fn(x.y)`.
	const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(.*\)$/s.exec(t);
	if (call) return call[1].includes(".") ? dottedSymbol(call[1]) : { kind: "symbol", name: call[1] };
	if (/\s/.test(t)) return null; // commands, code fragments, prose
	if (/[<>*]|\.\.\./.test(t)) return t.includes("/") || PATH_EXT.test(t) ? { kind: "placeholder", value: t } : null;
	if (isSymbolShaped(t)) return { kind: "symbol", name: t };
	if (/^\/[\w-]+$/.test(t)) return null; // a slash command (`/kiro`), not a path
	if (t.includes("/") || PATH_EXT.test(t)) {
		if (t.startsWith("~") || t.startsWith("/") || /^[a-z][\w+.-]*:\/\//i.test(t)) return { kind: "external", value: t };
		// Location suffixes: `:12`, `:12:3`, `:86-88`, `#L10`, `#L10-L20`.
		const path = t
			.replace(/^\.\//, "")
			.replace(/#L\d+(?:-L?\d+)?$/, "")
			.replace(/:\d+(?:-\d+)?(?::\d+)?$/, "")
			.replace(/\/$/, "");
		if (!path.includes("/") && !PATH_EXT.test(path)) return null;
		return { kind: "path", value: path, raw: t };
	}
	if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(t)) return dottedSymbol(t);
	return null;
}

/** `a.b.cName` cites its last segment when that is shaped like a code name. */
function dottedSymbol(name) {
	const last = name.split(".").pop();
	return isSymbolShaped(last) ? { kind: "symbol", name: last } : null;
}

// Hex runs: a `#` (a colour), a word character, `.`, `/` or `-` before one means it
// is part of something else; ranges (`a..b`) are split before matching.
const COMMIT = /(?<![\w./#-])([0-9a-fA-F]{7,40})(?![\w/-])/g;
const COMMIT_URL = /([\w.-]+\/[\w.-]+)\/commits?\/([0-9a-fA-F]{7,40})\b/g;
const SECTION_REF = /§\s?([\w.]+)/g;
const SECTION_ID = /^\d+[a-z]?(?:\.\d+)*$/;

function checkCitations(spec, tree, aliases) {
	const failures = [];
	const notes = { external: [], local: [], proposed: [], unresolvedSymbols: [], placeholders: [] };
	const seen = new Set();
	const note = (list, value) => {
		if (!notes[list].includes(value)) notes[list].push(value);
	};
	const citePath = (c, token, at, rest) => {
		// `path` (new) declares a file the spec creates. Per token, so it can
		// never excuse a different citation on the same line.
		if (/^\s*\(new\)/.test(rest)) note("proposed", c.value);
		else resolvePath(c.value, token, at, tree, aliases, failures, note);
	};
	for (const line of spec.prose) {
		const at = `line ${line.n}`;
		for (const match of line.text.matchAll(/`([^`]+)`/g)) {
			const token = match[1];
			if (seen.has(token)) continue;
			seen.add(token);
			const c = classifyToken(token);
			if (!c) continue;
			if (c.kind === "npm") {
				if (!(c.name in tree.scripts)) failures.push(`${at}: \`${token}\` names no package.json script "${c.name}"`);
			} else if (c.kind === "placeholder") {
				note("placeholders", c.value);
			} else if (c.kind === "external") {
				note("external", c.value);
			} else if (c.kind === "symbol") {
				resolveSymbol(c.name, token, at, tree, failures, notes);
			} else if (c.kind === "path") {
				citePath(c, token, at, line.text.slice(match.index + match[0].length));
			}
		}
		// Markdown link targets are citations too: `[the bridge](src/bridge.ts)`.
		for (const match of line.text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
			const target = match[1];
			if (/^(?:[a-z][\w+.-]*:|#)/i.test(target) || seen.has(`link:${target}`)) continue;
			seen.add(`link:${target}`);
			const c = classifyToken(target);
			if (c?.kind === "path") citePath(c, target, at, line.text.slice(match.index + match[0].length));
			else if (c?.kind === "external") note("external", c.value);
		}
		// Another repository's commit, as a URL: listed, never failed.
		const urlShas = new Set();
		for (const m of line.text.matchAll(COMMIT_URL)) {
			urlShas.add(m.index + m[0].length - m[2].length);
			note("external", `${m[1]}@${m[2].toLowerCase()}`);
		}
		const hexLine = line.text.replace(/([0-9a-fA-F]{7,40})(\.{2,3})(?=[0-9a-fA-F]{7,40})/g, (_, a, dots) => a + " ".repeat(dots.length));
		for (const m of hexLine.matchAll(COMMIT)) {
			if (urlShas.has(m.index)) continue;
			const raw = m[1];
			const sha = raw.toLowerCase();
			// A digits-only run is usually a number (a date, a port, a count) and a
			// letters-only one a word, so either is a commit only when written as code.
			const ticked = hexLine[m.index - 1] === "`" && hexLine[m.index + raw.length] === "`";
			if ((!/\d/.test(sha) || !/[a-f]/.test(sha)) && !ticked) continue;
			if (seen.has(`sha:${sha}`)) continue;
			seen.add(`sha:${sha}`);
			// `<owner>/<repo>@<sha>` cites another repository's history, which this
			// clone cannot check: listed for the reviewer, never failed. Anything
			// else before an `@` is not a repository and does not excuse the commit.
			if (hexLine[m.index - 1] === "@") {
				const repo = /([\w.-]+\/[\w.-]+)@$/.exec(hexLine.slice(0, m.index));
				if (repo) {
					note("external", `${repo[1]}@${sha}`);
					continue;
				}
			}
			resolveCommit(sha, raw, at, tree, failures);
		}
		for (const m of line.text.matchAll(SECTION_REF)) {
			const id = m[1].replace(/\.+$/, "");
			if (seen.has(`sec:${id}`)) continue;
			seen.add(`sec:${id}`);
			if (id.length > 40 || !SECTION_ID.test(id)) {
				failures.push(`${at}: §${id.slice(0, 40)}${id.length > 40 ? "..." : ""} is not a section number like §5e.3`);
				continue;
			}
			if (!sectionResolves(id, tree.designHeadings)) failures.push(`${at}: §${id} matches no heading in docs/design/*.md`);
		}
	}
	return { failures, notes };
}

/**
 * Whether a heading (its text, without the `#`s) IS section `id`: `§1` names
 * "1." or "1 Why", never "1.2 Detail", and `§5e` names "5e. Field evidence",
 * never "5e.3 Fixed".
 */
export function sectionResolves(id, headings) {
	return headings.some((h) => h.startsWith(id) && (h.length === id.length || /^\.?(?:\s|$)/.test(h.slice(id.length))));
}

function resolveCommit(sha, raw, at, tree, failures) {
	const commit = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { allowFail: true });
	if (commit === null) {
		if (tree.shallow) throw new Unverifiable(`commit ${raw} is not present and the clone is shallow; fetch full history`);
		const any = gitStatus(["cat-file", "-e", sha]);
		failures.push(`${at}: commit ${raw} ${any === 0 ? "names an object that is not a commit, or is ambiguous" : "does not exist"}`);
		return;
	}
	const ancestor = gitStatus(["merge-base", "--is-ancestor", commit.trim(), tree.ref]);
	if (ancestor === 0) return;
	if (ancestor === 1) {
		if (tree.shallow) throw new Unverifiable(`commit ${raw} is not reachable from ${tree.ref} in a shallow clone; fetch full history`);
		failures.push(`${at}: commit ${raw} is not an ancestor of ${tree.ref} (on another branch, or unreachable)`);
		return;
	}
	throw new Unverifiable(`git merge-base --is-ancestor ${sha} ${tree.ref} failed`);
}

function resolveSymbol(name, token, at, tree, failures, notes) {
	const exact = git(["grep", "-q", "-w", "-e", name, tree.ref, "--", ...SYMBOL_SCOPE], { allowFail: true });
	if (exact !== null) return;
	const near = git(["grep", "-h", "-o", "-i", "-w", "-e", name, tree.ref, "--", ...SYMBOL_SCOPE], { allowFail: true });
	// A case variant is a typo only when it starts in the same case: `StopReason`
	// (a type) next to `stopReason` (a field) is the normal pairing, not a slip.
	const initialUpper = (id) => /^_*[A-Z]/.test(id);
	const variants = [
		...new Set(
			(near ?? "")
				.split("\n")
				.filter(Boolean)
				.map((l) => l.slice(l.lastIndexOf(":") + 1))
				.filter((v) => initialUpper(v) === initialUpper(name)),
		),
	];
	// One edit away (a dropped, doubled, swapped-in or wrong letter) from a real
	// identifier of 8 or more characters. Shorter names are too dense for one edit
	// to mean a typo, and a NEW name one edit from an existing one is confusing
	// enough to deserve the failure.
	if (variants.length === 0 && name.length >= 8) {
		variants.push(
			...[...tree.identifiers()].filter(
				(id) => initialUpper(id) === initialUpper(name) && Math.abs(id.length - name.length) <= 1 && levenshtein(id, name) === 1,
			),
		);
	}
	if (variants.length > 0) {
		failures.push(`${at}: \`${token}\` is not in ${SYMBOL_SCOPE_LABEL}; probable typo of ${variants.map((v) => `\`${v}\``).join(", ")}`);
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
	if (/^docs\/specs\/[^/]+\.md$/.test(path) && existsSync(join(root(), path))) return; // a sibling in the same change
	// A path below a symlink is the author's own tree, not repo content: a
	// developer who links a working directory into the repo (`.gsd` -> a project
	// directory elsewhere) cites real files git will not resolve at all. Decided
	// before git is asked, because git answers such a path with a fatal, and a
	// fatal is indistinguishable from "not ignored" by exit status alone.
	if (underSymlink(path)) {
		note("local", path);
		return;
	}
	// Before the top-level check: a gitignored file under a tracked directory (a
	// local log, a tfvars) is provenance on the author's machine, not a broken path.
	// The user's own excludes file is switched off, so the answer does not depend
	// on who runs the linter; `--` keeps a path shaped like an option a path.
	// Non-zero is "not ignored" or git declining (a path outside the repository):
	// both fall through to the checks below, which end at an `external` note.
	const ignored = git(["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-q", "--", path], {
		allowFail: true,
		env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	if (ignored !== null) {
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
		if (aliased || tree.basenames.has(base) || existsSync(join(root(), "docs", "specs", base))) return;
		note("external", path);
		return;
	}
	// A top-level directory the repo has, mistyped: the wrong case (`SRC/`) fails;
	// one edit off (`scr/`, `tset/`) fails when the citation names a file (an id
	// like `kiro/auto` is not a path), and a leading dot alone is a different
	// directory, not a typo; two edits off fails only when the file it names
	// exists under the real directory.
	const caseTwin = [...tree.top].find((t) => t !== first && t.toLowerCase() === first.toLowerCase());
	const oneOff = PATH_EXT.test(path)
		? [...tree.top].find((t) => t !== first && first.length >= 3 && t.replace(/^\./, "") !== first.replace(/^\./, "") && damerau(t, first) === 1)
		: undefined;
	const twoOff = [...tree.top].find(
		(t) => t !== first && levenshtein(t, first) <= 2 && (tree.basenames.get(base) ?? []).some((f) => f.startsWith(`${t}/`)),
	);
	const typo = caseTwin ?? oneOff ?? twoOff;
	if (typo) {
		const real = (tree.basenames.get(base) ?? []).find((f) => f.startsWith(`${typo}/`));
		failures.push(`${at}: \`${token}\` does not exist; probable typo of \`${typo}/\`${real ? ` (${real})` : ""}`);
		return;
	}
	note("external", path);
}

function readSpec(file) {
	let size;
	try {
		size = statSync(file).size;
	} catch (error) {
		throw new Unverifiable(`cannot read ${file}: ${error.code ?? error.message}`);
	}
	if (size > MAX_SPEC_BYTES) throw new Unverifiable(`${file} is ${size} bytes; a spec is at most ${MAX_SPEC_BYTES}`);
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		throw new Unverifiable(`cannot read ${file}: ${error.code ?? error.message}`);
	}
}

export function lintSpec(file, { ref = "HEAD", aliases = new Map(), tree } = {}) {
	const spec = parseSpec(readSpec(file));
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

const USAGE = "usage: spec-lint.mjs [--json] [--ref <commit>] [--alias <cited>=<file>]... <spec.md>...";

function main(argv) {
	const files = [];
	const aliases = new Map();
	let ref = "HEAD";
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--ref") {
			ref = argv[++i];
			if (ref === undefined) throw new Unverifiable("--ref wants a commit");
		} else if (arg === "--alias") {
			const value = argv[++i] ?? "";
			const eq = value.indexOf("=");
			const cited = value.slice(0, eq);
			const actual = value.slice(eq + 1);
			if (eq <= 0 || !actual) throw new Unverifiable("--alias wants <cited-path>=<file>");
			aliases.set(cited, resolve(actual));
		} else if (arg === "--") files.push(...argv.slice(i + 1).map((f) => f));
		else if (arg.startsWith("-")) throw new Unverifiable(`unknown option ${arg}\n${USAGE}`);
		else files.push(arg);
		if (arg === "--") break;
	}
	if (files.length === 0) throw new Unverifiable(USAGE);
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
		// Exit 1 is reserved for findings: anything else, a bug included, means the
		// spec was not verified, which the queue must not read as lint-fail.
		console.error(`spec-lint: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}
