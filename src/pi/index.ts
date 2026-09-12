/**
 * pi-exec factory — the only file pi loads. Registers the CLI flags, wires
 * the one-shot `--exec` / `--exec-history` run on session_start, and exposes
 * the /exec and /exec-history commands.
 *
 * Flag values resolve lazily inside the session_start handler (pi only makes
 * them readable after startup); the factory itself only registers things.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TIMEOUT_SEC,
  formatHistoryPreview,
  parseHistoryLimit,
  parseTimeoutSec,
  readHistory,
  type ExecRequest,
} from "../core";
import { DEFAULT_HISTORY_PATH, EXEC_HELP_LINES, notify, runExec, ttyAvailable, type RunDeps } from "./run";

const EXEC_USAGE = 'usage: pi --exec "<request>"';
const EXEC_HISTORY_USAGE = "usage: --exec-history <n>";
const DEFAULT_HISTORY_LIMIT = 10;

function setExitCode(mode: string, code: number): void {
  // D-3: print and json are equally headless — both own the process exit code.
  if (mode === "print" || mode === "json") process.exitCode = code;
}

/** D-10: the help menu, mode-aware — dialogs where they exist, otherwise the
 * pipeable channel (print → stdout, json → stderr). */
function printHelp(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.notify(EXEC_HELP_LINES.join("\n"), "info");
  else if (ctx.mode === "json") process.stderr.write(`${EXEC_HELP_LINES.join("\n")}\n`);
  else process.stdout.write(`${EXEC_HELP_LINES.join("\n")}\n`);
}

export default function piExec(pi: ExtensionAPI, deps: RunDeps = {}): void {
  const historyPath = deps.historyPath ?? DEFAULT_HISTORY_PATH;

  pi.registerFlag("exec", {
    description: "Generate & run one shell command from a natural-language request",
    type: "string",
  });
  pi.registerFlag("exec-yes", {
    description: "Skip the confirmation dialog (safety lint still applies)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("exec-print", {
    description: "Print the proposed command without running it",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("exec-timeout", {
    description: `Execution timeout in seconds (default ${DEFAULT_TIMEOUT_SEC})`,
    type: "string",
  });
  // No default: a default would fire the preview in every plain pi session.
  pi.registerFlag("exec-history", {
    description: "Print the last N pi-exec history entries and exit",
    type: "string",
  });
  // No default: help must not fire in every plain pi session.
  pi.registerFlag("exec-help", {
    description: "Print the pi-exec help menu and exit",
    type: "boolean",
  });

  pi.on("session_start", async (event, ctx) => {
    // One-shot: never re-run on /new, /resume or /reload (D-5).
    if (event.reason !== "startup") return;

    // --exec-help is the highest precedence: help menu + exit 0, the exec
    // pipeline is not invoked (D-10).
    if (pi.getFlag("exec-help") === true) {
      printHelp(ctx);
      setExitCode(ctx.mode, 0);
      await ctx.shutdown();
      return;
    }

    // --exec-history takes precedence over --exec: preview + shutdown, the
    // exec pipeline is not invoked.
    const histRaw = pi.getFlag("exec-history");
    if (typeof histRaw === "string" && histRaw !== "") {
      const limit = parseHistoryLimit(histRaw);
      if (limit === null) {
        notify(ctx, EXEC_HISTORY_USAGE, "warning");
        setExitCode(ctx.mode, 1);
        await ctx.shutdown();
        return;
      }
      const entries = await readHistory(historyPath);
      const lines = formatHistoryPreview(entries, limit);
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
      else if (ctx.mode === "json") process.stderr.write(`${lines.join("\n")}\n`);
      // Print mode: the preview is data — stdout (pipeable).
      else process.stdout.write(`${lines.join("\n")}\n`);
      setExitCode(ctx.mode, 0);
      await ctx.shutdown();
      return;
    }

    const text = pi.getFlag("exec");
    if (text === undefined) return; // inert for normal sessions (FR6)
    if (typeof text !== "string") {
      notify(ctx, EXEC_USAGE, "warning");
      setExitCode(ctx.mode, 1);
      await ctx.shutdown();
      return;
    }
    if (text.trim() === "") {
      // D-10: an empty --exec value asks for help, not an error.
      printHelp(ctx);
      setExitCode(ctx.mode, 0);
      await ctx.shutdown();
      return;
    }

    const timeoutSec = parseTimeoutSec(pi.getFlag("exec-timeout"));
    if (timeoutSec === null) {
      notify(ctx, "usage: --exec-timeout <seconds>", "warning");
      setExitCode(ctx.mode, 1);
      await ctx.shutdown();
      return;
    }

    const req: ExecRequest = {
      text,
      cwd: ctx.cwd,
      yes: pi.getFlag("exec-yes") === true,
      printOnly: pi.getFlag("exec-print") === true,
      timeoutSec,
      hasUI: ctx.hasUI,
      // D-9: only print mode may confirm on /dev/tty (json keeps pure-protocol
      // behavior; tui/rpc have dialogs).
      ...(ctx.mode === "print" && (deps.ttyAvailable ?? ttyAvailable)()
        ? { canPrompt: true }
        : {}),
      // exactOptionalPropertyTypes: forward only when defined.
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };
    const code = await runExec(ctx, req, deps);
    setExitCode(ctx.mode, code);
    await ctx.shutdown(); // one-shot: done means done
  });

  pi.registerCommand("exec", {
    description: "Generate & run one shell command from a natural-language request",
    handler: async (args, ctx) => {
      if (args.trim() === "") {
        // D-10: bare /exec shows the help menu.
        ctx.ui.notify(EXEC_HELP_LINES.join("\n"), "info");
        return;
      }
      await runExec(ctx, {
        text: args,
        cwd: ctx.cwd,
        yes: false,
        printOnly: false,
        timeoutSec: DEFAULT_TIMEOUT_SEC,
        hasUI: ctx.hasUI,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }, deps);
      // In-session command: no shutdown — the session keeps running.
    },
  });

  pi.registerCommand("exec-history", {
    description: `Show recent pi-exec history entries (${DEFAULT_HISTORY_LIMIT} by default, or /exec-history <n>)`,
    handler: async (args, ctx) => {
      const raw = args.trim();
      const limit = raw === "" ? DEFAULT_HISTORY_LIMIT : parseHistoryLimit(raw);
      if (limit === null) {
        ctx.ui.notify("usage: /exec-history [n]", "warning");
        return;
      }
      const entries = await readHistory(historyPath);
      ctx.ui.notify(formatHistoryPreview(entries, limit).join("\n"), "info");
    },
  });
}
