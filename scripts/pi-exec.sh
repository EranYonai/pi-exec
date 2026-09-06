#!/usr/bin/env bash
#
# pi-exec — natural language in, one shell command out: generate → confirm → run.
#
# Thin delegating launcher: the pi-exec extension loaded by pi is the whole
# engine (contract, parse, safety lint, terminal confirm, security banner,
# history, flags). This script only translates the short, friendly form
#
#   pi-exec "<request>" [pi flags…]
#
# into its exact equivalent
#
#   pi -p --no-session --exec "<request>" [flags…]
#
# The first argument is the request (quote it); every remaining argument is
# passed through to pi unchanged (--exec-yes, --exec-print, --exec-model, …).
#
# History note: the v0 wrapper did its own `pi --system-prompt` generation
# with bash-side parse/confirm and had to drain stdin (`< /dev/null`) because
# pi read piped stdin as prompt input. That trap is history now — pi reads
# the confirmation answer via /dev/tty, not stdin.
#
# The idea came straight from pi's own homepage — its "Four modes" section
# (pi.dev / @earendil-works/pi-coding-agent) describing `pi -p` for scripts.
# Nobody had packaged it, so this is the lightweight version: pi's model writes
# the command, you approve it, bash runs it.
#
# Exit codes: the executed command's exit code, 1 on generation/refusal or bad
# usage, 130 when the user declines or aborts the confirmation.

set -euo pipefail

# ---------------------------------------------------------------- args ----

if [ "$#" -eq 0 ]; then
  echo "usage: pi-exec \"<description of the command you want>\"" >&2
  exit 1
fi

command -v pi >/dev/null 2>&1 || {
  echo "pi-exec: pi is not on PATH — install it: npm i -g @earendil-works/pi-coding-agent" >&2
  exit 1
}

# ------------------------------------------------- which extension? ----
# The extension must be loaded for --exec to exist. Default: the repo
# checkout containing this script (scripts/pi-exec.sh → ../src/pi/index.ts).
# Override: PI_EXEC_EXTENSION=/path/to/index.ts. Empty + not installed →
# pi's own "Unknown option: --exec" is the accurate hint to install pi-exec.

EXT="${PI_EXEC_EXTENSION:-}"
if [ -z "$EXT" ] && [ -f "$(dirname "$0")/../src/pi/index.ts" ]; then
  EXT="$(cd "$(dirname "$0")/.." && pwd)/src/pi/index.ts"
fi

# ---------------------------------------------------------------- run -----

if [ -n "$EXT" ]; then
  exec pi -e "$EXT" -p --no-session --exec "$1" "${@:2}"
fi
exec pi -p --no-session --exec "$1" "${@:2}"