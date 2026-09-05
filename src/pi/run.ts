/**
 * pi adapter for the exec pipeline: resolves the session's already-configured
 * model through `ctx.modelRegistry` (auth is pi's), executes the plan through
 * the exec seam, and reports by mode — print stdout stays pipeable, json
 * keeps stdout clean for pi's JSON channel, TUI gets live widgets.
 *
 * `deps` is the test seam (jiti calls the factory with one arg in
 * production): unit tests inject fake complete/exec and never touch a
 * network or a real shell.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendHistoryEntry,
  planExec,
  readHistory,
  type ExecDeps,
  type ExecRequest,
  type HistoryEntryKind,
} from "../core";
import { createSpawnExec, type ExecFn } from "./exec";

export type CompleteFn = ExecDeps["complete"];

export interface RunDeps {
  complete?: CompleteFn;
  exec?: ExecFn;
  historyPath?: string;
}

/** Append-only JSONL cache: ~/.pi/agent/cache/pi-exec/history.jsonl. */
export const DEFAULT_HISTORY_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "cache",
  "pi-exec",
  "history.jsonl",
);

const WIDGET_KEY = "pi-exec";
const WIDGET_TAIL_LINES = 15;
const NOTIFY_TAIL_LINES = 10;
const NOTIFY_LINE_CAP = 200;
const OUTPUT_BUFFER_CAP = 8000;

/** Last-3 history commands are passed to the model as reference context. */
const RECENT_COMMANDS_COUNT = 3;

type RunCtx = ExtensionContext | ExtensionCommandContext;

/**
 * Mode-aware notify: dialogs where they exist, `pi-exec: `-prefixed stderr
 * where they don't (print/json stdout is never touched from here).
 */
export function notify(ctx: RunCtx, text: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stderr.write(`pi-exec: ${text}\n`);
}

/**
 * D-7 security banner: a shell-comment line printed to stdout before the
 * command/output so warn-class risks are impossible to miss in piped runs
 * while `--exec-print | sh` keeps working (sh ignores comment lines).
 * Newlines collapse to spaces — the banner must stay a single line.
 */
export function formatSecurityBanner(reason: string): string {
  return `# ⚠ pi-exec: security risk — ${reason.replace(/\r?\n/g, " ")}`;
}

/** Last `maxLines` lines of a buffer, each capped at `lineCap` chars. */
function tailLines(text: string, maxLines: number, lineCap: number): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines
    .slice(-maxLines)
    .map((line) => (line.length > lineCap ? line.slice(0, lineCap) : line));
}

