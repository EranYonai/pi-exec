import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXEC_SYSTEM_PROMPT,
  appendHistoryEntry,
  readHistory,
  type ExecRequest,
  type HistoryEntry,
} from "../../src/core";
import type { ExecOptions, ExecResult } from "../../src/pi/exec";
import { DEFAULT_HISTORY_PATH, formatSecurityBanner, runExec } from "../../src/pi/run";
import {
  DEFAULT_EXEC_MODEL,
  EXEC_MODEL_ENV,
  resolveDefaultModel,
  type RunDeps,
} from "../../src/pi/run";

// The terminalConfirm fallback must never open a real /dev/tty: node:fs,
// node:tty, and node:readline/promises are fully mocked (history uses
// node:fs/promises — a different specifier, left untouched).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: vi.fn(),
    openSync: vi.fn(() => {
      throw new Error("no real /dev/tty in tests");
    }),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
  };
});
vi.mock("node:tty", () => ({
  ReadStream: vi.fn(),
  WriteStream: vi.fn(),
}));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

import { openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import { createInterface } from "node:readline/promises";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-exec-run-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function historyPath(): string {
  return join(dir, "history.jsonl");
}

function makeReq(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    text: "list files",
    cwd: "/work",
    yes: false,
    printOnly: false,
    timeoutSec: 120,
    hasUI: true,
    ...overrides,
  };
}

type Ui = {
  confirm: ReturnType<typeof vi.fn<(title: string, message: string) => Promise<boolean>>>;
  notify: ReturnType<
    typeof vi.fn<(message: string, level?: "info" | "warning" | "error") => void>
  >;
  setWidget: ReturnType<typeof vi.fn<(key: string, content: string[] | undefined) => void>>;
  setStatus: ReturnType<typeof vi.fn<(key: string, text: string | undefined) => void>>;
};

