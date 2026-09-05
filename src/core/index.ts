import { EXEC_SYSTEM_PROMPT, buildUserPrompt } from "./contract";
import { DENY_RULES, WARN_RULES, lintCommand } from "./lint";
import { MAX_COMMAND_LENGTH, parseModelOutput } from "./parse";
import type { ExecDeps, ExecPlan, ExecRequest } from "./types";

export type * from "./types";

export { EXEC_SYSTEM_PROMPT, buildUserPrompt } from "./contract";
export { appendHistoryEntry, formatHistoryPreview, parseHistoryLimit, readHistory } from "./history";
export { DENY_RULES, WARN_RULES, lintCommand } from "./lint";
export { MAX_COMMAND_LENGTH, parseModelOutput } from "./parse";

export const MAX_OUTPUT_TOKENS = 300;
export const DEFAULT_TIMEOUT_SEC = 120;

/**
 * Parse the --exec-timeout flag value: undefined → default (flag absent);
 * boolean → invalid (flag type confusion); a positive integer string → the
 * value; anything else → invalid.
 */
export function parseTimeoutSec(raw: string | boolean | undefined): number | null {
  if (raw === undefined) return DEFAULT_TIMEOUT_SEC;
  if (typeof raw === "boolean") return null;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value > 0) return value;
  }
  return null;
}

/**
 * Pure orchestrator: ExecRequest + the single async seam (deps.complete) →
 * ExecPlan. The adapter decides how to report and execute the plan.
 */
export async function planExec(req: ExecRequest, deps: ExecDeps): Promise<ExecPlan> {
  if (req.text.trim() === "") {
    return { kind: "error", reason: "empty request", exitCode: 1 };
  }

  let raw: string;
  try {
    raw = await deps.complete(
      EXEC_SYSTEM_PROMPT,
      buildUserPrompt(req.text, req.cwd, req.recentCommands ?? []),
      // exactOptionalPropertyTypes: pass signal only when defined.
      { maxTokens: MAX_OUTPUT_TOKENS, ...(req.signal ? { signal: req.signal } : {}) },
    );
  } catch (err) {
    return {
      kind: "error",
      reason: `generation failed: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }

  const parsed = parseModelOutput(raw);
  if (parsed.kind === "refusal") {
    return { kind: "refuse", reason: parsed.reason, exitCode: 1 };
  }

  const verdict = lintCommand(parsed.command);
  if (verdict.verdict === "deny") {
    return { kind: "refuse", reason: `safety lint denied: ${verdict.reason}`, exitCode: 1 };
  }

  const warn = verdict.verdict === "warn" ? verdict.reason : undefined;

  // Headless default is dry-run — safety by construction (no one to ask).
  // With a controlling terminal (canPrompt, D-9) the adapter confirms on
  // /dev/tty instead; --exec-print still forces a dry-run.
  if (req.printOnly || (!req.hasUI && !req.yes && req.canPrompt !== true)) {
    return warn === undefined
      ? { kind: "dry-run", command: parsed.command }
      : { kind: "dry-run", command: parsed.command, warn };
  }
  return warn === undefined
    ? { kind: "run", command: parsed.command }
    : { kind: "run", command: parsed.command, warn };
}