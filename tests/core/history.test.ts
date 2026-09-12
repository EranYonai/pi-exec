import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendHistoryEntry,
  formatHistoryPreview,
  parseHistoryLimit,
  readHistory,
} from "../../src/core";
import type { HistoryEntry } from "../../src/core";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-exec-history-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: 1_700_000_000_000,
    text: "list files",
    command: "ls -la",
    kind: "run",
    cwd: "/work",
    ...overrides,
  };
}

describe("appendHistoryEntry / readHistory", () => {
  it("append → read roundtrip preserves file (chronological) order", async () => {
    const path = join(dir, "history.jsonl");
    const first = makeEntry({ text: "first" });
    const second = makeEntry({ text: "second", kind: "dry-run", command: "echo hi" });
    const third = makeEntry({ text: "third", kind: "refuse", command: "" });
    expect(await appendHistoryEntry(path, first)).toBe(true);
    expect(await appendHistoryEntry(path, second)).toBe(true);
    expect(await appendHistoryEntry(path, third)).toBe(true);
    expect(await readHistory(path)).toEqual([first, second, third]);
  });

  it("creates missing parent directories (mkdir -p)", async () => {
    const path = join(dir, "cache", "pi-exec", "history.jsonl");
    const entry = makeEntry({ kind: "error", command: "", text: "no model" });
    expect(await appendHistoryEntry(path, entry)).toBe(true);
    expect(await readHistory(path)).toEqual([entry]);
  });

  it("skips blank and malformed lines, keeping valid JSON lines in file order", async () => {
    const path = join(dir, "history.jsonl");
    const good1 = makeEntry({ text: "good one" });
    const good2 = makeEntry({ text: "good two", kind: "declined" });
    await writeFile(
      path,
      [JSON.stringify(good1), "", "   ", "{ not json", JSON.stringify(good2)].join("\n"),
      "utf8",
    );
    expect(await readHistory(path)).toEqual([good1, good2]);
  });

  it("missing file → [] (never throws)", async () => {
    expect(await readHistory(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("unreadable path → [] (never throws)", async () => {
    // Reading a directory fails (EISDIR) — readHistory must swallow it.
    expect(await readHistory(dir)).toEqual([]);
  });

  it("unwritable location → append returns false without throwing", async () => {
    // dirname is an existing regular file → mkdir(recursive)/appendFile fail.
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "occupied", "utf8");
    expect(await appendHistoryEntry(join(blocker, "history.jsonl"), makeEntry())).toBe(false);
  });
});

describe("formatHistoryPreview", () => {
  it("empty input → [\"no history yet\"]", () => {
    expect(formatHistoryPreview([])).toEqual(["no history yet"]);
  });

  it("newest first; kind, exit code, command, warn reason and request text all visible", () => {
    const lines = formatHistoryPreview([
      makeEntry({ ts: 1, text: "list files", command: "ls -la", kind: "run", exitCode: 0 }),
      makeEntry({
        ts: 2,
        text: "update packages",
        command: "sudo apt update",
        kind: "run",
        warn: "runs as root",
        exitCode: 2,
      }),
    ]);
    expect(lines).toEqual([
      "run · exit 2 · $ sudo apt update",
      "    ⚠ runs as root · request: update packages",
      "run · exit 0 · $ ls -la",
      "    request: list files",
    ]);
  });

  it("no exit part when absent; no detail line when neither warn nor text exist", () => {
    const lines = formatHistoryPreview([makeEntry({ text: "" })]);
    expect(lines).toEqual(["run · $ ls -la"]);
  });

  it("warn absent but request text present → detail line with the request only", () => {
    const lines = formatHistoryPreview([makeEntry({ kind: "declined", command: "git push -f origin" })]);
    expect(lines).toEqual(["declined · $ git push -f origin", "    request: list files"]);
  });

  it("truncates commands to 120 and request texts to 100 characters", () => {
    const lines = formatHistoryPreview([
      makeEntry({ command: `echo ${"x".repeat(200)}`, text: "y".repeat(200) }),
    ]);
    expect(lines).toEqual([`run · $ echo ${"x".repeat(115)}`, `    request: ${"y".repeat(100)}`]);
  });

  it("default limit is 10, newest first; explicit limit caps the entry count", () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      makeEntry({ ts: i, command: `cmd-${i}`, text: "" }),
    );
    expect(formatHistoryPreview(entries)).toEqual(
      Array.from({ length: 10 }, (_, i) => `run · $ cmd-${11 - i}`),
    );
    expect(formatHistoryPreview(entries, 3)).toEqual([
      "run · $ cmd-11",
      "run · $ cmd-10",
      "run · $ cmd-9",
    ]);
  });
});

describe("parseHistoryLimit", () => {
  it("positive integer string → the value", () => {
    expect(parseHistoryLimit("10")).toBe(10);
    expect(parseHistoryLimit("1")).toBe(1);
  });

  it("everything else → null", () => {
    expect(parseHistoryLimit("0")).toBeNull();
    expect(parseHistoryLimit("-3")).toBeNull();
    expect(parseHistoryLimit("2.5")).toBeNull();
    expect(parseHistoryLimit("abc")).toBeNull();
    expect(parseHistoryLimit("")).toBeNull();
    expect(parseHistoryLimit(" 5")).toBeNull();
    expect(parseHistoryLimit("5 ")).toBeNull();
  });
});