interface CtxOverrides {
  mode?: ExtensionContext["mode"];
  hasUI?: boolean;
  cwd?: string;
  signal?: AbortSignal;
  /** null → no active model (headless without a provider). */
  model?: { provider: string; id: string } | null;
  /** Replace the throwing registry stub with a working fake. */
  registryComplete?: (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
  /** D-14 tests: registry find spy — omitted → no find on the fake (defensive path). */
  registryFind?: (provider: string, id: string) => unknown;
}

function makeCtx(overrides: CtxOverrides = {}) {
  const ui: Ui = {
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    setWidget: vi.fn(),
    setStatus: vi.fn(),
  };
  const raw = {
    ui,
    mode: overrides.mode ?? ("print" as const),
    hasUI: overrides.hasUI ?? false,
    cwd: overrides.cwd ?? "/work",
    model:
      overrides.model === null ? undefined : (overrides.model ?? { provider: "test", id: "test-model" }),
    modelRegistry: {
      complete:
        overrides.registryComplete ??
        vi.fn(async () => {
          throw new Error("registry must not be used when deps.complete is injected");
        }),
      // exactOptionalPropertyTypes: add find only when the test provides one.
      ...(overrides.registryFind ? { find: overrides.registryFind } : {}),
    },
    signal: overrides.signal,
    shutdown: vi.fn(),
  };
  return { ctx: raw as unknown as ExtensionContext, ui };
}

describe("runExec — default complete seam (production registry path)", () => {
  function assistantMessage(text: string): unknown {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
    };
  }

  it("wraps ctx.modelRegistry.complete and extracts the text via contentText", async () => {
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryComplete });
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
      exec: deps.exec,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(registryComplete).toHaveBeenCalledOnce();
    const [model, context, options] = registryComplete.mock.calls[0] as unknown as [
      unknown,
      { systemPrompt: string; messages: { role: string; content: string }[] },
      { maxTokens: number; signal?: AbortSignal },
    ];
    expect(model).toEqual({ provider: "test", id: "test-model" });
    expect(context.systemPrompt).toBe(EXEC_SYSTEM_PROMPT);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe("user");
    expect(context.messages[0]?.content).toContain("Request: list files");
    expect(options.maxTokens).toBe(300);
    expect(options).not.toHaveProperty("signal");
    // stdout carried the child output — the model text became the command.
    expect(deps.exec.mock.calls[0]?.[0]).toBe("ls -la");
  });

  it("forwards req.signal through the registry seam", async () => {
    const controller = new AbortController();
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryComplete });
    await runExec(
      ctx,
      makeReq({ hasUI: false, printOnly: true, signal: controller.signal }),
      { historyPath: historyPath() },
    );
    const options = (registryComplete.mock.calls[0] as unknown as unknown[] | undefined)?.[2] as {
      maxTokens: number;
      signal?: AbortSignal;
    };
    expect(options.signal).toBe(controller.signal);
  });

  it("UI dry-run without warn → a single info notify with the command", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    const deps = makeDeps("ls -la");
    const code = await runExec(ctx, makeReq({ printOnly: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(ui.notify).toHaveBeenCalledOnce();
    const [message, level] = ui.notify.mock.calls[0] as unknown as [string, string];
    expect(message).toBe("$ ls -la");
    expect(level).toBe("info");
  });

  it("json dry-run + warn → banner, command and status all to stderr, stdout untouched", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = spyStdout(stdout);
    const stderrSpy = spyStderr(stderr);
    try {
      const { ctx } = makeCtx({ mode: "json", hasUI: false });
      const deps = makeDeps("sudo apt update");
      const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
        ...deps,
        historyPath: historyPath(),
      });
      expect(code).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        `${formatSecurityBanner("runs as root")}\n`,
        "sudo apt update\n",
        "pi-exec: dry run — not executed\n",
      ]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

// Deliberately never exercised in this suite: `deps.historyPath ??
// DEFAULT_HISTORY_PATH` (would write to the real ~/.pi cache) and
// `deps.exec ?? createSpawnExec()` (would spawn a real shell). Both
// production defaults are therefore excluded from branch coverage by design;
// createSpawnExec itself is unit-tested in exec.test.ts behind a mock.

function makeDeps(
  output = "ls -la\n",
  execImpl?: (command: string, cwd: string, opts: ExecOptions) => Promise<ExecResult>,
) {
  return {
    complete: vi.fn<
      (systemPrompt: string, userPrompt: string, opts: { maxTokens: number; signal?: AbortSignal }) => Promise<string>
    >(async () => output),
    exec: vi.fn<(command: string, cwd: string, opts: ExecOptions) => Promise<ExecResult>>(
      execImpl ?? (async () => ({ code: 0, killed: false })),
    ),
  };
}

/** Spy a stream's writes into `sink`; restore with the returned mock. */
function spyStdout(sink: string[]) {
  return vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      sink.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
}

function spyStderr(sink: string[]) {
  return vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown) => {
      sink.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
}

describe("runExec — headless print mode (exit codes & stdout discipline)", () => {
  let stdout: string[];
  let stderr: string[];
  let stdoutSpy: ReturnType<typeof spyStdout>;
  let stderrSpy: ReturnType<typeof spyStderr>;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    stdoutSpy = spyStdout(stdout);
    stderrSpy = spyStderr(stderr);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("clean dry-run → stdout is exactly the command (pipeable), exit 0, no exec", async () => {
    const { ctx, ui } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("echo hello from exec\n");
    const code = await runExec(
      ctx,
      makeReq({ hasUI: false, printOnly: true }),
      { ...deps, historyPath: historyPath() },
    );
    expect(code).toBe(0);
    expect(stdout).toEqual(["echo hello from exec\n"]);
    expect(stderr).toContain("pi-exec: dry run — not executed\n");
    expect(deps.exec).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("headless default (no --exec-yes) is dry-run — safety by construction", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    const code = await runExec(ctx, makeReq({ hasUI: false }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual(["ls -la\n"]);
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("dry-run from the no-terminal rule prints the --exec-yes/--exec-print hint on stderr", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    await runExec(ctx, makeReq({ hasUI: false }), { ...deps, historyPath: historyPath() });
    expect(stderr).toContain(
      "pi-exec: dry run — not executed (no terminal to confirm; pass --exec-yes to run, --exec-print to print only)\n",
    );
  });

  it("printOnly dry-run keeps the plain marker (deliberate, no hint)", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(stderr).toContain("pi-exec: dry run — not executed\n");
    expect(stderr.join("")).not.toContain("no terminal to confirm");
  });

  it("headless --exec-yes runs: exit passthrough, command on stderr, output on stdout", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls", async (_c, _cwd, opts) => {
      opts.onStdout("out chunk\n");
      opts.onStderr("err chunk\n");
      return { code: 42, killed: false };
    });
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(42);
    expect(deps.exec).toHaveBeenCalledOnce();
    expect(stdout).toEqual(["out chunk\n"]);
    expect(stderr).toEqual(["$ ls\n", "err chunk\n", "pi-exec: ran: ls (exit 42)\n"]);
  });

  it("killed by our signal → exit 124", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("sleep 100", async () => ({ code: 124, killed: true }));
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(124);
  });

  it("no active model → exit 1 with a stderr hint, complete never called", async () => {
    const { ctx, ui } = makeCtx({ mode: "print", hasUI: false, model: null });
    const deps = makeDeps("ls");
    const code = await runExec(ctx, makeReq({ hasUI: false }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(1);
    expect(stderr).toEqual([
      "pi-exec: no active model — set one with /model or a provider env\n",
    ]);
    expect(ui.notify).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("model refusal → exit 1 with the reason on stderr", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("NOT_ONE_COMMAND: needs two steps");
    const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("pi-exec: needs two steps\n");
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("lint deny → exit 1 with the safety-lint reason on stderr", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("rm -rf /");
    const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toContain(
      "pi-exec: safety lint denied: recursive delete targeting / or the home directory",
    );
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("generation failure → exit 1 with the error reason on stderr", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = {
      complete: vi.fn(async () => {
        throw new Error("boom");
      }),
      exec: vi.fn(async () => ({ code: 0, killed: false })),
      historyPath: historyPath(),
    };
    const code = await runExec(ctx, makeReq({ hasUI: false }), deps);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("pi-exec: generation failed: boom\n");
    expect(deps.exec).not.toHaveBeenCalled();
  });
});

describe("runExec — confirm flow (UI)", () => {
  it("confirm shown only when !yes && hasUI, message contains command and warn reason", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    const deps = makeDeps("sudo apt update");
    const code = await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    expect(code).toBe(0);
    expect(ui.confirm).toHaveBeenCalledOnce();
    const [title, message] = ui.confirm.mock.calls[0] as [string, string];
    expect(title).toBe("Run this command?");
    expect(message).toContain("$ sudo apt update");
    expect(message).toContain("runs as root");
    expect(deps.exec).toHaveBeenCalledOnce();
  });

  it("yes skips the confirm dialog entirely", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    const deps = makeDeps("ls -la");
    await runExec(ctx, makeReq({ yes: true }), { ...deps, historyPath: historyPath() });
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(deps.exec).toHaveBeenCalledOnce();
  });

  it("declined → 130, nothing executed, cancel notify", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    ui.confirm.mockResolvedValue(false);
    const deps = makeDeps("rm -rf ./build");
    const code = await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    expect(code).toBe(130);
    expect(deps.exec).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("canceled — nothing executed", "info");
  });
});

describe("runExec — D-9 terminal confirm (print mode, /dev/tty)", () => {
  let stdout: string[];
  let stderr: string[];
  let stdoutSpy: ReturnType<typeof spyStdout>;
  let stderrSpy: ReturnType<typeof spyStderr>;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    stdoutSpy = spyStdout(stdout);
    stderrSpy = spyStderr(stderr);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  const TTY_HINT =
    "pi-exec: dry run — not executed (no terminal to confirm; pass --exec-yes to run, --exec-print to print only)";

  function makeRl(answer: string, reject = false) {
    return {
      on: vi.fn(),
      question: vi.fn((_q: string) => (reject ? Promise.reject(new Error("closed")) : Promise.resolve(answer))),
      close: vi.fn(),
    };
  }

  function mockRl(rl: ReturnType<typeof makeRl>): void {
    vi.mocked(createInterface).mockReturnValue(rl as unknown as ReturnType<typeof createInterface>);
  }

  it("prompt seam asked exactly when !hasUI && canPrompt && !yes — true runs the command", async () => {
    const { ctx, ui } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    const prompt = vi.fn(async () => true);
    const code = await runExec(ctx, makeReq({ hasUI: false, canPrompt: true }), {
      ...deps,
      prompt,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(prompt).toHaveBeenCalledOnce();
    expect(deps.exec).toHaveBeenCalledOnce();
    expect(ui.confirm).not.toHaveBeenCalled();
    // Review polish: the tty question already showed `$ ls -la` — the stderr
    // run-report must not duplicate it.
    expect(stderr.join("")).not.toContain("$ ls -la");
  });

  it("without a terminal prompt (yes path), the stderr run-report still prints", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(stderr.join("")).toContain("$ ls -la\n");
  });

  it("the prompt receives the command and the warn reason", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("sudo apt update");
    const prompt = vi.fn(async () => true);
    await runExec(ctx, makeReq({ hasUI: false, canPrompt: true }), {
      ...deps,
      prompt,
      historyPath: historyPath(),
    });
    expect(prompt).toHaveBeenCalledWith("sudo apt update", "runs as root");
  });

  it("prompt → false: no exec, declined history entry, exit 130, stderr cancel line", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("rm -rf ./build");
    const prompt = vi.fn(async () => false);
    const code = await runExec(ctx, makeReq({ hasUI: false, canPrompt: true }), {
      ...deps,
      prompt,
      historyPath: historyPath(),
    });
    expect(code).toBe(130);
    expect(deps.exec).not.toHaveBeenCalled();
    expect(stderr).toContain("pi-exec: canceled — nothing executed\n");
    const entries = await readHistory(historyPath());
    expect(entries[0]).toMatchObject({ kind: "declined", command: "rm -rf ./build" });
  });

  it("yes skips the terminal prompt entirely", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    const prompt = vi.fn(async () => false);
    const code = await runExec(ctx, makeReq({ hasUI: false, canPrompt: true, yes: true }), {
      ...deps,
      prompt,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(deps.exec).toHaveBeenCalledOnce();
  });

  it("hasUI keeps the dialog — the terminal prompt is never used", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    const deps = makeDeps("ls -la");
    const prompt = vi.fn(async () => true);
    await runExec(ctx, makeReq({ hasUI: true, canPrompt: true }), {
      ...deps,
      prompt,
      historyPath: historyPath(),
    });
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("dry-run plans never reach the terminal prompt", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    const prompt = vi.fn(async () => true);
    const code = await runExec(ctx, makeReq({ hasUI: false, canPrompt: true, printOnly: true }), {
      ...deps,
      prompt,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(deps.exec).not.toHaveBeenCalled();
    // Deliberate --exec-print dry-run: plain marker, no hint.
    expect(stderr).toContain("pi-exec: dry run — not executed\n");
  });

  it("banner still goes to stdout after the terminal confirm, before the child streams", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("sudo apt update", async (_c, _cwd, opts) => {
      opts.onStdout("child out\n");
      return { code: 0, killed: false };
    });
    const prompt = vi.fn(async () => true);
    const code = await runExec(ctx, makeReq({ hasUI: false, canPrompt: true }), {
      ...deps,
      prompt,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([`${formatSecurityBanner("runs as root")}\n`, "child out\n"]);
  });

  it("without deps.prompt, falls back to the built-in terminalConfirm on /dev/tty", async () => {
    const rl = makeRl("n");
    mockRl(rl);
    // Open the tty seam: two fds, two benign tty streams.
    vi.mocked(openSync).mockImplementationOnce(() => 11).mockImplementationOnce(() => 12);
    vi.mocked(ReadStream).mockImplementationOnce(
      () => ({ on: vi.fn(), destroy: vi.fn() }) as never,
    );
    vi.mocked(WriteStream).mockImplementationOnce(
      () => ({ on: vi.fn(), destroy: vi.fn() }) as never,
    );
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    const code = await runExec(ctx, makeReq({ hasUI: false, canPrompt: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(130);
    expect(deps.exec).not.toHaveBeenCalled();
    expect(openSync).toHaveBeenCalledWith("/dev/tty", "r");
    expect(openSync).toHaveBeenCalledWith("/dev/tty", "w");
    expect(ReadStream).toHaveBeenCalledWith(11);
    expect(WriteStream).toHaveBeenCalledWith(12);
    expect(rl.question).toHaveBeenCalledWith("$ ls -la\nRun this command? [y/N] ");
    expect(rl.close).toHaveBeenCalled();
  });

  it("built-in terminalConfirm EOF/close before an answer also declines", async () => {
    const rl = makeRl("", true);
    mockRl(rl);
    vi.mocked(openSync).mockImplementationOnce(() => 11).mockImplementationOnce(() => 12);
    vi.mocked(ReadStream).mockImplementationOnce(
      () => ({ on: vi.fn(), destroy: vi.fn() }) as never,
    );
    vi.mocked(WriteStream).mockImplementationOnce(
      () => ({ on: vi.fn(), destroy: vi.fn() }) as never,
    );
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    const code = await runExec(ctx, makeReq({ hasUI: false, canPrompt: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(130);
    expect(rl.close).toHaveBeenCalled();
  });

  it("the headless dry-run hint explains how to actually run (D-9)", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    const prompt = vi.fn(async () => true);
    await runExec(ctx, makeReq({ hasUI: false }), { ...deps, prompt, historyPath: historyPath() });
    expect(stderr).toContain(`${TTY_HINT}\n`);
  });
});

describe("runExec — D-7 security banner", () => {
  let stdout: string[];
  let stderr: string[];
  let stdoutSpy: ReturnType<typeof spyStdout>;
  let stderrSpy: ReturnType<typeof spyStderr>;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    stdoutSpy = spyStdout(stdout);
    stderrSpy = spyStderr(stderr);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("print dry-run + warn → banner line first, then the command", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("sudo apt update");
    const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([
      `${formatSecurityBanner("runs as root")}\n`,
      "sudo apt update\n",
    ]);
    expect(stdout[0]).toBe("# ⚠ pi-exec: security risk — runs as root\n");
  });

  it("clean print dry-run keeps stdout free of any banner", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(stdout).toEqual(["ls -la\n"]);
    expect(stdout.join("")).not.toContain("security risk");
  });

  it("print run + warn + yes → banner on stdout BEFORE the child streams", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("sudo apt update", async (_c, _cwd, opts) => {
      opts.onStdout("child out\n");
      return { code: 0, killed: false };
    });
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([
      `${formatSecurityBanner("runs as root")}\n`,
      "child out\n",
    ]);
    // The command itself never touches stdout in run mode.
    expect(stdout.join("")).not.toContain("$ sudo apt update");
  });

  it("json mode → banner to stderr, stdout untouched", async () => {
    const { ctx } = makeCtx({ mode: "json", hasUI: false });
    const deps = makeDeps("sudo apt update", async (_c, _cwd, opts) => {
      opts.onStdout("child out\n");
      return { code: 0, killed: false };
    });
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      `${formatSecurityBanner("runs as root")}\n`,
      "$ sudo apt update\n",
      "child out\n",
      "pi-exec: ran: sudo apt update (exit 0)\n",
    ]);
  });

  it("UI dry-run + warn → a single warning notify carrying risk text and command", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    const deps = makeDeps("sudo apt update");
    await runExec(ctx, makeReq({ printOnly: true }), { ...deps, historyPath: historyPath() });
    expect(ui.notify).toHaveBeenCalledOnce();
    const [message, level] = ui.notify.mock.calls[0] as [string, string];
    expect(level).toBe("warning");
    expect(message).toContain("⚠ security risk — runs as root");
    expect(message).toContain("$ sudo apt update");
  });

  it("formatSecurityBanner collapses embedded newlines (stays one line)", () => {
    expect(formatSecurityBanner("two\nlines")).toBe(
      "# ⚠ pi-exec: security risk — two lines",
    );
    expect(formatSecurityBanner("win\r\nlines")).toBe(
      "# ⚠ pi-exec: security risk — win lines",
    );
    expect(formatSecurityBanner("plain")).toBe("# ⚠ pi-exec: security risk — plain");
  });
});

describe("runExec — streaming by mode", () => {
  it("print mode: child stdout → stdout, child stderr → stderr, live", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = spyStdout(stdout);
    const stderrSpy = spyStderr(stderr);
    try {
      const { ctx } = makeCtx({ mode: "print", hasUI: false });
      const deps = makeDeps("ls", async (_c, _cwd, opts) => {
        opts.onStdout("out one\n");
        opts.onStderr("err one\n");
        opts.onStdout("out two");
        return { code: 3, killed: false };
      });
      const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
        ...deps,
        historyPath: historyPath(),
      });
      expect(code).toBe(3);
      expect(stdout).toEqual(["out one\n", "out two"]);
      expect(stderr).toEqual(["$ ls\n", "err one\n", "pi-exec: ran: ls (exit 3)\n"]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("tui mode: widget gets the live tail under the pi-exec key, final notify reports the exit", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    const deps = makeDeps("ls", async (_c, _cwd, opts) => {
      opts.onStdout("line one\n");
      opts.onStderr("warn line\n");
      opts.onStdout("line two\n");
      return { code: 0, killed: false };
    });
    const code = await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    expect(code).toBe(0);
    expect(ui.setWidget.mock.calls.length).toBeGreaterThan(0);
    for (const [key] of ui.setWidget.mock.calls as [string, string[]][]) {
      expect(key).toBe("pi-exec");
    }
    const last = ui.setWidget.mock.calls.at(-1) as [string, string[]];
    expect(last[1]).toEqual(["line one", "warn line", "line two"]);
    // The widget is never cleared — final output stays visible.
    expect(last[1]).not.toBeUndefined();
    // D-13: the final report names the executed command.
    const ran = ui.notify.mock.calls.find(
      (call) => (call[0] as string).includes("pi-exec: ran"),
    ) as [string, string];
    expect(ran[0]).toBe("pi-exec: ran 'ls' (exit 0)");
  });

  it("rpc mode: no widget, final notify includes the output tail", async () => {
    const { ctx, ui } = makeCtx({ mode: "rpc", hasUI: true });
    const deps = makeDeps("ls", async (_c, _cwd, opts) => {
      opts.onStdout(`line a\nline b\nline c\n`);
      return { code: 0, killed: false };
    });
    const code = await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    expect(code).toBe(0);
    expect(ui.setWidget).not.toHaveBeenCalled();
    const ran = ui.notify.mock.calls.find(
      (call) => (call[0] as string).includes("pi-exec: ran"),
    ) as [string, string];
    expect(ran[0]).toContain("pi-exec: ran 'ls' (exit 0)");
    expect(ran[0]).toContain("line a");
    expect(ran[0]).toContain("line c");
  });

  it("rpc mode: non-zero exit notifies at warning level", async () => {
    const { ctx, ui } = makeCtx({ mode: "rpc", hasUI: true });
    const deps = makeDeps("ls", async () => ({ code: 42, killed: false }));
    const code = await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    expect(code).toBe(42);
    const calls = ui.notify.mock.calls as unknown as [string, string][];
    const ran = calls.find((call) => call[0].includes("pi-exec: ran"))!;
    expect(ran[0]).toContain("pi-exec: ran 'ls' (exit 42)");
    expect(ran[1]).toBe("warning");
  });

  it("rpc tail lines are capped at 200 chars and the buffer drops its front past 8000", async () => {
    const { ctx, ui } = makeCtx({ mode: "rpc", hasUI: true });
    const deps = makeDeps("ls", async (_c, _cwd, opts) => {
      opts.onStdout(`EARLY-CONTENT-${"y".repeat(7980)}`);
      opts.onStdout("\nLATE-MARKER\n");
      return { code: 0, killed: false };
    });
    await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    const ran = ui.notify.mock.calls.find(
      (call) => (call[0] as string).includes("pi-exec: ran"),
    ) as unknown as [string, string];
    // The over-long first line is capped at 200 chars…
    const tailLine = ran[0].split("\n")[1] as string;
    expect(tailLine.length).toBe(200);
    // …the buffer's front was dropped (EARLY-CONTENT is gone)…
    expect(ran[0]).not.toContain("EARLY-CONTENT");
    // …and the newest content survived in the tail.
    expect(ran[0]).toContain("LATE-MARKER");
  });

  it("req.signal is composed into the signal forwarded to exec", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const deps = makeDeps("ls", async (_c, _cwd, opts) => {
      seen = opts.signal;
      return { code: 0, killed: false };
    });
    await runExec(ctx, makeReq({ hasUI: false, yes: true, signal: controller.signal }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });

  it("exec always receives a (non-aborted) timeout signal", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    let seen: AbortSignal | undefined;
    const deps = makeDeps("ls", async (_c, _cwd, opts) => {
      seen = opts.signal;
      return { code: 0, killed: false };
    });
    await runExec(ctx, makeReq({ hasUI: false, yes: true, timeoutSec: 5 }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });
});

describe("runExec — history wiring", () => {
  function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      ts: 1_700_000_000_000,
      text: "earlier request",
      command: "echo earlier",
      kind: "run",
      cwd: "/work",
      ...overrides,
    };
  }

  it("run outcome appends exactly one entry with exitCode and cwd", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false, cwd: "/somewhere" });
    const deps = makeDeps("ls -la", async () => ({ code: 7, killed: false }));
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true, text: "list files" }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(7);
    const entries = await readHistory(historyPath());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      ts: expect.any(Number),
      text: "list files",
      command: "ls -la",
      kind: "run",
      exitCode: 7,
      cwd: "/somewhere",
    });
  });

  it("dry-run outcome: kind dry-run, no exitCode", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la");
    await runExec(ctx, makeReq({ hasUI: false }), { ...deps, historyPath: historyPath() });
    const entries = await readHistory(historyPath());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("dry-run");
    expect(entries[0]).not.toHaveProperty("exitCode");
  });

  it("declined outcome: kind declined, command kept, no exitCode", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    ui.confirm.mockResolvedValue(false);
    const deps = makeDeps("git push --force");
    await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    const entries = await readHistory(historyPath());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      ts: expect.any(Number),
      text: "list files",
      command: "git push --force",
      kind: "declined",
      warn: "force push rewrites remote history",
      cwd: "/work",
    });
  });

  it("refuse and error outcomes append entries with an empty command", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const refuse = makeDeps("NOT_ONE_COMMAND: two steps");
    await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      ...refuse,
      historyPath: historyPath(),
    });
    const failing: RunDeps = {
      complete: vi.fn(async () => {
        throw new Error("boom");
      }),
      historyPath: historyPath(),
    };
    await runExec(ctx, makeReq({ hasUI: false, text: "second request" }), failing);
    const entries = await readHistory(historyPath());
    expect(entries).toEqual([
      {
        ts: expect.any(Number),
        text: "list files",
        command: "",
        kind: "refuse",
        cwd: "/work",
      },
      {
        ts: expect.any(Number),
        text: "second request",
        command: "",
        kind: "error",
        cwd: "/work",
      },
    ]);
  });

  it("no-model outcome appends an error entry with an empty command", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false, model: null });
    const deps = makeDeps("ls");
    await runExec(ctx, makeReq({ hasUI: false }), { ...deps, historyPath: historyPath() });
    const entries = await readHistory(historyPath());
    expect(entries).toEqual([
      {
        ts: expect.any(Number),
        text: "list files",
        command: "",
        kind: "error",
        cwd: "/work",
      },
    ]);
  });

  it("warn is recorded only when the lint warned", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("sudo apt update");
    await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    const entries = await readHistory(historyPath());
    expect(entries[0]?.warn).toBe("runs as root");

    const clean = makeCtx({ mode: "print", hasUI: false });
    const cleanDeps = makeDeps("ls -la");
    await runExec(clean.ctx, makeReq({ hasUI: false }), {
      ...cleanDeps,
      historyPath: historyPath(),
    });
    const after = await readHistory(historyPath());
    expect(after).toHaveLength(2);
    expect(after[1]).not.toHaveProperty("warn");
  });

  it("unwritable historyPath never breaks the exec result", async () => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "occupied", "utf8");
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("ls -la", async () => ({ code: 5, killed: false }));
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
      ...deps,
      historyPath: join(blocker, "history.jsonl"),
    });
    expect(code).toBe(5);
    expect(deps.exec).toHaveBeenCalledOnce();
  });

  it("loads the last 3 non-empty commands as recentCommands into the model prompt", async () => {
    const path = historyPath();
    await appendHistoryEntry(path, makeHistoryEntry({ command: "git status" }));
    await appendHistoryEntry(path, makeHistoryEntry({ command: "", kind: "refuse" }));
    await appendHistoryEntry(path, makeHistoryEntry({ command: "npm test" }));
    await appendHistoryEntry(path, makeHistoryEntry({ command: "ls -la" }));

    const prompts: string[] = [];
    const deps = {
      complete: vi.fn(async (_system: string, userPrompt: string) => {
        prompts.push(userPrompt);
        return "ls -la";
      }),
      historyPath: path,
    };
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    await runExec(ctx, makeReq({ hasUI: false }), deps);
    expect(prompts[0]).toBe(
      "Request: list files\nWorking directory: /work\n" +
        "Recent commands run via pi-exec (for reference):\n" +
        "$ git status\n$ npm test\n$ ls -la",
    );
  });

  it("DEFAULT_HISTORY_PATH points at ~/.pi/agent/cache/pi-exec/history.jsonl", () => {
    expect(DEFAULT_HISTORY_PATH.endsWith(join(".pi", "agent", "cache", "pi-exec", "history.jsonl")))
      .toBe(true);
  });
});

