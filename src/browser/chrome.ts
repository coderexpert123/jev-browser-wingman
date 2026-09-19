import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import type { WindowMode } from '../contract/types.js';
import { killTree, listChromeProcesses, processListAvailable } from './process-list.js';

export const CHROME_ARGS = (port: number, profileDir: string): string[] => [
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profileDir,
  '--no-first-run',
  '--no-default-browser-check',
  '--restore-last-session=false',
  '--window-size=1280,800',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,TabDiscarding,TabFreezing,IntensiveWakeUpThrottling',
];

export const HEADED_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];
export const OFFSCREEN_ARGS = ['--window-position=-32000,-32000'];

function chromeCandidatesForPlatform(env: NodeJS.ProcessEnv, platform: string): string[] {
  if (platform === 'win32') {
    const suffix = join('Google', 'Chrome', 'Application', 'chrome.exe');
    return [
      join(env.PROGRAMFILES ?? 'C:\\Program Files', suffix),
      join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', suffix),
      join(env.LOCALAPPDATA ?? join(os.homedir(), 'AppData', 'Local'), suffix),
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

export function chromeCandidates(
  chromePath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string[] {
  if (chromePath) return [chromePath, ...chromeCandidatesForPlatform(env, platform)];
  return chromeCandidatesForPlatform(env, platform);
}

export interface FindChromeDeps {
  fileExists?: (p: string) => boolean;
}

export function findChrome(
  chromePath: string | null,
  deps: FindChromeDeps = {},
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const fileExists = deps.fileExists ?? ((p: string) => existsSync(p));
  const found = chromeCandidates(chromePath, env, platform).find((p) => fileExists(p));
  return found ?? null;
}

export function defaultUserDataDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return join(home, '.config', 'google-chrome');
}

function normSlashes(s: string): string {
  return s.replace(/\\/g, '/');
}

export function isDefaultUserDataDir(
  dir: string,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): boolean {
  const def = defaultUserDataDir(platform, env, home);
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const norm = (s: string) => {
    let out = normSlashes(s).replace(/\/+$/, '');
    if (caseInsensitive) out = out.toLowerCase();
    return out;
  };
  return norm(dir) === norm(def);
}

export function profileMarkerMatches(cmdline: string, profileDir: string): boolean {
  const norm = (s: string) => s.replace(/["']/g, '').replace(/\\/g, '/').toLowerCase();
  const marker = `user-data-dir=${norm(profileDir)}`;
  const hay = norm(cmdline);
  const idx = hay.indexOf(marker);
  if (idx === -1) return false;
  const next = hay.charAt(idx + marker.length);
  return next === '' || next === '/' || /\s/.test(next);
}

export function debugPortOf(cmdline: string): number | null {
  const m = cmdline.match(/--remote-debugging-port=(\d+)/);
  if (!m) return null;
  return Number(m[1]);
}

export interface ProfileHoldersDeps {
  listChromeProcesses?: typeof listChromeProcesses;
}

export async function profileHolders(
  profileDir: string,
  deps: ProfileHoldersDeps = {},
): Promise<{ withPort: Array<{ pid: number; port: number }>; withoutPort: number[] }> {
  const lister = deps.listChromeProcesses ?? listChromeProcesses;
  const procs = await lister();
  const withPort: Array<{ pid: number; port: number }> = [];
  const withoutPort: number[] = [];
  for (const p of procs) {
    if (!profileMarkerMatches(p.cmdline, profileDir)) continue;
    const port = debugPortOf(p.cmdline);
    if (port === null) {
      withoutPort.push(p.pid);
    } else {
      withPort.push({ pid: p.pid, port });
    }
  }
  return { withPort, withoutPort };
}

export async function probeVersion(
  port: number,
  timeoutMs = 1500,
): Promise<{ webSocketDebuggerUrl?: string; Browser?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { webSocketDebuggerUrl?: string; Browser?: string };
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type EnsureResult =
  | { ok: true; endpoint: string; port: number; pid: number | null; startedByUs: boolean }
  | {
      ok: false;
      code: 'default-profile' | 'foreign-holder' | 'profile-mismatch' | 'no-chrome' | 'timeout' | 'spawn-failed';
      message: string;
      pids?: number[];
    };

export interface PidFileContents {
  pid: number;
  spawnedPid?: number;
  port: number;
  profileDir: string;
  startedAt: string;
}

export interface EnsureChromeDeps {
  isDefaultUserDataDir?: typeof isDefaultUserDataDir;
  profileHolders?: typeof profileHolders;
  probeVersion?: typeof probeVersion;
  findChrome?: typeof findChrome;
  fileExists?: (p: string) => boolean;
  mkdir?: typeof mkdir;
  spawnFn?: (comspec: string, args: string[], opts: Record<string, unknown>) => ChildProcess;
  directSpawnFn?: (chromePath: string, args: string[], opts: Record<string, unknown>) => ChildProcess;
  writeFile?: typeof writeFile;
  sleep?: (ms: number) => Promise<void>;
  socketOwnerPid?: (port: number) => Promise<number | null>;
  killTree?: typeof killTree;
  listChromeProcesses?: typeof listChromeProcesses;
  processListAvailable?: () => boolean;
  minimiseWindow?: (port: number) => Promise<void>;
  randomLaunchId?: () => string;
  now?: () => string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  unlinkFile?: (path: string) => Promise<void>;
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomHex16(): string {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function quoteCmdLine(argv: string[]): string {
  const bareRe = /^[A-Za-z0-9_\-.\/:=@+,{}]+$/;
  return argv
    .map((tok) => (bareRe.test(tok) ? tok : `"${tok.replace(/"/g, '""')}"`))
    .join(' ');
}

function modeArgs(window: WindowMode): string[] {
  if (window === 'offscreen') return [...HEADED_ARGS, ...OFFSCREEN_ARGS];
  if (window === 'normal' || window === 'minimized') return [...HEADED_ARGS];
  return ['--headless=new'];
}

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

export async function ensureChrome(
  opts: { port: number; profileDir: string; chromePath: string | null; home: string; window: WindowMode },
  deps: EnsureChromeDeps = {},
): Promise<EnsureResult> {
  const isDefault = deps.isDefaultUserDataDir ?? isDefaultUserDataDir;
  const holders = deps.profileHolders ?? profileHolders;
  const probe = deps.probeVersion ?? probeVersion;
  const findChromeFn = deps.findChrome ?? findChrome;
  const sleep = deps.sleep ?? defaultSleep;
  const socketOwnerPid = deps.socketOwnerPid ?? defaultSocketOwnerPid;
  const killTreeFn = deps.killTree ?? killTree;
  const listProcs = deps.listChromeProcesses ?? listChromeProcesses;
  const processListAvail = deps.processListAvailable ?? processListAvailable;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const writeFileFn = deps.writeFile ?? writeFile;
  const mkdirFn = deps.mkdir ?? mkdir;
  const nowFn = deps.now ?? (() => new Date().toISOString());
  const randomLaunchId = deps.randomLaunchId ?? randomHex16;
  const unlinkFile =
    deps.unlinkFile ??
    (async (path: string) => {
      const fs = await import('node:fs/promises');
      await fs.unlink(path).catch(() => {});
    });

  // (a) default user-data dir
  if (isDefault(opts.profileDir, platform, env)) {
    return {
      ok: false,
      code: 'default-profile',
      message:
        'Chrome ignores the debug port on its default user-data dir (Chrome 136 and later). Set profile_dir to a separate directory.',
    };
  }

  // (b) port answers
  const answer = await probe(opts.port, 1500);
  if (answer) {
    if (processListAvail()) {
      const procs = await listProcs();
      const onPort = procs.find((p) => {
        const port = debugPortOf(p.cmdline);
        return port === opts.port;
      });
      if (onPort && !profileMarkerMatches(onPort.cmdline, opts.profileDir)) {
        return {
          ok: false,
          code: 'profile-mismatch',
          message: `The Chrome answering on port ${opts.port} uses a different profile, so logged-in state from ${opts.profileDir} would not carry over. Stop that Chrome or change the port.`,
        };
      }
    }
    return { ok: true, endpoint: `http://127.0.0.1:${opts.port}`, port: opts.port, pid: null, startedByUs: false };
  }

  // (c) profile holders
  const { withPort, withoutPort } = await holders(opts.profileDir, { listChromeProcesses: listProcs });
  if (withoutPort.length > 0) {
    return {
      ok: false,
      code: 'foreign-holder',
      message: `Chrome pid(s) ${withoutPort.join(', ')} already run on ${opts.profileDir} without the debug port. Close that browser (or stop the tool that launched it), then run this again. jev-browser-wingman never closes or relaunches a browser it did not start.`,
      pids: withoutPort,
    };
  }
  const withPortOther = withPort.find((h) => h.port !== opts.port);
  if (withPortOther) {
    return {
      ok: false,
      code: 'foreign-holder',
      message: `Chrome pid ${withPortOther.pid} holds ${opts.profileDir} with debug port ${withPortOther.port}; set port to ${withPortOther.port}.`,
      pids: [withPortOther.pid],
    };
  }

  // (d) find binary
  const chromePath = findChromeFn(opts.chromePath, {}, env, platform);
  if (!chromePath) {
    return { ok: false, code: 'no-chrome', message: 'No Chrome executable found.' };
  }

  // (e) launch
  await mkdirFn(opts.profileDir, { recursive: true });
  const launchId = randomLaunchId();
  const args = [...CHROME_ARGS(opts.port, opts.profileDir), ...modeArgs(opts.window), `--jevw-launch=${launchId}`];

  let spawned: ChildProcess;
  if (opts.window === 'headless') {
    const spawnFn = deps.directSpawnFn ?? ((p: string, a: string[], o: Record<string, unknown>) => spawn(p, a, o));
    spawned = spawnFn(chromePath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  } else if (platform === 'win32') {
    const comspec = env.ComSpec ?? 'cmd.exe';
    const cmdArg = '"start "" /min ' + quoteCmdLine([chromePath, ...args]) + '"';
    const spawnFn = deps.spawnFn ?? ((c: string, a: string[], o: Record<string, unknown>) => spawn(c, a, o));
    spawned = spawnFn(comspec, ['/d', '/s', '/c', cmdArg], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } else if (platform === 'darwin' && chromePath.includes('.app/Contents/MacOS/')) {
    const bundleIdx = chromePath.indexOf('.app/Contents/MacOS/');
    const bundle = chromePath.slice(0, bundleIdx + 4);
    const spawnFn = deps.spawnFn ?? ((c: string, a: string[], o: Record<string, unknown>) => spawn(c, a, o));
    spawned = spawnFn('open', ['-g', '-n', '-a', bundle, '--args', ...args], { detached: true, stdio: 'ignore' });
  } else {
    const spawnFn = deps.directSpawnFn ?? ((p: string, a: string[], o: Record<string, unknown>) => spawn(p, a, o));
    spawned = spawnFn(chromePath, args, { detached: true, stdio: 'ignore' });
  }
  const spawnedPid = spawned.pid ?? null;
  spawned.unref?.();

  if (!spawnedPid) {
    return { ok: false, code: 'spawn-failed', message: 'Chrome spawn returned no pid.' };
  }

  const pidFilePath = join(opts.home, 'chrome.pid');
  const startedAt = nowFn();
  await writeFileFn(
    pidFilePath,
    JSON.stringify({ pid: spawnedPid, port: opts.port, profileDir: opts.profileDir, startedAt } satisfies PidFileContents),
  );

  const deadline = Date.now() + 10_000;
  let ok = false;
  while (Date.now() < deadline) {
    const p = await probe(opts.port, 1500);
    if (p) {
      ok = true;
      break;
    }
    await sleep(250);
  }

  if (!ok) {
    // (f) timeout
    if (processListAvail()) {
      const procs = await listProcs();
      const targets = procs.filter((p) => p.cmdline.includes(`--jevw-launch=${launchId}`));
      for (const t of targets) {
        await killTreeFn(t.pid);
      }
    } else {
      await killTreeFn(spawnedPid);
    }
    await unlinkFile(pidFilePath);
    const { withPort: wp2, withoutPort: wop2 } = await holders(opts.profileDir, { listChromeProcesses: listProcs });
    if (wp2.length > 0 || wop2.length > 0) {
      return {
        ok: false,
        code: 'foreign-holder',
        message: `Chrome pid(s) ${[...wp2.map((h) => h.pid), ...wop2].join(', ')} already run on ${opts.profileDir} without the debug port. Close that browser (or stop the tool that launched it), then run this again. jev-browser-wingman never closes or relaunches a browser it did not start.`,
        pids: [...wp2.map((h) => h.pid), ...wop2],
      };
    }
    return { ok: false, code: 'timeout', message: `Chrome did not answer on port ${opts.port} within 10 s.` };
  }

  const owner = (await socketOwnerPid(opts.port)) ?? spawnedPid;
  await writeFileFn(
    pidFilePath,
    JSON.stringify({ pid: owner, spawnedPid, port: opts.port, profileDir: opts.profileDir, startedAt } satisfies PidFileContents),
  );

  if (opts.window === 'minimized') {
    const minimise = deps.minimiseWindow ?? ((port: number) => minimiseWindowImpl(port));
    try {
      await minimise(opts.port);
    } catch (err) {
      process.stderr.write(`jev-browser-wingman: could not minimise the Chrome window: ${(err as Error).message}\n`);
    }
  }

  return { ok: true, endpoint: `http://127.0.0.1:${opts.port}`, port: opts.port, pid: owner, startedByUs: true };
}

async function minimiseWindowImpl(port: number): Promise<void> {
  const info = await probeVersion(port, 5000);
  if (!info?.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    let id = 1;
    const pending = new Map<number, (result: unknown) => void>();
    ws.addEventListener('open', () => {
      const send = (method: string, params?: unknown) =>
        new Promise<unknown>((res) => {
          const thisId = id++;
          pending.set(thisId, res);
          ws.send(JSON.stringify({ id: thisId, method, params }));
        });
      (async () => {
        const targets = (await send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string }> };
        const pageTargets = targets.targetInfos.filter((t) => t.type === 'page');
        const windowIds = new Set<number>();
        for (const t of pageTargets) {
          const w = (await send('Browser.getWindowForTarget', { targetId: t.targetId })) as { windowId: number };
          windowIds.add(w.windowId);
        }
        for (const windowId of windowIds) {
          await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        }
        clearTimeout(timer);
        ws.close();
        resolve();
      })().catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg.result);
          pending.delete(msg.id);
        }
      } catch {
        // ignore
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('websocket error'));
    });
  });
}

export interface ChromeStatusDeps {
  probeVersion?: typeof probeVersion;
  profileHolders?: typeof profileHolders;
  readPidFile?: (home: string) => Promise<PidFileContents | null>;
}

export async function chromeStatus(
  opts: { port: number; profileDir: string; home: string },
  deps: ChromeStatusDeps = {},
): Promise<{ answering: boolean; endpoint: string | null; port: number; pid: number | null; profileMatches: boolean | null }> {
  const probe = deps.probeVersion ?? probeVersion;
  const holders = deps.profileHolders ?? profileHolders;
  const answer = await probe(opts.port, 1500);
  if (!answer) {
    return { answering: false, endpoint: null, port: opts.port, pid: null, profileMatches: null };
  }
  const { withPort } = await holders(opts.profileDir);
  const onThisPort = withPort.find((h) => h.port === opts.port);
  return {
    answering: true,
    endpoint: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    pid: onThisPort?.pid ?? null,
    profileMatches: onThisPort ? true : null,
  };
}

export interface StopChromeDeps {
  readPidFile?: (path: string) => Promise<PidFileContents | null>;
  isAlive?: (pid: number) => Promise<boolean>;
  cmdlineOf?: (pid: number) => Promise<string | null>;
  killTree?: typeof killTree;
  unlinkFile?: (path: string) => Promise<void>;
}

export async function stopChrome(
  opts: { port: number; profileDir: string; home: string },
  deps: StopChromeDeps = {},
): Promise<{ killed: number[] }> {
  const pidFilePath = join(opts.home, 'chrome.pid');
  const readPidFile =
    deps.readPidFile ??
    (async (path: string) => {
      try {
        const content = await readFile(path, 'utf8');
        return JSON.parse(content) as PidFileContents;
      } catch {
        return null;
      }
    });
  const isAlive =
    deps.isAlive ??
    (async (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const cmdlineOf =
    deps.cmdlineOf ??
    (async (pid: number) => {
      const procs = await listChromeProcesses();
      return procs.find((p) => p.pid === pid)?.cmdline ?? null;
    });
  const killTreeFn = deps.killTree ?? killTree;
  const unlinkFile =
    deps.unlinkFile ??
    (async (path: string) => {
      const fs = await import('node:fs/promises');
      await fs.unlink(path).catch(() => {});
    });

  const record = await readPidFile(pidFilePath);
  if (!record) return { killed: [] };
  const alive = await isAlive(record.pid);
  if (!alive) {
    await unlinkFile(pidFilePath);
    return { killed: [] };
  }
  const cmdline = await cmdlineOf(record.pid);
  if (
    cmdline &&
    cmdline.includes(`--remote-debugging-port=${opts.port}`) &&
    profileMarkerMatches(cmdline, opts.profileDir)
  ) {
    await killTreeFn(record.pid);
    await unlinkFile(pidFilePath);
    return { killed: [record.pid] };
  }
  await unlinkFile(pidFilePath);
  return { killed: [] };
}
