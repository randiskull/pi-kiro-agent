#!/usr/bin/env node
/**
 * Calibration pass runner. It turns the prose protocol in
 * `spec-review/calibration/README.md` ("Running a reviewer pass") into a script,
 * so that a pass is reproducible, and so that the parts of it that are checks
 * are run as checks instead of being read as comments.
 *
 *   node scripts/calibrate.mjs run --harness kiro-cli --model gpt-5.6-terra
 *   node scripts/calibrate.mjs run --harness pi --model us.anthropic.claude-opus-5
 *   node scripts/calibrate.mjs finalize <run-dir> --counts false --why "<reason>"
 *
 * What each step is for, and why it is here rather than in a human's hands:
 *
 * - **One ref-stripped clone per ref the set needs** (`expected.json` `ref`, and
 *   a case's own `ref` where it has one), and a private copy of it per case, so
 *   no two sessions share a directory. `git clone --no-local`, every ref
 *   deleted, the reflog expired, unreachable objects pruned, and - which the
 *   README does not say - `origin` removed, because a clone that keeps its
 *   remote is one `git fetch origin` from the answer key.
 * - **The leak check is a gate.** The blob of `expected.json` and of every case
 *   must be unreachable from the clone. It runs on the base clone and again on
 *   each session copy, and any hit aborts the pass before a session starts.
 * - **One input directory per case**, outside the repository, under a random
 *   name, holding `rubric.md`, `spec.md` (the case) and the alias file where the
 *   case is given one. A case that cites the aliased path without being given
 *   the file aborts the pass: that is the one way this script could silently ask
 *   a reviewer to review a spec whose citations it cannot open.
 * - **The prompt is the README's**, with the paths substituted and with the
 *   `Reviewer: <harness>, <model>` line given to be copied, because a model
 *   cannot see its own model id (rubric, "Reviewer independence").
 * - **Each verdict is checked** against `git hash-object` of the spec the
 *   session was given and against the reviewer line the session was launched
 *   with. A wrong line is corrected and the correction recorded, which is what
 *   the README asks of the runner.
 * - **`RUN.json`'s blobs are computed, never typed**, and
 *   `countsTowardsShipBar` is written `false` with a `whyNot` saying the pass
 *   has not been scored yet. Only a human who has read `score.mjs` flips it,
 *   through `finalize`. A runner that graded its own pass would be the pass 8
 *   defect again (`expected.json` `shipBar.relabelling`).
 *
 * What it deliberately does not do: decide whether the pass met the bar (that
 * is `score.mjs`), write the `## Result` prose of `NOTES.md`, or run two passes
 * at once. Two passes are two invocations, which is also what keeps their
 * sessions in separate processes.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..");
const CAL = join(root, "spec-review", "calibration");

// ---------------------------------------------------------------------------
// Pure helpers. test/calibrate.test.ts holds these; everything below them
// touches the filesystem or spawns a process.
// ---------------------------------------------------------------------------

/** A model or harness id as it appears in a run directory name. */
export function slug(value) {
	return String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** The rubric's own number, read from the file rather than passed in. */
export function rubricNumber(text) {
	const m = /^Rubric:\s*(\d+)\s*$/m.exec(text);
	if (!m) throw new Error("spec-review/rubric.md has no 'Rubric: <n>' line");
	return Number(m[1]);
}

export function runIdFor({ date, rubric, harness, model }) {
	return `${date}-r${rubric}-${slug(harness)}-${slug(model)}`;
}

/** The sha git would store for these bytes. */
export function blobShaOf(body) {
	const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
	return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/**
 * Removes every GIT_* variable from an environment. A pre-push hook exports
 * GIT_DIR, and git obeys GIT_DIR over its working directory, so a child process
 * that runs git under a hook operates on the repository being pushed and not on
 * the directory it was given. That is not hypothetical here: it is how
 * test/spec-lint-symlink.test.ts committed over tracked files while passing.
 */
export function stripGitEnv(env) {
	const out = { ...env };
	for (const key of Object.keys(out)) if (key.startsWith("GIT_")) delete out[key];
	return out;
}

/**
 * One entry per case: the ref its clone is checked out at, and the alias files
 * it is given. A case with no `ref` of its own uses the set's, and is given
 * every alias the key declares, which is the README's "c2.md is copied for c1
 * to c6" expressed as the rule behind it.
 *
 * Throws when a case cites an aliased path it is not given. Without that, a case
 * added with its own ref that still cites the exemplar's sibling spec would be
 * reviewed against a citation the reviewer cannot open, and the G2 finding that
 * follows would look like a reviewer error.
 */
export function planCases(key, readCase) {
	const aliases = Object.entries(key.aliases ?? {});
	const plan = [];
	for (const [name, c] of Object.entries(key.cases)) {
		const usesSetRef = !c.ref;
		const given = usesSetRef ? aliases : [];
		const text = readCase(name);
		for (const [cited] of aliases) {
			if (text.includes(cited) && !given.some(([g]) => g === cited)) {
				throw new Error(
					`${name} cites ${cited} and is not given it (the case carries its own ref, so it gets no alias file). ` +
						"Give the case the alias or stop citing the path; a reviewer cannot open it.",
				);
			}
		}
		plan.push({
			name,
			ref: c.ref ?? key.ref,
			usesSetRef,
			aliases: given.map(([cited, target]) => ({ cited, target })),
		});
	}
	return plan;
}

/**
 * The part of lint's output a calibration reviewer is given: its `notes`, and
 * nothing else.
 *
 * The rubric's Review procedure step 3 is "Work through every item lint listed
 * under notes (G2 reviewer half)", and G2 divides itself the same way: its
 * script half owns "a repo path that does not exist at the ref", its reviewer
 * half opens with what lint listed *without* failing. A pass that skipped lint
 * and supplied nothing therefore left step 3 with no input and the boundary
 * between the two halves for the reviewer to guess. Rubric 3's pair guessed it
 * two opposite ways, across all six of its gate disagreements and the only false
 * fail it produced (`runs/SCORE.md`, "Rubric 3's first pair").
 *
 * `pass`, `checks` and every finding are dropped, so a reviewer still never
 * learns whether lint failed. That is the half of `shipBar.blind` worth keeping:
 * c3's whole construction is a lint G3 failure the reviewer has to reach on its
 * own, and handing over a verdict would answer the case instead of posing it.
 */
export function lintNotesOf(lintJson) {
	const entries = Array.isArray(lintJson) ? lintJson : [lintJson];
	if (entries.length !== 1) throw new Error(`lint reported ${entries.length} specs, expected exactly 1`);
	const notes = entries[0] && entries[0].notes;
	if (!notes || typeof notes !== "object") throw new Error("lint output carries no notes object");
	return notes;
}

/**
 * Where an alias file goes: the cited path inside the session's own clone, so
 * that the citation resolves exactly as every other citation in the spec does.
 *
 * It used to go into the input directory under its basename, with a prompt
 * sentence saying where to read it. That sentence says where the content is and
 * not that the citation resolves, so a reviewer that checked the filesystem was
 * contradicted by the harness rather than informed by it: run B of Rubric 3's
 * pair found `docs/specs/dual-host-pi-gsd.md` absent at the ref and failed G2 on
 * it in four cases, and c4's verdict is that one finding and nothing else, which
 * is the pair's only false fail. lint is handed the same mapping on its command
 * line (`spec-lint.mjs --alias`), so placing the file is the two halves of G2
 * being given the same world instead of opposite ones.
 */
export function aliasPlacements({ sessionDir, aliases }) {
	return aliases.map(({ cited, target }) => {
		if (cited.startsWith("/") || cited.split("/").includes("..")) {
			throw new Error(`alias path ${cited} must be repo-relative and must not climb out of the clone`);
		}
		return { from: join(root, target), to: join(sessionDir, cited) };
	});
}

/**
 * The README's prompt, with paths substituted. It carries no alias sentence:
 * the alias file is in the clone at the path the spec cites (`aliasPlacements`),
 * so there is nothing to redirect a reviewer to.
 */
export function promptFor({ inputDir, verdictPath, lintNotesPath, reviewerLine }) {
	return (
		`Review the implementation spec in ${join(inputDir, "spec.md")} against the rubric in ` +
		`${join(inputDir, "rubric.md")}, following its Review procedure. ` +
		"The repository is checked out at the commit the spec was written against. " +
		`Step 1 is already done: lint ran at that commit, and the notes it produced are in ${lintNotesPath}, ` +
		"which is step 3's input. Whether it passed or failed is deliberately withheld, so do not assume it " +
		"passed, do not infer it from the notes, and do not run lint yourself. Begin at step 2. " +
		`Write only the verdict file described in the rubric, at ${verdictPath}, with the first line ` +
		"`spec-review verdict for spec.md blob <sha>`, where `<sha>` is " +
		`\`git hash-object ${join(inputDir, "spec.md")}\`, and with the line \`${reviewerLine}\` copied exactly.`
	);
}

/**
 * Checks a verdict against what the session was given, and corrects the one
 * field the README puts on the runner.
 *
 * The header blob is a check and never a correction: a header naming another
 * blob means the session reviewed something other than the spec it was given,
 * and rewriting it would hide that. The `Reviewer:` line is the opposite - the
 * rubric says the runner owns it, and a run whose six sessions each guessed
 * their own model is why (README, "Rubric 1 asked the reviewer for a field it
 * cannot know").
 */
export function verifyVerdict({ text, specBlob, reviewerLine }) {
	const problems = [];
	const corrections = [];
	const header = /^spec-review verdict for (\S+) blob ([0-9a-f]{40})\s*$/m.exec(text.split("\n")[0] ?? "");
	if (!header) problems.push("the first line is not a verdict header the rubric describes");
	else if (header[2] !== specBlob) {
		problems.push(`the header names blob ${header[2].slice(0, 12)}, the spec it was given is ${specBlob.slice(0, 12)}`);
	}
	const found = /^Reviewer:.*$/m.exec(text);
	let out = text;
	if (!found) problems.push("there is no Reviewer: line to check");
	else if (found[0].trim() !== reviewerLine) {
		out = text.replace(/^Reviewer:.*$/m, reviewerLine);
		corrections.push(`Reviewer line was ${JSON.stringify(found[0].trim())}, corrected to ${JSON.stringify(reviewerLine)}`);
	}
	return { text: out, problems, corrections };
}

/**
 * The kiro-cli agent a reviewer session runs under. It exists for one reason:
 * kiro-cli's default agent on this machine is `amzn-builder`, which carries MCP
 * servers, and a reviewer session with `@builder-mcp/WorkspaceSearch` can search
 * outside the clone it was given. The first attempt at this pass ran with
 * `--trust-all-tools` and the default agent, and that tool ran inside a session;
 * the pass was voided and re-run under this agent, which declares no MCP server
 * and does not read `mcp.json`.
 *
 * The three tools are what a review needs: read the rubric and the spec, run git
 * in the clone, write the verdict. A session under this agent reports that no
 * MCP tool is available.
 */
export function reviewerAgent() {
	return {
		name: "reviewer",
		description: "A review session: filesystem read and write and a shell, with no MCP servers and no extra context.",
		tools: ["fs_read", "fs_write", "execute_bash"],
		allowedTools: ["fs_read", "fs_write", "execute_bash"],
		mcpServers: {},
		includeMcpJson: false,
		resources: [],
	};
}

/** The strings a session must not have seen, and the reason each one is here. */
export const LEAK_STRINGS = [
	"expected.json",
	"mustQuoteOneOf",
	"labelledBy",
	"countsTowardsShipBar",
	"shipBar",
	"spec-review/calibration",
];

/**
 * The isolation audit, as a function of text so it can be tested without a
 * session. Reports every leak string a session's own output contains, and every
 * path belonging to another session.
 */
export function auditText({ text, otherPaths }) {
	const hits = LEAK_STRINGS.filter((s) => text.includes(s)).map((s) => `leak string ${JSON.stringify(s)}`);
	for (const p of otherPaths) if (text.includes(p)) hits.push(`another session's path ${p}`);
	return hits;
}

// ---------------------------------------------------------------------------
// Harnesses. Adding one is a table entry: the argv, a version string for
// RUN.json, and the route note that says what a public reader needs to resolve
// the model id.
// ---------------------------------------------------------------------------

const HARNESSES = {
	"kiro-cli": {
		bin: "kiro-cli",
		argv: (model, prompt) => [
			"chat",
			"--no-interactive",
			"--trust-all-tools",
			"--agent",
			"reviewer",
			"--model",
			model,
			prompt,
		],
		// kiro-cli discovers a workspace agent in <cwd>/.kiro/agents, and the
		// session's working directory is its own copy of the clone, so the agent
		// is written there rather than into anyone's global configuration.
		prepare: (sessionDir) => {
			const dir = join(sessionDir, ".kiro", "agents");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "reviewer.json"), `${JSON.stringify(reviewerAgent(), null, "\t")}\n`);
		},
		version: () => `kiro-cli ${run("kiro-cli", ["--version"]).replace(/^kiro-cli\s*/, "")}`,
		route: (model) =>
			`kiro-cli's own model id, as listed by 'kiro-cli chat --list-models --format json'. Seat-billed through the official client; no model endpoint is called directly. Model ${model}.`,
		env: () => ({}),
	},
	pi: {
		bin: "pi",
		// -nc -ne -ns -np --no-mcp keep this machine's globally installed pi
		// extensions, skills, prompt templates and MCP servers out of the
		// session: one of them injects guidance into every turn, which a
		// calibration session must not have. --no-session keeps nothing behind.
		argv: (model, prompt) => [
			"-p",
			"--no-session",
			"-nc",
			"-ne",
			"-ns",
			"-np",
			"--no-mcp",
			"--provider",
			"amazon-bedrock",
			"--model",
			model,
			"--",
			prompt,
		],
		version: () => `@earendil-works/pi-coding-agent ${run("pi", ["--version"])}`,
		route: (model) =>
			`amazon-bedrock, us-west-2, through pi's provider of that name. ${model} is a US cross-region inference profile; the bare anthropic.* id of a current-generation model is refused for on-demand invocation. Both are public Bedrock identifiers.`,
		env: () => ({ AWS_REGION: process.env.AWS_REGION ?? "us-west-2" }),
		// Nothing to prepare: the flags above already keep this machine's
		// extensions, skills, prompt templates and MCP servers out of the session.
		prepare: () => {},
	},
};

