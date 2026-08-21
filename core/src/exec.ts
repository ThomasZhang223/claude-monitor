/**
 * The single place this tool shells out, plus cumulative call accounting.
 *
 * Every module takes an `Exec` rather than calling `exec` directly. That seam
 * exists so parsing can be tested against captured fixture strings: the prior
 * art in localstack/monitor-core fused detection with shelling out, and that is
 * precisely why its most fragile module is the only one with no test file.
 * Mocking the `tmux` / `git` / `ps` binaries instead of injecting here would
 * defeat the point.
 */
import { exec } from "child_process";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, timeoutMs?: number) => Promise<ExecResult>;

export const execAsync: Exec = (cmd, timeoutMs = 5000) => {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
};

/** Single-quote a value for safe interpolation into a shell command. Recaps and
 *  branch names are user text and can contain spaces, quotes and `$`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
