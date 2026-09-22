import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './chrome.js';

async function defaultSocketOwnerPid(port: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const { execFile } = await import('node:child_process');
      const stdout: string = await new Promise((resolve, reject) => {
        execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (err, out) => {
          if (err) reject(err);
          else resolve(out);
        });
      });
      for (const line of stdout.split('\n')) {
        if (line.includes(`:${port} `) && /LISTENING/.test(line)) {
          const m = line.trim().match(/(\d+)\s*$/);
          if (m) return Number(m[1]);
        }
      }
      return null;
    } else {
      const { execFile } = await import('node:child_process');
      const stdout: string = await new Promise((resolve, reject) => {
        execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], (err, out) => {
          if (err) reject(err);
          else resolve(out);
        });
      });
      const first = stdout.trim().split('\n')[0];
      return first ? Number(first) : null;
    }
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launchEphemeralChrome(
  opts: { headless?: boolean; chromePath?: string | null } = {},
): Promise<{ endpoint: string; port: number; profileDir: string; pid: number; close(): Promise<void> }> {
  const headless = opts.headless ?? true;
  const chromePath = findChrome(opts.chromePath ?? null);
  if (!chromePath) {
    throw new Error('No Chrome executable found.');
  }
  // Teardown-hardening (2026-09-22): when a test runner tags the environment
  // with WINGMAN_RUN_TOKEN, bake the token into the ephemeral profile dir so
  // every chrome carrying `--user-data-dir=<profile>` exposes the run token on
  // its command line — that is how the runner's exit sweep identifies (and
  // kills) anything this run leaked. The tag must ride user-data-dir, NOT an
  // extra switch: an unknown switch (`--wingman-run-token=...`) breaks headless
  // chrome startup (A/B proven 2026-09-22 — endpoint never answers). Unset
  // (production, bench) = unchanged profile prefix.
  const runToken = process.env.WINGMAN_RUN_TOKEN;
  const profileDir = await mkdtemp(
    join(tmpdir(), runToken ? `wingman-ephemeral-${runToken}-` : 'wingman-ephemeral-'),
  );
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const spawnedPid = child.pid;
  if (!spawnedPid) {
    throw new Error('Chrome spawn returned no pid.');
  }

  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  let port: number | null = null;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(portFile, 'utf8');
      const firstLine = content.split('\n')[0].trim();
      if (firstLine) {
        port = Number(firstLine);
        break;
      }
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  if (port === null) {
    throw new Error('Chrome did not write DevToolsActivePort within 15 s.');
  }

  const owner = (await defaultSocketOwnerPid(port)) ?? spawnedPid;

  const close = async (): Promise<void> => {
    try {
      const info = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>);
      if (info.webSocketDebuggerUrl) {
        const ws = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          });
          ws.addEventListener('message', () => {
            clearTimeout(timer);
            ws.close();
            resolve();
          });
          ws.addEventListener('error', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } catch {
      // ignore, fall through to tree-kill
    }
    const stopDeadline = Date.now() + 5000;
    while (Date.now() < stopDeadline) {
      const answer = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      if (!answer) break;
      await sleep(200);
    }
    const { killTree } = await import('./process-list.js');
    try {
      await killTree(owner);
    } catch {
      // ignore
    }
    try {
      await killTree(spawnedPid);
    } catch {
      // ignore
    }
    for (let i = 0; i < 5; i++) {
      try {
        await rm(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  };

  return { endpoint: `http://127.0.0.1:${port}`, port, profileDir, pid: owner, close };
}
