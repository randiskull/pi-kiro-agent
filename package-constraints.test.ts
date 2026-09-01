/**
 * Regression test: ensures the @modelcontextprotocol/sdk version constraint
 * in package.json enforces the >=1.30.0 lower bound documented in README.
 *
 * README states: "@modelcontextprotocol/sdk is kept >=1.30 (clears the
 * @hono/node-server path-traversal chain)."
 *
 * This test fails if the constraint is reverted to ^1.29.0 or any range
 * that allows versions below 1.30.0.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const packageJson = JSON.parse(
	readFileSync(resolve(__dirname, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

describe("package.json security constraints", () => {
	it("@modelcontextprotocol/sdk lower bound is >=1.30.0 (clears @hono/node-server path-traversal chain)", () => {
		const constraint = packageJson.dependencies?.["@modelcontextprotocol/sdk"];
		expect(constraint, "@modelcontextprotocol/sdk must be present in dependencies").toBeDefined();

		// Extract the major.minor from the constraint to verify >= 1.30.
		// Matches caret/tilde/gte ranges like: ^1.30.0, ~1.30.0, >=1.30.0, ^2.0.0
		const match = constraint!.match(/^[~^>=]*(\d+)\.(\d+)/);
		expect(
			match,
			`@modelcontextprotocol/sdk constraint "${constraint}" could not be parsed as a semver range`,
		).not.toBeNull();

		const [, majorStr, minorStr] = match!;
		const major = parseInt(majorStr, 10);
		const minor = parseInt(minorStr, 10);

		// Must be >= 1.30: either major > 1, or major === 1 and minor >= 30
		const meetsMinimum = major > 1 || (major === 1 && minor >= 30);
		expect(
			meetsMinimum,
			`@modelcontextprotocol/sdk constraint "${constraint}" allows versions below 1.30.0. ` +
				"Must be at least ^1.30.0 to prevent @hono/node-server path-traversal chain (see README).",
		).toBe(true);
	});
});
