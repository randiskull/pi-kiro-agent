/**
 * Live identity eval (pi-mode-spec.md "Identity contract", Layer 2). Measures,
 * per model, whether kiro's model answers identity questions as pi when
 * pi-kiro puts the <identity> block at the top of every prompt. Layer 1 (the
 * line pi-kiro renders itself) is deterministic and covered by unit tests; this
 * file is the only place Layer 2 is measured rather than assumed.
 *
 * Per model: every IDENTITY_QUESTIONS entry x PI_KIRO_IDENTITY_REPEATS (default
 * 3), each a FRESH conversation with no system prompt, so the only identity cue
 * is ours against kiro's server-side prompt. Scored by identity-score.ts.
 *
 *   Claude models: expected to pass every answer (asserted).
 *   Other models:  recorded only (the probes saw GPT answer "Kiro" 0/4); the
 *                  test asserts the run completed and logs the score.
 *
 * Results are cached by kiro version + engine + model + prompt hash, so a re-run
 * on an unchanged setup reuses the last measurement instead of spending seat
 * credits. PI_KIRO_IDENTITY_FRESH=1 forces a new measurement.
 *
 *   PI_KIRO_LIVE=1 npx vitest run test/identity-live.test.ts
 *   PI_KIRO_LIVE=1 PI_KIRO_IDENTITY_MODELS=claude-sonnet-4.6,gpt-5.6-terra npx vitest run test/identity-live.test.ts
 *   PI_KIRO_LIVE=1 PI_KIRO_IDENTITY_TRANSPORT=acp npx vitest run test/identity-live.test.ts
 *
 * Cost: questions x repeats real turns per model (9 by default).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _resetAcpSessions } from "../src/acp-session.js";
import { _resetAcpChildren, makeStreamViaAcp } from "../src/acp-transport.js";
import { ACP_ENGINE, CHAT_ENGINE, identityBlock, identityLine, parseKiroVersion, resolvePiVersion, type KiroEngine } from "../src/identity.js";
import { checkKiroReadiness } from "../src/readiness.js";
import { _resetSessions } from "../src/session-manager.js";
import { makeStreamViaKiro } from "../src/stream-adapter.js";
import { IDENTITY_QUESTIONS, scoreIdentityAnswer, type IdentityScore } from "./identity-score.js";
import { ctx, drainTurn, LIVE, LIVE_MODEL, user, withRealHome } from "./live-support.js";

const MODELS = (process.env.PI_KIRO_IDENTITY_MODELS ?? LIVE_MODEL.id)
	.split(",")
	.map((id) => id.trim())
	.filter(Boolean);
const REPEATS = Math.max(1, Number(process.env.PI_KIRO_IDENTITY_REPEATS ?? 3) || 3);
const FRESH = process.env.PI_KIRO_IDENTITY_FRESH === "1";
// Its own variable: test-setup.ts deletes PI_KIRO_TRANSPORT before any test
// runs, so reading that here would silently measure the chat transport.
const USE_ACP = process.env.PI_KIRO_IDENTITY_TRANSPORT === "acp";
const ENGINE: KiroEngine = USE_ACP ? ACP_ENGINE : CHAT_ENGINE;
const RESULTS_PATH =
	process.env.PI_KIRO_IDENTITY_RESULTS ??
	join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache", "pi-kiro", "identity-eval.json");
/** Generous: a cold kiro child plus a real model call, per turn. */
const TURN_BUDGET_MS = 120_000;

type Expectation = "pass" | "record";
/**
 * Models MEASURED as pi on engine v2 (kiro-cli 2.26.1, chat, 3 questions x 3
 * repeats, 2026-10-01), every one 9/9: 11 claude-* models (sonnet-4/4.5/4.6/5,
 * opus-4.5/4.7/4.8/5/5.5, haiku-4.5, fable-5.1), gpt-5.6-terra/sol/luna,
 * deepseek-3.2, glm-5, qwen3-coder-next, minimax-m2.1/m2.5 and auto. Those are
 * asserted; claude-* stays asserted as a family (haiku-4.5 fails on chat only
 * when global steering overflows its 200K window). agi-nova-beta-1m is
 * recorded only: kiro itself reports it "temporarily unavailable". Any other
 * model is recorded only until it has been measured.
 */
const ASSERTED_MODELS = new Set([
	"gpt-5.6-terra",
	"gpt-5.6-sol",
	"gpt-5.6-luna",
	"deepseek-3.2",
	"glm-5",
	"qwen3-coder-next",
	"minimax-m2.1",
	"minimax-m2.5",
	"auto",
]);
const expectationFor = (model: string): Expectation =>
	/^claude-/.test(model) || ASSERTED_MODELS.has(model) ? "pass" : "record";

interface AnswerRecord extends IdentityScore {
	question: string;
	repeat: number;
	text: string;
}