function run(bin, args, cwd = root) {
	return execFileSync(bin, args, { cwd, env: stripGitEnv(process.env), encoding: "utf8" }).trim();
}

function git(args, cwd = root, allowFail = false) {
	try {
		return run("git", args, cwd);
	} catch (e) {
		if (allowFail) return null;
		throw e;
	}
}

function blobOf(path) {
	return blobShaOf(readFileSync(path));
}

/** Every blob a reviewer must not be able to reach, with a label for the error. */
function forbiddenBlobs(key) {
	return [
		{ label: "expected.json", sha: blobOf(join(CAL, "expected.json")) },
		...Object.keys(key.cases).map((name) => ({ label: `cases/${name}.md`, sha: blobOf(join(CAL, "cases", `${name}.md`)) })),
	];
}

/**
 * The leak check as a function of a reachability test, so both directions can be
 * held by a test: a reachable blob has to produce a message, and an unreachable
 * one has to produce none. Returns null when the clone is clean.
 *
 * What no test here proves is the wiring - that the `isReachable` the runner
 * passes is really git's. Proving it would need a clone from which the key IS
 * reachable, which is a ref this set does not have. The e2e test instead checks
 * the clone the runner built, with its own git calls, and finds the key absent
 * and no remote to fetch it from; that is independent evidence about the clone,
 * not about this function being called.
 */
