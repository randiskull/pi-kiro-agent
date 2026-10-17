# Releasing

## What a version number means here

The package is pre-1.0, so semver permits breaking changes in a minor. This is the
convention the project actually follows, which is narrower than that permission.

| Bump | When |
| --- | --- |
| **patch** (`0.3.0` to `0.3.1`) | Bug fixes, documentation, internal refactors, and dependency bumps that do **not** move a floor. Nothing a user types or sets changes meaning. |
| **minor** (`0.3.x` to `0.4.0`) | Any change to the user-visible surface, any raised floor (pi, kiro-cli, Node, or the MCP SDK), and any behaviour change a user could notice. While 0.x, breaking changes land here. |
| **major** (`1.0.0`) | Reserved for the first commitment to a stable surface. Not yet made. |

The user-visible surface is wider than the TypeScript exports, because almost
nobody imports this package. It is:

- the slash commands (`/kiro`, `/kiro-subagents`) and their argument grammar;
- the model ids a user types (`kiro/auto`, `kiro/router`, `kiro/<id>`);
- the `PI_KIRO_*` environment variables;
- `pi.extensions` and the `files` allowlist, which decide what pi loads from the
  published tarball;
- the minimum pi host and kiro-cli versions the code is tested against.

A change to any of those is at least a minor, even when no exported symbol moved.

## The pi host is a peer dependency at `*`, which makes version policy load-bearing

`@earendil-works/pi-coding-agent` and `pi-ai` are declared as peer dependencies at
`*`, deliberately. pi is the host application: the user installs it, not us, and a
range here would refuse installs for anyone on a newer pi before we had tested it.

The consequence is that **npm will never stop a mismatched install**, so nothing in
the resolver enforces host compatibility. Two mechanisms stand in for it, and both
have to be maintained by hand:

1. The pi SDK **devDependency**, which is the only statement of which host version
   CI exercises. Raising it is a **minor**, not a patch, for exactly that reason: it
   changes the claim the release makes about what it works with.
2. The drift tests, which derive their expectations from the installed pi's own
   `ExtensionAPI` type rather than a hardcoded list, so a new host method shows up as
   a failure instead of silence. `test/pi-transcript-context.test.ts` is the one that
   matters most: the bridge capture shim must no-op every host mutator pi declares,
   and that set is an allowlist, so each new pi release can add a method that leaks
   through until it is named.

A stale devDependency hides both. In 0.3.0 the range allowed pi 1.2 while the
lockfile still pinned 1.0.0, so `npm ci` had been testing against an SDK nobody ran,
and `registerToolRenderer` reached the real host undetected. **Check `pi --version`
against the lockfile at the start of every release**, not just the range in
`package.json`.

kiro-cli is a runtime binary rather than a dependency, so the same applies with no
resolver involvement at all. A change that needs a newer kiro-cli is a minor, and
the CHANGELOG entry has to say so.

## What is machine-checked, and what is judgement

Enforced, so a mistake fails CI or the publish:

- `package.json` version is plain `X.Y.Z`, and equals the newest released heading in
  `CHANGELOG.md`. A bump without a changelog cut fails, and a cut without a bump
  fails. (`test/package-constraints.test.ts`)
- Release headings are in strictly descending semver order, with no duplicates.
- The git tag matches `package.json`, or `publish.yml` refuses to publish.
- The tagged commit is an ancestor of `main`, so a tag on an unreviewed branch
  cannot publish.
- `prepublishOnly` runs the full verify suite, so no publish skips typecheck, tests
  or the secret scan.
- A `### Fixed` bullet under `## Unreleased` that names a source file (`src/...ts`)
  also names the test that proves the fix (`test/...test.ts`), so a claim cannot ship
  without its gate. Cite a test that fails with the fix reverted.
  (`test/package-constraints.test.ts`)

Judgement, so it needs a human:

- **Which** component to bump. Nothing can tell that a behaviour change is
  user-visible.
- Whether a breaking change is described as breaking in the CHANGELOG.

## Cutting a release

1. Confirm the host and the lockfile agree:

   ```
   pi --version
   node -p "require('./package-lock.json').packages['node_modules/@earendil-works/pi-coding-agent'].version"
   ```

   If they differ, raise the devDependency first and treat the release as a minor.

2. `npm run verify` and `npm audit --omit=dev`. Dev-only advisories inside pi's own
   dependency tree do not block a release; nothing in `--omit=dev` may be dirty,
   because that is what consumers install.

3. Pick the number from the table above.

4. Cut the CHANGELOG: rename `## Unreleased` to `## X.Y.Z - YYYY-MM-DD`. Do not
   leave an empty `## Unreleased` behind; the next change adds it back.

5. Bump the version and resync the lockfile:

   ```
   npm version X.Y.Z --no-git-tag-version
   npm install --package-lock-only
   ```

6. Open a PR and merge it. Merging publishes nothing.

7. Tag the merged commit on `main`:

   ```
   git switch main && git pull
   git tag vX.Y.Z && git push --tags
   ```

   The tag push is the only thing that publishes. `publish.yml` re-runs the version
   match, the ancestry check and `prepublishOnly` before `npm publish`.

## Provenance needs a public repository

Publishing uses npm trusted publishing over OIDC, with no token secret in the repo
and none to be added. npm attaches a provenance attestation automatically, **but
only while the repository is public**. On a private repo the publish still succeeds
and simply has no attestation, which is easy to miss because nothing fails.

So if a release is meant to carry provenance, confirm the repository is public
before pushing the tag, not after.
