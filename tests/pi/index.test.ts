import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHistoryEntry,
  readHistory,
  type HistoryEntry,
} from "../../src/core";
import piExec from "../../src/pi/index";

let dir: string;
let historyPath: string;
const originalExitCode = process.exitCode;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-exec-index-"));
  historyPath = join(dir, "history.jsonl");
});

afterEach(async () => {
  process.exitCode = originalExitCode;
  await rm(dir, { recursive: true, force: true });
});

interface FlagOptions {
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
}

type SessionStartHandler = (
  event: { reason: string },
  ctx: ExtensionContext,
) => Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface FakePi {
  pi: ExtensionAPI;
  flags: Map<string, FlagOptions>;
  flagValues: Map<string, boolean | string | undefined>;
  commands: Map<string, { description?: string; handler: CommandHandler }>;
  sessionStartHandler: () => SessionStartHandler;
  registerFlag: ReturnType<typeof vi.fn>;
}

/** Fake ExtensionAPI: registerFlag seeds defaults, flag values overridable per test. */
function makePi(): FakePi {
  const flags = new Map<string, FlagOptions>();
  const flagValues = new Map<string, boolean | string | undefined>();
  const commands = new Map<string, { description?: string; handler: CommandHandler }>();
  let sessionStart: SessionStartHandler | undefined;

  const registerFlag = vi.fn((name: string, options: FlagOptions) => {
    flags.set(name, options);
    // pi exposes registered defaults through getFlag until overridden.
    flagValues.set(name, options.default);
  });
  const registerCommand = vi.fn(
    (name: string, options: { description?: string; handler: CommandHandler }) => {
      commands.set(name, options);
    },
  );
  const on = vi.fn((event: string, handler: SessionStartHandler) => {
    if (event === "session_start") sessionStart = handler;
  });
  const getFlag = vi.fn((name: string) => flagValues.get(name));

  const pi = { registerFlag, registerCommand, on, getFlag } as unknown as ExtensionAPI;
  return {
    pi,
    flags,
    flagValues,
    commands,
    sessionStartHandler: () => {
      if (!sessionStart) throw new Error("session_start handler was not registered");
      return sessionStart;
    },
    registerFlag,
  };
}

function makeCtx(mode: ExtensionContext["mode"], signal?: AbortSignal) {
  const ui = {
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    setWidget: vi.fn(),
    setStatus: vi.fn(),
  };
  const raw = {
    ui,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/work",
    model: { provider: "test", id: "test-model" },
    modelRegistry: {
      complete: vi.fn(async () => {
        throw new Error("registry must not be used when deps.complete is injected");
      }),
    },
    signal,
    shutdown: vi.fn(),
  };
  return {
    ctx: raw as unknown as ExtensionContext,
    ui,
    shutdown: raw.shutdown as ReturnType<typeof vi.fn>,
  };
}

function makeDeps() {
  return {
    complete: vi.fn<
      (systemPrompt: string, userPrompt: string, opts: { maxTokens: number; signal?: AbortSignal }) => Promise<string>
    >(async () => "echo hello from exec\n"),
    exec: vi.fn(async () => ({ code: 0, killed: false })),
    historyPath,
  };
}

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

/** Capture process.stderr writes while running `body`, then restore. */
async function captureStderr(body: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return chunks;
}

