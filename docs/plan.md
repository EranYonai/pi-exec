# pi-exec — Design & Implementation Plan

> Status: PLANNING (read-only session; this document is the only artifact).
> Repo: `EranYonai/pi-exec` (currently: `LICENSE` + empty git history).
> Target npm package: **`pi-exec`** (verified free on npm; repo, package, flag, command and
> script all share the one name — see §2).

---

## 1. What & why

**pi-exec** is a lightweight pi extension: natural language in, one shell command out,
confirmed, executed, reported.

```
pi --exec "find all pdf files larger than 50MB in my home folder"
```

The session's already-configured model translates the description into **one** shell command
(strict output contract), the extension shows it, the user confirms, the command runs with
streamed output, and pi exits. No agent loop, no tools, no context window bloat — a single
LLM completion plus one child process. That is the whole product.

### Non-goals

- Not a general agent (`pi` already is one). If the request needs multi-step reasoning or
  file edits, pi-exec should say so instead of improvising.
- No new API keys, no own model configuration — it reuses the session model and pi's auth
  (the codebase-memory lesson recorded in pi-weave: resolve the session model through
  `ctx.modelRegistry`, which owns auth).
- No background resources, no UI surfaces beyond confirm/notify. The only disk artifact is
  the lightweight history cache (§4.6) — no config, no session data.
- No Windows support in v1 (POSIX shell; `bash -lc`). Noted as a follow-up.

### Why a dedicated flag instead of just prompting pi?

`pi -p "find big pdfs"` starts a full agent run: system prompt, tools, permission flow,
session file. `pi --exec` is the fast path for the 90% case — "I know this is one
command, I just don't remember its syntax" — with a **single** completion, a hard output
contract, a one-keystroke confirm, and process exit with the command's own exit code.

---

## 2. Naming

