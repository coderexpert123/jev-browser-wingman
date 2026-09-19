// WP-F2: registrations tests (§ WP-F2 item 8 list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  portabilityProblems,
  readRegistrations,
  wrapPlaywrightEntry,
  type RegistrationEntry,
} from '../src/cli/registrations.js';
import { packageRoot } from '../src/package-root.js';

// The compiled test lives under <root>/.build/<x>/tests (or <root>/dist/tests);
// packageRoot walks up to the repo root, where the fixtures live.
const fixtureDir = join(packageRoot(), 'tests', 'fixtures');

function findEntry(entries: RegistrationEntry[], server: string): RegistrationEntry {
  const hit = entries.find((e) => e.server === server);
  assert.ok(hit, `entry ${server} not found`);
  return hit;
}

test('reads claude, codex and opencode fixture registrations', async () => {
  const claude = await readRegistrations('claude', { file: join(fixtureDir, 'claude.json') });
  assert.ok(!('error' in claude), 'claude parse error');
  assert.equal(claude.exists, true);
  const claudePw = findEntry(claude.entries, 'playwright');
  assert.deepEqual(claudePw.command, 'npx');
  assert.deepEqual(claudePw.args, ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome']);
  assert.ok(claude.entries.some((e) => e.server === 'pa-mcp'));

  const codex = await readRegistrations('codex', { file: join(fixtureDir, 'codex-config.toml') });
  assert.ok(!('error' in codex), 'codex parse error');
  const codexPw = findEntry(codex.entries, 'playwright');
  assert.equal(codexPw.command, 'npx');
  assert.deepEqual(codexPw.args, [
    '-y',
    '@playwright/mcp@0.0.80',
    '--browser',
    'chrome',
    '--user-data-dir=C:/Users/example/.pa/browser-profile',
  ]);
  const x = findEntry(codex.entries, 'x');
  assert.deepEqual(x.env, { API_TOKEN: 'fixture-value', HOME_DIR: 'C:/Users/example/.pa' });

  const opencode = await readRegistrations('opencode', { file: join(fixtureDir, 'opencode.jsonc') });
  assert.ok(!('error' in opencode), 'opencode parse error');
  const ocPw = findEntry(opencode.entries, 'playwright');
  // Array form splits into command + args.
  assert.equal(ocPw.command, 'npx');
  assert.deepEqual(ocPw.args, [
    '-y',
    '@playwright/mcp@0.0.80',
    '--browser',
    'chrome',
    '--user-data-dir',
    'C:/Users/example/.pa/browser-profile',
  ]);
  const ocPa = findEntry(opencode.entries, 'pa-mcp');
  assert.deepEqual(ocPa.env, { PA_HOME: 'C:/Users/example/.pa' });
});

test('wrapPlaywrightEntry output for the claude fixture equals the pinned JSON', async () => {
  // Wrap the fixture's raw entry (with its `type` and `env` keys) so the
  // output can equal the pinned JSON exactly.
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(join(fixtureDir, 'claude.json'), 'utf8')) as {
    mcpServers: Record<string, { command?: string; args?: string[] }>;
  };
  const pw = raw.mcpServers['playwright'];
  assert.ok(pw);
  const wrapped = wrapPlaywrightEntry(pw, 'claude');
  assert.equal(
    JSON.stringify(wrapped),
    '{"type":"stdio","command":"jev-browser-wingman","args":["with-chrome","--","npx","-y","@playwright/mcp@0.0.80","--browser","chrome"],"env":{}}',
  );
});

test('wrapPlaywrightEntry drops --user-data-dir in both forms', () => {
  const pair = wrapPlaywrightEntry(
    { command: 'npx', args: ['-y', '@playwright/mcp@0.0.80', '--user-data-dir', 'C:/Users/example/prof', '--browser', 'chrome'] },
    'claude',
  ) as { args: string[] };
  assert.deepEqual(pair.args, ['with-chrome', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome']);

  const inline = wrapPlaywrightEntry(
    { command: 'npx', args: ['-y', '@playwright/mcp@0.0.80', '--user-data-dir=C:/Users/example/prof', '--browser', 'chrome'] },
    'claude',
  ) as { args: string[] };
  assert.deepEqual(inline.args, ['with-chrome', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome']);

  // opencode's array form
  const array = wrapPlaywrightEntry(
    ['npx', '-y', '@playwright/mcp@0.0.80', '--user-data-dir', 'C:/Users/example/prof'],
    'opencode',
  ) as string[];
  assert.deepEqual(array, ['jev-browser-wingman', 'with-chrome', '--', 'npx', '-y', '@playwright/mcp@0.0.80']);
});

test('codex wrapped table gains startup_timeout_sec 60', () => {
  const wrapped = wrapPlaywrightEntry(
    { command: 'npx', args: ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'] },
    'codex',
  ) as Record<string, unknown>;
  assert.equal(wrapped.startup_timeout_sec, 60);
  assert.equal(wrapped.command, 'jev-browser-wingman');
  assert.equal((wrapped.args as string[])[0], 'with-chrome');

  const claude = wrapPlaywrightEntry({ command: 'npx', args: [] }, 'claude') as Record<string, unknown>;
  assert.equal(claude.startup_timeout_sec, undefined);
});

test('portabilityProblems flags an absolute path', () => {
  const problems = portabilityProblems({
    client: 'claude',
    server: 'playwright',
    command: 'node',
    args: ['C:/tools/mcp.js', '--profile=D:/x/p'],
    env: {},
    raw: null,
  });
  assert.deepEqual(problems.sort(), ['absolute-path:--profile=D:/x/p', 'absolute-path:C:/tools/mcp.js']);

  // A relative path and a tilde path are fine.
  assert.deepEqual(
    portabilityProblems({
      client: 'claude',
      server: 'playwright',
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.80'],
      env: {},
      raw: null,
    }),
    [],
  );
});

test('portabilityProblems flags a secret in env without printing it', () => {
  const problems = portabilityProblems({
    client: 'claude',
    server: 'pw',
    command: 'npx',
    args: [],
    env: { TYPESAFE_API_KEY: 'super-secret-value-123', EMPTY_TOKEN: '', PLAIN: 'x' },
    raw: null,
  });
  assert.deepEqual(problems, ['secret-in-env:TYPESAFE_API_KEY']);
  assert.ok(!problems.join(';').includes('super-secret-value-123'));
});

test('a tilde path is portable', () => {
  const problems = portabilityProblems({
    client: 'claude',
    server: 'playwright',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.80', '--user-data-dir=~/browser-profile'],
    env: {},
    raw: null,
  });
  assert.deepEqual(problems, []);
});
