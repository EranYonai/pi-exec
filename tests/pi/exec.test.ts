import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// NEVER spawn a real shell in unit tests: node:child_process is fully mocked.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { createSpawnExec } from "../../src/pi/exec";

const spawnMock = vi.mocked(spawn);

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** Emit the scripted child events on the next microtask, then run the assertions. */
function scriptChild(child: FakeChild, script: (child: FakeChild) => void): void {
  spawnMock.mockReturnValue(child as unknown as ChildProcess);
  queueMicrotask(() => script(child));
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("createSpawnExec", () => {
  it("spawns `bash -lc <command>` with cwd, signal and piped stdio", async () => {
    scriptChild(makeFakeChild(), (child) => child.emit("close", 0, null));
    const signal = new AbortController().signal;
    const result = await createSpawnExec()("ls -la", "/work", {
      signal,
      onStdout: () => {},
      onStderr: () => {},
    });
    expect(result).toEqual({ code: 0, killed: false });
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith("bash", ["-lc", "ls -la"], {
      cwd: "/work",
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("streams stdout/stderr chunks as strings", async () => {
    const chunks: { out: string[]; err: string[] } = { out: [], err: [] };
    scriptChild(makeFakeChild(), (child) => {
      child.stdout.emit("data", Buffer.from("hello "));
      child.stderr.emit("data", Buffer.from("oops\n"));
      child.emit("close", 0, null);
    });
    const result = await createSpawnExec()("echo hello", "/work", {
      onStdout: (chunk) => chunks.out.push(chunk),
      onStderr: (chunk) => chunks.err.push(chunk),
    });
    expect(result).toEqual({ code: 0, killed: false });
    expect(chunks.out).toEqual(["hello "]);
    expect(chunks.err).toEqual(["oops\n"]);
  });

  it("passes the child's exit code through", async () => {
    scriptChild(makeFakeChild(), (child) => child.emit("close", 42, null));
    const result = await createSpawnExec()("exit 42", "/work", {
      onStdout: () => {},
      onStderr: () => {},
    });
    expect(result).toEqual({ code: 42, killed: false });
  });

  it("maps a signal kill to code 124 with killed: true", async () => {
    scriptChild(makeFakeChild(), (child) => child.emit("close", null, "SIGTERM"));
    const result = await createSpawnExec()("sleep 100", "/work", {
      onStdout: () => {},
      onStderr: () => {},
    });
    expect(result).toEqual({ code: 124, killed: true });
  });

  it("treats close(null, null) as a failure", async () => {
    scriptChild(makeFakeChild(), (child) => child.emit("close", null, null));
    const result = await createSpawnExec()("x", "/work", {
      onStdout: () => {},
      onStderr: () => {},
    });
    expect(result).toEqual({ code: 1, killed: false });
  });

  it("turns a spawn error into an onStderr line and exit code 1", async () => {
    const errChunks: string[] = [];
    scriptChild(makeFakeChild(), (child) => child.emit("error", new Error("spawn ENOENT")));
    const result = await createSpawnExec()("missing-binary", "/work", {
      onStdout: () => {},
      onStderr: (chunk) => errChunks.push(chunk),
    });
    expect(result).toEqual({ code: 1, killed: false });
    expect(errChunks).toEqual(["spawn ENOENT\n"]);
  });

  it("handles an already-aborted signal (spawn error path)", async () => {
    const controller = new AbortController();
    controller.abort();
    const errChunks: string[] = [];
    scriptChild(makeFakeChild(), (child) => child.emit("error", new Error("This operation was aborted")));
    const result = await createSpawnExec()("sleep 100", "/work", {
      signal: controller.signal,
      onStdout: () => {},
      onStderr: (chunk) => errChunks.push(chunk),
    });
    expect(result).toEqual({ code: 1, killed: false });
    expect(errChunks).toEqual(["This operation was aborted\n"]);
    expect(spawnMock.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
  });

  it("resolves once even when error and close both fire", async () => {
    scriptChild(makeFakeChild(), (child) => {
      child.emit("error", new Error("boom"));
      child.emit("close", null, null);
    });
    const result = await createSpawnExec()("x", "/work", {
      onStdout: () => {},
      onStderr: () => {},
    });
    expect(result).toEqual({ code: 1, killed: false });
  });
});