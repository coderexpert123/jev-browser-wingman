// CLI tests (§ WP-F1 item 7 required list). The CLI under test is the real
// built `node <this build>/src/cli/main.js`, spawned by path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

function scrubEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === 'WINGMAN_HOME' ||
      k === 'WINGMAN_CDP_ENDPOINT' ||
      k === 'PLAYWRIGHT_MCP_CDP_ENDPOINT' ||
      k === 'TYPESAFE_API_KEY' ||
      k === 'TYPESAFE_BASE_URL'
    ) {
      continue;
    }
    env[k] = v;
  }
  return env;
}

function runCli(args: string[], env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [mainJs, ...args], {
    env: { ...scrubEnv(), ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
}

function mkHome(mode: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-cli-test-'));
  // `off` is the key-absent default; the config rejects an explicit "off".
  const modeKeys = mode === 'off' ? {} : { mode };
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      ...modeKeys,
      adapter: 'playwright',
      window: 'headless',
      profile_dir: path.join(home, 'profile'),
      port: 9333,
    }),
  );
  return home;
}

// ---- required tests ----

test('--version prints jev-browser-wingman 0.1.0', () => {
  const r = runCli(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'jev-browser-wingman 0.1.0\n');
});

test('an unknown subcommand exits 2', () => {
  const r = runCli(['frobnicate']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.length > 0, 'expected usage on stderr');
  assert.equal(r.stdout, '');
});

test('run with mode off prints fallback mode-off', () => {
  const home = mkHome('off');
  const r = runCli(['run', '--goal', 'Click Continue'], { WINGMAN_HOME: home });
  assert.equal(r.status, 0);
  const result = JSON.parse((r.stdout as string).trim()) as { status: string; reason: string };
  assert.equal(result.status, 'fallback');
  assert.equal(result.reason, 'mode-off');
});

test('run rejects values on argv', () => {
  const r = runCli(['run', '--goal', 'Fill the form', '--values', '{"name":"someone"}']);
  assert.equal(r.status, 2);
  assert.match(r.stderr as string, /values/);
});

test('chrome show dispatches into chrome-cmd (no-browser JSON, not the usage exit)', () => {
  // Dispatch-level: chrome-cmd tolerates a missing config.json (defaults
  // apply), so wired `chrome show` proceeds to its port probe and prints its
  // own `no-browser` JSON line (exit 1) without launching anything. Unwired,
  // `chrome show` never reaches chrome-cmd: the CLI prints usage on stderr
  // and exits 2.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-cli-show-'));
  try {
    const r = runCli(['chrome', 'show'], { WINGMAN_HOME: home });
    assert.equal(r.status, 1);
    const result = JSON.parse((r.stdout as string).trim()) as { ok: boolean; code: string; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no-browser');
    assert.match(result.error, /run jev-browser-wingman chrome ensure first\.$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('guide exits 1 when the contract file is missing', () => {
  // A temp package root: copy the whole compiled build into tmp/dist beside a
  // package.json carrying the package's name (and a node_modules junction, so
  // main.js's dependency imports resolve), so packageRoot() resolves to the
  // temp root, where no INSTALL-FOR-AGENTS.md exists.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-cli-guide-'));
  try {
    const distRoot = path.resolve(path.dirname(mainJs), '..', '..');
    fs.cpSync(distRoot, path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'jev-browser-wingman', version: '0.1.0', type: 'module' }));
    // Find the package's node_modules (dist/ and .build/f1 are at different
    // depths), then junction it into the temp root so main.js's dependency
    // imports resolve.
    let nmCursor = distRoot;
    let packageNodeModules = path.join(nmCursor, 'node_modules');
    while (!fs.existsSync(packageNodeModules) && nmCursor !== path.dirname(nmCursor)) {
      nmCursor = path.dirname(nmCursor);
      packageNodeModules = path.join(nmCursor, 'node_modules');
    }
    if (fs.existsSync(packageNodeModules)) {
      fs.symlinkSync(packageNodeModules, path.join(tmp, 'node_modules'), 'junction');
    }
    const r = spawnSync(process.execPath, [path.join(tmp, 'dist', 'src', 'cli', 'main.js'), 'guide'], {
      env: scrubEnv(),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr as string, /INSTALL-FOR-AGENTS\.md not found in /);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
