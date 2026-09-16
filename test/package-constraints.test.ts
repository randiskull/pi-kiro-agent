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
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const packageJson = JSON.parse(
	readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
) as {
	dependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	publishConfig?: { registry?: string; access?: string };
	files?: string[];
	pi?: { extensions?: string[] };
};

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

describe("supply-chain constraints on the release path", () => {
	// A contributor with write access cannot publish (releases are tag-gated), but
	// an install-time lifecycle script would run on every consumer's machine at
	// `npm install` time, with no review gate between merge and execution. The
	// package deliberately has none, and this pins that.
	it("declares no install-time lifecycle scripts", () => {
		const forbidden = ["preinstall", "install", "postinstall", "prepare"];
		const present = forbidden.filter((name) => packageJson.scripts?.[name] !== undefined);
		expect(
			present,
			`install-time lifecycle scripts run on every consumer without review: ${present.join(", ")}`,
		).toEqual([]);
	});

	it("pins the publish registry to npmjs.org with public access", () => {
		expect(
			packageJson.publishConfig?.registry,
			"publishConfig.registry must stay pinned, or a publish follows whatever default registry the machine has (e.g. a private CodeArtifact repository)",
		).toBe("https://registry.npmjs.org/");
		expect(packageJson.publishConfig?.access).toBe("public");
	});

	it("gates publishes on the full verify suite", () => {
		expect(
			packageJson.scripts?.prepublishOnly,
			"prepublishOnly must run verify so a publish cannot skip typecheck, tests or the secret scan",
		).toBe("npm run verify");
	});
});

describe("published surface", () => {
	// The entry point is only exercised for real by installing the package: no
	// unit test imports it through the manifest. A typo here passes every gate
	// and only fails at `pi install` time, so it is pinned to a file on disk.
	it("pi.extensions points at files that exist", () => {
		const entries = packageJson.pi?.extensions;
		expect(entries, "pi.extensions must be declared or the extension never loads").toBeDefined();
		expect(entries?.length).toBeGreaterThan(0);
		for (const entry of entries ?? []) {
			expect(
				existsSync(resolve(__dirname, "..", entry)),
				`pi.extensions entry "${entry}" does not exist on disk`,
			).toBe(true);
		}
	});

	// `files` used to be a denylist ("*.ts" plus negations for the test files),
	// where any new root-level .ts shipped unless someone remembered to exclude
	// it. Keeping it negation-free means the published surface is opt-in.
	it("files is an allowlist, with no negated patterns", () => {
		const files = packageJson.files;
		expect(files, "files must be declared, or npm packs everything not gitignored").toBeDefined();
		const negations = (files ?? []).filter((pattern) => pattern.startsWith("!"));
		expect(
			negations,
			`a negated files pattern means the published surface is a denylist: ${negations.join(", ")}`,
		).toEqual([]);
	});

	// The README links to docs/integrations/*.md with relative paths. If docs/
	// stops shipping, those links break for anyone reading the installed copy.
	it("ships the docs the README links to", () => {
		expect(packageJson.files).toContain("docs/");
	});
});
