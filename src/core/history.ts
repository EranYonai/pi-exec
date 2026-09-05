import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HistoryEntry } from "./types";

/** Preview caps: commands truncate to 120 chars, request texts to 100. */
const COMMAND_PREVIEW_MAX = 120;
const REQUEST_PREVIEW_MAX = 100;

/**
 * Append one JSONL entry to the history cache, creating the parent directory
 * when missing. NEVER throws: the cache may never break an exec, so any fs
 * error only turns into `false`.
 */
export async function appendHistoryEntry(path: string, entry: HistoryEntry): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the history file: one JSON entry per line, blank/malformed lines
 * skipped, entries kept in file order (chronological, oldest first).
 * NEVER throws: ENOENT / unreadable / bad JSON → [].
 */
export async function readHistory(path: string): Promise<HistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // Malformed line — skip it rather than lose the rest of the cache.
    }
  }
  return entries;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Newest-first preview lines, at most `limit` entries. Main line:
 * `<kind> · exit <n> · $ <command>` (exit part only when present), plus an
 * indented detail line with the warn reason and/or the request text.
 */
export function formatHistoryPreview(entries: readonly HistoryEntry[], limit = 10): string[] {
  if (entries.length === 0) return ["no history yet"];

  const lines: string[] = [];
  for (const entry of entries.slice(-limit).reverse()) {
    const exitPart = entry.exitCode === undefined ? "" : ` · exit ${entry.exitCode}`;
    lines.push(`${entry.kind}${exitPart} · $ ${truncate(entry.command, COMMAND_PREVIEW_MAX)}`);

    const parts: string[] = [];
    if (entry.warn !== undefined) parts.push(`⚠ ${entry.warn}`);
    if (entry.text !== "") parts.push(`request: ${truncate(entry.text, REQUEST_PREVIEW_MAX)}`);
    if (parts.length > 0) lines.push(`    ${parts.join(" · ")}`);
  }
  return lines;
}

/**
 * Parse the /exec-history [n] argument: a positive integer string → the
 * number; anything else → null (invalid).
 */
export function parseHistoryLimit(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value > 0) return value;
  }
  return null;
}