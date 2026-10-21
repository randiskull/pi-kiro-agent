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
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
		// A forward-slash check alone passed a backslash, a drive letter and a
		// parent that resolves elsewhere. The key is trusted, so none of these was
		// reachable; the guard is cheaper than the argument that it stays that way.
		if (isAbsolute(cited) || /^[A-Za-z]:/.test(cited) || cited.includes("\\") || cited.split("/").includes("..")) {
			throw new Error(`alias path ${cited} must be repo-relative, forward-slashed, and must not climb out of the clone`);
		}
		const to = join(sessionDir, cited);
		if (!resolve(to).startsWith(resolve(sessionDir) + sep)) {
			throw new Error(`alias path ${cited} resolves outside the session clone`);
		}
		return { from: join(root, target), to };
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
		"Check a cited path against the files in the checkout rather than against git's HEAD: the " +
		"checkout is the world under review, and not every file in it is committed at this commit. " +
		`Write only the verdict file described in the rubric, at ${verdictPath}, with the first line ` +
		"`spec-review verdict for spec.md blob <sha>`, where `<sha>` is " +
		`\`git hash-object ${join(inputDir, "spec.md")}\`, and with the line \`${reviewerLine}\` copied exactly.`
	);
}

/**
 * The prompt's wording, as a sha256 over the template with every per-session
 * path and the reviewer line replaced by a placeholder.
 *
 * `d98d5b6` is why this exists. The prompt alone caused all six of Rubric 3's
 * pair's gate disagreements, and a run collected under the defective prompt
 * still recorded blobs that matched, because the prompt is not a file and the
 * blob rule could not see it. Hashing the wording puts it inside the rule. The
 * placeholders are what make the two runs of a pair comparable: the paths differ
 * per session and the reviewer line per run, and neither is the wording.
 */
export const PROMPT_FINGERPRINT_INPUT = {
	inputDir: "<input>",
	verdictPath: "<input>/verdict.md",
	lintNotesPath: "<input>/lint-notes.json",
	reviewerLine: "Reviewer: <harness>, <model>",
};

