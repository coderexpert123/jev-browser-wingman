import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { findChrome } from './chrome.js';
import { killTree as killTreeReal, listChromeProcesses as listChromeProcessesReal } from './process-list.js';

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

// --- Leak defence (2026-09-25): three independent guards, because a killed
// or hung test worker runs neither the returned close() nor run-tests.mjs's
// exit sweep. See CLAUDE.md "Gotchas from the ephemeral-Chrome leak fix" for
// the incident this responds to (70 leaked headless chromes, RAM exhausted).

// 1. Owner-pid tag: every profile dir embeds the launching process's pid, so
//    an orphan sweep (below) can tell "owner died" from "owner still running"
//    without any registry surviving the owner's own death.
interface LiveChromeEntry {
  pid: number;
  spawnedPid: number;
  profileDir: string;
}

const liveChromes = new Set<LiveChromeEntry>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const entry of liveChromes) {
      const pids = new Set([entry.pid, entry.spawnedPid]);
      for (const pid of pids) {
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          } else {
            process.kill(pid, 'SIGKILL');
          }
        } catch {
          // best-effort: nothing more can run at exit
        }
      }
    }
    liveChromes.clear();
  });
}

// 4. Orphan sweep: finds chromes/dirs left behind by an owner process that no
// longer exists (a killed test worker, an aborted runner) and cleans them up.
// Never throws. Every I/O boundary is injectable so tests can prove both the
// kill and the no-op paths without ever launching a real Chrome.
export interface SweepDeps {
  listChromeProcesses?: () => Promise<Array<{ pid: number; cmdline: string }>>;
  killTree?: (pid: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  readdir?: (dir: string) => Promise<string[]>;
  stat?: (path: string) => Promise<{ mtimeMs: number }>;
  rm?: (path: string) => Promise<void>;
  tmpdir?: () => string;
}

const OWNER_TAG_RE = /-p(\d+)-/;
const LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but we can't signal it — count as alive.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function extractUserDataDir(cmdline: string): string | null {
  const m = cmdline.match(/--user-data-dir=(?:"([^"]*)"|(\S+))/);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

function isRootChromeCmdline(cmdline: string): boolean {
  return !cmdline.includes('--type=');
}

export async function sweepOrphanedEphemeralChromes(
  deps: SweepDeps = {},
): Promise<{ killed: number; removedDirs: number }> {
  const listFn = deps.listChromeProcesses ?? (() => listChromeProcessesReal());
  const killTreeFn = deps.killTree ?? ((pid: number) => killTreeReal(pid));
  const isAliveFn = deps.isAlive ?? defaultIsAlive;
  const readdirFn = deps.readdir ?? ((dir: string) => readdir(dir));
  const statFn = deps.stat ?? ((path: string) => stat(path));
  const rmFn = deps.rm ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const tmpdirFn = deps.tmpdir ?? tmpdir;

  let killed = 0;
  let removedDirs = 0;

  try {
    const chromes = await listFn();

    const killedRootPids = new Set<number>();
    const killedDirBasenames = new Set<string>();
    const liveReferencedBasenames = new Set<string>();

    // Pass 1: classify every tagged root chrome as live-owner or dead-owner.
    for (const proc of chromes) {
      const dir = extractUserDataDir(proc.cmdline);
      if (!dir) continue;
      const base = basename(dir);
      if (!base.startsWith('wingman-ephemeral-')) continue;
      if (!isRootChromeCmdline(proc.cmdline)) continue;
      const m = base.match(OWNER_TAG_RE);
      if (!m) continue; // legacy root: never a kill candidate
      const ownerPid = Number(m[1]);
      let alive: boolean;
      try {
        alive = isAliveFn(ownerPid);
      } catch {
        alive = true; // can't prove death — be conservative
      }
      if (alive) {
        liveReferencedBasenames.add(base);
      } else {
        killedRootPids.add(proc.pid);
        killedDirBasenames.add(base);
      }
    }

    // Pass 1b: any dir referenced by a chrome we are NOT killing (legacy
    // roots, live-owner roots, and their child processes) stays referenced.
    for (const proc of chromes) {
      const dir = extractUserDataDir(proc.cmdline);
      if (!dir) continue;
      const base = basename(dir);
      if (killedDirBasenames.has(base)) continue;
      liveReferencedBasenames.add(base);
    }

    for (const pid of killedRootPids) {
      try {
        await killTreeFn(pid);
        killed += 1;
      } catch {
        // best-effort
      }
    }

    // Pass 2: profile-dir cleanup in the tmp root.
    const root = tmpdirFn();
    let entries: string[] = [];
    try {
      entries = await readdirFn(root);
    } catch {
      entries = [];
    }
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith('wingman-ephemeral-')) continue;
      const full = join(root, name);
      const m = name.match(OWNER_TAG_RE);
      if (m) {
        const ownerPid = Number(m[1]);
        let alive: boolean;
        try {
          alive = isAliveFn(ownerPid);
        } catch {
          alive = true;
        }
        if (alive) continue;
        if (liveReferencedBasenames.has(name)) continue;
        try {
          await rmFn(full);
          removedDirs += 1;
        } catch {
          // best-effort
        }
      } else {
        // Legacy untagged dir: only delete if stale and unreferenced — can't
        // prove ownership any other way.
        if (liveReferencedBasenames.has(name)) continue;
        try {
          const info = await statFn(full);
          if (now - info.mtimeMs > LEGACY_MAX_AGE_MS) {
            await rmFn(full);
            removedDirs += 1;
          }
        } catch {
          // stat failed — skip rather than guess
        }
      }
    }
  } catch {
    // never throw — this runs unattended before every launch
  }

  return { killed, removedDirs };
}

let sweepMemo: Promise<{ killed: number; removedDirs: number }> | null = null;

function sweepOnce(): Promise<{ killed: number; removedDirs: number }> {
  if (!sweepMemo) {
    sweepMemo = sweepOrphanedEphemeralChromes().catch(() => ({ killed: 0, removedDirs: 0 }));
  }
  return sweepMemo;
}

export async function launchEphemeralChrome(
  opts: { headless?: boolean; chromePath?: string | null } = {},
): Promise<{ endpoint: string; port: number; profileDir: string; pid: number; close(): Promise<void> }> {
  await sweepOnce();

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
  //
  // Owner-pid tag (2026-09-25): the launching process's own pid rides the
  // same dir, ALWAYS, right after the run token so run-tests.mjs's substring
  // match on `wingman-ephemeral-<token>` still hits. This is what lets the
  // orphan sweep tell a chrome whose launcher died from one still in use.
  const runToken = process.env.WINGMAN_RUN_TOKEN;
  const ownerTag = `p${process.pid}-`;
  const prefix = runToken ? `wingman-ephemeral-${runToken}-${ownerTag}` : `wingman-ephemeral-${ownerTag}`;
  const profileDir = await mkdtemp(join(tmpdir(), prefix));
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
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('Chrome spawn returned no pid.');
  }

  try {
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

    const entry: LiveChromeEntry = { pid: owner, spawnedPid, profileDir };
    installExitHook();
    liveChromes.add(entry);

    const close = async (): Promise<void> => {
      liveChromes.delete(entry);
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
      try {
        await killTreeReal(owner);
      } catch {
        // ignore
      }
      try {
        await killTreeReal(spawnedPid);
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
  } catch (err) {
    try {
      await killTreeReal(spawnedPid);
    } catch {
      // best-effort
    }
    try {
      await rm(profileDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
}