export async function runExec(
  ctx: RunCtx,
  req: ExecRequest,
  deps: RunDeps = {},
): Promise<number> {
  const historyPath = deps.historyPath ?? DEFAULT_HISTORY_PATH;

  // Record exactly one HistoryEntry per terminal outcome. appendHistoryEntry
  // never throws and its boolean result is ignored — the cache may never
  // break an exec.
  const record = async (
    kind: HistoryEntryKind,
    command: string,
    warn?: string,
    exitCode?: number,
  ): Promise<void> => {
    await appendHistoryEntry(historyPath, {
      ts: Date.now(),
      text: req.text,
      command,
      kind,
      ...(warn !== undefined ? { warn } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      cwd: ctx.cwd,
    });
  };

  // Step 0: last-3 executed commands from the cache become model reference
  // context (chronological, oldest → newest).
  const history = await readHistory(historyPath);
  const recentCommands = history
    .map((entry) => entry.command)
    .filter((command) => command !== "")
    .slice(-RECENT_COMMANDS_COUNT);

  // Step 1: no active model — nothing to generate from.
  const model = ctx.model;
  if (!model) {
    notify(ctx, "no active model — set one with /model or a provider env", "error");
    await record("error", "");
    return 1;
  }

  const complete: CompleteFn =
    deps.complete ??
    ((systemPrompt, userPrompt, opts) =>
      ctx.modelRegistry
        .complete(
          model,
          {
            systemPrompt,
            messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
          },
          // exactOptionalPropertyTypes: pass signal only when defined.
          { maxTokens: opts.maxTokens, ...(opts.signal ? { signal: opts.signal } : {}) },
        )
        .then((message) => contentText(message.content)));

  const plan = await planExec(
    { ...req, ...(recentCommands.length > 0 ? { recentCommands } : {}) },
    { complete },
  );

  if (plan.kind === "refuse" || plan.kind === "error") {
    notify(ctx, plan.reason, plan.kind === "refuse" ? "warning" : "error");
    await record(plan.kind, "");
    return plan.exitCode;
  }

  if (plan.kind === "dry-run") {
    if (ctx.hasUI) {
      ctx.ui.notify(
        plan.warn !== undefined
          ? `⚠ security risk — ${plan.warn}\n$ ${plan.command}`
          : `$ ${plan.command}`,
        plan.warn !== undefined ? "warning" : "info",
      );
    } else if (ctx.mode === "json") {
      // stdout is pi's JSON channel — everything goes to stderr.
      if (plan.warn !== undefined) {
        process.stderr.write(`${formatSecurityBanner(plan.warn)}\n`);
      }
      process.stderr.write(`${plan.command}\n`);
      process.stderr.write("pi-exec: dry run — not executed\n");
    } else {
      // Print mode: banner comment line first, then ONLY the command —
      // `pi --exec ... --exec-print | sh` stays pipeable.
      if (plan.warn !== undefined) {
        process.stdout.write(`${formatSecurityBanner(plan.warn)}\n`);
      }
      process.stdout.write(`${plan.command}\n`);
      process.stderr.write("pi-exec: dry run — not executed\n");
    }
    await record("dry-run", plan.command, plan.warn);
    return 0;
  }

  // plan.kind === "run"
  if (!req.yes && ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      "Run this command?",
      `$ ${plan.command}${plan.warn !== undefined ? `\n\n⚠ ${plan.warn}` : ""}`,
    );
    if (!confirmed) {
      notify(ctx, "canceled — nothing executed", "info");
      await record("declined", plan.command, plan.warn);
      return 130;
    }
  }

  // Report the command being run. In run mode stdout belongs to the child's
  // output — the command itself goes to stderr; only the banner may touch
  // stdout, before the child streams.
  if (ctx.hasUI) {
    ctx.ui.notify(
      plan.warn !== undefined
        ? `⚠ security risk — ${plan.warn}\n$ ${plan.command}`
        : `$ ${plan.command}`,
      plan.warn !== undefined ? "warning" : "info",
    );
  } else if (ctx.mode === "json") {
    if (plan.warn !== undefined) {
      process.stderr.write(`${formatSecurityBanner(plan.warn)}\n`);
    }
    process.stderr.write(`$ ${plan.command}\n`);
  } else {
    process.stderr.write(`$ ${plan.command}\n`);
    if (plan.warn !== undefined) {
      process.stdout.write(`${formatSecurityBanner(plan.warn)}\n`);
    }
  }

  // Compose abort sources: the request signal (usually undefined) plus the
  // execution timeout.
  const timeoutSignal = AbortSignal.timeout(req.timeoutSec * 1000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

  // Bounded tail buffer — always kept, so RPC can include the output tail in
  // its final notify; TUI additionally mirrors it live in a widget.
  let buffer = "";
  const push = (chunk: string): void => {
    buffer = buffer.length + chunk.length > OUTPUT_BUFFER_CAP
      ? `${buffer}${chunk}`.slice(-OUTPUT_BUFFER_CAP)
      : buffer + chunk;
  };
  // TUI-only live view: the widget keeps the final output after completion.
  const updateWidget = (): void => {
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, tailLines(buffer, WIDGET_TAIL_LINES, NOTIFY_LINE_CAP));
    }
  };

  const exec = deps.exec ?? createSpawnExec();
  const result = await exec(plan.command, ctx.cwd, {
    signal,
    onStdout: (chunk) => {
      push(chunk);
      if (ctx.mode === "print") process.stdout.write(chunk);
      else if (ctx.mode === "json") process.stderr.write(chunk);
      else updateWidget();
    },
    onStderr: (chunk) => {
      push(chunk);
      if (ctx.mode === "print" || ctx.mode === "json") process.stderr.write(chunk);
      else updateWidget();
    },
  });

  if (ctx.hasUI) {
    const tail = tailLines(buffer, NOTIFY_TAIL_LINES, NOTIFY_LINE_CAP);
    // TUI keeps the output visible in the widget; RPC has no widget, so the
    // tail rides along in the final notify.
    ctx.ui.notify(
      ctx.mode === "rpc" && tail.length > 0
        ? `pi-exec: finished (exit ${result.code})\n${tail.join("\n")}`
        : `pi-exec: finished (exit ${result.code})`,
      result.code === 0 ? "info" : "warning",
    );
  } else {
    process.stderr.write(`pi-exec: exit ${result.code}\n`);
  }
  await record("run", plan.command, plan.warn, result.code);
  return result.code;
}