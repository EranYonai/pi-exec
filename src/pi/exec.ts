import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  killed: boolean;
}

export interface ExecOptions {
  signal?: AbortSignal;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

/** The execution seam run.ts drives: command + cwd + stream callbacks → outcome. */
export type ExecFn = (command: string, cwd: string, opts: ExecOptions) => Promise<ExecResult>;

/**
 * Real exec seam: one `bash -lc` child, output streamed live through the
 * callbacks so each mode decides where the bytes go (stdout / stderr /
 * widget buffer). Resolves — never rejects: spawn errors (including a
 * signal that was already aborted before spawn) become a stderr line and
 * exit code 1.
 */
export function createSpawnExec(): ExecFn {
  return (command, cwd, opts) =>
    new Promise<ExecResult>((resolve) => {
      const child = spawn("bash", ["-lc", command], {
        cwd,
        signal: opts.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (data: Buffer) => opts.onStdout(data.toString()));
      child.stderr?.on("data", (data: Buffer) => opts.onStderr(data.toString()));
      child.on("error", (err: Error) => {
        opts.onStderr(`${err.message}\n`);
        resolve({ code: 1, killed: false });
      });
      child.on("close", (code, signal) => {
        // 124 = killed by our timeout/abort signal (conventional); a clean
        // close with neither code nor signal is treated as a failure.
        resolve({ code: code ?? (signal ? 124 : 1), killed: signal !== null });
      });
    });
}