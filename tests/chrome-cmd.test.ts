// WP-F2: chrome-cmd tests (§ WP-F2 item 8 list). All effects injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGETS } from '../src/contract/constants.js';
import type { WingmanConfig } from '../src/contract/types.js';
import { chromeCommand } from '../src/cli/chrome-cmd.js';
import type { ChromeCmdDeps } from '../src/cli/chrome-cmd.js';
import type { EnsureResult } from '../src/browser/chrome.js';

function stubConfig(): WingmanConfig {
  return {
    mode: 'on',
    adapter: 'cdp',
    window: 'offscreen',
    profile_dir: 'C:/Users/example/.pa/browser-profile',
    port: 9222,
    chrome_path: null,
    secrets_file: null,
    plugin: null,
    sensitive_hosts: {},
    budgets: { ...DEFAULT_BUDGETS },
  };
}

function capture(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s: string) => lines.push(s) };
}

test('ensure prints the EnsureResult JSON', async () => {
  const out = capture();
  const seen: Array<{ port: number; profileDir: string; chromePath: string | null; window: string }> = [];
  const result: EnsureResult = {
    ok: true,
    endpoint: 'http://127.0.0.1:9222',
    port: 9222,
    pid: 4711,
    startedByUs: true,
  };
  const code = await chromeCommand('ensure', {
    env: {},
    write: out.write,
    loadConfigFn: async () => ({ ok: true, config: stubConfig(), source: 'file' }),
    ensureChromeFn: async (opts) => {
      seen.push({ port: opts.port, profileDir: opts.profileDir, chromePath: opts.chromePath, window: opts.window });
      return result;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [
    { port: 9222, profileDir: 'C:/Users/example/.pa/browser-profile', chromePath: null, window: 'offscreen' },
  ]);
  assert.deepEqual(JSON.parse(out.lines[0]), result);
});

test('a foreign holder exits 1 with code foreign-holder', async () => {
  const out = capture();
  const code = await chromeCommand('ensure', {
    env: {},
    write: out.write,
    loadConfigFn: async () => ({ ok: true, config: stubConfig(), source: 'file' }),
    ensureChromeFn: async () => ({
      ok: false,
      code: 'foreign-holder',
      message: 'Chrome pid(s) 4242 already run on the profile without the debug port.',
      pids: [4242],
    }),
  });
  assert.equal(code, 1);
  const parsed = JSON.parse(out.lines[0]) as { ok: boolean; code: string; error: string };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'foreign-holder');
  assert.match(parsed.error, /4242/);
});

test('stop prints killed pids', async () => {
  const out = capture();
  const code = await chromeCommand('stop', {
    env: {},
    write: out.write,
    loadConfigFn: async () => ({ ok: true, config: stubConfig(), source: 'file' }),
    stopChromeFn: async () => ({ killed: [4711, 4712] }),
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.lines[0]), { ok: true, killed: [4711, 4712] });
});

// ---------------------------------------------------------------------------
// WP-X: chrome show|hide (spec § 0 RO-7)
// ---------------------------------------------------------------------------

import { CdpConnection } from '../src/adapters/cdp-connection.js';

interface SendRecord {
  method: string;
  params: Record<string, unknown> | undefined;
}

/** Fake CdpConnection shaped for the connectCdp seam: scripted
 *  Browser.getWindowForTarget replies, every send recorded. */
function fakeConn(getWindowReplies: Array<{ windowId: number; windowState?: string }>) {
  const sends: SendRecord[] = [];
  let windowProbe = 0;
  const conn = {
    async send(method: string, params?: Record<string, unknown>) {
      sends.push({ method, params });
      if (method === 'Target.getTargets') {
        return {
          targetInfos: getWindowReplies.map((w, i) => ({ targetId: `t${i}`, type: 'page' })),
        };
      }
      if (method === 'Browser.getWindowForTarget') {
        const reply = getWindowReplies[windowProbe % getWindowReplies.length];
        windowProbe++;
        return { windowId: reply.windowId, bounds: { windowState: reply.windowState ?? 'normal' } };
      }
      return {};
    },
    async close() {},
  } as unknown as CdpConnection;
  return { conn, sends };
}

function stubDepsWithConn(conn: CdpConnection): ChromeCmdDeps {
  return {
    env: {},
    write: (): void => {},
    loadConfigFn: async () => ({ ok: true, config: stubConfig(), source: 'file' as const }),
    probeVersionFn: async () => ({ Browser: 'Chrome' }),
    connectCdp: async () => conn,
  };
}

test('show restores and moves the shared window on-screen', async () => {
  const out = capture();
  const { conn, sends } = fakeConn([
    { windowId: 7 },
    { windowId: 7 },
    { windowId: 9 }, // a second page on a distinct window
  ]);
  const code = await chromeCommand('show', { ...stubDepsWithConn(conn), write: out.write });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.lines[0]), { ok: true, windows: [7, 9] });
  const boundsCalls = sends.filter((s) => s.method === 'Browser.setWindowBounds');
  // windowState normal first (show may restore), then the on-screen position.
  assert.deepEqual(boundsCalls, [
    { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { windowState: 'normal' } } },
    { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { left: 40, top: 40 } } },
    { method: 'Browser.setWindowBounds', params: { windowId: 9, bounds: { windowState: 'normal' } } },
    { method: 'Browser.setWindowBounds', params: { windowId: 9, bounds: { left: 40, top: 40 } } },
  ]);
});

