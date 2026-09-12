#!/usr/bin/env bash
# pi-exec "<request>" [pi flags] → pi -p --no-session --exec "<request>" [pi flags]

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: pi-exec \"<description of the command you want>\"" >&2
  exit 1
fi

command -v pi >/dev/null 2>&1 || {
  echo "pi-exec: pi is not on PATH — install it: npm i -g @earendil-works/pi-coding-agent" >&2
  exit 1
}

EXT="${PI_EXEC_EXTENSION:-}"
if [ -z "$EXT" ] && [ -f "$(dirname "$0")/../src/pi/index.ts" ]; then
  EXT="$(cd "$(dirname "$0")/.." && pwd)/src/pi/index.ts"
fi

if [ -n "$EXT" ]; then
  exec pi -e "$EXT" -p --no-session --exec "$1" "${@:2}"
fi
exec pi -p --no-session --exec "$1" "${@:2}"
