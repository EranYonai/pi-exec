import type { ParsedCommand } from "./types";

/** Model output (after cleaning) longer than this is refused, not executed. */
export const MAX_COMMAND_LENGTH = 2000;

const EMPTY_OUTPUT_REASON = "model returned empty output";
const MULTI_COMMAND_REASON = "request needs more than one command";
const BACKTICK_REASON =
  "command contains a backtick (broken fence or command substitution)";
const HISTORY_EXPANSION_REASON =
  "bash history expansion (!!, !-N, !cmd) only works in interactive shells — the full command must be written out";
const LENGTH_REASON = `command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters`;

// Bash event designators: a word starting with `!` followed by `!`, `-`, `?` or an
// alphanumeric — `!!`, `!-2`, `!ls`, `!?foo`. Silent no-ops in `bash -lc` (no
// history expansion outside interactive shells), so they are refused loudly
// instead. `! grep x` (negation) and `echo 'hi!!'` (mid-word) do not match.
const HISTORY_EXPANSION_PATTERN = /(?:^|\s)!(?:!|-|\?|[a-z0-9])/i;
// Chatter stems (case-insensitive, typographic ’ allowed) followed by a
// boundary: the model explained itself instead of emitting a command.
const CHATTER_PATTERN =
  /^(?:i['’]m sorry|i['’]m unable|i am unable|i can['’]t|i cannot|sorry|as an ai|unfortunately|sure)(?:[!,:?]|\s)/i;

/**
 * raw model text → ParsedCommand. Defensive against common model quirks:
 * code fences, surrounding quotes, shell-prompt markers, chatter, multi-line
 * output. Anything that is not exactly one clean command line is a refusal.
 */
export function parseModelOutput(raw: string): ParsedCommand {
  const text = raw.trim();
  if (text === "") return { kind: "refusal", reason: EMPTY_OUTPUT_REASON };

  let line = text;
  // Fence strip: ```lang\n<cmd>\n``` (drop the language-tag line) or the
  // inline ```cmd``` form. Multi-block or fence+prose input is not stripped
  // here; it falls through to the line-count rule and is refused.
  if (line.startsWith("```") && line.endsWith("```")) {
    const inner = line.slice(3, -3);
    line = inner.includes("\n") ? inner.slice(inner.indexOf("\n") + 1) : inner;
  }

  const lines = line
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length !== 1) {
    return {
      kind: "refusal",
      reason:
        lines.length === 0
          ? EMPTY_OUTPUT_REASON
          : `expected exactly one command line, got ${lines.length}`,
    };
  }
  line = lines[0]!;

  if (/^not_one_command:/i.test(line)) {
    const reason = line.slice(line.indexOf(":") + 1).trim();
    return {
      kind: "refusal",
      reason: reason === "" ? MULTI_COMMAND_REASON : reason,
    };
  }

  if (CHATTER_PATTERN.test(line)) {
    return { kind: "refusal", reason: `model chatter instead of a command: ${line}` };
  }

  // Unwrap one whole-line matching quote/backtick pair.
  const first = line[0]!;
  if (
    line.length >= 2 &&
    (first === "`" || first === '"' || first === "'") &&
    line.endsWith(first)
  ) {
    line = line.slice(1, -1);
  }

  // Any remaining backtick is a broken fence or legacy command substitution —
  // refuse loudly rather than guess.
  if (line.includes("`")) {
    return { kind: "refusal", reason: BACKTICK_REASON };
  }

  // Bash history expansion is a silent no-op in non-interactive `bash -lc` —
  // refuse it rather than run something other than what the user confirmed.
  if (HISTORY_EXPANSION_PATTERN.test(line)) {
    return { kind: "refusal", reason: HISTORY_EXPANSION_REASON };
  }

  // Strip a leading shell-prompt marker.
  line = line.replace(/^[$%>]\s+/, "");

  if (line === "") return { kind: "refusal", reason: EMPTY_OUTPUT_REASON };
  if (line.length > MAX_COMMAND_LENGTH) {
    return { kind: "refusal", reason: LENGTH_REASON };
  }
  return { kind: "command", command: line };
}