export function leakReport({ forbidden, isReachable }) {
	const reachable = forbidden.filter(({ sha }) => isReachable(sha));
	if (!reachable.length) return null;
	return `LEAK: the key is reachable: ${reachable.map((f) => `${f.label} (${f.sha.slice(0, 12)})`).join(", ")}`;
}

/**
 * Runs the deterministic half for one case and returns the notes the reviewer is
 * owed, through `lintNotesOf`.
 *
 * It runs in the real repository, at the case's ref and with the key's aliases,
 * which is the command `README.md` documents under "Running the deterministic
 * half". Only the notes are kept, so nothing about pass or fail reaches the
 * session. Two cases fail lint by construction (c3's deleted negative-control
 * bullet, c5's two misspelled citations), so a non-zero exit is the normal path
 * here and not an error: `execFileSync` throws on it and the output we want is
 * on the thrown error.
 */
function lintNotesFor({ name, ref, aliases }) {
	const argv = [join(root, "scripts", "spec-lint.mjs"), "--json", "--ref", ref];
	for (const { cited, target } of aliases) argv.push("--alias", `${cited}=${target}`);
	argv.push(join("spec-review", "calibration", "cases", `${name}.md`));
	let out;
	try {
		out = execFileSync(process.execPath, argv, { cwd: root, encoding: "utf8", env: stripGitEnv(process.env) });
	} catch (err) {
		if (typeof err.stdout !== "string" || !err.stdout.trim()) throw err;
		out = err.stdout;
	}
	const notes = lintNotesOf(JSON.parse(out));
	const leaks = LEAK_STRINGS.filter((leak) => JSON.stringify(notes).includes(leak));
	if (leaks.length) {
		throw new Error(`lint notes for ${name} carry ${leaks.join(", ")}. The run would be void; nothing was launched.`);
	}
	return notes;
}