describe("runExec — D-13 ran-command report", () => {
  let stdout: string[];
  let stderr: string[];
  let stdoutSpy: ReturnType<typeof spyStdout>;
  let stderrSpy: ReturnType<typeof spyStderr>;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    stdoutSpy = spyStdout(stdout);
    stderrSpy = spyStderr(stderr);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("headless print: the final stderr line is `pi-exec: ran: <command> (exit N)`", async () => {
    const { ctx } = makeCtx({ mode: "print", hasUI: false });
    const deps = makeDeps("echo hello world", async () => ({ code: 7, killed: false }));
    const code = await runExec(ctx, makeReq({ hasUI: false, yes: true }), {
      ...deps,
      historyPath: historyPath(),
    });
    expect(code).toBe(7);
    expect(stderr.at(-1)).toBe("pi-exec: ran: echo hello world (exit 7)\n");
  });

  it("tui: the final notify is `pi-exec: ran '<command>' (exit N)`", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    const deps = makeDeps("echo hello world", async () => ({ code: 3, killed: false }));
    const code = await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    expect(code).toBe(3);
    const ran = ui.notify.mock.calls.find(
      (call) => (call[0] as string).includes("pi-exec: ran"),
    ) as [string, string];
    expect(ran[0]).toBe("pi-exec: ran 'echo hello world' (exit 3)");
    expect(ran[1]).toBe("warning");
  });

  it("tui: a clean run reports the command at info level", async () => {
    const { ctx, ui } = makeCtx({ mode: "tui", hasUI: true });
    const deps = makeDeps("ls -la");
    const code = await runExec(ctx, makeReq(), { ...deps, historyPath: historyPath() });
    expect(code).toBe(0);
    const ran = ui.notify.mock.calls.find(
      (call) => (call[0] as string).includes("pi-exec: ran"),
    ) as [string, string];
    expect(ran[0]).toBe("pi-exec: ran 'ls -la' (exit 0)");
    expect(ran[1]).toBe("info");
  });
});

