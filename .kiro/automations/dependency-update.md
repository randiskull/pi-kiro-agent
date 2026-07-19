# Kiro Automation: dependency update

Kiro Automations are configured in the web UI (`app.kiro.dev/automations`), not
from a repo file — they run in a cloud sandbox on a schedule and open a pull
request with their results. This file is the **canonical prompt** for the
automation so the definition lives in version control and stays reviewable.

## Setup (one time)

1. Open `app.kiro.dev/automations` and create a new automation.
2. **Repository:** `randiskull/pi-kiro`.
3. **Schedule:** Weekly (`cron(0 8 ? * MON *)` — Mondays 08:00 UTC, after the
   security audit runs at 06:00 UTC).
4. **Prompt:** paste the block below verbatim.
5. Review the PRs it opens like any other contribution.

## Prompt

> You are performing a scheduled dependency update for the pi-kiro repository —
> a Pi coding-agent extension (TypeScript, Node >=22, ESM).
>
> Steps:
>
> 1. Run `npm outdated --json` to identify packages with newer versions.
> 2. For each outdated dependency:
>    - Check the changelog or release notes for breaking changes.
>    - If the update is a patch or minor with no breaking changes, update it.
>    - If the update is a major version, evaluate whether the breaking changes
>      affect pi-kiro. Only update if the migration is straightforward.
> 3. After updating `package.json`, run `npm install` to regenerate the lockfile.
> 4. Run `npm run check` (TypeScript) and `npm test` (Vitest) to verify nothing
>    breaks.
> 5. If tests fail after an update, revert that specific update and note it in
>    the PR body as needing manual attention.
>
> PR guidelines:
> - Title: "chore(deps): weekly dependency update"
> - Body: list each updated package with old → new version and a one-line
>   summary of notable changes.
> - If no updates are available or all updates fail tests, open no PR and
>   report "all dependencies up to date" or describe what failed.
>
> Constraints:
> - Do not update `peerDependencies` — those track upstream Pi versions.
> - Do not modify source code beyond what a dependency update requires.
> - Preserve the existing `engines.node` constraint.

## Relationship to other workflows

- `.github/workflows/ci.yml` — runs typecheck + tests on the resulting PR.
- `.github/workflows/security-audit.yml` — `npm audit` catches known
  vulnerabilities; this automation handles version freshness.
