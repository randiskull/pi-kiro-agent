# Kiro Automation: pi-kiro security & release audit

Kiro Automations are configured in the web UI (`app.kiro.dev/automations`), not
from a repo file — they run in a cloud sandbox on a schedule and open a pull
request with their results. This file is the **canonical prompt** for the
automation so the scan definition lives in version control and stays reviewable.

## Setup (one time)

1. Open `app.kiro.dev/automations` and create a new automation.
2. **Repository:** `randiskull/pi-kiro-agent`.
3. **Schedule:** Weekly (or `cron(0 6 ? * MON *)` to align with the
   `security-audit.yml` dependency scan). Up to 5 schedules are allowed.
4. **Prompt:** paste the block below verbatim.
5. Review the PRs it opens like any other contribution.

## Prompt

> You are performing a scheduled security and release-readiness audit of the
> pi-kiro repository — a Pi coding-agent extension that registers a `kiro`
> provider delegating turns to a local kiro-cli, plus a loopback MCP bridge that
> exposes the calling session's tools to delegated runs.
>
> Review the current `main` for issues in these areas, most-severe first:
>
> 1. **Security** — command/path injection in the kiro-cli spawn and MCP bridge;
>    trust-boundary handling in `bridge.ts` (only user-scope packages may be
>    bridged — project-scope settings from an untrusted repo must never inject an
>    executed extension); the loopback MCP endpoint's bearer-token/auth path;
>    any credential handling (there should be none — all model traffic goes
>    through the user's own kiro-cli login).
> 2. **Correctness** — the sentinel output protocol (`<pi_final>…</pi_final>`),
>    ANSI/credits parsing, abort/kill-tree teardown, and per-turn agent-profile
>    cleanup.
> 3. **Docs accuracy** — README claims match code behavior (env vars, commands,
>    bridged tool list, effort mapping).
> 4. **Release readiness** — anything that would embarrass a public release.
> 5. **Open Dependabot PRs** — for any open `dependencies`-labeled PR, assess
>    supply-chain risk that `npm audit` wouldn't catch: unexpected new
>    transitive dependencies, unreviewed major-version bumps, maintainer/
>    provenance red flags, or changes to `@earendil-works/pi-ai` /
>    `@earendil-works/pi-coding-agent` peer-dependency ranges that could break
>    the `kiro` provider contract. Comment findings on the Dependabot PR itself
>    rather than opening a new one; approve-worthy routine bumps need no comment.
>
> Constraints: inspect the diff and source only; do not weaken any existing
> security control to make a test pass. For each confirmed issue, prefer a
> minimal fix with a regression test; if a finding is uncertain, describe it in
> the PR body rather than changing code. Keep the PR focused — one theme per PR.
> If nothing actionable is found, open no PR and report "clean".

## Relationship to other CI/CD workflows

The deterministic, no-API-key bar runs in Actions and gates merges:

- `.github/workflows/ci.yml` — typecheck, tests, secret scan on every push/PR.
- `.github/workflows/security-audit.yml` — `npm audit` + full-tree secret scan,
  weekly + on dependency changes + `workflow_dispatch`. Dependabot PRs touch
  `package.json`/`package-lock.json`, so they trigger this workflow automatically.
- `.github/dependabot.yml` — weekly PRs for npm dependencies (dev bumps grouped)
  and GitHub Actions versions used by the workflows above.

Kiro-powered CI/CD (requires `KIRO_API_KEY` repo secret):

- `.github/workflows/kiro.yml` — ad-hoc `/kiro` comment triggers and `kiro`
  label triggers via `kirodotdev-labs/kiro-action`.
- `.github/workflows/kiro-code-review.yml` — automated code review on every PR
  using the `.kiro/agents/code-reviewer.json` agent in headless mode.

Kiro Automations (configured at `app.kiro.dev/automations`):

- `dependency-update.md` — weekly dependency freshness check and update PRs.

This security scan Automation is the **AI-judgment** layer on top — the
reasoning-heavy review (logic, trust boundaries, docs drift, dependency-bump
risk) that a rule-based scanner can't do.
