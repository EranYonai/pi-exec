# pi-exec

Natural language in, one shell command out—confirmed, executed, reported.

```bash
pi --exec "find all PDF files larger than 50 MB under my home directory"
```

pi-exec makes one completion with pi's active model, accepts exactly one command, applies a safety lint, asks for confirmation, and runs one `bash -lc` child. There is no agent loop and
the model receives no tools.

Built on [pi](https://pi.dev) by
[@earendil-works](https://github.com/earendil-works/pi).

## Honest take

pi was not a great fit for the invisible, headless command launcher we wanted. We could not
make plain `pi --exec` run headlessly; the closest working form still needs
`pi -p --no-session --exec` and pi's session lifecycle. The extension works, but the
invocation is more awkward than the idea deserves. It was still a fun project and a useful
look at how far pi extensions can be pushed.

## Install

```bash
pi install npm:pi-exec
```

## Usage

```bash
# recommended one-shot; confirmation appears on the terminal
pi -p --no-session --exec "resize every PNG here to 50%"

# use pi's saved default model, or choose one with pi's native flag
pi --model openai-codex/gpt-5.6-luna -p --no-session --exec "count files"

# print only
pi -p --no-session --exec "find the process on port 3000" --exec-print

# run without confirmation (safety denials still apply)
pi -p --no-session --exec "show disk usage" --exec-yes

# longer execution timeout
pi -p --no-session --exec "re-encode every FLAC as MP3" --exec-timeout 900

# history and help
pi --exec-history 10
pi --exec-help
```

Inside pi, use `/exec <request>` and `/exec-history [n]`. The short wrapper
`scripts/pi-exec.sh "<request>" [pi flags]` delegates to the same extension.

pi-exec uses pi's active model and authentication. In `/model`, select a model and press
Ctrl+S to save it as pi's startup default.

## Flags

| Flag | Meaning |
|---|---|
| `--exec <request>` | Generate one command; absent means the extension does nothing |
| `--exec-yes` | Skip confirmation, but not safety lint |
| `--exec-print` | Print the command without running it |
| `--exec-timeout <seconds>` | Execution timeout; default 120 |
| `--exec-history <n>` | Print recent history |
| `--exec-help` | Print help |

Print mode confirms through `/dev/tty`, leaving stdout pipeable. Without a terminal it
defaults to a dry-run unless `--exec-yes` is supplied. JSON mode keeps stdout reserved for
pi's protocol.

## Safety

Hard-denied commands never run, even with `--exec-yes`: destructive root deletion,
filesystem creation, raw-device writes, fork bombs, root-wide chmod, remote scripts piped
to a shell, and power commands.

Risky commands require confirmation and show a warning: sudo, forced recursive deletion,
force push, hard reset, SIGKILL, and absolute-path redirects. The parser also refuses model
chatter, multiple command lines, malformed fences, and shell history expansion.

Exit codes are the child's code when executed, `130` when declined, `0` for dry-run/help,
and `1` for invalid input, refusal, lint denial, or generation failure.

## History

Outcomes are appended to `~/.pi/agent/cache/pi-exec/history.jsonl`. Failures to read or
write history never break execution. Child output is streamed, not stored. Delete the file
to reset it.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs strict TypeScript and enforces at least 95% coverage for lines,
branches, functions, and statements. Tests use fakes: no network or real shell.

See [docs/plan.md](docs/plan.md) for the concise design.

## License

MIT—see [LICENSE](LICENSE).
