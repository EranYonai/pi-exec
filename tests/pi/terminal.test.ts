import { beforeEach, describe, expect, it, vi } from "vitest";

// NEVER open a real /dev/tty in tests: node:fs (openSync/accessSync) and
// node:tty are fully mocked, and node:readline/promises is mocked too
// (history.ts uses node:fs/promises — a different specifier, left untouched
// so its real tmpdir behavior is preserved).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: vi.fn(),
    openSync: vi.fn(),
  };
});
vi.mock("node:tty", () => ({
  ReadStream: vi.fn(),
  WriteStream: vi.fn(),
}));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

import { accessSync, constants, openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import { createInterface } from "node:readline/promises";
import { EXEC_HELP_LINES, terminalConfirm, ttyAvailable } from "../../src/pi/run";

const accessSyncMock = vi.mocked(accessSync);
const openSyncMock = vi.mocked(openSync);
const ttyReadStreamMock = vi.mocked(ReadStream);
const ttyWriteStreamMock = vi.mocked(WriteStream);
const createInterfaceMock = vi.mocked(createInterface);

interface FakeRl {
  on: ReturnType<typeof vi.fn<(event: string, listener: (err?: unknown) => void) => void>>;
  question: ReturnType<typeof vi.fn<(q: string) => Promise<string>>>;
  close: ReturnType<typeof vi.fn<() => void>>;
}

function makeRl(answer: string, reject = false): FakeRl {
  return {
    on: vi.fn(),
    question: vi.fn((_q: string) =>
      reject ? Promise.reject(new Error("readline was closed")) : Promise.resolve(answer),
    ),
    close: vi.fn(),
  };
}

/** Minimal tty stream fake: 'error' listener attachment + destroy. */
function makeFakeStream(): { on: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
  return { on: vi.fn(), destroy: vi.fn() };
}

function mockRl(rl: FakeRl): void {
  createInterfaceMock.mockReturnValue(rl as unknown as ReturnType<typeof createInterface>);
}

beforeEach(() => {
  // mockReset (not just clear): implementations like a throwing openSync
  // must not leak between tests.
  accessSyncMock.mockReset();
  openSyncMock.mockReset();
  ttyReadStreamMock.mockReset();
  ttyWriteStreamMock.mockReset();
  createInterfaceMock.mockReset();
  // Defaults: two distinct fds (r then w) and benign fake streams — tests
  // override what they need to observe.
  openSyncMock.mockImplementation(
    ((_path: string, flags: string | number) => (String(flags).includes("r") ? 11 : 12)) as typeof openSync,
  );
  ttyReadStreamMock.mockImplementation(() => makeFakeStream() as never);
  ttyWriteStreamMock.mockImplementation(() => makeFakeStream() as never);
});

describe("ttyAvailable (D-9)", () => {
  it("true when /dev/tty is readable and writable", () => {
    expect(ttyAvailable()).toBe(true);
    expect(accessSyncMock).toHaveBeenCalledOnce();
    expect(accessSyncMock).toHaveBeenCalledWith("/dev/tty", constants.R_OK | constants.W_OK);
  });

  it("false when accessSync throws (no controlling terminal)", () => {
    accessSyncMock.mockImplementation(() => {
      throw new Error("ENOENT: /dev/tty");
    });
    expect(ttyAvailable()).toBe(false);
  });

  it("false when accessSync throws a non-Error — never throws itself", () => {
    accessSyncMock.mockImplementation(() => {
      throw "weird";
    });
    expect(() => ttyAvailable()).not.toThrow();
    expect(ttyAvailable()).toBe(false);
  });
});

describe("terminalConfirm (D-9)", () => {
  it("opens /dev/tty via node:tty streams (r + w fds) and closes the interface afterwards", async () => {
    const rl = makeRl("y");
    mockRl(rl);
    await expect(terminalConfirm("ls -la")).resolves.toBe(true);
    expect(openSyncMock).toHaveBeenCalledWith("/dev/tty", "r");
    expect(openSyncMock).toHaveBeenCalledWith("/dev/tty", "w");
    expect(ttyReadStreamMock).toHaveBeenCalledWith(11);
    expect(ttyWriteStreamMock).toHaveBeenCalledWith(12);
    expect(createInterfaceMock).toHaveBeenCalledOnce();
    expect(rl.close).toHaveBeenCalledOnce();
  });

  it.each(["y", "yes", "Yes", "YES", " y "])("accepts %j (trimmed, case-insensitive)", async (answer) => {
    const rl = makeRl(answer);
    mockRl(rl);
    await expect(terminalConfirm("ls -la")).resolves.toBe(true);
  });

  it.each(["n", "no", "N", "", "nope", "yes please", "maybe"])("declines %j", async (answer) => {
    const rl = makeRl(answer);
    mockRl(rl);
    await expect(terminalConfirm("ls -la")).resolves.toBe(false);
  });

  it("empty answer (EOF resolving the question) declines", async () => {
    const rl = makeRl("");
    mockRl(rl);
    await expect(terminalConfirm("ls -la")).resolves.toBe(false);
  });

  it("EOF/close before an answer declines and still closes the interface", async () => {
    const rl = makeRl("", true);
    mockRl(rl);
    await expect(terminalConfirm("ls -la")).resolves.toBe(false);
    expect(rl.close).toHaveBeenCalledOnce();
  });

  it("tty open throwing (no tty) declines without ever reaching readline", async () => {
    openSyncMock.mockImplementation(() => {
      throw new Error("no tty available");
    });
    const rl = makeRl("y");
    mockRl(rl);
    await expect(terminalConfirm("ls -la")).resolves.toBe(false);
    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect(rl.close).not.toHaveBeenCalled();
  });

  it("attaches 'error' listeners to the tty streams and the interface (stream-death regression)", async () => {
    // The synchronous open can succeed while the streams die later (EOF,
    // device errors) — the streams' 'error' events must be listened to, or
    // Node crashes with an unhandled 'error' event.
    const onInput = vi.fn();
    const onOutput = vi.fn();
    ttyReadStreamMock.mockImplementation(
      () => ({ on: onInput, destroy: vi.fn() }) as never,
    );
    ttyWriteStreamMock.mockImplementation(
      () => ({ on: onOutput, destroy: vi.fn() }) as never,
    );
    const rl = makeRl("y");
    mockRl(rl);
    await expect(terminalConfirm("ls -la")).resolves.toBe(true);
    expect(onInput).toHaveBeenCalledWith("error", expect.any(Function));
    expect(onOutput).toHaveBeenCalledWith("error", expect.any(Function));
    expect(rl.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("a stream 'error' after the open (EOF/device failure) declines instead of crashing", async () => {
    let failStream: ((err: unknown) => void) | undefined;
    ttyReadStreamMock.mockImplementation(() => ({
      on: vi.fn((event: string, listener: (err: unknown) => void) => {
        if (event === "error") failStream = listener;
      }),
      destroy: vi.fn(),
    }) as never);
    const rl = {
      on: vi.fn(),
      question: vi.fn(
        (_q: string) =>
          new Promise<string>((_resolve, reject) => {
            // The interface never answers: the stream died mid-question.
            queueMicrotask(() => reject(new Error("readline was closed")));
          }),
      ),
      close: vi.fn(),
    };
    mockRl(rl as unknown as FakeRl);
    const pending = terminalConfirm("ls -la");
    // The stream failure arrives while the question is still pending.
    queueMicrotask(() =>
      failStream?.(Object.assign(new Error("open '/dev/tty' failed"), { code: "ENXIO" })),
    );
    await expect(pending).resolves.toBe(false);
    expect(rl.close).toHaveBeenCalledOnce();
  });

  it("question text: warn reason, then the command, then the fixed ask", async () => {
    const rl = makeRl("y");
    mockRl(rl);
    await terminalConfirm("sudo apt update", "runs as root");
    expect(rl.question).toHaveBeenCalledWith(
      "⚠ security risk — runs as root\n$ sudo apt update\nRun this command? [y/N] ",
    );
  });

  it("question text without a warn: command line plus the fixed ask", async () => {
    const rl = makeRl("y");
    mockRl(rl);
    await terminalConfirm("ls -la");
    expect(rl.question).toHaveBeenCalledWith("$ ls -la\nRun this command? [y/N] ");
  });

  it("never touches stdout or stderr — the question lives on the tty only", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    try {
      const rl = makeRl("y");
      mockRl(rl);
      await terminalConfirm("sudo apt update", "runs as root");
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe("EXEC_HELP_LINES (D-10)", () => {
  const text = EXEC_HELP_LINES.join("\n");

  it("is a compact menu (15–25 lines) with a one-line pitch", () => {
    expect(EXEC_HELP_LINES.length).toBeGreaterThanOrEqual(15);
    expect(EXEC_HELP_LINES.length).toBeLessThanOrEqual(25);
    expect(EXEC_HELP_LINES[0]).toContain("pi-exec");
  });

  it("names every flag", () => {
    for (const flag of [
      "--exec",
      "--exec-yes",
      "--exec-print",
      "--exec-timeout",
      "--exec-history",
      "--exec-help",
    ]) {
      expect(text).toContain(flag);
    }
  });

  it("documents the recommended no-interface one-shot and the TUI form", () => {
    expect(text).toContain('pi -p --no-session --exec "<request>"');
    expect(text).toContain("TUI");
  });

  it("documents the in-session commands and the empty-value help form", () => {
    expect(text).toContain("/exec");
    expect(text).toContain("/exec-history");
    expect(text).toContain('--exec ""');
  });

  it("summarizes safety: deny never runs even with --exec-yes, warn shows its reason, dry-run fallback", () => {
    expect(text).toContain("--exec-yes");
    expect(text).toContain("dry-run");
    expect(text.toLowerCase()).toContain("confirm");
  });

  it("documents the exit codes (child code, 130 declined, 1 refusal/error, 0 dry-run/help)", () => {
    expect(text).toContain("130");
    expect(text).toContain("1");
    expect(text).toContain("0");
  });

  it("points at the history cache and how to reset it", () => {
    expect(text).toContain("~/.pi/agent/cache");
    expect(text).toContain("delete the file to reset");
  });
});