/** Capture both process streams while running `body`, then restore. */
async function captureBoth(
  body: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  try {
    await body();
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { stdout, stderr };
}

/** Capture process.stdout writes while running `body`, then restore. */
async function captureStdout(body: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return chunks;
}

describe("piExec factory — registration", () => {
  it("registers the 5 flags with the verified types", () => {
    const { pi, flags, registerFlag } = makePi();
    piExec(pi);
    const names = (registerFlag.mock.calls as [string, FlagOptions][]).map(([name]) => name);
    expect(names).toEqual(["exec", "exec-yes", "exec-print", "exec-timeout", "exec-history"]);
    expect(flags.get("exec")?.type).toBe("string");
    expect(flags.get("exec-yes")).toMatchObject({ type: "boolean", default: false });
    expect(flags.get("exec-print")).toMatchObject({ type: "boolean", default: false });
    expect(flags.get("exec-timeout")?.type).toBe("string");
    const history = flags.get("exec-history");
    expect(history?.type).toBe("string");
    // No default: a default would fire the preview in every plain pi session.
    expect(history).not.toHaveProperty("default");
  });

  it("registers /exec and /exec-history commands", () => {
    const { pi, commands } = makePi();
    piExec(pi);
    expect([...commands.keys()]).toEqual(["exec", "exec-history"]);
    expect(commands.get("exec")?.description).toBeTruthy();
    expect(commands.get("exec-history")?.description).toBeTruthy();
  });
});

describe("piExec factory — --exec one-shot", () => {
  it("no flags → inert: no shutdown, no exit code, no pipeline", async () => {
    const { pi, sessionStartHandler } = makePi();
    const deps = makeDeps();
    piExec(pi, deps);
    const { ctx, shutdown } = makeCtx("print");
    process.exitCode = 7;
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.exec).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(7);
  });

  it("flag present → runExec end-to-end, shutdown called, exit 0 (headless dry-run)", async () => {
    const { pi, sessionStartHandler, flagValues } = makePi();
    const deps = makeDeps();
    piExec(pi, deps);
    flagValues.set("exec", "list files");
    const { ctx, shutdown } = makeCtx("print");
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(deps.complete).toHaveBeenCalledOnce();
    expect(deps.exec).not.toHaveBeenCalled(); // headless default is dry-run
    expect(shutdown).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it("exec-yes runs the command and passes the child exit code through", async () => {
    const { pi, sessionStartHandler, flagValues } = makePi();
    const deps = makeDeps();
    deps.exec.mockResolvedValue({ code: 42, killed: false });
    piExec(pi, deps);
    flagValues.set("exec", "list files");
    flagValues.set("exec-yes", true);
    const { ctx, shutdown } = makeCtx("print");
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(deps.exec).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(42);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("exit code is NOT set in tui mode (pi owns the interactive process)", async () => {
    const { pi, sessionStartHandler, flagValues } = makePi();
    const deps = makeDeps();
    piExec(pi, deps);
    flagValues.set("exec", "list files");
    process.exitCode = 7;
    const { ctx, shutdown } = makeCtx("tui");
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(deps.complete).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(7);
  });

  it("session_start reason reload/new/resume/fork → inert even with --exec set", async () => {
    const { pi, sessionStartHandler, flagValues } = makePi();
    const deps = makeDeps();
    piExec(pi, deps);
    flagValues.set("exec", "list files");
    for (const reason of ["reload", "new", "resume", "fork"]) {
      const { ctx, shutdown } = makeCtx("print");
      await sessionStartHandler()({ reason }, ctx);
      expect(shutdown).not.toHaveBeenCalled();
    }
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("empty --exec string → usage failure, exit 1, shutdown", async () => {
    const stderr = await captureStderr(async () => {
      const { pi, sessionStartHandler, flagValues } = makePi();
      const deps = makeDeps();
      piExec(pi, deps);
      flagValues.set("exec", "   ");
      const { ctx, shutdown } = makeCtx("print");
      await sessionStartHandler()({ reason: "startup" }, ctx);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(deps.complete).not.toHaveBeenCalled();
    });
    expect(stderr.join("")).toContain('usage: pi --exec "<request>"');
  });

  it("invalid --exec-timeout → failure, exit 1, shutdown", async () => {
    const stderr = await captureStderr(async () => {
      const { pi, sessionStartHandler, flagValues } = makePi();
      const deps = makeDeps();
      piExec(pi, deps);
      flagValues.set("exec", "list files");
      flagValues.set("exec-timeout", "abc");
      const { ctx, shutdown } = makeCtx("print");
      await sessionStartHandler()({ reason: "startup" }, ctx);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(deps.complete).not.toHaveBeenCalled();
    });
    expect(stderr.join("")).toContain("--exec-timeout");
  });

  it("json mode: exit code is set and stdout stays clean (pi's JSON channel)", async () => {
    const { stderr, stdout } = await captureBoth(async () => {
      const { pi, sessionStartHandler, flagValues } = makePi();
      const deps = makeDeps();
      piExec(pi, deps);
      flagValues.set("exec", "list files");
      const { ctx, shutdown } = makeCtx("json");
      await sessionStartHandler()({ reason: "startup" }, ctx);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(0);
    });
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["echo hello from exec\n", "pi-exec: dry run — not executed\n"]);
  });

  it("forwards ctx.signal into the ExecRequest (session_start path)", async () => {
    const { pi, sessionStartHandler, flagValues } = makePi();
    const deps = makeDeps();
    let seen: AbortSignal | undefined;
    deps.complete.mockImplementation(async (_system: string, _user: string, opts: { signal?: AbortSignal }) => {
      seen = opts?.signal;
      return "echo hello from exec\n";
    });
    piExec(pi, deps);
    flagValues.set("exec", "list files");
    const controller = new AbortController();
    const { ctx } = makeCtx("print", controller.signal);
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(seen).toBe(controller.signal);
  });
});

describe("piExec factory — --exec-history one-shot", () => {
  it("preview printed to stdout (print mode), exit 0, exec pipeline NOT invoked", async () => {
    await appendHistoryEntry(historyPath, makeHistoryEntry({ command: "echo one" }));
    await appendHistoryEntry(
      historyPath,
      makeHistoryEntry({ command: "echo two", kind: "dry-run", text: "request two" }),
    );
    const stdout = await captureStdout(async () => {
      const { pi, sessionStartHandler, flagValues } = makePi();
      const deps = makeDeps();
      piExec(pi, deps);
      flagValues.set("exec-history", "5");
      const { ctx, shutdown } = makeCtx("print");
      await sessionStartHandler()({ reason: "startup" }, ctx);
      expect(deps.complete).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
      expect(shutdown).toHaveBeenCalledOnce();
    });
    expect(stdout).toHaveLength(1);
    // Newest first: echo two before echo one; kind and request text visible.
    expect(stdout[0]).toContain("dry-run · $ echo two");
    expect(stdout[0]).toContain("request: request two");
    expect(stdout[0]!.indexOf("echo two")).toBeLessThan(stdout[0]!.indexOf("echo one"));
  });

  it("json mode: preview goes to stderr, exit 0", async () => {
    await appendHistoryEntry(historyPath, makeHistoryEntry({ command: "echo one" }));
    const { stderr, stdout } = await captureBoth(async () => {
      const { pi, sessionStartHandler, flagValues } = makePi();
      piExec(pi, makeDeps());
      flagValues.set("exec-history", "5");
      const { ctx, shutdown } = makeCtx("json");
      await sessionStartHandler()({ reason: "startup" }, ctx);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(0);
    });
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("$ echo one");
  });

  it("takes precedence over --exec: preview runs, exec pipeline not invoked", async () => {
    const { pi, sessionStartHandler, flagValues } = makePi();
    const deps = makeDeps();
    piExec(pi, deps);
    flagValues.set("exec", "list files");
    flagValues.set("exec-history", "3");
    const { ctx, shutdown } = makeCtx("print");
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.exec).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it("invalid --exec-history value → usage failure mentioning the flag, exit 1", async () => {
    const stderr = await captureStderr(async () => {
      const { pi, sessionStartHandler, flagValues } = makePi();
      const deps = makeDeps();
      piExec(pi, deps);
      flagValues.set("exec-history", "abc");
      const { ctx, shutdown } = makeCtx("print");
      await sessionStartHandler()({ reason: "startup" }, ctx);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(deps.complete).not.toHaveBeenCalled();
    });
    expect(stderr.join("")).toContain("--exec-history <n>");
  });

  it("empty history cache still previews (message, not error) with exit 0", async () => {
    const { pi, sessionStartHandler, flagValues } = makePi();
    const deps = makeDeps();
    piExec(pi, deps);
    flagValues.set("exec-history", "5");
    const { ctx, shutdown } = makeCtx("print");
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(process.exitCode).toBe(0);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("tui mode previews via ui.notify", async () => {
    await appendHistoryEntry(historyPath, makeHistoryEntry({ command: "echo one" }));
    const { pi, sessionStartHandler, flagValues } = makePi();
    piExec(pi, makeDeps());
    flagValues.set("exec-history", "5");
    const { ctx, ui, shutdown } = makeCtx("tui");
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("$ echo one"), "info");
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

describe("piExec factory — /exec command", () => {
  it("empty args → usage notify, pipeline not invoked", async () => {
    const { pi, commands } = makePi();
    const deps = makeDeps();
    piExec(pi, deps);
    const { ctx, ui, shutdown } = makeCtx("tui");
    await commands.get("exec")!.handler("", ctx as ExtensionCommandContext);
    expect(ui.notify).toHaveBeenCalledWith("usage: /exec <request>", "warning");
    expect(deps.complete).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("valid args → full pipeline with defaults, session keeps running (no shutdown)", async () => {
    const { pi, commands } = makePi();
    const deps = makeDeps();
    piExec(pi, deps);
    const { ctx, ui, shutdown } = makeCtx("tui");
    await commands.get("exec")!.handler("list the files here", ctx as ExtensionCommandContext);
    expect(deps.complete).toHaveBeenCalledOnce();
    // yes=false + hasUI → confirm shown; accepted → executed.
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(deps.exec).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("forwards ctx.signal into the ExecRequest (/exec path)", async () => {
    const { pi, commands } = makePi();
    const deps = makeDeps();
    let seen: AbortSignal | undefined;
    deps.complete.mockImplementation(async (_system: string, _user: string, opts: { signal?: AbortSignal }) => {
      seen = opts?.signal;
      return "echo hello from exec\n";
    });
    piExec(pi, deps);
    const controller = new AbortController();
    const { ctx } = makeCtx("tui", controller.signal);
    await commands.get("exec")!.handler("list the files here", ctx as ExtensionCommandContext);
    expect(seen).toBe(controller.signal);
  });

  it("writes exactly one history entry for the /exec outcome", async () => {
    const { pi, commands } = makePi();
    piExec(pi, makeDeps());
    const { ctx } = makeCtx("tui");
    await commands.get("exec")!.handler("list the files here", ctx as ExtensionCommandContext);
    const entries = await readHistory(historyPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      text: "list the files here",
      command: "echo hello from exec",
      kind: "run",
      exitCode: 0,
      cwd: "/work",
    });
  });
});

describe("piExec factory — /exec-history command", () => {
  it("default limit is 10, newest first, reading the deps history seam", async () => {
    for (let i = 1; i <= 12; i++) {
      await appendHistoryEntry(
        historyPath,
        makeHistoryEntry({ command: `echo ${i}`, text: "" }),
      );
    }
    const { pi, commands } = makePi();
    piExec(pi, makeDeps());
    const { ctx, ui } = makeCtx("tui");
    await commands.get("exec-history")!.handler("", ctx as ExtensionCommandContext);
    const [message] = ui.notify.mock.calls[0] as unknown as [string, string];
    const mainLines = message.split("\n").filter((line) => !line.startsWith("    "));
    expect(mainLines).toHaveLength(10);
    expect(mainLines[0]).toContain("$ echo 12");
    expect(mainLines.at(-1)).toContain("$ echo 3");
  });

  it("limit taken from the argument", async () => {
    for (let i = 1; i <= 5; i++) {
      await appendHistoryEntry(
        historyPath,
        makeHistoryEntry({ command: `echo ${i}`, text: "" }),
      );
    }
    const { pi, commands } = makePi();
    piExec(pi, makeDeps());
    const { ctx, ui } = makeCtx("tui");
    await commands.get("exec-history")!.handler("2", ctx as ExtensionCommandContext);
    const [message] = ui.notify.mock.calls[0] as unknown as [string, string];
    const mainLines = message.split("\n").filter((line) => !line.startsWith("    "));
    expect(mainLines).toHaveLength(2);
    expect(mainLines[0]).toContain("$ echo 5");
  });

  it("invalid argument → usage warning", async () => {
    const { pi, commands } = makePi();
    piExec(pi, makeDeps());
    const { ctx, ui } = makeCtx("tui");
    await commands.get("exec-history")!.handler("abc", ctx as ExtensionCommandContext);
    expect(ui.notify).toHaveBeenCalledWith("usage: /exec-history [n]", "warning");
  });
});