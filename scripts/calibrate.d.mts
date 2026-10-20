/**
 * Types for scripts/calibrate.mjs, so test/calibrate.test.ts can import it
 * under `tsc --noEmit`. The script is a script: it stays JavaScript because it
 * is run with bare `node` from a README, with no build step in front of it.
 *
 * This file can drift from the implementation, since nothing compiles the two
 * together. test/calibrate.test.ts asserts the module's exported names against
 * a list, which fails when an export declared here stops existing.
 */
export declare const root: string;

export declare function slug(value: string): string;
export declare function rubricNumber(text: string): number;
export declare function runIdFor(input: { date: string; rubric: number; harness: string; model: string }): string;
export declare function blobShaOf(body: string | Buffer): string;
export declare function stripGitEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;

export interface CaseAlias {
	cited: string;
	target: string;
}
export interface CasePlan {
	name: string;
	ref: string;
	usesSetRef: boolean;
	aliases: CaseAlias[];
}
export declare function planCases(
	key: { ref: string; aliases?: Record<string, string>; cases: Record<string, { ref?: string }> },
	readCase: (name: string) => string,
): CasePlan[];

export interface LintNotes {
	external: string[];
	local: string[];
	proposed: string[];
	unresolvedSymbols: string[];
	placeholders: string[];
}
export declare function lintNotesOf(lintJson: unknown): LintNotes;

export interface AliasPlacement {
	from: string;
	to: string;
}
export declare function aliasPlacements(input: { sessionDir: string; aliases: CaseAlias[] }): AliasPlacement[];

export declare function promptFor(input: {
	inputDir: string;
	verdictPath: string;
	lintNotesPath: string;
	reviewerLine: string;
}): string;

export declare function verifyVerdict(input: { text: string; specBlob: string; reviewerLine: string }): {
	text: string;
	problems: string[];
	corrections: string[];
};

export declare function reviewerAgent(): {
	name: string;
	description: string;
	tools: string[];
	allowedTools: string[];
	mcpServers: Record<string, unknown>;
	includeMcpJson: boolean;
	resources: string[];
};

export interface ForbiddenBlob {
	label: string;
	sha: string;
}
export declare function leakReport(input: {
	forbidden: ForbiddenBlob[];
	isReachable: (sha: string) => boolean;
}): string | null;

export declare const LEAK_STRINGS: string[];
export declare function auditText(input: { text: string; otherPaths: string[] }): string[];
