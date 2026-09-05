# pi-exec

**Natural language in, one shell command out — confirmed, executed, reported.**

```bash
pi --exec "find all pdf files larger than 50MB in my home folder"
```

The session's already-configured model translates your description into **one** shell
command (strict output contract), pi-exec shows it, you confirm, it runs with streamed
output, and pi exits with the command's own exit code. No agent loop, no tools, no context
window bloat — a single LLM completion plus one child process.

> **Thanks pi.** This idea came straight from [pi](https://pi.dev)
> ([@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi)) — its
> homepage's "Four modes" section (specifically `pi -p` for scripts) planted it. All
> credit for the idea to the pi team; the bugs are ours.

## Install

```bash
# install (once published)
pi install npm:pi-exec

# trial — nothing installed
pi -e npm:pi-exec --exec "show the 10 largest directories under ~"
```

## Usage

```bash
# one-shot, interactive: propose → confirm → stream → exit
pi --exec "resize all pngs in this folder to 50%"

# scripted / CI: headless auto-run, pi exits with the command's exit code
pi -p --no-session --exec "git shortlog -sn | head -5" --exec-yes

# dry run: just show me the command (stdout = exactly the command → pipeable)
pi --exec "kill whatever is listening on :3000" --exec-print

# slow command
pi --exec "re-encode all flac to mp3" --exec-timeout 900

# what did I run lately? (newest first, then exit)
pi --exec-history 10

# inside a running pi session
/exec show me the 10 largest directories under ~
/exec-history 5
```

`--no-session` is recommended for one-shots: pi-exec never persists anything itself
beyond its history cache, but pi would still write a session file for the run.

## Flags

| Flag | Type | Meaning |
|---|---|---|
| `--exec <prompt>` | string | the natural-language request; absent → the extension is inert |
| `--exec-yes` | boolean | skip the confirmation dialog (**safety lint still applies**) |
| `--exec-print` | boolean | never execute; print the proposed command only (dry run) |
| `--exec-timeout <sec>` | string | execution timeout in seconds (default 120) |
| `--exec-history <n>` | string | print the last N history entries and exit |

### Confirmation matrix

| Mode | default | `--exec-yes` | `--exec-print` |
|---|---|---|---|
| tui / rpc | confirm dialog | run | print only |
| print / json (headless) | **print only** (dry run) | run | print only |

Headless default is dry-run because there is no one to ask — safety by construction.

## Safety model

**The model proposes; lint gates; you decide.** `--exec-yes` skips the dialog, never the
safety lint.

- **Deny** (never runs, even with `--exec-yes`): `rm -rf /` variants, `mkfs`, `dd` to raw
  devices, redirects to raw disks, fork bombs, `chmod -R 777 /`, `curl … | sh`
  pipe-to-shell, `shutdown`/`reboot`/`halt`/`poweroff`.
- **Warn** (runs only after confirm; the reason is always visible): `sudo`, scoped
  `rm -rf`, `git push --force`, `git reset --hard`, `kill -9`, redirects to absolute
  paths outside the working directory. In headless dry-runs the risk is flagged on
  **stdout** as a shell-comment banner — impossible to miss, still pipe-safe:

  ```
  # ⚠ pi-exec: security risk — runs as root
  sudo ls
  ```

- The parser refuses anything that is not exactly one clean command line (fences,
  chatter, multiple lines, bash `!!` history expansion — a silent no-op in
  non-interactive shells), and the model output is never executed unlinted.

### Exit codes

| Path | Exit code |
|---|---|
| executed | the command's own exit code (`124` when killed by timeout/abort) |
| declined confirmation | `130` |
| dry run | `0` |
| generation error / parse refusal / lint deny / invalid flags | `1` |

## History cache

Every outcome is appended to `~/.pi/agent/cache/pi-exec/history.jsonl` — one JSON line
per entry: `{ ts, text, command, kind, warn?, exitCode?, cwd }`. Super lightweight on
purpose:

- Child **output** is never captured (it streams live; capturing would force buffering).
  Recorded: the request, the proposed command, the lint verdict, the exit code.
- Read/write failures never break an exec (worst case: empty history).
- The last 3 commands are offered to the model as reference context, so
  "rerun that ffmpeg command" resolves against real history.
- `/exec-history [n]` (in-session) and `pi --exec-history <n>` preview newest-first.
- Deleting the file resets the cache. No rotation in v1.

## The v0 wrapper

`scripts/pi-exec.sh` is the verified standalone wrapper that shipped the same UX before
the extension existed (`pi -p` under the hood, `read`-based confirm, `bash -lc` exec,
exit-code passthrough). It stays as the reference implementation of parse + confirm.

## Development

```bash
npm install
npm run check        # typecheck (strict) + coverage (95% gate, all metrics)
```

- `src/core` is the portable engine (parse, lint, contract, plan, history) — no pi
  imports, enforced by a purity test.
- `src/pi` is the thin adapter: flags, session wiring, streaming exec, mode-aware
  reporting. Test seams (`deps.complete`, `deps.exec`, `deps.historyPath`) mean no unit
  test touches a network or spawns a real shell.
- `docs/plan.md` is the design document; `docs/implementation-brief.md` records the
  verified pi API facts and binding specs the code follows.

## Troubleshooting

- **`pi -exec "…"` (single dash) is invalid** — commander parses it as a short-flag
  cluster (`Error: Unknown option: -exec`). The invocation is always `pi --exec "…"`.
- `--exec` needs a session start (any mode, including `-p`); `pi --help` and similar
  no-session invocations correctly do nothing.
- A warn-class command in dry-run stdout? That banner comment is deliberate — `sh`
  ignores it, so `pi --exec … --exec-print | sh` keeps working.

## Roadmap

- config-file lint overrides, `--exec-model` override
- Windows/powershell path
- richer history: search, rerun-by-id, optional child-output capture

## License

MIT — see [LICENSE](LICENSE).