interface EvalRecord {
	key: string;
	model: string;
	engine: KiroEngine;
	kiroVersion: string | undefined;
	piVersion: string | undefined;
	line: string;
	at: string;
	passed: number;
	total: number;
	answers: AnswerRecord[];
}

function readResults(): Record<string, EvalRecord> {
	try {
		return JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as Record<string, EvalRecord>;
	} catch {
		return {};
	}
}

function writeResult(record: EvalRecord): void {
	const all = readResults();
	all[record.key] = record;
	mkdirSync(dirname(RESULTS_PATH), { recursive: true });
	writeFileSync(RESULTS_PATH, `${JSON.stringify(all, null, 2)}\n`);
}

/**
 * What a cached result must match to be reused. The prompt hash covers the
 * identity block template and the question set, so editing either one forces a
 * fresh measurement instead of silently reusing a result for a different prompt.
 */
function cacheKey(model: string, kiroVersion: string | undefined): string {
	const promptHash = createHash("sha256")
		.update(identityBlock("<LINE>"))
		.update(JSON.stringify(IDENTITY_QUESTIONS))
		.update(String(REPEATS))
		.digest("hex")
		.slice(0, 12);
	return `${kiroVersion ?? "unknown"}|${ENGINE}|${model}|${promptHash}`;
}

const modelFor = (id: string): Model<any> => ({ ...LIVE_MODEL, id, name: `${id} [kiro]` }) as Model<any>;

describe.skipIf(!LIVE)(`live identity eval (engine ${ENGINE})`, () => {
	withRealHome();

	let kiroVersion: string | undefined;
	let piVersion: string | undefined;
	const savedResume = process.env.PI_KIRO_RESUME;

	beforeAll(async () => {
		const readiness = await checkKiroReadiness(true);
		if (!readiness.ready) throw new Error(`kiro-cli not ready: ${readiness.detail}`);
		kiroVersion = parseKiroVersion(readiness.version);
		piVersion = await resolvePiVersion();
		// Every conversation is independent: never resume a prior eval session.
		process.env.PI_KIRO_RESUME = "off";
	});

	afterAll(() => {
		if (savedResume === undefined) delete process.env.PI_KIRO_RESUME;
		else process.env.PI_KIRO_RESUME = savedResume;
		_resetAcpChildren();
	});

	for (const modelId of MODELS) {
		const expectation = expectationFor(modelId);
		it(
			`${modelId}: answers as pi (${expectation === "pass" ? "asserted" : "recorded only"})`,
			async () => {
				const key = cacheKey(modelId, kiroVersion);
				const line = identityLine({ piVersion, kiroVersion, engine: ENGINE, model: modelId });
				let record = FRESH ? undefined : readResults()[key];

				if (record) {
					console.info(`[identity-eval] reusing cached result for ${key} from ${record.at} (PI_KIRO_IDENTITY_FRESH=1 to re-measure)`);
				} else {
					const model = modelFor(modelId);
					const answers: AnswerRecord[] = [];
					for (const question of IDENTITY_QUESTIONS) {
						for (let repeat = 0; repeat < REPEATS; repeat++) {
							_resetSessions();
							_resetAcpSessions();
							_resetAcpChildren();
							const stream = USE_ACP
								? makeStreamViaAcp({ binaryPath: "kiro-cli", kiroVersion })(model, ctx([user(question)]))
								: makeStreamViaKiro({ binaryPath: "kiro-cli", kiroVersion })(model, ctx([user(question)]));
							const turn = await drainTurn(stream);
							answers.push({ question, repeat, text: turn.text, ...scoreIdentityAnswer(turn.text, line) });
						}
					}
					record = {
						key,
						model: modelId,
						engine: ENGINE,
						kiroVersion,
						piVersion,
						line,
						at: new Date().toISOString(),
						passed: answers.filter((a) => a.pass).length,
						total: answers.length,
						answers,
					};
					writeResult(record);
				}

				const failures = record.answers.filter((a) => !a.pass);
				console.info(
					`[identity-eval] ${modelId} engine ${ENGINE} kiro-cli ${kiroVersion ?? "unknown"}: ${record.passed}/${record.total} as pi` +
						(failures.length ? `; failures: ${failures.map((f) => `${f.reason}${f.claimed ? `(${f.claimed})` : ""}: ${JSON.stringify(f.text.slice(0, 80))}`).join(" | ")}` : ""),
				);

				// The run itself must be complete and real for either expectation.
				expect(record.total).toBe(IDENTITY_QUESTIONS.length * REPEATS);
				expect(record.answers.every((a) => a.text.trim().length > 0)).toBe(true);

				if (expectation === "pass") {
					expect(failures.map((f) => `${f.reason}: ${f.text}`)).toEqual([]);
				} else if (record.passed === record.total) {
					console.info(`[identity-eval] ${modelId} was expected to fail and passed ${record.total}/${record.total}: update expectationFor()`);
				}
			},
			TURN_BUDGET_MS * IDENTITY_QUESTIONS.length * REPEATS,
		);
	}
});
