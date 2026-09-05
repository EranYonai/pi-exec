#!/usr/bin/env bash
#
# pi-exec — natural language in, one shell command out: generate → confirm → run.
#
# The idea came straight from pi's own homepage — its "Four modes" section
# (pi.dev / @earendil-works/pi-coding-agent) describing `pi -p` for scripts.
# Nobody had packaged it, so this is the lightweight version: pi's model writes
# the command, you approve it, bash runs it.
#
# Usage:
#   pi-exec "find all pdf files larger than 50MB in my home folder"
#   pi-exec kill the process listening on port 3000
#
# Exit codes: the executed command's exit code, 1 on generation/refusal,
# 130 when the user declines or aborts the confirmation.

set -euo pipefail

# ---------------------------------------------------------------- args ----

if [[ $# -eq 0 ]]; then
  echo "usage: pi-exec \"<description of the command you want>\"" >&2
  exit 1
fi

command -v pi >/dev/null 2>&1 || {
  echo "pi-exec: pi is not on PATH — install it: npm i -g @earendil-works/pi-coding-agent" >&2
  exit 1
}

PROMPT="$*"

# ------------------------------------------------------------- contract ----
# --system-prompt replaces pi's default prompt entirely: the model must emit
# ONLY the command — no markdown, no fences, no chatter.

SYSTEM_PROMPT='You are a command-line utility assistant. Output ONLY the executable shell command requested by the user, with no markdown formatting, no code fences, no backticks, no quotes around the output, and no explanations. Exactly one line. If the request cannot be fulfilled with a single shell command, output exactly: NOT_ONE_COMMAND: <reason>. Target shell: POSIX/bash. Current working directory: '"$(pwd)"

# ------------------------------------------------------------ generate -----

echo "pi-exec: generating command…" >&2

RAW="$(pi -p --no-session --system-prompt "$SYSTEM_PROMPT" "$PROMPT" </dev/null)"
# stdin is redirected for pi on purpose: pi reads piped stdin as prompt input,
# which would swallow the user's confirmation answer below. The prompt arrives
# via argv; stdin stays free for the y/N gate (TTY or pipe).

# --------------------------------------------------------------- parse ----
# Enforce the contract defensively: models fence sometimes. Strip fence
# lines, trim blanks, then require exactly one non-empty line.

CLEANED="$(printf '%s\n' "$RAW" | sed -e '/^```/d' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | awk 'NF { print; n++ } END { exit n == 1 ? 0 : 1 }')" \
  || {
    echo "pi-exec: model did not return a single clean command — nothing run. Raw output:" >&2
    printf '%s\n' "$RAW" >&2
    exit 1
  }

if [[ "$CLEANED" == "NOT_ONE_COMMAND:"* ]]; then
  echo "pi-exec: ${CLEANED#NOT_ONE_COMMAND: }" >&2
  exit 1
fi

CMD="$CLEANED"

# --------------------------------------------------------------- gate -----

printf '\nProposed command:\n  \033[1;32m%s\033[0m\n\n' "$CMD"

if ! read -r -p "Run this command? [y/N] " REPLY; then
  printf '\npi-exec: no confirmation (stdin closed) — canceled.\n' >&2
  exit 130
fi

case "$REPLY" in
  y | Y | yes | YES)
    ;;
  *)
    echo "Execution canceled."
    exit 130
    ;;
esac

# ---------------------------------------------------------------- run -----

printf '\n'
exec bash -lc "$CMD"