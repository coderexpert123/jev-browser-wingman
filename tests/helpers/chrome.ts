import { execFileSync } from 'node:child_process';
import { launchEphemeralChrome } from '../../src/browser/ephemeral.js';

type ChromeHandle = Awaited<ReturnType<typeof launchEphemeralChrome>>;

// Teardown-hardening (2026-09-22): every browser this helper launches is
// registered here and removed on a clean close(). The `process.on('exit')`
// backstop below tree-kills anything still registered when the test process
// exits without closing it — a crashed test, a missed finally-block, an early
// assertion throw. This is BEST-EFFORT (sync, fast, errors swallowed); the
// run-tests.mjs WINGMAN_RUN_TOKEN sweep is the real guarantee.
const registry = new Set<ChromeHandle>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    if (registry.size === 0) return;
    for (const chrome of registry) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 10_000,
            windowsHide: true,
          });
        } else {
          try {
            process.kill(-chrome.pid);
          } catch {
            // ESRCH etc. — best-effort
          }
          try {
            process.kill(chrome.pid);
          } catch {
            // best-effort
          }
        }
      } catch {
        // best-effort: the runner sweep is the guarantee, not this hook
      }
    }
    registry.clear();
  });
}

export const launchTestChrome = (opts?: { headless?: boolean; chromePath?: string | null }) =>
  launchEphemeralChrome({ headless: true, ...opts }).then((chrome) => {
    installExitHook();
    registry.add(chrome);
    const origClose = chrome.close.bind(chrome);
    chrome.close = async (): Promise<void> => {
      registry.delete(chrome);
      await origClose();
    };
    return chrome;
  });