| Surface | Name | Note |
|---|---|---|
| GitHub repo | `pi-exec` | already created (`EranYonai/pi-exec`) |
| npm package | `pi-exec` | free (checked 2025-09-05); one name everywhere: repo = package = flag stem = script |
| CLI flag | `--exec <prompt>` | long flag only. **`pi -exec` (single dash) is invalid** — commander parses it as a short-flag cluster; verified empirically: `Error: Unknown option: -exec`. The invocation is `pi --exec "…"` |
| In-session command | `/exec` | same pipeline, interactive; no built-in collision (checked pi's command list) |
| Import path | `pi-exec/core` | portable engine export, mirroring pi-weave's `./core` |

One name, everywhere: repo `EranYonai/pi-exec`, npm `pi-exec`, flag stem `--exec*`, command
`/exec`, wrapper `pi-exec`. README examples always show the double-dash form; `pi -exec "…"`
(single dash) belongs in a troubleshooting note, not in usage examples — it is a real
error users will type.

## 2.5 v0 — the `pi-exec` wrapper script (already implemented & verified)

Before the extension exists, the standalone wrapper delivers the same UX **today**, with
zero publishing: `~/.local/bin/pi-exec` on this machine (installed as `magic-exec`, renamed
when the project settled on pi-exec) and `scripts/pi-exec.sh` in
the repo once P0 lands.

```bash
pi-exec "find all pdf files larger than 50MB in my home folder"
```

Flow: join argv into a prompt → `pi -p --no-session --system-prompt "$CONTRACT" "$PROMPT"
(`< /dev/null` — **pi drains piped stdin as prompt input**, which otherwise swallows the
confirmation answer; found by testing) → strip fences, require exactly one non-empty
line → refuse `NOT_ONE_COMMAND: <reason>` → print command in green → `read` y/N →
`exec bash -lc "$CMD"` (exit-code passthrough; 1 = refusal/parse, 130 = declined).

Verified end-to-end on this machine (glm-5.3:cloud): clean generation, decline path,
approve path with correct exit code, stdin-closed edge, no-arg usage. The extension (§4)
is the same pipeline with lint, streaming, and flags — the script is the reference
implementation of parse + confirm.

---

## 3. How pi extensions actually work (facts this design is built on)

Verified against the installed pi docs (`docs/extensions.md`, `docs/packages.md`,
`examples/extensions/`) and pi-weave's adapter code — **not** the Python sketch:

1. An extension is a **TypeScript module with a default factory**:
   `export default function (pi: ExtensionAPI) { ... }`. Loaded via jiti; no build step.
2. **CLI flags are registered from the factory**: `pi.registerFlag("exec", { description,
   type: "string" })`, but flag *values* are only readable after startup — pi-weave/ssh.ts
   resolves them lazily on `session_start` ("CLI flags not available during factory").
3. **The factory must not start background resources.** Resource startup is deferred to
   `session_start`/handlers; `session_shutdown` is the teardown hook. pi-exec starts
   nothing — it only reacts.
4. **LLM calls without an agent turn**: `ctx.model` is the active model;
   `ctx.modelRegistry.complete(model, { systemPrompt, messages }, { maxTokens, signal })`
   returns an `AssistantMessage`; text via `contentText(message.content)` — the exact
   pattern pi-weave's `src/pi/summarize.ts` uses. Auth is pi's; no keys of our own.
5. **UI**: `ctx.ui.confirm(title, message) → Promise<boolean>`, `ctx.ui.notify(text, "info"|
   "warning"|"error")`. Guard dialogs with `ctx.hasUI` (false in print/json mode;
   `ctx.mode` is `"tui" | "rpc" | "json" | "print"`).
6. **Execution**: `pi.exec(command, args, { signal, timeout })` for captured output; the
   ssh.ts example shows the spawn-with-streaming `BashOperations` shape for live output.
7. **Exit**: `ctx.shutdown()` requests graceful shutdown in every mode and emits
   `session_shutdown`. For exit codes, set `process.exitCode` in print mode.
8. **Distribution**: package.json `pi` key → `{ "extensions": ["./src/pi/index.ts"] }`;
   install via `pi install npm:pi-exec`, trial via `pi -e npm:pi-exec`. Runtime
   deps must be in `dependencies` (production install), peers stay in `peerDependencies`.

---

## 4. Design

### 4.1 Flow

```
pi --exec "…prompt…"
  │
  ├─ factory: registerFlag(exec, exec-yes, exec-print, exec-timeout)
  │            registerCommand("exec"); register nothing else; start nothing
  │
  └─ session_start(reason) ── flag present? ── no ──► extension is a no-op for the session
                                        │ yes
                                        ▼
        1. resolve model     ctx.model? — null → notify + shutdown(exit 1)
        2. generate          modelRegistry.complete(model, CONTRACT_PROMPT + user text,
                              { maxTokens: 300, signal })   [ONE completion, no tools]
        3. parse             strip code fences/quotes/whitespace; reject >1 command line,
                            refuse "I can't" chatter → show raw + exit
        4. lint              hard-deny patterns (§4.4) → refuse + exit;
                            soft-warn patterns → flag in the confirm dialog
        5. confirm           TUI/RPC: ctx.ui.confirm("Run this command?", cmd)
                            print + terminal: y/N prompt on /dev/tty (pi stays invisible)
                            headless without a terminal (hasUI=false): default DRY-RUN
                            --exec-yes skips; --exec-print forces print-only
        6. execute           spawn("bash", ["-lc", cmd]) in ctx.cwd, stream stdout+stderr,
                            kill on ctx.signal / timeout (default 120s, flag-overridable)
        7. report            streamed output, exit code; pi session file not written by us
                            (--no-session recommended in docs for one-shots)
        7.5 record           append one JSONL entry to the history cache (§4.6) — every outcome
        8. shutdown          ctx.shutdown(); print mode: process.exitCode = command's code
```

`/exec <text>` inside a session reuses steps 1–7 and reports via `ctx.ui.notify`
(plus a final confirm); it does not shut down.

### 4.2 Layers (pi-weave hard rule #3: core is portable)

```
src/core/            No @earendil-works/*, no typebox, no node built-ins beyond std.
  contract.ts        system prompt + output contract builder
  parse.ts           model-output → command string (fences, quotes, multi-line, refusal)
  lint.ts            classify: ok | warn(reason) | deny(reason); exported rule tables
  types.ts           ExecRequest, ParsedCommand, LintVerdict, RunPlan, HistoryEntry
  history.ts         append-only JSONL cache: append/read/preview (failure-tolerant)
  index.ts           orchestrator: (req, deps) → RunPlan  [pure; deps-injected]

src/pi/
  index.ts           factory: flags, command, session_start wiring, shutdown
  run.ts             adapter: model call via modelRegistry (seam: deps.complete),
                    confirm via ctx.ui, exec via spawn (seam: deps.exec),
                    error → notify/exit-code mapping

tests/
  core/              parse, lint, contract, orchestrator — pure, no network
  pi/                adapter wiring with fake complete/exec/ui — no network
```

The two seams (`deps.complete`, `deps.exec`) are the pi-weave testing pattern
(`createModelSummarizer`'s `deps.complete`): unit tests inject fakes and never touch a
network or spawn a real shell.

### 4.3 Flag & command surface

| Flag | Type | Meaning |
|---|---|---|
| `--exec <prompt>` | string | the natural-language request; absent → extension no-ops |
| `--exec-yes` | boolean | skip confirmation (still refuses hard-denied commands) |
| `--exec-print` | boolean | never execute; print the proposed command only (dry run) |
| `--exec-timeout <sec>` | number | execution timeout, default 120 |
| `--exec-history <n>` | string | print the last N cache entries (newest first) and exit; `/exec-history [n]` is the in-session form |
| `--exec-help` | boolean | print the pi-exec help menu and exit (same menu for `--exec ""` and bare `/exec`) |

Confirmation matrix:

| Mode | default | `--exec-yes` | `--exec-print` |
|---|---|---|---|
| tui / rpc | confirm dialog | run | print only |
| print + controlling terminal | **y/N prompt on /dev/tty** | run | print only |
| print / json, no terminal | **print only** (dry run) | run | print only |

Headless default is dry-run because there is no one to ask — but when a controlling terminal
exists, the extension asks directly on /dev/tty (pi stays behind the scenes, no TUI), so the
recommended one-shot is `pi -p --no-session --exec "…"`.

### 4.4 Safety model

1. **Output contract**: the system prompt demands exactly one executable command line, no
   markdown, no backticks, no explanation. Parser enforces it; anything else is a refusal
   with the raw output shown.
2. **Lint classify** (pure function, exported tables → tested, reviewable):
   - **deny** (never run, even with `--exec-yes`): `rm -rf /` variants, `mkfs`,
     `dd … of=/dev/…`, writes to raw devices, fork bombs (`:(){ … };:`), `chmod -R 777 /`,
     `curl … | sh` piped-to-shell patterns, `> /dev/sda`, `shutdown`/`reboot`/`halt`.
   - **warn** (runs only after confirm, dialog shows the reason): `sudo`, `rm -rf` (scoped),
     `git push --force`, `git reset --hard`, `kill -9`, anything redirecting to files
     outside `ctx.cwd`… v1 keeps this list small and honest; over-blocking is its own bug.
   - **ok**: everything else.
3. **Confirm-by-default**, dry-run headless default, `--exec-yes` cannot bypass deny.
4. **Abort-aware**: model call and child process both honor `ctx.signal` (Esc/Ctrl+C).
5. **Minimal persistence**: the only disk artifact is the history cache (§4.6) — append-only
   JSONL, failure-tolerant, never captures child output. Docs still recommend `--no-session`
   for one-shots (pi's session file is pi's, not ours, to suppress).

### 4.5 Key decisions

- **D1 — single completion, not an agent turn.** The model gets the contract prompt and
  the user text; no tools, no system prompt of pi's, no session context. Deterministic,
  cheap, fast; the failure mode is a bad command, which lint + confirm gate.
- **D2 — session model via `modelRegistry.complete`.** No keys, no provider config, works
  with whatever the user already pays for. Null model (headless without provider) → clean
  error, exit 1.
- **D3 — `bash -lc` spawn with streaming**, not `pi.exec`: live output is the point;
  `pi.exec`'s captured result is the fallback for tests only via the exec seam.
- **D4 — exit-code passthrough** in print mode (`process.exitCode`), so
  `pi --exec "…" --exec-yes` is scriptable and composable in pipes.
- **D5 — one name: `pi-exec`.** Repo, npm package, flag stem (`--exec*`), command (`/exec`),
  wrapper script — all identical. Single-dash `-exec` verified invalid (see §2); docs show
  `--exec` only.
- **D6 — no config files in v1.** Flags only. A settings-driven lint/config can come later;
  v1 ships zero configuration surface. (The history cache is data, not configuration.)
- **D7 — no skill in v1.** pi-weave ships skills; this extension's whole surface is one
  flag + one command, so a skill would be redundant. Revisit if interactive refactoring
  ("make that `tar` command safer") is wanted.

### 4.6 History cache (lightweight, always-on)

Owner decision: pull P6's "history file" candidate into v1, as a super-lightweight cache.
Every exec outcome — input (the request) and output (the proposed command, lint verdict,
exit code) — is appended locally, referable later and previewable. This section replaces the
old blanket "no persistence" rule for this one artifact; nothing else is ever written.

- **File**: `~/.pi/agent/cache/pi-exec/history.jsonl` — append-only, one JSON object per line:
  `{ ts, text, command, kind, warn?, exitCode?, cwd }` with `kind ∈ run | dry-run |
  declined | refuse | error`. Child process output is deliberately NOT captured (it streams
  live; capturing would force unbounded buffering — that is the "super lightweight" call).
  No rotation in v1; deleting the file resets the history.
- **Failure-tolerant**: read/write errors are swallowed (empty list / skipped append) — the
  cache may never break an exec.
- **Refer**: the last 3 recorded commands are injected into the generation prompt as
  reference context, so "run that ffmpeg command again" resolves against real history.
- **Preview**: `/exec-history [n]` in-session (default 10) and one-shot
  `pi --exec-history <n>` (newest first, then exit).

---

## 5. Requirements

### Functional

| # | Requirement |
|---|---|
| FR1 | `pi --exec "<text>"` proposes exactly one shell command derived from `<text>` |
| FR2 | Proposed command is confirmed before execution — dialog in TUI/RPC, terminal y/N prompt (on /dev/tty) in print mode when a controlling terminal exists; headless without a terminal defaults to dry-run |
| FR3 | Execution streams stdout/stderr live; supports `--exec-timeout`, Ctrl+C abort |
| FR4 | Exit code of `pi` (print mode) equals the command's exit code; refusals exit non-zero |
| FR5 | `/exec <text>` works inside a running session without ending it |
| FR6 | Absent flag ⇒ extension is inert (no events handled beyond registration, no status, no writes) |
| FR7 | No-model, empty-parse, and lint-deny paths all produce a clear message and correct exit code |
| FR8 | Every outcome is appended to the history cache; `/exec-history [n]` and `--exec-history <n>` preview it; the last 3 commands feed the model as reference context |
| FR9 | `--exec-help`, `--exec ""` (empty value) and bare `/exec` print the pi-exec help menu (flag forms exit 0, no exec pipeline) |

### Safety

| # | Requirement |
|---|---|
| SR1 | Hard-deny list is enforced even with `--exec-yes` |
| SR2 | Warn-class commands show the reason in the confirm dialog |
| SR3 | Model output is never executed unparseable/unlinted; fences and chatter are stripped or refused |
| SR4 | The only disk write is the history cache (§4.6); no child output, no session data, no config |

### Non-functional

| # | Requirement |
|---|---|
| NR1 | Zero runtime `dependencies`; peers only (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) — pi-exec must stay install-light |
| NR2 | Coverage ≥ 95% lines/branches/functions/statements (pi-weave gate, vitest thresholds) |
| NR3 | `src/core` imports no `@earendil-works/*` (enforced by review + a unit-test import scan) |
| NR4 | Node 20 & 22 on CI; engines `>=20.13.0` |
| NR5 | Typecheck strict (pi-weave tsconfig: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax) |

### Infrastructure

| # | Requirement |
|---|---|
| IR1 | npm publish from CI on push to `main`: check → sync version to latest published → bump patch → tag → `npm publish --provenance --access public` → GitHub release |
| IR2 | CI matrix (node 20/22) runs `npm ci && npm run check` on PRs and main |
| IR3 | `NPM_TOKEN` secret + `id-token: write` (provenance) configured once in repo settings |
| IR4 | `.gitignore` mirrors pi-weave minus the weave-specific entries |

---

## 6. Usage (the shipped UX)

```bash
# today, before anything is published — the v0 wrapper (§2.5)
pi-exec "find all pdf files larger than 50MB in my home folder"

# trial — nothing installed
pi -e npm:pi-exec --exec "find all pdf files larger than 50MB in my home folder"

# install
pi install npm:pi-exec

# one-shot, interactive, NO pi interface: propose → confirm on your terminal → stream → exit
pi -p --no-session --exec "resize all pngs in this folder to 50%"

# same, but inside the pi TUI (opens the full interface)
pi --exec "resize all pngs in this folder to 50%"

# scripted / CI: headless auto-run, pi exits with the command's exit code
pi -p --no-session --exec "git shortlog -sn | head -5" --exec-yes

# dry run: just show me the command
pi --exec "kill whatever is listening on :3000" --exec-print

# slow command
pi --exec "re-encode all flac to mp3" --exec-timeout 900

# inside a running pi session
/exec show me the 10 largest directories under ~

# what did I run lately? (newest first, then exit)
pi --exec-history 10

# same, inside a session
/exec-history 5

# help menu (also: pi --exec "" — an empty value)
pi --exec-help
```

Docs promise: **the model proposes; lint gates; you decide.** `--exec-yes` is
documented as "skip the dialog", never "skip the safety lint".

---

## 7. Repository & infrastructure (mirror of pi-weave)

### 7.1 `.gitignore` (pi-weave's, minus weave-specific lines)

```gitignore
node_modules/
coverage/
dist/
*.log
.DS_Store

# local pi harness config (see AGENTS.md smoke instructions)
.pi/
```

pi-weave's `!src/web/client/dist/` re-include and `.okf/` are weave-specific — dropped.

### 7.2 `package.json`

```jsonc
{
  "name": "pi-exec",
  "version": "0.1.0",
  "description": "Natural language → one shell command → confirm → run. A lightweight pi extension: pi --exec \"explanation of command\".",
  "type": "module",
  "sideEffects": false,
  "publishConfig": { "access": "public" },
  "keywords": ["pi-package", "cli", "shell", "ai", "productivity"],
  "license": "MIT",
  "author": "Eran Yonai <yonai.eran@gmail.com>",
  "repository": { "type": "git", "url": "git+https://github.com/EranYonai/pi-exec.git" },
  "homepage": "https://github.com/EranYonai/pi-exec#readme",
  "bugs": "https://github.com/EranYonai/pi-exec/issues",
  "engines": { "node": ">=20.13.0" },
  "exports": { "./core": "./src/core/index.ts" },
  "files": ["src", "README.md", "LICENSE"],
  "pi": {
    "extensions": ["./src/pi/index.ts"]
  },
  "scripts": {
    "test": "vitest run",
    "coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm run coverage",
    "prepublishOnly": "npm run check"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "^0.84.2",
    "@earendil-works/pi-coding-agent": "^0.84.2",
    "@types/node": "^24.0.0",
    "@vitest/coverage-v8": "^3.2.4",
    "typebox": "1.3.7",
    "typescript": "^5.8.0",
    "vitest": "^3.2.4"
  }
}
```

Differences from pi-weave, all deliberate: no `pi.image` (no logo yet), no `pi-tui`
peer (no custom TUI rendering), no build scripts (no web client), no `skills/` (D7).

### 7.3 `tsconfig.json` / `vitest.config.ts`

Copy pi-weave's `tsconfig.json` verbatim (ES2022, bundler resolution, strict +
noUncheckedIndexedAccess + exactOptionalPropertyTypes + verbatimModuleSyntax, noEmit,
include `src/**/*.ts`, `tests/**/*.ts`, config file). vitest: same include/coverage
block, thresholds 95/95/95/95, no exclusions needed (no type-only module planned — if
one appears, document it like pi-weave's `types.ts` note).

### 7.4 `.github/workflows/ci.yml` — identical shape to pi-weave

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    name: check (node ${{ matrix.node }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: ["20", "22"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run check
```

### 7.5 `.github/workflows/publish.yml` — pi-weave's pipeline, `pi-weave`→`pi-exec`

```yaml
name: Publish
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: write
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    if: github.event.head_commit == null || !contains(github.event.head_commit.message, '[skip ci]')
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: npm
      - name: Configure Git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
      - run: npm ci
      - run: npm run check
      - name: Bump patch version
        run: |
          LATEST=$(npm view pi-exec version 2>/dev/null || echo "0.1.0")
          npm version "$LATEST" --no-git-tag-version --allow-same-version
          VERSION=$(npm version patch --no-git-tag-version)
          echo "VERSION=$VERSION" >> "$GITHUB_ENV"
          git tag "$VERSION" -f
      - run: git push origin --tags --force
      - name: Publish to npm
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - name: Create GitHub Release
        run: gh release create "$VERSION" --title "$VERSION" --generate-notes
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Why this shape (inherited from pi-weave): push-to-main = release; version syncs against the
*published* latest so a force-push history rewrite can't downgrade; `id-token: write`
enables provenance; `[skip ci]` in a commit message skips the release.

### 7.6 `AGENTS.md` hard rules (adapted)

1. Never commit directly to `main`; feature branch + PR.
2. Coverage ≥ 95% on all four metrics; tests written with the feature.
3. `src/core` never imports `@earendil-works/*` or `typebox`.
4. The lint deny-list changes require a test and a CHANGELOG note (it's a security surface).
5. Smoke test: `pi -e . --exec "echo hello from exec" --exec-print`.

### 7.7 One-time GitHub setup (manual, before first merge to main)

1. `npm adduser`-ready token: create **Automation**-type npm token → repo secret `NPM_TOKEN`.
2. Settings → Actions → permit `id-token: write` (default with the workflow's `permissions`).
3. Branch protection on `main`: require CI check, no direct pushes.
4. First publish will be `0.1.1` (pipeline bumps patch from `0.1.0`); tag `v0.1.1` + release
   are automatic.

---

## 8. Code sketches

### `src/core/contract.ts`

```ts
export const EXEC_SYSTEM_PROMPT = [
  "You are a command-line utility assistant.",
  "Given a request, output ONLY the single shell command that fulfills it.",
  "Rules: no markdown, no code fences, no backticks, no quotes around the output,",
  "no explanation, no commentary. One line. If the request needs multiple steps or",
  "cannot be done with one command, output exactly: NOT_ONE_COMMAND: <reason>.",
  "Target shell: POSIX/bash. Working directory is the user's current directory.",
].join("\n");

export function buildUserPrompt(request: string, cwd: string): string { … }
```

### `src/core/parse.ts`

```ts
export type ParsedCommand =
  | { kind: "command"; command: string }
  | { kind: "refusal"; reason: string };   // NOT_ONE_COMMAND, chatter, multi-line

export function parseModelOutput(raw: string): ParsedCommand;
// strip ```fences``` / surrounding quotes / trailing whitespace;
// ≤1 line; reject prose around the command; length cap (e.g. 2000 chars).
```

### `src/core/lint.ts`

```ts
export type LintVerdict =
  | { verdict: "ok" }
  | { verdict: "warn"; reason: string }
  | { verdict: "deny"; reason: string };

export function lintCommand(command: string): LintVerdict;   // pure, table-driven
export const DENY_RULES: readonly LintRule[];               // exported for tests/docs
export const WARN_RULES: readonly LintRule[];
```

### `src/core/index.ts` — orchestrator (pure)

```ts
export interface ExecDeps {
  complete: (systemPrompt: string, userPrompt: string, opts: { maxTokens: number; signal?: AbortSignal }) => Promise<string>;
}
export interface ExecRequest { text: string; cwd: string; yes: boolean; printOnly: boolean; timeoutSec: number; hasUI: boolean; }
export type ExecPlan =
  | { kind: "run"; command: string; warn?: string }   // confirm unless yes||printOnly
  | { kind: "dry-run"; command: string; warn?: string }
  | { kind: "refuse"; reason: string; exitCode: 1 }
  | { kind: "error"; reason: string; exitCode: 1 };   // no model, empty output, parse fail

export async function planExec(req: ExecRequest, deps: ExecDeps): Promise<ExecPlan>;
```

Core decides; adapter reports. Everything above is unit-testable with a fake `complete`.

### `src/pi/run.ts` — adapter (thin)

```ts
export interface RunDeps {
  complete?: CompleteFn;                 // seam, default: ctx.modelRegistry.complete
  exec?: ExecFn;                         // seam, default: spawn("bash", ["-lc", cmd]) streaming
}
export async function runExec(ctx: ExtensionContext | ExtensionCommandContext,
                                   req: ExecRequest, deps: RunDeps = {}): Promise<number /* exitCode */>;
// - plan = planExec(...)
// - refuse/error → ctx.ui.notify(msg, "warning"|"error") (notify guarded by ctx.hasUI; always process.exitCode in print mode)
// - run: if !req.yes && req.hasUI → ctx.ui.confirm("Run this command?", display(command, warn))
// - exec with AbortSignal.any(ctx.signal, AbortSignal.timeout(req.timeoutSec))
// - dry-run / print mode → print command (+warn) only
```

### `src/pi/index.ts` — factory

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piExec(pi: ExtensionAPI): void {
  pi.registerFlag("exec", { description: "Generate & run one shell command from a natural-language request", type: "string" });
  pi.registerFlag("exec-yes", { description: "Skip the confirmation dialog (lint still applies)", type: "boolean", default: false });
  pi.registerFlag("exec-print", { description: "Print the proposed command without running it", type: "boolean", default: false });
  pi.registerFlag("exec-timeout", { description: "Execution timeout in seconds (default 120)", type: "number", default: 120 });

  pi.on("session_start", async (_event, ctx) => {
    const text = pi.getFlag("exec") as string | undefined;
    if (!text) return;                                   // inert for normal sessions
    const code = await runExec(ctx, requestFromFlags(pi, text, ctx));
    if (ctx.mode === "print") process.exitCode = code;
    await ctx.shutdown();                                // one-shot: done means done
  });

  pi.registerCommand("exec", {
    description: "Generate & run one shell command from a natural-language request",
    handler: async (args, ctx) => {
      if (!args.trim()) return ctx.ui.notify("usage: /exec <request>", "warning");
      await runExec(ctx, { text: args, hasUI: ctx.hasUI, /* … defaults */ });
    },
  });
}
```

(Also: `session_shutdown` handler is unnecessary — nothing is started; that absence is a
feature and keeps the extension honest with pi's "no background resources" rule.)

---

## 9. Implementation phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| **P0 — scaffold** | repo files: package.json, tsconfig, vitest config, .gitignore, AGENTS.md, empty src/core+src/pi, workflows ci.yml+publish.yml, README (with pi credit, §12) + `scripts/pi-exec.sh` (the verified v0 wrapper, §2.5), CHANGELOG.md | `npm install && npm run check` green on empty suites; `scripts/pi-exec.sh "echo hi"` declines cleanly |
| **P1 — core engine** | contract.ts, parse.ts, lint.ts, history.ts, index.ts + full unit suites (fake complete only) | ≥95% coverage on core; NR3 import-scan test passes |
| **P2 — pi adapter** | flags, session_start wiring, /exec + /exec-history commands, run.ts with exec seam + adapter tests (fake exec) | `pi -e . --exec "echo hi" --exec-print` prints `echo hi` end-to-end; the outcome lands in the history cache |
| **P3 — execution + UX polish** | streaming output, timeout, abort wiring, exit-code passthrough, warn-reason display in confirm | manual smoke matrix (tui confirm / print dry-run / -yes / deny refusal) |
| **P4 — docs** | README: usage (§6), the pi credit section (§12), wrapper + extension install paths; this plan stays as docs/plan.md; CHANGELOG.md | README renders; usage commands verified by hand |
| **P5 — release infra** | push branch → PR → CI green → merge; pipeline publishes 0.1.1 with provenance + release notes | `pi -e npm:pi-exec --exec …` works from the published package |
| **P6 — v1.1 candidates (post-release, not blockers)** | config-file lint overrides, `--exec-model` override, Windows/powershell path, richer history (search, rerun-by-id, child-output capture) — the basic cache itself ships in v1 (§4.6) | discussed in README "Roadmap" |

---

## 10. Test plan

| Suite | What | Seams |
|---|---|---|
| `tests/core/parse.test.ts` | fences, quotes, multi-line, chatter, NOT_ONE_COMMAND, empty, length cap | pure |
| `tests/core/lint.test.ts` | every DENY rule matches its pattern & clean commands pass; warn classification | pure |
| `tests/core/plan.test.ts` | ok→run; warn+!yes→confirm path; deny→refuse; no-model→error; printOnly; headless default dry-run | fake `complete` |
| `tests/pi/run.test.ts` | confirm accepted/rejected; exec streaming + timeout + abort; exit codes; notify guarded by hasUI | fake `complete`+`exec`+`ui` |
| `tests/pi/index.test.ts` | flag absent → no-op; flag present → drives runExec; /exec arg parsing | fakes |
| `tests/core/purity.test.ts` | scans src/core for `@earendil-works` imports (NR3) | fs scan |
| `tests/core/history.test.ts` | append/read roundtrip, malformed-line skip, preview formatting, limit parsing | tmpdir fs |
| `tests/pi/run.test.ts` (extends) | history entry appended per outcome via a `historyPath` seam | tmpdir fs |
| `tests/pi/run.test.ts` (extends) | terminal y/N confirm via a `deps.prompt` seam — called only when `!hasUI && canPrompt && !yes`; decline/EOF → 130 | fake `prompt` |
| `tests/pi/index.test.ts` (extends) | `--exec-help` / `--exec ""` → help menu + exit 0, no exec; bare `/exec` → menu lines | fakes |

No test touches a network, spawns a real shell, or loads jiti — adapter tests exercise the
same functions the factory wires, against fakes.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Model proposes destructive-but-plausible command | output contract + lint tables + confirm-by-default + headless dry-run default |
| Flag parsing collides with future pi flags | long-flag-only; all four flags share the `exec`/`exec-*` stem under the project name; `-exec` single-dash verified invalid, so no short-alias temptation |
| `session_start` doesn't fire in some invocation (e.g. `pi --help`) | correct behavior: no session, no run — nothing to do; document that `--exec` needs a session start (any mode incl. `-p`) |
| Model chatter breaks parsing | parser refuses loudly (shows raw output) rather than guessing |
| npm name squatting between now and P5 | publish early after P2 (0.1.0) if desired; pipeline handles the rest |
| Provenance requires public repo + id-token | repo is public; workflow sets `permissions: id-token: write` |

---

## 12. Credit where due (README section, required)

The pi-exec idea is not ours. It comes straight from **pi's own homepage** — the "Four
modes" section, where `pi -p "query"` for scripts is presented as a first-class mode
(pi.dev / `@earendil-works/pi-coding-agent`). The four modes made the one-shot
"describe → command → run" flow obvious; nobody had packaged it, so we did.

README must carry a short credit, e.g.:

> **Thanks pi.** This idea came straight from [pi](https://pi.dev)
> ([@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi)) — its
> homepage's "Four modes" section (specifically `pi -p` for scripts) planted it. All
> credit for the idea to the pi team; the bugs are ours.

## 13. Open questions

1. ~~npm name~~ **Decided: `pi-exec`** — one name everywhere (repo, package, flag stem,
   command, script). Both `pi-exec` and `pi-magicexec` were free; symmetry won.
2. Should `/exec` inside a session also offer "edit command" (`ctx.ui.input`) before
   running, or keep confirm/reject binary for v1? (Recommendation: binary; v1.1.)
3. `--exec-model` override at P6 or ship in v1? (Recommendation: P6 — session model
   is the whole point of "no configuration".)
4. Should TUI runs set a status-line marker while the child streams? (pi-weave does this for
   servers; here the streamed output is the UX — recommend no status line.)
5. Wrapper parity: should `scripts/pi-exec.sh` grow a `--yes`/`--print` pair mirroring the
   extension flags, or stay minimal until the extension replaces it? (Recommendation: stay
   minimal — it's the v0; the extension is the product.)