test('hide moves the shared window off-screen', async () => {
  const out = capture();
  const { conn, sends } = fakeConn([{ windowId: 7 }, { windowId: 9 }]);
  const code = await chromeCommand('hide', { ...stubDepsWithConn(conn), write: out.write });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.lines[0]), { ok: true, windows: [7, 9] });
  const boundsCalls = sends.filter((s) => s.method === 'Browser.setWindowBounds');
  assert.deepEqual(boundsCalls, [
    { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { left: -32000, top: -32000 } } },
    { method: 'Browser.setWindowBounds', params: { windowId: 9, bounds: { left: -32000, top: -32000 } } },
  ]);
});

test('hide restores a minimised window before moving it off-screen', async () => {
  const out = capture();
  const { conn, sends } = fakeConn([{ windowId: 7, windowState: 'minimized' }]);
  const code = await chromeCommand('hide', { ...stubDepsWithConn(conn), write: out.write });
  assert.equal(code, 0);
  const boundsCalls = sends.filter((s) => s.method === 'Browser.setWindowBounds');
  assert.deepEqual(boundsCalls, [
    { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { windowState: 'normal' } } },
    { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { left: -32000, top: -32000 } } },
  ]);
});

test('show fails with no-browser when nothing answers on the port', async () => {
  const out = capture();
  let connectCalled = false;
  const code = await chromeCommand('show', {
    env: {},
    write: out.write,
    loadConfigFn: async () => ({ ok: true, config: stubConfig(), source: 'file' }),
    probeVersionFn: async () => null,
    connectCdp: async () => {
      connectCalled = true;
      return fakeConn([{ windowId: 7 }]).conn;
    },
  });
  assert.equal(code, 1);
  const parsed = JSON.parse(out.lines[0]) as { ok: boolean; code: string };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'no-browser');
  assert.equal(connectCalled, false, 'nothing answers, so no CDP connection is made');
});

// ---------------------------------------------------------------------------
// WP-X live proof: show/hide move a REAL headed window both ways, measured
// with GetWindowRect. Scratch profile (wingman-ephemeral- marker) and a free
// port; the window starts off-screen so it never disturbs the operator.
// ---------------------------------------------------------------------------