describe("runExec — D-11/D-12 model selection (registry path)", () => {
  function assistantMessage(text: string): unknown {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
    };
  }

  it("D-11: the default complete passes reasoning minimal in the registry options", async () => {
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryComplete });
    const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(registryComplete).toHaveBeenCalledOnce();
    const options = (registryComplete.mock.calls[0] as unknown as unknown[] | undefined)?.[2] as {
      maxTokens: number;
      reasoning?: string;
      signal?: AbortSignal;
    };
    expect(options.reasoning).toBe("minimal");
    expect(options.maxTokens).toBe(300);
  });

  it("D-12: deps.model overrides ctx.model in the registry call", async () => {
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryComplete });
    const override = { provider: "ollama", id: "glm-5.3-flash:cloud" } as unknown as Model<Api>;
    const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      model: override,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(registryComplete).toHaveBeenCalledOnce();
    const [modelArg] = registryComplete.mock.calls[0] as unknown as [unknown];
    // The override object itself — not the session model — reaches the registry.
    expect(modelArg).toBe(override);
    expect(modelArg).not.toEqual({ provider: "test", id: "test-model" });
  });

  it("D-12: deps.model alone is enough when ctx.model is null", async () => {
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, model: null, registryComplete });
    const override = { provider: "test", id: "override-model" } as unknown as Model<Api>;
    const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      model: override,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(registryComplete).toHaveBeenCalledOnce();
    const [modelArg] = registryComplete.mock.calls[0] as unknown as [unknown];
    expect(modelArg).toBe(override);
  });
});

