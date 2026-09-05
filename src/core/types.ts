/**
 * Portable engine types. Type-only module: it erases to zero runtime JS
 * (coverage-excluded for that reason — see vitest.config.ts).
 *
 * exactOptionalPropertyTypes is ON: optional properties are added via
 * conditional spreads, never assigned undefined explicitly.
 */

export interface ExecRequest {
  text: string;
  cwd: string;
  yes: boolean;
  printOnly: boolean;
  timeoutSec: number;
  hasUI: boolean;
  signal?: AbortSignal;
  recentCommands?: readonly string[]; // last-3 history commands passed to the model as reference
  canPrompt?: boolean; // a controlling terminal exists: print mode may confirm on /dev/tty (D-9)
}

export type HistoryEntryKind = "run" | "dry-run" | "declined" | "refuse" | "error";

export interface HistoryEntry {
  ts: number; // Date.now() at record time
  text: string; // the user's request
  command: string; // proposed command, "" when none was produced
  kind: HistoryEntryKind;
  warn?: string; // lint warn reason when present
  exitCode?: number; // set only when kind === "run"
  cwd: string;
}

export type ParsedCommand =
  | { kind: "command"; command: string }
  | { kind: "refusal"; reason: string };

export type LintVerdict =
  | { verdict: "ok" }
  | { verdict: "warn"; reason: string }
  | { verdict: "deny"; reason: string };

export interface LintRule {
  name: string;
  reason: string;
  pattern: RegExp;
}

export type ExecPlan =
  | { kind: "run"; command: string; warn?: string } // confirm (unless yes), then execute
  | { kind: "dry-run"; command: string; warn?: string } // show only
  | { kind: "refuse"; reason: string; exitCode: 1 }
  | { kind: "error"; reason: string; exitCode: 1 };

export interface ExecDeps {
  complete: (
    systemPrompt: string,
    userPrompt: string,
    opts: { maxTokens: number; signal?: AbortSignal },
  ) => Promise<string>;
}