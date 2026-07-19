#!/usr/bin/env node
/**
 * Secret scanner for pi-kiro. Greps tracked text files for high-confidence
 * credential patterns (provider key prefixes, private-key PEM headers). Exits
 * non-zero when any match is found so CI can gate on it.
 *
 * Modes:
 *   node scripts/secret-scan.mjs --all           scan every git-tracked file
 *   node scripts/secret-scan.mjs --base <ref>    scan only files changed vs <ref>
 *   node scripts/secret-scan.mjs                  scan files changed vs HEAD
 *
 * The pattern set is deliberately narrow: each matches a token shape that is
 * almost never a false positive (fixed prefixes, PEM banners), so a hit is
 * worth blocking on. Broad "high-entropy string" heuristics are intentionally
 * omitted — they flag hashes, base64 blobs, and test fixtures.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** [label, regex] — regex is tested per line. */
const PATTERNS = [
	["AWS access key id", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/],
	["AWS secret access key assignment", /aws_secret_access_key\s*[=:]\s*['"][A-Za-z0-9/+]{40}['"]/i],
	["Private key (PEM)", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
	["GitHub token", /\bgh[posru]_[A-Za-z0-9]{36,}\b/],
	["GitHub fine-grained PAT", /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
	["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
	["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
	["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
	["Stripe secret key", /\bsk_live_[0-9A-Za-z]{24,}\b/],
	["Generic bearer secret assignment", /(?:api[_-]?key|secret|token|password)\s*[=:]\s*['"][A-Za-z0-9/+_-]{24,}['"]/i],
];

// Files/dirs never worth scanning: vendored code, the lockfile (npm integrity
// hashes trip the generic pattern), and this scanner (it contains the patterns).
const SKIP = [/(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)package-lock\.json$/, /(^|\/)scripts\/secret-scan\.mjs$/];

// The generic-assignment pattern can match documented example env values and
// placeholder fixtures. Allow an inline opt-out marker on the offending line.
const ALLOW_MARKER = /secret-scan:allow/;

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function trackedFiles() {
	const all = git(["ls-files"]).split("\n").filter(Boolean);
	return all.filter((file) => !SKIP.some((re) => re.test(file)));
}

function changedFiles(base) {
	const range = base ? `${base}...HEAD` : "HEAD";
	let out = "";
	try {
		out = git(["diff", "--name-only", "--diff-filter=ACM", range]);
	} catch {
		// base ref unavailable (shallow clone / first commit) — fall back to full tree
		return trackedFiles();
	}
	const files = out.split("\n").filter(Boolean);
	return files.filter((file) => !SKIP.some((re) => re.test(file)));
}

function isProbablyText(file) {
	try {
		if (statSync(file).size > 2_000_000) return false;
	} catch {
		return false;
	}
	try {
		const buf = readFileSync(file);
		// NUL byte ⇒ binary.
		return !buf.includes(0);
	} catch {
		return false;
	}
}

function main() {
	const argv = process.argv.slice(2);
	const all = argv.includes("--all");
	const baseIndex = argv.indexOf("--base");
	const base = baseIndex !== -1 ? argv[baseIndex + 1] : undefined;

	const files = all ? trackedFiles() : changedFiles(base);
	const findings = [];

	for (const file of files) {
		if (!isProbablyText(file)) continue;
		let contents;
		try {
			contents = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const lines = contents.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (ALLOW_MARKER.test(line)) continue;
			for (const [label, re] of PATTERNS) {
				if (re.test(line)) {
					findings.push({ file, line: i + 1, label });
				}
			}
		}
	}

	if (findings.length === 0) {
		console.log(`secret-scan: clean (${files.length} file(s) scanned).`);
		process.exit(0);
	}

	console.error(`secret-scan: ${findings.length} potential secret(s) found:\n`);
	for (const { file, line, label } of findings) {
		console.error(`  ${file}:${line}  ${label}`);
	}
	console.error(
		"\nIf a hit is a false positive (placeholder/example), add a `secret-scan:allow` comment on that line.",
	);
	process.exit(1);
}

main();
