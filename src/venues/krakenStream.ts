import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export function spawnKrakenStream(cliBinaryPath: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(cliBinaryPath, [...args, '-o', 'json'], {
    env: { ...process.env, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

export async function* ndjsonLines(child: ChildProcess): AsyncIterable<unknown> {
  if (!child.stdout) return;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { yield JSON.parse(trimmed); }
    catch { /* skip non-JSON banner lines */ }
  }
}
