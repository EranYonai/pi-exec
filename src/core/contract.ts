/**
 * The one-shot output contract: the model emits exactly one shell command or
 * an explicit NOT_ONE_COMMAND refusal — nothing else.
 */

export const EXEC_SYSTEM_PROMPT = [
  "You are a command-line utility assistant.",
  "Given a request, output ONLY the single shell command that fulfills it.",
  "Rules: no markdown, no code fences, no backticks, no quotes around the output,",
  "no explanation, no commentary. One line. If the request needs multiple steps or",
  "cannot be done with one command, output exactly: NOT_ONE_COMMAND: <reason>.",
  "Never use bash history expansion (!! or !N) — write commands out in full.",
  "Target shell: POSIX/bash. Working directory is the user's current directory.",
].join("\n");

export function buildUserPrompt(
  request: string,
  cwd: string,
  recent?: readonly string[],
): string {
  const base = `Request: ${request}\nWorking directory: ${cwd}`;
  // Recent history is model reference context only: oldest → newest, bare
  // commands, no request texts.
  return recent === undefined || recent.length === 0
    ? base
    : `${base}\nRecent commands run via pi-exec (for reference):\n${recent
        .map((command) => `$ ${command}`)
        .join("\n")}`;
}