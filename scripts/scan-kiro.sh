#!/bin/sh
# Kiro-driven full release audit of the working tree. Runs the local,
# authenticated kiro-cli (no API key, no cloud) over the repo and blocks only on
# a HIGH/security verdict. Used on-demand (`npm run scan:kiro`) and, opt-in, by
# the pre-push hook (PIKIRO_PREPUSH_KIRO_AUDIT=1).
#
# Exit codes: 0 = clean/PASS or kiro unavailable (advisory, never blocks on
# infra), 2 = BLOCK verdict emitted.
#
# Env:
#   PIKIRO_SCAN_MODEL   kiro model id (default: auto)
#   PIKIRO_SCAN_TIMEOUT seconds before giving up (default: 300)

set -eu

MODEL="${PIKIRO_SCAN_MODEL:-auto}"
TIMEOUT="${PIKIRO_SCAN_TIMEOUT:-300}"

if ! command -v kiro-cli >/dev/null 2>&1; then
	echo "scan:kiro: kiro-cli not on PATH — skipping AI audit (advisory)." >&2
	exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

OUT_DIR="$REPO_ROOT/scans"
mkdir -p "$OUT_DIR"
STAMP="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
OUT_FILE="$OUT_DIR/scan-$STAMP.md"

PROMPT='You are auditing the pi-kiro repository for release readiness — a Pi
coding-agent extension registering a `kiro` provider that delegates turns to a
local kiro-cli, plus a loopback MCP bridge exposing the calling session'"'"'s tools
to delegated runs.

Review the current working tree, most-severe first:
1. SECURITY — command/path injection in the kiro-cli spawn and MCP bridge; the
   trust boundary in bridge.ts (only user-scope packages may be bridged;
   project-scope settings from an untrusted repo must never inject an executed
   extension); the loopback endpoint auth; credential handling (there should be
   none).
2. CORRECTNESS — the <pi_final> sentinel protocol, ANSI/credits parsing, abort
   teardown, per-turn agent-profile cleanup.
3. DOCS — README claims vs actual code behavior.

Inspect source only; do not modify files or run project code. Do not weaken any
security control. Be concise. On the final line print exactly one of these
tokens verbatim (no markdown, no backticks, no emphasis):
  SCANVERDICT PASS   (nothing that should block a release)
  SCANVERDICT BLOCK  (a HIGH-severity or security issue that must be fixed first)'

echo "scan:kiro: auditing with kiro/$MODEL (timeout ${TIMEOUT}s)…" >&2

# Portable timeout: use `timeout` if present, else run directly.
RUN="kiro-cli chat --no-interactive --trust-all-tools"
[ "$MODEL" = "auto" ] || RUN="$RUN --model $MODEL"
if command -v timeout >/dev/null 2>&1; then
	RUN="timeout ${TIMEOUT} $RUN"
fi

# Capture output (tee to a gitignored report). </dev/null so the hook's stdin
# (push refs) is never consumed by kiro.
if ! $RUN "$PROMPT" </dev/null >"$OUT_FILE" 2>&1; then
	echo "scan:kiro: kiro-cli run failed or timed out — skipping (advisory)." >&2
	sed -n '1,40p' "$OUT_FILE" >&2 || true
	exit 0
fi

# Strip ANSI, show the report, then decide on the verdict. Kiro's TUI renders
# markdown emphasis/backticks into ANSI, so after stripping we also drop stray
# `_ * ` characters and collapse spaces before matching the sentinel — the
# match must fail CLOSED (block) rather than silently miss a mangled BLOCK.
strip() { sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$OUT_FILE"; }
strip

VERDICT_LINE="$(strip | tr -d '_*`' | tr -s ' ' | grep -i 'SCANVERDICT' | tail -1 || true)"

if printf '%s' "$VERDICT_LINE" | grep -qi 'SCANVERDICT *:* *BLOCK'; then
	echo "scan:kiro: BLOCK verdict — see $OUT_FILE" >&2
	exit 2
fi
if printf '%s' "$VERDICT_LINE" | grep -qi 'SCANVERDICT *:* *PASS'; then
	echo "scan:kiro: PASS (report: $OUT_FILE)" >&2
	exit 0
fi

# No parseable verdict — advisory run, don't block, but say so loudly.
echo "scan:kiro: no clear verdict from the model — treating as advisory (report: $OUT_FILE)." >&2
exit 0