describe("runExec — default generation model (D-14)", () => {
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env[EXEC_MODEL_ENV];
    delete process.env[EXEC_MODEL_ENV];
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[EXEC_MODEL_ENV];
    else process.env[EXEC_MODEL_ENV] = previousEnv;
  });

  function modelSentinel(id: string): Model<Api> {
    return { provider: "ollama", id } as unknown as Model<Api>;
  }

  function assistantMessage(text: string): unknown {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "ollama",
      model: "flash",
    };
  }

  it("env unset → the built-in cheap default (deepseek-v4-flash) is resolved and used", async () => {
    const sentinel = modelSentinel(DEFAULT_EXEC_MODEL.id);
    const find = vi.fn(() => sentinel);
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryFind: find, registryComplete });
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      exec: deps.exec,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    expect(find).toHaveBeenCalledWith(DEFAULT_EXEC_MODEL.provider, DEFAULT_EXEC_MODEL.id);
    const [modelArg] = registryComplete.mock.calls[0] as unknown as [unknown];
    // The flash default — not the session model — reaches the registry.
    expect(modelArg).toBe(sentinel);
  });

  it("env set + resolvable → the env model wins over the built-in default", async () => {
    const envModel = modelSentinel("glm-5.3-flash:cloud");
    const defaultModel = modelSentinel(DEFAULT_EXEC_MODEL.id);
    const find = vi.fn((provider: string, id: string) =>
      id === "glm-5.3-flash:cloud" ? envModel : defaultModel,
    );
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryFind: find, registryComplete });
    process.env[EXEC_MODEL_ENV] = "ollama/glm-5.3-flash:cloud";
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      exec: deps.exec,
      historyPath: historyPath(),
    });
    expect(find).toHaveBeenCalledWith("ollama", "glm-5.3-flash:cloud");
    const [modelArg] = registryComplete.mock.calls[0] as unknown as [unknown];
    expect(modelArg).toBe(envModel);
  });

  it("env set but unknown → warns and falls through to the built-in default", async () => {
    const sentinel = modelSentinel(DEFAULT_EXEC_MODEL.id);
    const find = vi.fn((_provider: string, id: string) =>
      id === DEFAULT_EXEC_MODEL.id ? sentinel : undefined,
    );
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx, ui } = makeCtx({
      mode: "print",
      hasUI: false,
      registryFind: find,
      registryComplete,
    });
    process.env[EXEC_MODEL_ENV] = "ollama/nope";
    const stderr: string[] = [];
    const stderrSpy = spyStderr(stderr);
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    try {
      const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
        exec: deps.exec,
        historyPath: historyPath(),
      });
      expect(code).toBe(0);
    } finally {
      stderrSpy.mockRestore();
    }
    expect(stderr.join("")).toContain("PI_EXEC_MODEL ollama/nope: unknown model");
    expect(ui.notify).not.toHaveBeenCalled();
    const [modelArg] = registryComplete.mock.calls[0] as unknown as [unknown];
    expect(modelArg).toBe(sentinel);
  });

  it("env without a provider → usage warning, built-in default still used", async () => {
    const sentinel = modelSentinel(DEFAULT_EXEC_MODEL.id);
    const find = vi.fn(() => sentinel);
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryFind: find, registryComplete });
    process.env[EXEC_MODEL_ENV] = "just-an-id";
    const stderr: string[] = [];
    const stderrSpy = spyStderr(stderr);
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    try {
      await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
        exec: deps.exec,
        historyPath: historyPath(),
      });
    } finally {
      stderrSpy.mockRestore();
    }
    expect(stderr.join("")).toContain("usage: PI_EXEC_MODEL=<provider/model-id>");
    // The malformed env value never reaches find as a provider.
    expect(find).not.toHaveBeenCalledWith("just-an-id", expect.anything());
    expect(find).toHaveBeenCalledWith(DEFAULT_EXEC_MODEL.provider, DEFAULT_EXEC_MODEL.id);
  });

  it("D-12 beats D-14: deps.model (the --exec-model flag) wins over a resolvable env", async () => {
    const flagModel = modelSentinel("flag-model:cloud");
    const find = vi.fn(() => modelSentinel("env-model:cloud"));
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryFind: find, registryComplete });
    process.env[EXEC_MODEL_ENV] = "ollama/env-model:cloud";
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      model: flagModel,
      exec: deps.exec,
      historyPath: historyPath(),
    });
    expect(find).not.toHaveBeenCalled();
    const [modelArg] = registryComplete.mock.calls[0] as unknown as [unknown];
    expect(modelArg).toBe(flagModel);
  });

  it("nothing resolves (find undefined everywhere) → ctx.model is the fallback", async () => {
    const find = vi.fn(() => undefined);
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({ mode: "print", hasUI: false, registryFind: find, registryComplete });
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      exec: deps.exec,
      historyPath: historyPath(),
    });
    const [modelArg] = registryComplete.mock.calls[0] as unknown as [unknown];
    expect(modelArg).toEqual({ provider: "test", id: "test-model" });
  });

  it("a throwing registry find is swallowed → ctx.model fallback, no throw", async () => {
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({
      mode: "print",
      hasUI: false,
      registryFind: () => {
        throw new Error("registry hiccup");
      },
      registryComplete,
    });
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
      exec: deps.exec,
      historyPath: historyPath(),
    });
    expect(code).toBe(0);
    const [modelArg] = registryComplete.mock.calls[0] as unknown as [unknown];
    expect(modelArg).toEqual({ provider: "test", id: "test-model" });
  });

  it("nothing resolves and ctx.model is null → the no-active-model error stands", async () => {
    const find = vi.fn(() => undefined);
    const registryComplete = vi.fn(async () => assistantMessage("ls -la\n"));
    const { ctx } = makeCtx({
      mode: "print",
      hasUI: false,
      model: null,
      registryFind: find,
      registryComplete,
    });
    const deps = makeDeps("ls", async () => ({ code: 0, killed: false }));
    const stderr: string[] = [];
    const stderrSpy = spyStderr(stderr);
    try {
      const code = await runExec(ctx, makeReq({ hasUI: false, printOnly: true }), {
        exec: deps.exec,
        historyPath: historyPath(),
      });
      expect(code).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
    expect(registryComplete).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("no active model");
  });

  it("resolveDefaultModel returns the built-in default directly when nothing else applies", () => {
    const sentinel = modelSentinel(DEFAULT_EXEC_MODEL.id);
    const { ctx } = makeCtx({
      mode: "print",
      hasUI: false,
      registryFind: (_provider: string, id: string) => (id === DEFAULT_EXEC_MODEL.id ? sentinel : undefined),
    });
    expect(resolveDefaultModel(ctx)).toBe(sentinel);
    // Whitespace-only env values count as unset.
    process.env[EXEC_MODEL_ENV] = "   ";
    expect(resolveDefaultModel(ctx)).toBe(sentinel);
  });
});