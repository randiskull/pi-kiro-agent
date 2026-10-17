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
	version?: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	publishConfig?: { registry?: string; access?: string };
	files?: string[];
	pi?: { extensions?: string[] };
	overrides?: Record<string, string>;
};

const changelog = readFileSync(resolve(__dirname, "..", "CHANGELOG.md"), "utf8");

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

	/**
	 * `overrides` pins a transitive dependency to one exact version, which makes it
	 * a ceiling as well as a floor. The block these tests replace was added to clear
	 * an advisory (`brace-expansion@5.0.9`) and later became the reason three new
	 * ones were reported: upstream had already moved to the patched 5.0.12 and the
	 * pin dragged it back into the vulnerable range (4.0.0 - 5.0.11). Nothing warns
	 * about that. `npm ls` prints a neutral "overridden", and the dependency the pin
	 * applies to is dev-only here, so `npm audit --omit=dev` -- which is what CI
	 * gates on -- never sees it either.
	 *
	 * Two assertions rather than one, because the exception path is where this kind
	 * of gate usually dies: a bare `toEqual([])` has no way to admit a legitimate
	 * override, so the first contributor who needs one deletes the test instead. The
	 * name goes in ALLOWED_OVERRIDES with its reason, and the range it names still
	 * has to be a floor -- so the exception cannot reintroduce the pin this exists
	 * to prevent.
	 */
	/**
	 * `>=x.y.z` only. `^`, `~` and a bare version all cap the dependency somewhere.
	 * Two more forms are rejected on purpose: a compound range (`>=5.0.12 <6`) is a
	 * ceiling wearing a floor's clothes, and a pre-release floor (`>=5.0.12-0`)
	 * forces every consumer onto a pre-release. If one is genuinely needed, widen
	 * the pattern here -- `/^>=\d+\.\d+\.\d+(-[\w.]+)?$/` -- rather than working
	 * around this check at the call site.
	 */
	const isFloorRange = (range: string): boolean => /^>=\d+\.\d+\.\d+$/.test(range.trim());

	/**
	 * Dependencies allowed an `overrides` entry. Empty on purpose. Add a name here
	 * with the advisory it covers and why upstream cannot fix it; the floor check
	 * below then applies to its range.
	 */
	const ALLOWED_OVERRIDES: string[] = [];

	it("declares no unapproved dependency overrides (an exact pin is a ceiling)", () => {
		const unapproved = Object.keys(packageJson.overrides ?? {}).filter(
			(name) => !ALLOWED_OVERRIDES.includes(name),
		);
		expect(
			unapproved,
			"package.json overrides a dependency that is not in ALLOWED_OVERRIDES. An exact pin " +
				"there blocks the upstream security patches it was added to anticipate; prefer a " +
				"floor in `dependencies`, or add the name to ALLOWED_OVERRIDES in this test with " +
				"the reason (see README 'Security scanning').",
		).toEqual([]);
	});

	// Vacuous while ALLOWED_OVERRIDES is empty, which is the point of the next
	// test: the predicate is pinned against a known-bad and a known-good range so
	// a typo in the regex cannot make this pass by matching everything.
	it("an approved override names a floor, never a pinned version", () => {
		for (const name of ALLOWED_OVERRIDES) {
			const range = packageJson.overrides?.[name];
			expect(range, `ALLOWED_OVERRIDES names ${name}, which has no overrides entry`).toBeDefined();
			expect(
				isFloorRange(range as string),
				`overrides["${name}"] is "${range}". An approved override must be a floor ` +
					'(">=x.y.z"), so upstream patches above it still resolve.',
			).toBe(true);
		}
	});

	it("the floor check accepts only a bare `>=` floor", () => {
		expect(isFloorRange("5.0.9"), "a bare version is a pin").toBe(false);
		expect(isFloorRange("^5.0.12"), "a caret range caps at the next major").toBe(false);
		expect(isFloorRange("~5.0.12"), "a tilde range caps at the next minor").toBe(false);
		// Both are rejected deliberately rather than by omission -- see isFloorRange.
		expect(isFloorRange(">=5.0.12 <6"), "a compound range still has a ceiling").toBe(false);
		expect(isFloorRange(">=5.0.12-0"), "a pre-release floor forces a pre-release").toBe(false);
		expect(isFloorRange(">=5.0.12")).toBe(true);
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

/**
 * The versioning policy in docs/releasing.md, enforced where it can be.
 *
 * Which component to bump is judgement and no test can supply it. What a test can
 * supply is that the three places a version is written never disagree: package.json,
 * the CHANGELOG, and (in publish.yml) the git tag. Each disagreement has a failure
 * mode that is otherwise quiet. A bump with no changelog cut publishes a version
 * whose release notes are still filed under "Unreleased"; a cut with no bump leaves
 * the tag check in publish.yml as the only thing standing between main and a
 * mislabelled publish.
 */
/**
 * The `### Fixed` bullets of the Unreleased section that cite no test.
 *
 * A bullet passes by naming a test file (`test/....test.ts`), or by carrying an
 * explicit waiver, `(no test: why)`, for the fix that genuinely has none.
 *
 * The first form of this rule only fired on a bullet that also named a `src/`
 * file, which made the cheapest way to pass "do not name the file" -- and the
 * first entry it ever saw, the #58 timer-leak fix, named `armKill` and no path,
 * so it passed while citing nothing. An escape hatch that has to be written
 * down and reviewed is the point; a silent one is not.
 *
 * Released sections stay exempt: the rule postdates them.
 */
function uncitedFixes(text: string): string[] {
	const unreleased = /^## Unreleased\s*$/m.exec(text);
	if (!unreleased) return [];
	const rest = text.slice(unreleased.index + unreleased[0].length);
	const end = rest.search(/^## /m);
	const section = end === -1 ? rest : rest.slice(0, end);
	const fixed = /^### Fixed\s*$/m.exec(section);
	if (!fixed) return [];
	const after = section.slice(fixed.index + fixed[0].length);
	const stop = after.search(/^### /m);
	const body = stop === -1 ? after : after.slice(0, stop);
	const bullets = body.split(/\n(?=- )/).map((bullet) => bullet.trim()).filter((bullet) => bullet.startsWith("- "));
	const citesTest = (bullet: string) => /\btest\/[\w./-]+\.test\.ts\b/.test(bullet);
	// A waiver needs a reason: `(no test:)` and `(no test:   )` do not count.
	const waived = (bullet: string) => /\(no test:\s*\S[^)]*\)/.test(bullet);
	return bullets.filter((bullet) => !citesTest(bullet) && !waived(bullet));
}

describe("version and changelog agree (docs/releasing.md)", () => {
	/** `## 1.2.3 - 2026-01-01` headings, in file order. `## Unreleased` is skipped. */
	const releaseHeadings = [...changelog.matchAll(/^## (\d+)\.(\d+)\.(\d+)\b/gm)].map((m) => ({
		version: `${m[1]}.${m[2]}.${m[3]}`,
		parts: [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number],
	}));

	// Not vacuous: every assertion below is satisfied by an empty list, and a typo in
	// the heading regex would produce exactly that. Pin a release that has shipped.
	it("parses the changelog's release headings", () => {
		expect(
			releaseHeadings.length,
			"no `## X.Y.Z` headings matched: the regex and the changelog format have diverged",
		).toBeGreaterThanOrEqual(3);
		expect(releaseHeadings.map((h) => h.version)).toContain("0.2.1");
	});

	it("package.json version is a plain X.Y.Z", () => {
		expect(
			packageJson.version,
			"version must be an exact release number: a range or a `v` prefix breaks the tag match in publish.yml",
		).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("package.json version is the newest released changelog heading", () => {
		expect(
			packageJson.version,
			`package.json is ${packageJson.version} but the newest release in CHANGELOG.md is ` +
				`${releaseHeadings[0]?.version}. Bump and cut the changelog in the same commit: ` +
				"rename `## Unreleased` to `## <version> - <date>` (docs/releasing.md).",
		).toBe(releaseHeadings[0]?.version);
	});

	it("release headings descend, with no duplicates", () => {
		for (let i = 1; i < releaseHeadings.length; i++) {
			const newer = releaseHeadings[i - 1];
			const older = releaseHeadings[i];
			const delta = newer.parts.findIndex((part, index) => part !== older.parts[index]);
			expect(
				delta,
				`CHANGELOG.md lists ${newer.version} directly above ${older.version}, which is not a ` +
					"strict decrease (duplicate or out-of-order heading)",
			).toBeGreaterThanOrEqual(0);
			expect(
				newer.parts[delta] > older.parts[delta],
				`CHANGELOG.md lists ${newer.version} above ${older.version}; newest release goes first`,
			).toBe(true);
		}
	});

	// The release the version names must actually have notes. An entry cut to a bare
	// heading still satisfies every check above.
	it("the newest release has a non-empty body", () => {
		const version = packageJson.version ?? "";
		// Line-anchored, and the version must be followed by a separator, so
		// `## 0.3.0` cannot match inside a `## 0.3.0-rc1` heading above it and
		// slice the wrong section. Matches the anchoring used for releaseHeadings.
		const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}( |$)`, "m");
		const found = heading.exec(changelog);
		expect(found, `no heading for ${version} in CHANGELOG.md`).not.toBeNull();
		const rest = changelog.slice(found!.index + `## ${version}`.length);
		const end = rest.search(/^## /m);
		const body = end === -1 ? rest : rest.slice(0, end);
		expect(
			body.split("\n").filter((line) => line.startsWith("- ")).length,
			`the ${version} section in CHANGELOG.md has no bullet points`,
		).toBeGreaterThan(0);
	});

	it("every Unreleased ### Fixed entry cites the test that proves it, or waives it in writing", () => {
		const uncited = uncitedFixes(changelog);
		expect(
			uncited,
			"these Unreleased `### Fixed` bullets cite no `test/...test.ts`; name the test that fails " +
				"without the fix, so the claim and its gate are tied together, or write `(no test: why)` " +
				"to waive it on the record (docs/releasing.md)",
		).toEqual([]);
	});

	// Not vacuous: on a changelog with no Unreleased section the check above passes
	// trivially, so pin the parser on fixtures. This one exercises every verdict,
	// including the two shapes the first form of this rule let through, and places
	// ### Fixed between two other subsections so the parser cannot pass by only ever
	// looking at the first one.
	it("the citation check accepts a cited fix and a waived one, and catches the rest", () => {
		const fixture = [
			"## Unreleased",
			"",
			"### Added",
			"",
			"- `src/metering.ts` is new, not a fix, so it needs no citation.",
			"",
			"### Fixed",
			"",
			"- **Cited.** The router in `src/transport-utils.ts` resets on retry",
			"  (`test/painted-once.test.ts`).",
			"- **Waived.** A typo in a log line (no test: the string is not asserted anywhere).",
			"- **Uncited.** `src/stream-json-reader.ts` no longer mirrors message chunks.",
			"- **Names no file at all.** This is how the #58 entry passed the first form of the rule.",
			"- **Waiver with no reason.** (no test:)",
			"",
			"### Changed",
			"",
			"- `src/index.ts` is not a fix, so it needs no citation.",
			"",
			"## 0.4.0 - 2026-10-17",
			"",
			"### Fixed",
			"",
			"- `src/acp-transport.ts`, released before the rule.",
		].join("\n");
		expect(uncitedFixes(fixture)).toEqual([
			"- **Uncited.** `src/stream-json-reader.ts` no longer mirrors message chunks.",
			"- **Names no file at all.** This is how the #58 entry passed the first form of the rule.",
			"- **Waiver with no reason.** (no test:)",
		]);
	});

	// A cycle with nothing to fix has no Unreleased `### Fixed` at all. Unless the
	// search is confined to the Unreleased SECTION, the next `### Fixed` it finds is a
	// RELEASED one, and the whole back catalogue -- written before this rule -- is
	// reported as uncited. The fixture above cannot show that: its Unreleased section
	// does have a Fixed subsection.
	it("looks only inside Unreleased, so a cycle with no fixes does not report the back catalogue", () => {
		const fixture = [
			"## Unreleased",
			"",
			"### Changed",
			"",
			"- Nothing was fixed this cycle.",
			"",
			"## 0.4.0 - 2026-10-17",
			"",
			"### Fixed",
			"",
			"- **Released and uncited.** Exempt: the rule postdates it.",
			"- **Also released and uncited.**",
		].join("\n");
		expect(uncitedFixes(fixture)).toEqual([]);
	});

	// docs/releasing.md explains why the pi SDK devDependency is the only statement
	// of which host CI tests against, and why raising it is a minor. If the peer range
	// is ever narrowed, that reasoning is void and the doc is wrong.
	it("keeps the pi peer dependencies unpinned", () => {
		const peers = packageJson.peerDependencies;
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
			expect(
				peers?.[name],
				`${name} is the host application, installed by the user. A range here refuses installs ` +
					"on a newer pi before we have tested it; the drift tests are the compatibility " +
					"mechanism instead (docs/releasing.md).",
			).toBe("*");
		}
	});
});
