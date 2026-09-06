# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — unreleased

Initial implementation of the pi-exec extension (design: `docs/plan.md`; verified specs:
`docs/implementation-brief.md`).

### Added

- Portable core engine (`src/core`, no pi imports, purity-test enforced):
  - output contract (`EXEC_SYSTEM_PROMPT`, `buildUserPrompt` with recent-history context)
  - strict parser: fences, quotes, shell-prompt markers, chatter, multi-line, length cap,
    and bash history-expansion (`!!`/`!N`) refusal — anything not one clean command
    line is refused
  - table-driven safety lint: 8 deny rules (rm-root, mkfs, dd-to-device,
    raw-device redirect, fork bomb, chmod-root-777, pipe-to-shell, power verbs —
    enforced even with `--exec-yes`) and 6 warn rules (sudo, scoped rm -rf,
    git push --force, git reset --hard, kill -9, absolute-path redirects)
  - pure orchestrator `planExec` (single injected `complete` seam) with headless
    dry-run-by-default safety
  - lightweight history cache: append-only JSONL at
    `~/.pi/agent/cache/pi-exec/history.jsonl`, failure-tolerant, never captures child
    output; last-3 commands injected as model reference context; `formatHistoryPreview`
    newest-first
- pi adapter (`src/pi`): `--exec`, `--exec-yes`, `--exec-print`, `--exec-timeout`,
  `--exec-history`, `--exec-help` flags; one-shot `session_start` wiring
  (startup-reason guarded, exit-code passthrough in print/json modes); `/exec` and
  `/exec-history` commands; streaming `bash -lc` exec seam with timeout/abort handling
  (exit 124 on kill); mode-aware reporting with TUI widget + RPC tail; **security-risk
  banner on stdout** for warn-class commands (shell-comment format, pipe-safe)
- **print-mode terminal confirmation (D-9)**: `pi -p --no-session --exec "…"` asks
  `Run this command? [y/N]` directly on `/dev/tty` — pi stays fully behind the scenes,
  no TUI. Declined → 130. Dry-run remains the default only without a terminal (CI,
  pipes); Ctrl+D ends pi cleanly with nothing executed
- **help menu (D-10)**: `--exec-help`, `pi --exec ""` (empty value, exit 0) and bare
  `/exec` print the full usage/safety/exit-code menu
- **performance (D-11)**: generation runs with `reasoning: "minimal"` — measured
  16.5s → 4.2s on glm-5.3:cloud (auto thinking was the wait, not pi's ~1s startup)
- **`--exec-model <provider/model-id>` (D-12)**: generation-model override resolved
  via the registry (unknown/malformed → exit 1); flash tiers bring the whole one-shot
  to ~2s
- **ran-command report (D-13)**: the final line names the executed command and its exit
  code — `pi-exec: ran: <command> (exit N)` — so transcripts are self-describing
- **wrapper is now the short face**: `pi-exec "<request>" [--flags…]` delegates to the
  extension (`pi -p --no-session --exec …`, `-e` resolved from the checkout or
  `PI_EXEC_EXTENSION`)
- v0 standalone wrapper `scripts/pi-exec.sh` (the verified reference implementation)
- CI (node 20/22 matrix) and publish pipeline (patch bump, provenance, GitHub release)
- Docs: README (usage, safety model, history, troubleshooting), AGENTS.md, this changelog

### Safety notes

- Bash history expansion (`!!`, `!-N`, `!cmd`) is refused at parse: it is a silent no-op
  in non-interactive `bash -lc`, so a confirmed command would not do what the user saw.
  The generation contract also forbids it.
- `shutdown`/`reboot`/`halt`/`poweroff` match anywhere in the command line — a
  deliberate over-block, documented in `src/core/lint.ts`.