function leakCheck(dir, forbidden) {
	const message = leakReport({ forbidden, isReachable: (sha) => git(["cat-file", "-e", sha], dir, true) !== null });
	if (message) throw new Error(`${message} from ${dir}. The run would be void; nothing was launched.`);
}

function baseClone(workRoot, ref, forbidden) {
	const dir = join(workRoot, `base-${ref}`);
	if (existsSync(dir)) return dir;
	git(["clone", "--no-local", "--no-checkout", "--quiet", root, dir]);
	git(["checkout", "--detach", "--quiet", ref], dir);
	git(["remote", "remove", "origin"], dir);
	for (const r of (git(["for-each-ref", "--format=%(refname)"], dir) || "").split("\n").filter(Boolean)) {
		git(["update-ref", "-d", r], dir);
	}
	git(["reflog", "expire", "--expire=now", "--all"], dir);
	git(["gc", "--prune=now", "--quiet"], dir);
	leakCheck(dir, forbidden);
	return dir;
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) out[key] = true;
			else {
				out[key] = next;
				i += 1;
			}
		} else out._.push(a);
	}
	return out;
}

async function session({ harness, model, reviewerLine, workRoot, base, caseEntry, timeoutMs, dryRun }) {
	const h = HARNESSES[harness];
	const name = caseEntry.name;
	const sessionDir = mkdtempSync(join(tmpdir(), "s-"));
	const inputDir = mkdtempSync(join(tmpdir(), "in-"));
	cpSync(base, sessionDir, { recursive: true });
	leakCheck(sessionDir, caseEntry.forbidden);
	h.prepare(sessionDir);
	for (const { from, to } of aliasPlacements({ sessionDir, aliases: caseEntry.aliases })) {
		mkdirSync(dirname(to), { recursive: true });
		cpSync(from, to);
	}
	// Again, after the placement: the alias file is a case file, and a case file
	// copied into the clone is the one write this runner makes to a reviewer's
	// world. Placing it adds no git object, so this cannot fail for that reason,
	// which is the point of asserting it rather than reasoning about it.
	leakCheck(sessionDir, caseEntry.forbidden);
	cpSync(join(CAL, "..", "rubric.md"), join(inputDir, "rubric.md"));
	cpSync(join(CAL, "cases", `${name}.md`), join(inputDir, "spec.md"));
	const lintNotesPath = join(inputDir, "lint-notes.json");
	writeFileSync(lintNotesPath, `${JSON.stringify(lintNotesFor(caseEntry), null, "\t")}\n`);
	const verdictPath = join(inputDir, "verdict.md");
	const prompt = promptFor({ inputDir, verdictPath, lintNotesPath, reviewerLine });
	const argv = h.argv(model, prompt);
	const logs = join(workRoot, "logs");
	mkdirSync(logs, { recursive: true });
	writeFileSync(join(logs, `${name}.prompt.txt`), `${prompt}\n`);
	cpSync(lintNotesPath, join(logs, `${name}.lint-notes.json`));
	writeFileSync(
		join(logs, `${name}.cmd.txt`),
		`${[h.bin, ...argv.slice(0, -1)].join(" ")} <prompt>\ncwd: ${sessionDir}\ninput: ${inputDir}\n`,
	);
	const meta = { name, sessionDir, inputDir, verdictPath, specBlob: blobOf(join(inputDir, "spec.md")) };
	if (dryRun) return { ...meta, code: null, signal: null, dryRun: true };
	const started = Date.now();
	const { code, signal, out, err } = await new Promise((done) => {
		const child = spawn(h.bin, argv, {
			cwd: sessionDir,
			env: { ...stripGitEnv(process.env), ...h.env() },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks = { out: [], err: [] };
		child.stdout.on("data", (d) => chunks.out.push(d));
		child.stderr.on("data", (d) => chunks.err.push(d));
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (c, s) => {
			clearTimeout(timer);
			done({ code: c, signal: s, out: Buffer.concat(chunks.out).toString(), err: Buffer.concat(chunks.err).toString() });
		});
	});
	writeFileSync(join(logs, `${name}.out.txt`), out);
	writeFileSync(join(logs, `${name}.err.txt`), err);
	return { ...meta, code, signal, seconds: Math.round((Date.now() - started) / 1000) };
}

async function pool(items, jobs, worker) {
	const results = [];
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
		for (;;) {
			const i = next;
			next += 1;
			if (i >= items.length) return;
			results[i] = await worker(items[i]);
		}
	});
	await Promise.all(lanes);
	return results;
}

