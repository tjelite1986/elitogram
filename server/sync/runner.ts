import { spawn } from 'node:child_process';

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a downloader without a shell; output is capped so a chatty run can't exhaust memory. */
export function runProc(bin: string, args: string[], opts: { timeoutMs?: number; cwd?: string; onLine?: (line: string) => void } = {}): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let stdout = '';
    let stderr = '';
    const cap = (s: string, add: string) => (s.length > 200_000 ? s : s + add);
    let partial = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout = cap(stdout, d.toString());
      if (opts.onLine) {
        const lines = (partial + d.toString()).split('\n');
        partial = lines.pop() ?? '';
        lines.forEach((l) => l.trim() && opts.onLine!(l));
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = cap(stderr, d.toString());
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