export function promptFingerprint() {
	return createHash("sha256").update(promptFor(PROMPT_FINGERPRINT_INPUT)).digest("hex");
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
 * the machine's default kiro-cli agent carries MCP servers, and a reviewer
 * session with an MCP workspace-search tool can search outside the clone it was
 * given. The first attempt at this pass ran with
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
		// One source for the region. The route note said us-west-2 while the
		// environment honoured AWS_REGION, so a run in another region recorded a
		// route that was not the one it used.
		region: () => process.env.AWS_REGION ?? "us-west-2",
		// -nc -ne -ns -np --no-mcp keep this machine's globally installed pi
		// extensions, skills, prompt templates and MCP servers out of the
		// session: one of them injects guidance into every turn, which a
		// calibration session must not have. --no-session keeps nothing behind.
		// --mode json is what makes the isolation audit able to see anything. In
		// text mode pi's print mode writes the final answer and nothing else, so
		// a session could have read the key with a tool and the audit, which scans
		// stdout, would have reported clean. The json transcript carries the tool
		// calls and their results.
		argv: (model, prompt) => [
			"-p",
			"--mode",
			"json",
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
		route(model) {
			return `amazon-bedrock, ${this.region()}, through pi's provider of that name. ${model} is a US cross-region inference profile; the bare anthropic.* id of a current-generation model is refused for on-demand invocation. Both are public Bedrock identifiers.`;
		},
		env() {
			return { AWS_REGION: this.region() };
		},
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

/**
 * Every blob of a path that has ever been committed on any ref, newest first.
 *
 * The current blob is not the whole exposure. A clone at an old ref cannot reach
 * today's key, but it can reach any key blob that is an ancestor of that ref,
 * and both refs this set uses happen to predate the file. That is a property of
 * two commit ids, not of the design: a case added at a later ref would expose
 * every older key and the check would still pass. So the history is forbidden
 * too.
 */
function historicalBlobsOf(relPath) {
	const commits = (git(["log", "--all", "--format=%H", "--", relPath], root, true) || "").split("\n").filter(Boolean);
	const shas = new Set();
	for (const commit of commits) {
		const sha = git(["rev-parse", `${commit}:${relPath}`], root, true);
		if (sha) shas.add(sha);
	}
	return [...shas];
}

/** Every blob a reviewer must not be able to reach, with a label for the error. */
function forbiddenBlobs(key) {
	const paths = ["spec-review/calibration/expected.json", ...Object.keys(key.cases).map((name) => `spec-review/calibration/cases/${name}.md`)];
	const out = [];
	const seen = new Set();
	for (const relPath of paths) {
		const label = relPath.replace("spec-review/calibration/", "");
		for (const [sha, which] of [
			[blobOf(join(root, relPath)), label],
			...historicalBlobsOf(relPath).map((sha) => [sha, `${label} (an earlier commit of it)`]),
		]) {
			if (seen.has(sha)) continue;
			seen.add(sha);
			out.push({ label: which, sha });
		}
	}
	return out;
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
		// Exit 1 is "lint found something", which is the normal path for c3 and c5.
		// Exit 2 is could-not-verify, and its notes would describe the runner's own
		// failure to resolve a ref rather than the spec. It happens to carry no
		// stdout today, so accepting any non-zero exit with output worked by
		// accident; a reviewer must never be handed notes from a 2.
		if (err.status !== 1) throw err;
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

/**
 * Which of `shas` the object database in `dir` can reach, in one git call.
 *
 * One `cat-file -e` per blob was fine for nine; with the history of the key
 * forbidden too it is hundreds, per clone, twice per session.
 *
 * CALIBRATE_ASSUME_LEAK is a test seam, and the only one in this file. It makes
 * every forbidden blob read as reachable, which is how `test/calibrate.test.ts`
 * proves the CALL SITES refuse a run rather than only that `leakReport` returns
 * a string. It can make the runner refuse and can never make it permit, so the
 * seam cannot weaken the check it tests.
 */
function reachableShas(dir, shas) {
	if (!shas.length) return new Set();
	if (process.env.CALIBRATE_ASSUME_LEAK) return new Set(shas);
	const out = execFileSync("git", ["cat-file", "--batch-check"], {
		cwd: dir,
		input: `${shas.join("\n")}\n`,
		encoding: "utf8",
		env: stripGitEnv(process.env),
		maxBuffer: 64 * 1024 * 1024,
	});
	const found = new Set();
	for (const line of out.split("\n")) {
		const m = /^([0-9a-f]{40}) (\S+)/.exec(line);
		if (m && m[2] !== "missing") found.add(m[1]);
	}
	return found;
}

function leakCheck(dir, forbidden, launched = false) {
	const reachable = reachableShas(dir, forbidden.map((f) => f.sha));
	const message = leakReport({ forbidden, isReachable: (sha) => reachable.has(sha) });
	if (message) {
		const tail = launched ? "The run is void." : "The run would be void; nothing was launched.";
		throw new Error(`${message} from ${dir}. ${tail}`);
	}
	return forbidden.length;
}

function baseClone(workRoot, ref, forbidden) {
	const dir = join(workRoot, `base-${ref}`);
	// A reused --work used to return here unchecked, so the one clone every
	// session is copied from was the one thing never verified on a second run.
	if (existsSync(dir)) {
		leakCheck(dir, forbidden);
		return dir;
	}
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

/**
 * A flag that must be a whole number above zero.
 *
 * `--jobs abc` made `Array.from({length: NaN})`, which is zero lanes: the run
 * exited 0 having launched nothing, and in a real run would have written a
 * RUN.json with no verdicts in it. `--timeout-min abc` passed NaN to
 * setTimeout, which Node treats as 1ms, so every session was killed at once.
 */
export function positiveInt(value, flag) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`--${flag} must be a whole number above zero, got ${JSON.stringify(String(value))}`);
	}
	return n;
}

/** A run id and a run directory are built from this, so it is not free text. */
export function checkedDate(value) {
	const s = String(value);
	// toISOString throws a RangeError on an impossible date, which would surface
	// as "Invalid Date" and say nothing about which flag was wrong.
	const real = /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
	if (!real || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) {
		throw new Error(`--date must be a real yyyy-mm-dd date, got ${JSON.stringify(s)}`);
	}
	return s;
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

/**
 * Everything a session needs, built before any model is launched.
 *
 * This used to run inside the parallel pool, which made two claims false. The
 * lint-notes leak check and the per-session leak check both throw, and by the
 * time one lane threw another lane had already started a model: the process
 * exited 2 while those children kept running and billing, and the message said
 * nothing was launched. Preparing every session first, in order, makes the
 * sentence true and leaves the pool with one job, which is to spawn.
 *
 * The directories live under the work root rather than in the system temp
 * directory. A full clone per case and an input directory per case were being
 * created outside --work and never removed, so every run and every `npm run
 * verify` left two more behind.
 */
function prepareSession({ harness, model, reviewerLine, workRoot, base, caseEntry }) {
	const h = HARNESSES[harness];
	const name = caseEntry.name;
	const sessionDir = join(workRoot, "sessions", name);
	const inputDir = join(workRoot, "inputs", name);
	mkdirSync(dirname(sessionDir), { recursive: true });
	mkdirSync(inputDir, { recursive: true });
	cpSync(base, sessionDir, { recursive: true });
	const blobsChecked = leakCheck(sessionDir, caseEntry.forbidden);
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
	return {
		name,
		harness,
		sessionDir,
		inputDir,
		verdictPath,
		argv,
		blobsChecked,
		specBlob: blobOf(join(inputDir, "spec.md")),
	};
}

async function launchSession({ prepared, workRoot, timeoutMs }) {
	const { name, sessionDir, argv, harness } = prepared;
	const h = HARNESSES[harness];
	const logs = join(workRoot, "logs");
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
	return { ...prepared, code, signal, seconds: Math.round((Date.now() - started) / 1000) };
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
	const date = args.date === undefined ? new Date().toISOString().slice(0, 10) : checkedDate(args.date);
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
	const timeoutMs = (args["timeout-min"] === undefined ? 60 : positiveInt(args["timeout-min"], "timeout-min")) * 60_000;
	const jobs = args.jobs === undefined ? 4 : positiveInt(args.jobs, "jobs");
	// A model that has already taken part in a pass cannot be one of the two the
	// bar asks for, and a run on one is a probe whether or not it is labelled.
	// Recording that as a field rather than as prose in whyNot is what lets
	// score.mjs refuse it: a probe's run id, its null calibrationPass and its
	// directory all look exactly like a gating run's.
	const spent = new Set(Array.isArray(key.shipBar?.spent) ? key.shipBar.spent : []);
	const probe = Boolean(args.probe) || spent.has(model);
	// What the sessions are given has to be what the run records. The blobs used
	// to be hashed from the working tree after the pool finished, hours after the
	// rubric and the cases were copied into the first session, and scoredAtCommit
	// was HEAD whether or not those blobs were in it. One snapshot, before
	// anything is prepared, over a tree that is not allowed to be dirty.
	if (!dryRun) {
		const watched = ["spec-review", "scripts/calibrate.mjs", "scripts/spec-lint.mjs"];
		const dirty = (git(["status", "--porcelain", "--", ...watched]) || "").trim();
		if (dirty) {
			throw new Error(
				`the tree is dirty under ${watched.join(", ")}, so a run's blobs would match no commit:\n${dirty}\n` +
					"Commit or stash first. Nothing was launched.",
			);
		}
	}
	const snapshot = {
		rubric: blobOf(join(root, "spec-review", "rubric.md")),
		expected: blobOf(join(CAL, "expected.json")),
		runner: blobOf(join(root, "scripts", "calibrate.mjs")),
		prompt: promptFingerprint(),
		cases: Object.fromEntries(chosen.map((c) => [c.name, blobOf(join(CAL, "cases", `${c.name}.md`))])),
	};
	console.log(`run id    ${runId}`);
	console.log(`reviewer  ${reviewerLine}`);
	console.log(`work      ${workRoot}`);
	console.log(`cases     ${chosen.map((c) => c.name).join(", ")}${dryRun ? "  (dry run)" : ""}`);
	if (probe) {
		console.log(`probe     yes${spent.has(model) ? ` (${model} is in shipBar.spent)` : " (--probe)"}; this run can never count`);
	}
	const bases = new Map();
	for (const c of chosen) {
		if (!bases.has(c.ref)) bases.set(c.ref, baseClone(workRoot, c.ref, forbidden));
	}
	console.log(`clones    ${[...bases.keys()].map((r) => `${r} (leak check clean)`).join(", ")}`);
	// Sequential, and before the first spawn: every check that can void the run
	// happens here, so the message that nothing was launched is true.
	const prepared = [];
	for (const caseEntry of chosen) {
		prepared.push(
			prepareSession({
				harness,
				model,
				reviewerLine,
				workRoot,
				base: bases.get(caseEntry.ref),
				caseEntry: { ...caseEntry, forbidden },
			}),
		);
	}
	console.log(`prepared  ${prepared.length} session(s), ${forbidden.length} forbidden blobs checked per clone`);
	if (dryRun) {
		for (const r of prepared) console.log(`  ${r.name}: prepared, spec blob ${r.specBlob.slice(0, 12)}, input ${r.inputDir}`);
		console.log(`\nprompts and argv are under ${join(workRoot, "logs")}`);
		return 0;
	}
	const results = await pool(prepared, jobs, (p) => launchSession({ prepared: p, workRoot, timeoutMs }));
	const runDir = join(CAL, "runs", runId);
	mkdirSync(runDir, { recursive: true });
	const report = [];
	let bad = 0;
	for (const r of results) {
		if (!existsSync(r.verdictPath)) {
			bad += 1;
			report.push({ name: r.name, verdict: false, status: `NO VERDICT (exit ${r.code}, signal ${r.signal})`, corrections: [] });
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
			verdict: true,
			status: checked.problems.length ? `PROBLEM: ${checked.problems.join("; ")}` : `ok (exit ${r.code}, ${r.seconds}s)`,
			corrections: checked.corrections,
		});
	}
	const audit = [];
	const hitsByCase = new Map();
	for (const r of results) {
		const others = results.filter((o) => o.name !== r.name).flatMap((o) => [o.sessionDir, o.inputDir]);
		const texts = [`${r.name}.out.txt`, `${r.name}.err.txt`]
			.map((f) => join(workRoot, "logs", f))
			.filter((p) => existsSync(p))
			.map((p) => readFileSync(p, "utf8"));
		if (existsSync(join(runDir, `${r.name}.verdict.md`))) texts.push(readFileSync(join(runDir, `${r.name}.verdict.md`), "utf8"));
		const hits = auditText({ text: texts.join("\n"), otherPaths: others });
		// Paths are stripped of the work root: these lines are committed, and a
		// maintainer's temp directory carries a home directory in it.
		hitsByCase.set(r.name, hits.map((h) => h.split(workRoot).join("<work>")));
		audit.push(`${r.name}: ${hits.length ? `HITS ${hits.join("; ")}` : "clean"}`);
	}
	writeFileSync(join(workRoot, "audit.txt"), `${audit.join("\n")}\n`);
	// An audit hit used to print and leave the exit code alone, so a run that had
	// seen the key could still be finalized as a pass. It voids the run.
	const auditFailed = [...hitsByCase.values()].some((h) => h.length);
	if (auditFailed) bad += 1;
	for (const ref of bases.keys()) leakCheck(bases.get(ref), forbidden, true);
	const reviewed = new Set(report.filter((r) => r.verdict).map((r) => r.name));
	const h = HARNESSES[harness];
	const runJson = {
		runId,
		harness,
		harnessVersion: h.version(),
		model,
		modelRoute: h.route(model),
		calibrationPass: null,
		probe,
		ref: key.ref,
		// Both of these used to be taken from the key, so a --cases run and a run
		// whose session timed out both recorded all eight cases: the run claimed
		// coverage it did not have, and score.mjs then died on the missing verdict
		// file rather than reporting the gap.
		refsByCase: Object.fromEntries(chosen.filter((c) => reviewed.has(c.name)).map((c) => [c.name, c.ref])),
		scoredAtCommit: git(["rev-parse", "HEAD"]),
		scoredAgainst: {
			rubric: snapshot.rubric,
			expected: snapshot.expected,
			runner: snapshot.runner,
			prompt: snapshot.prompt,
			cases: Object.fromEntries(Object.entries(snapshot.cases).filter(([name]) => reviewed.has(name))),
		},
		sessions: results.map((r) => {
			const line = report.find((x) => x.name === r.name);
			return {
				case: r.name,
				exit: r.code,
				signal: r.signal,
				seconds: r.seconds ?? null,
				verdict: Boolean(line?.verdict),
				forbiddenBlobsChecked: r.blobsChecked,
				reviewerLineCorrected: Boolean(line?.corrections.length),
				audit: (hitsByCase.get(r.name) ?? []).length ? { clean: false, hits: hitsByCase.get(r.name) } : { clean: true },
			};
		}),
		auditScope:
			harness === "pi"
				? "pi runs with --mode json, so stdout carries the tool calls and their results and the audit reads them."
				: "kiro-cli --no-interactive prints the tools it runs, so stdout carries them and the audit reads them.",
		auditBlindTo:
			"A read whose path and content never appear in the transcript, anything a session did through a tool whose output it did not echo, and the real filesystem: a session runs as the maintainer and is not sandboxed, so this audit is evidence about what the transcript shows and not a boundary.",
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
	console.log(`\nisolation audit: ${auditFailed ? "HITS - THE RUN IS VOID, see audit.txt" : "clean for every session"}`);
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
	// Nothing used to read shipBar.spent. A probe, or any run on a model that had
	// already taken part in a pass, could be finalized with --counts true over
	// matching blobs and score.mjs would exit 0 on it. Both are refused here and
	// again in score.mjs, because a flag a human types is the place this is most
	// likely to go wrong and the place a reason can be given.
	if (args.counts === "true") {
		const key = JSON.parse(readFileSync(join(CAL, "expected.json"), "utf8"));
		const spent = Array.isArray(key.shipBar?.spent) ? key.shipBar.spent : [];
		if (run.probe === true) {
			throw new Error("this run records probe: true, and a probe is never one of the two (shipBar.capabilityMatched)");
		}
		if (spent.includes(run.model)) {
			throw new Error(`${run.model} is in shipBar.spent, so it cannot be one of the two held-out models (shipBar.heldOut)`);
		}
	}
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
       [--cases c1,c2] [--jobs 4] [--timeout-min 60] [--work <dir>] [--date <yyyy-mm-dd>]
       [--probe] [--dry-run]
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