async function cmdRun(args) {
	const harness = args.harness;
	const model = args.model;
	if (!HARNESSES[harness]) throw new Error(`--harness must be one of ${Object.keys(HARNESSES).join(", ")}`);
	if (!model) throw new Error("--model is required");
	const key = JSON.parse(readFileSync(join(CAL, "expected.json"), "utf8"));
	const rubricText = readFileSync(join(root, "spec-review", "rubric.md"), "utf8");
	const rubric = rubricNumber(rubricText);
	const date = args.date ?? new Date().toISOString().slice(0, 10);
	const runId = runIdFor({ date, rubric, harness, model });
	const reviewerLine = `Reviewer: ${harness}, ${model}`;
	const forbidden = forbiddenBlobs(key);
	const plan = planCases(key, (name) => readFileSync(join(CAL, "cases", `${name}.md`), "utf8"));
	const only = typeof args.cases === "string" ? args.cases.split(",").map((s) => s.trim()) : null;
	const chosen = plan.filter((c) => !only || only.includes(c.name));
	if (!chosen.length) throw new Error("no cases selected");
	const workRoot = args.work ? resolve(args.work) : mkdtempSync(join(tmpdir(), "cal-"));
	mkdirSync(workRoot, { recursive: true });
	const dryRun = Boolean(args["dry-run"]);
	const timeoutMs = Number(args["timeout-min"] ?? 60) * 60_000;
	const jobs = Number(args.jobs ?? 4);
	console.log(`run id    ${runId}`);
	console.log(`reviewer  ${reviewerLine}`);
	console.log(`work      ${workRoot}`);
	console.log(`cases     ${chosen.map((c) => c.name).join(", ")}${dryRun ? "  (dry run)" : ""}`);
	const bases = new Map();
	for (const c of chosen) {
		if (!bases.has(c.ref)) bases.set(c.ref, baseClone(workRoot, c.ref, forbidden));
	}
	console.log(`clones    ${[...bases.keys()].map((r) => `${r} (leak check clean)`).join(", ")}`);
	const results = await pool(
		chosen.map((c) => ({ ...c, forbidden })),
		jobs,
		(caseEntry) =>
			session({
				harness,
				model,
				reviewerLine,
				workRoot,
				base: bases.get(caseEntry.ref),
				caseEntry,
				timeoutMs,
				dryRun,
			}),
	);
	if (dryRun) {
		for (const r of results) console.log(`  ${r.name}: prepared, spec blob ${r.specBlob.slice(0, 12)}, input ${r.inputDir}`);
		console.log(`\nprompts and argv are under ${join(workRoot, "logs")}`);
		return 0;
	}
	const runDir = join(CAL, "runs", runId);
	mkdirSync(runDir, { recursive: true });
	const report = [];
	let bad = 0;
	for (const r of results) {
		if (!existsSync(r.verdictPath)) {
			bad += 1;
			report.push({ name: r.name, status: `NO VERDICT (exit ${r.code}, signal ${r.signal})`, corrections: [] });
			continue;
		}
		const checked = verifyVerdict({
			text: readFileSync(r.verdictPath, "utf8"),
			specBlob: r.specBlob,
			reviewerLine,
		});
		writeFileSync(join(runDir, `${r.name}.verdict.md`), checked.text);
		if (checked.problems.length) bad += 1;
		report.push({
			name: r.name,
			status: checked.problems.length ? `PROBLEM: ${checked.problems.join("; ")}` : `ok (exit ${r.code}, ${r.seconds}s)`,
			corrections: checked.corrections,
		});
	}
	const audit = [];
	for (const r of results) {
		const others = results.filter((o) => o.name !== r.name).flatMap((o) => [o.sessionDir, o.inputDir]);
		const texts = [`${r.name}.out.txt`, `${r.name}.err.txt`]
			.map((f) => join(workRoot, "logs", f))
			.filter((p) => existsSync(p))
			.map((p) => readFileSync(p, "utf8"));
		if (existsSync(join(runDir, `${r.name}.verdict.md`))) texts.push(readFileSync(join(runDir, `${r.name}.verdict.md`), "utf8"));
		const hits = auditText({ text: texts.join("\n"), otherPaths: others });
		audit.push(`${r.name}: ${hits.length ? `HITS ${hits.join("; ")}` : "clean"}`);
	}
	writeFileSync(join(workRoot, "audit.txt"), `${audit.join("\n")}\n`);
	for (const ref of bases.keys()) leakCheck(bases.get(ref), forbidden);
	const h = HARNESSES[harness];
	const runJson = {
		runId,
		harness,
		harnessVersion: h.version(),
		model,
		modelRoute: h.route(model),
		calibrationPass: null,
		ref: key.ref,
		refsByCase: Object.fromEntries(plan.map((c) => [c.name, c.ref])),
		scoredAtCommit: git(["rev-parse", "HEAD"]),
		scoredAgainst: {
			rubric: blobOf(join(root, "spec-review", "rubric.md")),
			expected: blobOf(join(CAL, "expected.json")),
			cases: Object.fromEntries(Object.keys(key.cases).map((name) => [name, blobOf(join(CAL, "cases", `${name}.md`))])),
		},
		countsTowardsShipBar: false,
		whyNot:
			"Not scored yet: scripts/calibrate.mjs writes this false on purpose, because a runner that declared its own pass to meet the bar is the pass 8 defect (shipBar.relabelling). Run score.mjs over both passes, then set it with 'calibrate.mjs finalize'.",
	};
	writeFileSync(join(runDir, "RUN.json"), `${JSON.stringify(runJson, null, "\t")}\n`);
	console.log("");
	for (const r of report) {
		console.log(`  ${r.name.padEnd(3)} ${r.status}`);
		for (const c of r.corrections) console.log(`      correction: ${c}`);
	}
	console.log(`\nisolation audit: ${audit.every((a) => a.endsWith("clean")) ? "clean for every session" : "SEE audit.txt"}`);
	console.log(`verdicts and RUN.json: ${runDir}`);
	console.log(`logs, prompts and audit: ${workRoot}`);
	console.log(`corrections to record in NOTES.md: ${report.flatMap((r) => r.corrections).length}`);
	console.log(`\nnext: node spec-review/calibration/score.mjs ${runDir} <the other pass>`);
	return bad === 0 ? 0 : 1;
}

