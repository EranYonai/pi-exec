import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEOUT_SEC,
  EXEC_SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
  buildUserPrompt,
  parseTimeoutSec,
  planExec,
} from "../../src/core";
import type { ExecRequest } from "../../src/core";

function makeReq(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    text: "list files",
    cwd: "/work",
    yes: false,
    printOnly: false,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    hasUI: true,
    ...overrides,
  };
}

type CompleteFn = (
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens: number; signal?: AbortSignal },
) => Promise<string>;

function fakeComplete(output: string) {
  return vi.fn(async (_systemPrompt: string, _userPrompt: string, _opts: { maxTokens: number; signal?: AbortSignal }): Promise<string> => output);
}

describe("planExec", () => {
  it("ok verdict → run plan without a warn key", async () => {
    const plan = await planExec(makeReq(), { complete: fakeComplete("ls -la\n") });
    expect(plan).toEqual({ kind: "run", command: "ls -la" });
    expect(plan).not.toHaveProperty("warn");
  });

  it("sends the system contract and a cwd-scoped user prompt with maxTokens 300", async () => {
    const complete = fakeComplete("ls");
    await planExec(makeReq(), { complete });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toBe(EXEC_SYSTEM_PROMPT);
    expect(complete.mock.calls[0]?.[1]).toBe(
      "Request: list files\nWorking directory: /work",
    );
    expect(complete.mock.calls[0]?.[2]).toEqual({ maxTokens: MAX_OUTPUT_TOKENS });
    expect(complete.mock.calls[0]?.[2]).not.toHaveProperty("signal");
  });

  it("forwards req.signal to complete when defined", async () => {
    const signal = new AbortController().signal;
    const complete = fakeComplete("ls");
    await planExec(makeReq({ signal }), { complete });
    expect(complete.mock.calls[0]?.[2]?.signal).toBe(signal);
    expect(complete.mock.calls[0]?.[2]?.maxTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("non-empty recentCommands → history section in the user prompt", async () => {
    const complete = fakeComplete("ls");
    await planExec(makeReq({ recentCommands: ["git status", "ls -la"] }), { complete });
    expect(complete.mock.calls[0]?.[1]).toBe(
      "Request: list files\nWorking directory: /work\n" +
        "Recent commands run via pi-exec (for reference):\n$ git status\n$ ls -la",
    );
  });

  it("empty recentCommands → no history section in the user prompt", async () => {
    const complete = fakeComplete("ls");
    await planExec(makeReq({ recentCommands: [] }), { complete });
    expect(complete.mock.calls[0]?.[1]).toBe("Request: list files\nWorking directory: /work");
  });

  it("warn verdict flows into the run plan", async () => {
    const plan = await planExec(makeReq(), { complete: fakeComplete("sudo apt update") });
    expect(plan).toEqual({ kind: "run", command: "sudo apt update", warn: "runs as root" });
  });

  it("deny verdict → refuse with the safety-lint reason", async () => {
    const plan = await planExec(makeReq(), { complete: fakeComplete("rm -rf /") });
    expect(plan).toEqual({
      kind: "refuse",
      reason: "safety lint denied: recursive delete targeting / or the home directory",
      exitCode: 1,
    });
  });

  it("NOT_ONE_COMMAND → refuse with the model's reason", async () => {
    const plan = await planExec(makeReq(), {
      complete: fakeComplete("NOT_ONE_COMMAND: needs two steps"),
    });
    expect(plan).toEqual({ kind: "refuse", reason: "needs two steps", exitCode: 1 });
  });

  it("empty model output → refuse", async () => {
    const plan = await planExec(makeReq(), { complete: fakeComplete("   \n  ") });
    expect(plan).toEqual({ kind: "refuse", reason: "model returned empty output", exitCode: 1 });
  });

  it("complete throwing an Error → error plan with its message", async () => {
    const plan = await planExec(makeReq(), {
      complete: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(plan).toEqual({ kind: "error", reason: "generation failed: boom", exitCode: 1 });
  });

  it("complete throwing a non-Error → error plan with String(err)", async () => {
    const plan = await planExec(makeReq(), {
      complete: vi.fn(async () => {
        throw "boom";
      }),
    });
    expect(plan).toEqual({ kind: "error", reason: "generation failed: boom", exitCode: 1 });
  });

  it("empty request → error plan without calling complete", async () => {
    const complete = fakeComplete("ls");
    const plan = await planExec(makeReq({ text: "   " }), { complete });
    expect(plan).toEqual({ kind: "error", reason: "empty request", exitCode: 1 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("printOnly → dry-run even with UI and yes", async () => {
    const plan = await planExec(makeReq({ printOnly: true, yes: true }), {
      complete: fakeComplete("ls"),
    });
    expect(plan).toEqual({ kind: "dry-run", command: "ls" });
    expect(plan).not.toHaveProperty("warn");
  });

  it("headless without yes → dry-run", async () => {
    const plan = await planExec(makeReq({ hasUI: false, yes: false }), {
      complete: fakeComplete("ls"),
    });
    expect(plan).toEqual({ kind: "dry-run", command: "ls" });
  });

  it("headless with yes → run", async () => {
    const plan = await planExec(makeReq({ hasUI: false, yes: true }), {
      complete: fakeComplete("ls"),
    });
    expect(plan).toEqual({ kind: "run", command: "ls" });
  });

  it("tui without yes → run (confirm happens in the adapter)", async () => {
    const plan = await planExec(makeReq({ hasUI: true, yes: false }), {
      complete: fakeComplete("ls"),
    });
    expect(plan).toEqual({ kind: "run", command: "ls" });
  });

  it("warn flows into a dry-run plan too", async () => {
    const plan = await planExec(makeReq({ printOnly: true }), {
      complete: fakeComplete("sudo apt update"),
    });
    expect(plan).toEqual({ kind: "dry-run", command: "sudo apt update", warn: "runs as root" });
  });
});

describe("buildUserPrompt", () => {
  it("embeds request and working directory", () => {
    expect(buildUserPrompt("resize images", "/home/x")).toBe(
      "Request: resize images\nWorking directory: /home/x",
    );
  });

  it("appends the recent-commands section (oldest → newest) when recent is non-empty", () => {
    expect(buildUserPrompt("resize images", "/home/x", ["pwd", "ls -la"])).toBe(
      "Request: resize images\nWorking directory: /home/x\n" +
        "Recent commands run via pi-exec (for reference):\n$ pwd\n$ ls -la",
    );
  });
});

describe("parseTimeoutSec", () => {
  it("undefined → default timeout", () => {
    expect(parseTimeoutSec(undefined)).toBe(DEFAULT_TIMEOUT_SEC);
    expect(DEFAULT_TIMEOUT_SEC).toBe(120);
  });

  it("boolean → null (invalid)", () => {
    expect(parseTimeoutSec(true)).toBeNull();
    expect(parseTimeoutSec(false)).toBeNull();
  });

  it("positive integer string → value", () => {
    expect(parseTimeoutSec("90")).toBe(90);
    expect(parseTimeoutSec("1")).toBe(1);
  });

  it("everything else → null", () => {
    expect(parseTimeoutSec("0")).toBeNull();
    expect(parseTimeoutSec("-5")).toBeNull();
    expect(parseTimeoutSec("12.5")).toBeNull();
    expect(parseTimeoutSec("abc")).toBeNull();
    expect(parseTimeoutSec("")).toBeNull();
    expect(parseTimeoutSec(" 90")).toBeNull();
    expect(parseTimeoutSec("90 ")).toBeNull();
    expect(parseTimeoutSec("1e3")).toBeNull();
  });
});

describe("MAX_OUTPUT_TOKENS", () => {
  it("is 300", () => {
    expect(MAX_OUTPUT_TOKENS).toBe(300);
  });
});