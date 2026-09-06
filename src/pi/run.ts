/**
 * pi adapter for the exec pipeline: resolves the generation model — the
 * `--exec-model` override (`deps.model`, D-12) or the session's configured
 * model through `ctx.modelRegistry` (auth is pi's) — executes the plan through
 * the exec seam, and reports by mode — print stdout stays pipeable, json
 * keeps stdout clean for pi's JSON channel, TUI gets live widgets.
 *
 * `deps` is the test seam (jiti calls the factory with one arg in
 * production): unit tests inject fake complete/exec and never touch a
 * network or a real shell.
 */

import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  type ReadStream,
  type WriteStream,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
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

/** D-9 terminal prompt seam: ask on /dev/tty, resolve true only on y/yes. */
export type PromptFn = (command: string, warn?: string) => Promise<boolean>;

export interface RunDeps {
  complete?: CompleteFn;
  exec?: ExecFn;
  historyPath?: string;
  /** D-12: overrides the session model for generation (resolved from --exec-model by the factory). */
  model?: Model<Api>;
  prompt?: PromptFn;
  ttyAvailable?: () => boolean;
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

/**
 * D-9: a controlling terminal the confirm question can be asked on, without
 * touching pi's stdout/stderr channels. Never throws.
 */
export function ttyAvailable(): boolean {
  try {
    accessSync("/dev/tty", fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * D-9 default prompt: ask `Run this command? [y/N]` directly on /dev/tty —
 * never stdout/stderr. ANY failure (no tty — including an async open error
 * like ENXIO, EOF before an answer, stream error) resolves false; never
 * throws, never crashes on unhandled 'error' events.
 */
export async function terminalConfirm(command: string, warn?: string): Promise<boolean> {
  let rl: Interface | undefined;
  let input: ReadStream | undefined;
  let output: WriteStream | undefined;
  try {
    input = createReadStream("/dev/tty");
    output = createWriteStream("/dev/tty");
    rl = createInterface({ input, output });
    // Opening /dev/tty can fail asynchronously (ENXIO without a controlling
    // terminal) — an unhandled EventEmitter 'error' would crash the process.
    // Race the question against those errors: the failure becomes a plain
    // false. The extra .catch marks `failed` as handled so a late error after
    // a normal answer cannot become an unhandled rejection.
    const failed = new Promise<never>((_resolve, reject) => {
      const fail = (err: unknown): void =>
        reject(err instanceof Error ? err : new Error(String(err)));
      input?.on("error", fail);
      output?.on("error", fail);
      rl?.on("error", fail);
    });
    failed.catch(() => {});
    const answer = await Promise.race([
      rl.question(
        `${warn !== undefined ? `⚠ security risk — ${warn}\n` : ""}$ ${command}\nRun this command? [y/N] `,
      ),
      failed,
    ]);
    return /^(y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl?.close();
    input?.destroy();
    output?.destroy();
  }
}

/**
 * D-10 help menu — printed by `--exec-help`, `--exec ""` and bare `/exec`.
 */
export const EXEC_HELP_LINES: readonly string[] = [
  "pi-exec — describe a shell task in plain language, confirm one command, done.",
  "",
  "Usage:",
  '  pi --exec "<request>"                    ask in the pi interface (TUI form)',
  '  pi -p --no-session --exec "<request>"    recommended one-shot without the interface',
  '  pi --exec "<request>" --exec-yes         skip the confirmation (safety lint still applies)',
  '  pi --exec "<request>" --exec-print       print the command only, never run it',
  '  pi --exec "<request>" --exec-timeout 30  execution timeout in seconds (default 120)',
  '  pi --exec "<request>" --exec-model p/m   generate with another model (provider/model-id)',
  "  pi --exec-history <n>                    print the last n history entries and exit",
  "  pi --exec-help                           print this help menu and exit",
  '  pi --exec ""                             an empty value also prints this menu',
  "  /exec <request>                          same as --exec inside a running session",
  "  /exec-history [n]                        recent history inside a running session",
  "",
  "Safety: deny-class commands never run, even with --exec-yes; warn-class risks show",
  "their reason before you confirm; every command asks first by default, and headless",
  "runs without a terminal fall back to a dry-run.",
  "",
  "Exit codes: the child command's own exit code; 130 when declined or aborted; 1 on",
  "refusal or error; 0 for a dry-run or this help.",
  "",
  "History is appended to ~/.pi/agent/cache/pi-exec/history.jsonl — delete the file to reset.",
];

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

  // Step 1: generation model — the --exec-model override (D-12) wins over the
  // session model; when both are absent there is nothing to generate from.
  const model = deps.model ?? ctx.model;
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
          {
            maxTokens: opts.maxTokens,
            // EXPERIMENT: command generation is trivial — minimal reasoning
            reasoning: "minimal",
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
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
    // The no-terminal headless rule (D-9) deserves a hint about how to
    // actually run; --exec-print dry-runs are deliberate, so no hint.
    const dryRunMarker = !req.printOnly && !req.hasUI
      ? "pi-exec: dry run — not executed (no terminal to confirm; pass --exec-yes to run, --exec-print to print only)"
      : "pi-exec: dry run — not executed";
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
      process.stderr.write(`${dryRunMarker}\n`);
    } else {
      // Print mode: banner comment line first, then ONLY the command —
      // `pi --exec ... --exec-print | sh` stays pipeable.
      if (plan.warn !== undefined) {
        process.stdout.write(`${formatSecurityBanner(plan.warn)}\n`);
      }
      process.stdout.write(`${plan.command}\n`);
      process.stderr.write(`${dryRunMarker}\n`);
    }
    await record("dry-run", plan.command, plan.warn);
    return 0;
  }

  // plan.kind === "run". Confirmation gate, first match wins: --exec-yes
  // skips; UI modes ask in a dialog; print mode with a terminal (D-9) asks
  // on /dev/tty. Without any of these, core already produced a dry-run —
  // defensively decline if that is ever reached.
  let ttyConfirmed = false;
  if (!req.yes) {
    if (ctx.hasUI) {
      const confirmed = await ctx.ui.confirm(
        "Run this command?",
        `$ ${plan.command}${plan.warn !== undefined ? `\n\n⚠ ${plan.warn}` : ""}`,
      );
      if (!confirmed) {
        notify(ctx, "canceled — nothing executed", "info");
        await record("declined", plan.command, plan.warn);
        return 130;
      }
    } else if (req.canPrompt === true) {
      // D-9: the question goes to /dev/tty — never stdout/stderr.
      const ok = await (deps.prompt ?? terminalConfirm)(plan.command, plan.warn);
      if (!ok) {
        notify(ctx, "canceled — nothing executed", "info");
        await record("declined", plan.command, plan.warn);
        return 130;
      }
      // The question already showed the command (+ warn) on the tty — the
      // stderr run-report below would be a verbatim duplicate.
      ttyConfirmed = true;
    } else {
      notify(ctx, "canceled — nothing executed", "info");
      await record("declined", plan.command, plan.warn);
      return 130;
    }
  }

  // Report the command being run. In run mode stdout belongs to the child's
  // output — the command itself goes to stderr (skipped when the tty confirm
  // already displayed it); only the banner may touch stdout, before the
  // child streams.
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
    if (!ttyConfirmed) {
      process.stderr.write(`$ ${plan.command}\n`);
    }
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
    // tail rides along in the final notify. D-13: the report names the
    // executed command so the transcript is self-describing.
    ctx.ui.notify(
      ctx.mode === "rpc" && tail.length > 0
        ? `pi-exec: ran '${plan.command}' (exit ${result.code})\n${tail.join("\n")}`
        : `pi-exec: ran '${plan.command}' (exit ${result.code})`,
      result.code === 0 ? "info" : "warning",
    );
  } else {
    process.stderr.write(`pi-exec: ran: ${plan.command} (exit ${result.code})\n`);
  }
  await record("run", plan.command, plan.warn, result.code);
  return result.code;
}