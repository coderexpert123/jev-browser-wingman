// WP-F2: the `chrome ensure|status|stop` commands (§ WP-F2 item 6). Each
// prints exactly one JSON line; the resolved number is the exit code.

import { loadConfig } from '../core/config.js';
import { wingmanHome } from '../contract/home.js';
import {
  chromeStatus,
  ensureChrome,
  stopChrome,
} from '../browser/chrome.js';

export interface ChromeCmdDeps {
  env?: NodeJS.ProcessEnv;
  loadConfigFn?: typeof loadConfig;
  ensureChromeFn?: typeof ensureChrome;
  chromeStatusFn?: typeof chromeStatus;
  stopChromeFn?: typeof stopChrome;
  write?: (s: string) => void;
}

export async function chromeCommand(
  sub: 'ensure' | 'status' | 'stop',
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

  // stop
  const result = await (deps.stopChromeFn ?? stopChrome)({
    port: config.port,
    profileDir: config.profile_dir,
    home,
  });
  write(JSON.stringify({ ok: true, killed: result.killed }) + '\n');
  return 0;
}