import { spawn as realSpawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile as writeFileAsync, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { findChrome, CHROME_ARGS, HEADED_ARGS, probeVersion } from '../src/browser/chrome.js';

function execFileP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${err.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function socketOwnerPid(port: number): Promise<number | null> {
  return execFileP('netstat', ['-ano', '-p', 'tcp']).then((out) => {
    for (const line of out.split('\n')) {
      if (line.includes(`:${port} `) && /LISTENING/.test(line)) {
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) return Number(m[1]);
      }
    }
    return null;
  });
}

interface WinRect { iconic: boolean; left: number; top: number; right: number; bottom: number }

/** Visible Chrome_WidgetWin_1 windows of `pid`, with the virtual screen. */
async function chromeWindowRects(pid: number): Promise<{ vs: { left: number; top: number; right: number; bottom: number }; windows: WinRect[] }> {
  const script = `Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinsX {
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  public static List<string> Results = new List<string>();
  public static uint TargetPid;
  public static bool Enum(IntPtr hWnd, IntPtr lParam) {
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    if (pid == TargetPid && IsWindowVisible(hWnd)) {
      StringBuilder sb = new StringBuilder(256);
      GetClassName(hWnd, sb, sb.Capacity);
      if (sb.ToString() == "Chrome_WidgetWin_1") {
        RECT r;
        GetWindowRect(hWnd, out r);
        Results.Add(IsIconic(hWnd) + "|" + r.Left + "|" + r.Top + "|" + r.Right + "|" + r.Bottom);
      }
    }
    return true;
  }
}
"@
[WinsX]::TargetPid = ${pid}
[WinsX]::Results.Clear()
$del = [Delegate]::CreateDelegate([WinsX+EnumWindowsProc], [WinsX], 'Enum')
[WinsX]::EnumWindows($del, [IntPtr]::Zero) | Out-Null
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Output ("VS|" + $vs.Left + "|" + $vs.Top + "|" + $vs.Right + "|" + $vs.Bottom)
foreach ($r in [WinsX]::Results) { Write-Output $r }`;
  const out = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  let vs = { left: 0, top: 0, right: 0, bottom: 0 };
  const windows: WinRect[] = [];
  for (const line of lines) {
    const parts = line.split('|');
    if (parts[0] === 'VS') {
      vs = { left: Number(parts[1]), top: Number(parts[2]), right: Number(parts[3]), bottom: Number(parts[4]) };
      continue;
    }
    if (parts.length !== 5) continue;
    windows.push({
      iconic: parts[0] === 'True',
      left: Number(parts[1]),
      top: Number(parts[2]),
      right: Number(parts[3]),
      bottom: Number(parts[4]),
    });
  }
  return { vs, windows };
}

function isOffscreen(w: WinRect, vs: { left: number; top: number; right: number; bottom: number }): boolean {
  return !w.iconic && (w.right <= vs.left || w.left >= vs.right || w.bottom <= vs.top || w.top >= vs.bottom);
}

function isOnscreen(w: WinRect, vs: { left: number; top: number; right: number; bottom: number }): boolean {
  return !w.iconic && w.left < vs.right && w.right > vs.left && w.top < vs.bottom && w.bottom > vs.top;
}

test('show and hide move the real window on-screen and back off-screen (GetWindowRect)', { skip: process.platform !== 'win32' && 'win32 only' }, async () => {
  const chromePath = findChrome(null);
  assert.ok(chromePath, 'No Chrome executable found — the live show/hide proof cannot run');
  const profileDir = await mkdtemp(join(tmpdir(), 'wingman-ephemeral-'));
  const home = await mkdtemp(join(tmpdir(), 'wingman-ephemeral-home-'));
  const port = await freePort();
  const args = [
    ...CHROME_ARGS(port, profileDir),
    ...HEADED_ARGS,
    '--window-position=-32000,-32000',
    'about:blank',
  ];
  const child = realSpawn(chromePath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  const spawnedPid = child.pid ?? 0;
  child.unref();

  const cleanup = async (): Promise<void> => {
    const owner = await socketOwnerPid(port).catch(() => null);
    if (owner) {
      try {
        execSyncShim(`taskkill /PID ${owner} /T /F`);
      } catch {
        // already gone
      }
    }
    if (spawnedPid) {
      try {
        execSyncShim(`taskkill /PID ${spawnedPid} /T /F`);
      } catch {
        // already gone
      }
    }
    for (let i = 0; i < 5; i++) {
      try {
        await rm(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await rm(home, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // Wait for the debug port.
    const deadline = Date.now() + 15_000;
    let up = false;
    while (Date.now() < deadline) {
      if (await probeVersion(port, 1000)) {
        up = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, `spawned Chrome never answered on port ${port}`);
    const owner = (await socketOwnerPid(port)) ?? spawnedPid;
    assert.ok(owner, 'no socket owner pid found');

    // Precondition: the window really starts off-screen.
    const start = await chromeWindowRects(owner);
    assert.ok(start.windows.length > 0, 'no visible Chrome window found for the owner pid');
    assert.ok(
      start.windows.every((w) => isOffscreen(w, start.vs)),
      `precondition failed: window not off-screen at start: ${JSON.stringify(start)}`,
    );

    await writeFileAsync(join(home, 'config.json'), JSON.stringify({ port, profile_dir: profileDir, window: 'offscreen' }));
    const env = { WINGMAN_HOME: home } as NodeJS.ProcessEnv;

    // show: on-screen.
    const showOut = capture();
    const showCode = await chromeCommand('show', { env, write: showOut.write });
    assert.equal(showCode, 0, `show failed: ${showOut.lines.join(' ')}`);
    await new Promise((r) => setTimeout(r, 500));
    const shown = await chromeWindowRects(owner);
    assert.ok(
      shown.windows.some((w) => isOnscreen(w, shown.vs)),
      `show did not bring the window on-screen: ${JSON.stringify(shown)}`,
    );

    // hide: back off-screen.
    const hideOut = capture();
    const hideCode = await chromeCommand('hide', { env, write: hideOut.write });
    assert.equal(hideCode, 0, `hide failed: ${hideOut.lines.join(' ')}`);
    await new Promise((r) => setTimeout(r, 500));
    const hidden = await chromeWindowRects(owner);
    assert.ok(
      hidden.windows.length > 0 && hidden.windows.every((w) => isOffscreen(w, hidden.vs)),
      `hide did not move the window off-screen: ${JSON.stringify(hidden)}`,
    );
  } finally {
    await cleanup();
  }
});

// taskkill via execSync (child_process import above only pulls spawn/execFile).
import { execSync } from 'node:child_process';
function execSyncShim(cmd: string): void {
  execSync(cmd, { windowsHide: true, stdio: 'ignore' });
}
