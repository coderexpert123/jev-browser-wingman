import { execFile } from 'node:child_process';

let listAvailable = true;

export function processListAvailable(): boolean {
  return listAvailable;
}

interface ExecFn {
  (cmd: string, args: string[], opts: { windowsHide: boolean; timeout?: number }): Promise<string>;
}

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: opts.windowsHide, timeout: opts.timeout, maxBuffer: 1024 * 1024 * 16 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });

export async function listChromeProcesses(exec: ExecFn = defaultExec): Promise<Array<{ pid: number; cmdline: string }>> {
  try {
    if (process.platform === 'win32') {
      const stdout = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, timeout: 15_000 },
      );
      const trimmed = stdout.trim();
      if (!trimmed) {
        listAvailable = true;
        return [];
      }
      let parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) parsed = [parsed];
      const out: Array<{ pid: number; cmdline: string }> = [];
      for (const row of parsed as Array<{ ProcessId?: number; CommandLine?: string }>) {
        if (typeof row.ProcessId === 'number' && typeof row.CommandLine === 'string') {
          out.push({ pid: row.ProcessId, cmdline: row.CommandLine });
        }
      }
      listAvailable = true;
      return out;
    } else {
      const stdout = await exec('ps', ['-ax', '-o', 'pid=,command='], { windowsHide: false, timeout: 15_000 });
      const out: Array<{ pid: number; cmdline: string }> = [];
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const cmdline = m[2];
        if (/chrome|chromium/i.test(cmdline)) {
          out.push({ pid: Number(m[1]), cmdline });
        }
      }
      listAvailable = true;
      return out;
    }
  } catch {
    listAvailable = false;
    return [];
  }
}

export async function killTree(pid: number, exec: ExecFn = defaultExec): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // best-effort
    }
  } else {
    try {
      process.kill(-pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        // ignore other errors too — best-effort tree kill
      }
    }
    try {
      process.kill(pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        // best-effort
      }
    }
  }
}
