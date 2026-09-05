# AGENTS.md — working on pi-exec

Guidance for any agent (or human) making changes here. `docs/plan.md` is the source of
truth for *why* (design); `docs/implementation-brief.md` records the verified pi API
facts and the binding per-file specs. This file is about *how we work here*.

## What this project is

pi-exec is a lightweight pi extension: natural language in, **one** shell command out,
confirmed, executed, reported. One LLM completion + one child process — no agent loop,
no tools. The portable engine lives in `src/core`; `src/pi` only wires it into pi.

## Hard rules

1. **Never commit directly to `main`.** Create a feature branch (`feat/…`, `fix/…`),
   commit there, push, and open a PR.
2. **Coverage must stay ≥ 95%** on lines, branches, functions, statements — enforced by
   `vitest --coverage` thresholds (`npm run coverage`). Write tests *with* the feature.
3. **`src/core/` must never import from `@earendil-works/*`, `typebox`, or `../pi`.**
   The core is the portable engine; `src/pi/` is the thin adapter. `tests/core/purity.test.ts`
   enforces this by scanning sources — keep it that way.
4. **Lint deny-list changes are a security surface.** Any change to `DENY_RULES`/
   `WARN_RULES` requires new positive+negative tests and a CHANGELOG note.
5. **No test touches a network, spawns a real shell, or loads jiti.** Use the seams:
   `deps.complete`, `deps.exec`, `deps.historyPath` (tmpdir), `vi.mock("node:child_process")`.

## Repository layout

```text
src/core/      Portable engine: contract, parse, lint, plan (planExec), history cache
src/pi/        pi adapter: factory (flags, session_start), run (reporting/confirm), exec (spawn)
tests/core/    pure unit suites (parse, lint, plan, history, purity)
tests/pi/      adapter suites (run, index, exec) — fakes only
docs/          plan.md (design) + implementation-brief.md (verified API facts, binding specs)
scripts/       pi-exec.sh — the verified v0 standalone wrapper
```

## Commands

```bash
npm run typecheck   # tsc --noEmit (strict; must stay clean)
npm test            # vitest run (no coverage gate)
npm run coverage    # vitest run --coverage (the 95% gate)
npm run check       # typecheck + coverage — run before committing
```

## Conventions

- `exactOptionalPropertyTypes` is on: optional properties are added via conditional
  spreads, never assigned `undefined` explicitly.
- `verbatimModuleSyntax` is on: `import type` / `export type` for types.
- Print-mode stdout discipline: dry-run prints the security banner (when warn) + the
  command — nothing else; run mode leaves stdout to the child's output. json mode writes
  everything to stderr (stdout is pi's JSON channel).
- Smoke test the extension end-to-end after adapter changes:
  `pi -e . --exec "echo hello from exec" --exec-print -p --no-session`
  must print exactly `echo hello from exec`.
- The history cache is failure-tolerant by design: read/write errors are swallowed; it
  may never break an exec.