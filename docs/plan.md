# pi-exec design

pi-exec turns a natural-language request into one shell command, asks for confirmation,
runs it, and reports the exit code. It performs one model completion and starts one child
process. It is not an agent loop and exposes no tools to the model.

## Flow

1. Use pi's active model through `ctx.modelRegistry`; pi owns model selection and auth.
2. Ask for exactly one command with a strict output contract.
3. Parse the response and reject chatter, multiple lines, history expansion, and malformed
   output.
4. Apply the deny/warn safety rules.
5. Print or confirm the command.
6. Run one `bash -lc` child and stream its output.
7. Record the outcome in the failure-tolerant history cache.

Use pi's native `--model provider/id` for a one-off model choice. Without it, pi-exec uses
the model saved in pi (`/model`, then Ctrl+S). pi-exec has no model configuration of its own.

## Interfaces

- `--exec <request>`: one-shot entry point.
- `/exec <request>`: in-session entry point.
- `--exec-yes`: skip confirmation, never safety lint.
- `--exec-print`: print the command without running it.
- `--exec-timeout <seconds>`: execution timeout; default 120.
- `--exec-history <n>` and `/exec-history [n]`: view recent outcomes.
- `--exec-help`, `--exec ""`, and bare `/exec`: show help.

The wrapper maps `pi-exec "<request>" [pi flags]` to
`pi -p --no-session --exec "<request>" [pi flags]`.

## Modes

- TUI/RPC use pi dialogs and notifications.
- Print mode confirms on `/dev/tty`, keeping stdout pipeable.
- Headless print mode without a terminal defaults to dry-run unless `--exec-yes` is set.
- JSON mode writes extension output to stderr because stdout belongs to pi's JSON protocol.
- Run mode leaves stdout to the child process.

## Safety

Deny rules never run, even with `--exec-yes`: destructive root deletion, filesystem
creation, raw-device writes, fork bombs, root-wide chmod, remote scripts piped to a shell,
and power commands.

Warn rules require confirmation and display a visible reason: sudo, forced recursive
deletion, force push, hard reset, SIGKILL, and redirects to absolute non-temporary paths.
Changes to either rule table require positive and negative tests plus a changelog note.

## History

Every outcome is appended as JSONL to
`~/.pi/agent/cache/pi-exec/history.jsonl`. Read and write errors are ignored. Child output
is not captured. The last three commands are included as reference context for generation.

## Exit codes

- Executed command: the child's exit code (`124` when killed).
- Declined confirmation: `130`.
- Dry-run or help: `0`.
- Invalid input, refusal, lint denial, or generation failure: `1`.

## Code boundaries

- `src/core`: portable contract, parser, lint, plan, and history. No pi imports.
- `src/pi`: pi registration, terminal/UI reporting, and child-process execution.
- `tests/core`: pure tests.
- `tests/pi`: adapter tests using injected completions/execution and mocked child processes.

Tests never call a model, network, or real shell. `npm run check` must keep lines, branches,
functions, and statements at or above 95%.