function cmdFinalize(args) {
	const dir = args._[1];
	if (!dir) throw new Error("usage: calibrate.mjs finalize <run-dir> --counts true|false --why '<reason>'");
	if (args.counts !== "true" && args.counts !== "false") throw new Error("--counts must be true or false");
	if (typeof args.why !== "string" || !args.why.trim()) throw new Error("--why is required: a run records why it counts, or why not");
	const path = join(resolve(dir), "RUN.json");
	const run = JSON.parse(readFileSync(path, "utf8"));
	run.countsTowardsShipBar = args.counts === "true";
	if (run.countsTowardsShipBar) {
		run.why = args.why;
		delete run.whyNot;
	} else {
		run.whyNot = args.why;
		delete run.why;
	}
	writeFileSync(path, `${JSON.stringify(run, null, "\t")}\n`);
	console.log(`${path}: countsTowardsShipBar ${run.countsTowardsShipBar}`);
	return 0;
}

const USAGE = `usage:
  calibrate.mjs run --harness <${Object.keys(HARNESSES).join("|")}> --model <id>
       [--cases c1,c2] [--jobs 4] [--timeout-min 60] [--work <dir>] [--date <yyyy-mm-dd>] [--dry-run]
  calibrate.mjs finalize <run-dir> --counts true|false --why "<reason>"
`;

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];
	try {
		const code = cmd === "run" ? await cmdRun(args) : cmd === "finalize" ? cmdFinalize(args) : (console.error(USAGE), 2);
		process.exit(code);
	} catch (e) {
		console.error(`calibrate: ${e.message}`);
		process.exit(2);
	}
}
