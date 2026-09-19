#!/usr/bin/env node
// WP-D0 live window-mode gate (§ 3.15, § WP-D0 item 6). Plain ESM, no build.
// win32 only; elsewhere prints a skip line and exits 0.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = { dist: 'dist', window: null, knownBad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') out.dist = argv[++i];
    else if (a === '--window') out.window = argv[++i];
    else if (a === '--known-bad') out.knownBad = argv[++i];
  }
  return out;
}

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 * 16, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.message}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function foregroundPid() {
  const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$h = [Fg]::GetForegroundWindow()
$procId = 0
[void][Fg]::GetWindowThreadProcessId($h, [ref]$procId)
Write-Output $procId`;
  const out = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return Number(out.trim());
}

async function chromeWindowState(pid) {
  const script = `Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class Wins {
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
        bool iconic = IsIconic(hWnd);
        Results.Add(iconic + "|" + r.Left + "|" + r.Top + "|" + r.Right + "|" + r.Bottom);
      }
    }
    return true;
  }
}
"@
[Wins]::TargetPid = ${pid}
[Wins]::Results.Clear()
$del = [Delegate]::CreateDelegate([Wins+EnumWindowsProc], [Wins], 'Enum')
[Wins]::EnumWindows($del, [IntPtr]::Zero) | Out-Null
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Output ("VS|" + $vs.Left + "|" + $vs.Top + "|" + $vs.Right + "|" + $vs.Bottom)
foreach ($r in [Wins]::Results) { Write-Output $r }`;
  const out = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  let vs = null;
  const windows = [];
  for (const line of lines) {
    if (line.startsWith('VS|')) {
      const [, l, t, r, b] = line.split('|').map((x, i) => (i === 0 ? x : Number(x)));
      vs = { left: l, top: t, right: r, bottom: b };
      continue;
    }
    const parts = line.split('|');
    if (parts.length !== 5) continue;
    windows.push({
      iconic: parts[0] === 'True',
      left: Number(parts[1]),
      top: Number(parts[2]),
      right: Number(parts[3]),
      bottom: Number(parts[4]),
    });
  }
  if (!vs) vs = { left: 0, top: 0, right: 0, bottom: 0 };
  const iconic = windows.some((w) => w.iconic);
  const offscreen =
    windows.length > 0 &&
    !iconic &&
    windows.every((w) => w.right <= vs.left || w.left >= vs.right || w.bottom <= vs.top || w.top >= vs.bottom);
  return { iconic, offscreen, windowCount: windows.length };
}

async function main() {
  const { dist, window, knownBad } = parseArgs(process.argv.slice(2));

  if (process.platform !== 'win32') {
    console.log(`WINDOW-MODE: skipped platform=${process.platform}`);
    process.exit(0);
  }

  if (!window) {
    console.error('Usage: node scripts/gates/window-mode.mjs [--dist <dir>] --window offscreen|normal|minimized [--known-bad no-minimize|no-offscreen]');
    process.exit(2);
  }

  const distAbs = join(process.cwd(), dist);
  const chromeModUrl = pathToFileURL(join(distAbs, 'src', 'browser', 'chrome.js')).href;
  const { ensureChrome, stopChrome } = await import(chromeModUrl);

  const home = await mkdtemp(join(tmpdir(), 'wingman-wm-home-'));
  const profileDir = await mkdtemp(join(tmpdir(), 'wingman-wm-profile-'));
  const port = await freePort();

  const F0 = await foregroundPid();

  const launchWindow = knownBad ? 'normal' : window;

  let ensureResult;
  let iconic = false;
  let offscreen = false;
  let focus = 'unchanged';
  let exitCode = 0;

  try {
    ensureResult = await ensureChrome({ port, profileDir, chromePath: null, home, window: launchWindow });
    if (!ensureResult.ok) {
      console.log(`WINDOW-MODE: FAIL window=${window} iconic=false offscreen=false focus=unchanged`);
      process.exit(1);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const F1 = await foregroundPid();
    const state = await chromeWindowState(ensureResult.pid);
    iconic = state.iconic;
    offscreen = state.offscreen;

    if (F1 === F0) {
      focus = 'unchanged';
    } else {
      const procs = await execFileP('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${F1} -ErrorAction SilentlyContinue).Path`,
      ]).catch(() => '');
      focus = /chrome\.exe/i.test(procs) ? 'taken-by-chrome' : 'changed';
    }

    const expectedIconic = window === 'minimized';
    const expectedOffscreen = window === 'offscreen';
    const pass = iconic === expectedIconic && offscreen === expectedOffscreen;
    exitCode = pass ? 0 : 1;
    const line = `WINDOW-MODE: ${pass ? 'ok' : 'FAIL'} window=${window} iconic=${iconic} offscreen=${offscreen} focus=${focus}`;
    console.log(line);
  } finally {
    try {
      if (ensureResult && ensureResult.ok) {
        await stopChrome({ port, profileDir, home });
      }
    } catch {
      // best-effort
    }
    try {
      await execFileP('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profileDir.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ]);
    } catch {
      // best-effort
    }
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
