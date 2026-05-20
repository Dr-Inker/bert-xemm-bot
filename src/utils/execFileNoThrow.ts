import { execFile } from 'node:child_process';

export interface ExecResult { stdout: string; stderr: string; status: number }
export interface ExecOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  strictArgs?: boolean;
  stdin?: string;
}

const SHELL_META = /[;&|`$<>\\]/;

export function execFileNoThrow(file: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  if (opts.strictArgs) {
    for (const a of args) {
      if (SHELL_META.test(a)) {
        return Promise.reject(new Error(`refused: shell metacharacter in argv: ${a}`));
      }
    }
  }
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      const status = typeof code === 'number' ? code : (err ? 1 : 0);
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), status });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}
