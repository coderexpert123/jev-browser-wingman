// WP-F2: chrome-cmd tests (§ WP-F2 item 8 list). All effects injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGETS } from '../src/contract/constants.js';
import type { WingmanConfig } from '../src/contract/types.js';
import { chromeCommand } from '../src/cli/chrome-cmd.js';
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
