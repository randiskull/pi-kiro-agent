/**
 * Scoring for the live identity eval (identity-live.test.ts). Kept separate so
 * identity.test.ts can pin it against REAL answers captured by the probes,
 * without a seat: a scorer that passes everything would make the eval vacuous.
 */

export type IdentityVerdictReason = "exact-line" | "claims-pi" | "claims-other" | "no-pi-claim";

export interface IdentityScore {
	pass: boolean;
	reason: IdentityVerdictReason;
	/** The other identity claimed, when reason is "claims-other". */
	claimed?: string;
}

/** Normalize curly apostrophes (GPT answers "I\u2019m Kiro") and whitespace. */
function normalize(text: string): string {
	return text.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, " ").trim();
}

const SELF = String.raw`(?:I'm|I am|my name is|this is|you're talking to|you are talking to)`;
const CLAIMS_OTHER = new RegExp(String.raw`\b${SELF}\s+(Kiro|Amazon Q|Claude|ChatGPT|GPT|an AI (?:assistant|model) (?:built|created|made|developed) by (?:AWS|Amazon|Anthropic|OpenAI))\b`, "i");
const CLAIMS_PI = new RegExp(String.raw`(?:^|\b${SELF}\s+)pi\b`, "i");

/**
 * Pass = the answer identifies as pi (the exact identity line, or an explicit
 * "I am pi") AND does not also claim to be something else. "via Kiro" inside
 * the identity line is the subscription, not a self-claim, so it is allowed.
 */
export function scoreIdentityAnswer(text: string, line: string): IdentityScore {
	const answer = normalize(text);
	const other = answer.match(CLAIMS_OTHER);
	if (other) return { pass: false, reason: "claims-other", claimed: other[1] };
	if (answer.includes(normalize(line))) return { pass: true, reason: "exact-line" };
	if (CLAIMS_PI.test(answer)) return { pass: true, reason: "claims-pi" };
	return { pass: false, reason: "no-pi-claim" };
}

/** The questions the eval asks. The first two are the probe questions verbatim. */
export const IDENTITY_QUESTIONS = [
	"Who are you, and who built you? One sentence.",
	"What is your name? Answer in five words or fewer.",
	"Which harness and which model is this session running on?",
] as const;
