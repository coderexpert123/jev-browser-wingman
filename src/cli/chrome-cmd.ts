// WP-F2: the `chrome ensure|status|stop` commands (§ WP-F2 item 6), extended
// by WP-X (spec § 0 RO-7) with `chrome show|hide`: move the shared window
// on-screen or back off-screen via CDP `Browser.setWindowBounds`, for when
// the operator must act, e.g. a login code. Each prints exactly one JSON
// line; the resolved number is the exit code.

import { loadConfig } from '../core/config.js';
import { wingmanHome } from '../contract/home.js';
import {
  chromeStatus,
  ensureChrome,
  stopChrome,
  probeVersion,
  OFFSCREEN_WINDOW_BOUNDS,
  ONSCREEN_WINDOW_BOUNDS,
} from '../browser/chrome.js';
import { CdpConnection } from '../adapters/cdp-connection.js';

export interface ChromeCmdDeps {
  env?: NodeJS.ProcessEnv;
  loadConfigFn?: typeof loadConfig;
  ensureChromeFn?: typeof ensureChrome;
  chromeStatusFn?: typeof chromeStatus;
  stopChromeFn?: typeof stopChrome;
  write?: (s: string) => void;
  probeVersionFn?: typeof probeVersion;
  connectCdp?: (endpoint: string) => Promise<CdpConnection>;
}

export async function chromeCommand(
  sub: 'ensure' | 'status' | 'stop' | 'show' | 'hide',
  deps: ChromeCmdDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const loaded = await (deps.loadConfigFn ?? loadConfig)(env);
  if (!loaded.ok) {
    write(JSON.stringify({ ok: false, error: `config: ${loaded.error}` }) + '\n');
    return 1;
  }
  const config = loaded.config;
  const home = wingmanHome(env);

  if (sub === 'ensure') {
    const result = await (deps.ensureChromeFn ?? ensureChrome)({
      port: config.port,
      profileDir: config.profile_dir,
      chromePath: config.chrome_path,
      home,
      window: config.window,
    });
    if (result.ok) {
      write(JSON.stringify(result) + '\n');
      return 0;
    }
    write(JSON.stringify({ ok: false, code: result.code, error: result.message }) + '\n');
    return 1;
  }

  if (sub === 'status') {
    const status = await (deps.chromeStatusFn ?? chromeStatus)({
      port: config.port,
      profileDir: config.profile_dir,
      home,
    });
    write(JSON.stringify(status) + '\n');
    return 0;
  }

  if (sub === 'show' || sub === 'hide') {
    const probe = deps.probeVersionFn ?? probeVersion;
    const answering = await probe(config.port, 1500);
    if (!answering) {
      write(
        JSON.stringify({
          ok: false,
          code: 'no-browser',
          error: `No Chrome is answering on port ${config.port}; run jev-browser-wingman chrome ensure first.`,
        }) + '\n',
      );
      return 1;
    }
    const connect = deps.connectCdp ?? ((endpoint: string) => CdpConnection.connect(endpoint));
    const conn = await connect(`http://127.0.0.1:${config.port}`);
    try {
      const targets = (await conn.send('Target.getTargets')) as {
        targetInfos?: Array<{ targetId: string; type: string }>;
      };
      const pageTargets = (targets.targetInfos ?? []).filter((t) => t.type === 'page');
      // Distinct windows of the page targets, with the first one's reported
      // window state (a `minimized` window must be restored before its
      // position can change).
      const windows: Array<{ windowId: number; minimized: boolean }> = [];
      for (const t of pageTargets) {
        const w = (await conn.send('Browser.getWindowForTarget', { targetId: t.targetId })) as {
          windowId: number;
          bounds?: { windowState?: string };
        };
        if (windows.some((x) => x.windowId === w.windowId)) continue;
        windows.push({ windowId: w.windowId, minimized: w.bounds?.windowState === 'minimized' });
      }
      const moved: number[] = [];
      for (const { windowId, minimized } of windows) {
        if (sub === 'show') {
          // Restoring through Browser.setWindowBounds takes the foreground —
          // that is the point of show (RO-7: the operator must act).
          await conn.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          await conn.send('Browser.setWindowBounds', { windowId, bounds: { ...ONSCREEN_WINDOW_BOUNDS } });
        } else {
          if (minimized) {
            // A minimized window rejects a position-only change; restore it
            // first so the off-screen move lands.
            await conn.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          }
          await conn.send('Browser.setWindowBounds', { windowId, bounds: { ...OFFSCREEN_WINDOW_BOUNDS } });
        }
        moved.push(windowId);
      }
      write(JSON.stringify({ ok: true, windows: moved }) + '\n');
      return 0;
    } catch (err) {
      write(JSON.stringify({ ok: false, code: 'cdp-error', error: (err as Error).message }) + '\n');
      return 1;
    } finally {
      await conn.close();
    }
  }

  // stop
  const result = await (deps.stopChromeFn ?? stopChrome)({
    port: config.port,
    profileDir: config.profile_dir,
    home,
  });
  write(JSON.stringify({ ok: true, killed: result.killed }) + '\n');
  return 0;
}
