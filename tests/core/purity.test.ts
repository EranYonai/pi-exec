import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_DIR = join(import.meta.dirname, "..", "..", "src", "core");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

function coreSources(): { file: string; source: string }[] {
  return walk(CORE_DIR).map((path) => ({
    file: path,
    source: readFileSync(path, "utf8"),
  }));
}

describe("src/core purity (NR3)", () => {
  it("scans at least one source file", () => {
    expect(coreSources().length).toBeGreaterThan(0);
  });

  it("never imports @earendil-works/*", () => {
    for (const { file, source } of coreSources()) {
      expect(source, file).not.toMatch(/@earendil-works/);
    }
  });

  it("never imports typebox", () => {
    for (const { file, source } of coreSources()) {
      expect(source, file).not.toMatch(/typebox/i);
    }
  });

  it("never imports the src/pi adapter (../pi or ./pi)", () => {
    for (const { file, source } of coreSources()) {
      expect(source, file).not.toMatch(/from\s+["']\.\.\/pi|from\s+["']\.\/pi/);
    }
  });
});