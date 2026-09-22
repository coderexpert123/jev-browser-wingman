import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveKey } from '../src/core/config.js';
import type { WingmanConfig } from '../src/contract/types.js';

function mkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-config-test-'));
}

function envFor(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, WINGMAN_HOME: home, ...extra };
}

function writeConfig(home: string, obj: unknown): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(obj));
}

test('missing file loads defaults', async () => {
  const home = mkHome();
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.source, 'defaults');
    assert.equal(result.config.mode, 'off');
    assert.equal(result.config.adapter, 'playwright');
    assert.equal(result.config.window, 'offscreen');
    assert.equal(result.config.budgets.max_steps, 24); // whole-goal delegation default
    assert.equal(result.config.budgets.max_ms, 45_000);
  }
});

test('mode absent means off', async () => {
  const home = mkHome();
  writeConfig(home, { adapter: 'cdp' });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.mode, 'off');
    assert.equal(result.source, 'file');
  }
});

test('malformed JSON fails', async () => {
  const home = mkHome();
  fs.writeFileSync(path.join(home, 'config.json'), '{ not json');
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});

test('an unknown key fails', async () => {
  const home = mkHome();
  writeConfig(home, { totally_unknown_key: true });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});

test('a relative profile_dir fails', async () => {
  const home = mkHome();
  writeConfig(home, { profile_dir: 'relative/profile' });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});

test('~ paths expand and absolute paths pass', async () => {
  const home = mkHome();
  writeConfig(home, { profile_dir: '~/wingman-profile-test' });
  const tildeResult = await loadConfig(envFor(home));
  assert.equal(tildeResult.ok, true);
  if (tildeResult.ok) {
    assert.ok(path.isAbsolute(tildeResult.config.profile_dir));
    assert.ok(tildeResult.config.profile_dir.startsWith(os.homedir()));
  }

  const home2 = mkHome();
  const absoluteDir = path.join(os.tmpdir(), 'wingman-abs-profile');
  writeConfig(home2, { profile_dir: absoluteDir });
  const absoluteResult = await loadConfig(envFor(home2));
  assert.equal(absoluteResult.ok, true);
  if (absoluteResult.ok) {
    assert.equal(absoluteResult.config.profile_dir, absoluteDir);
  }
});

test('a max_steps override of 24 (the default) is accepted', async () => {
  const home = mkHome();
  writeConfig(home, { budgets: { max_steps: 24 } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.budgets.max_steps, 24);
  }
});

test('a budget outside BUDGET_LIMITS fails', async () => {
  const home = mkHome();
  writeConfig(home, { budgets: { max_steps: 999 } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});

test('a window value outside offscreen, normal, minimized and headless fails', async () => {
  const home = mkHome();
  writeConfig(home, { window: 'fullscreen' });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);

  const home2 = mkHome();
  const absentResult = await loadConfig(envFor(home2));
  assert.equal(absentResult.ok, true);
  if (absentResult.ok) {
    assert.equal(absentResult.config.window, 'offscreen');
  }
});

test('an unknown sensitive_hosts category fails', async () => {
  const home = mkHome();
  writeConfig(home, { sensitive_hosts: { not_a_real_category: ['example.com'] } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});

test('gate.mode accepts confirm and off and defaults to confirm', async () => {
  const readGateMode = (config: WingmanConfig): string | undefined =>
    (config as WingmanConfig & { gate?: { mode?: string } }).gate?.mode;

  const home = mkHome();
  writeConfig(home, { gate: { mode: 'off' } });
  const offResult = await loadConfig(envFor(home));
  assert.equal(offResult.ok, true);
  if (offResult.ok) {
    assert.equal(readGateMode(offResult.config), 'off');
  }

  const home2 = mkHome();
  writeConfig(home2, { gate: { mode: 'confirm' } });
  const confirmResult = await loadConfig(envFor(home2));
  assert.equal(confirmResult.ok, true);
  if (confirmResult.ok) {
    assert.equal(readGateMode(confirmResult.config), 'confirm');
  }

  const home3 = mkHome();
  const absentResult = await loadConfig(envFor(home3));
  assert.equal(absentResult.ok, true);
  if (absentResult.ok) {
    assert.equal(readGateMode(absentResult.config), 'confirm');
  }
});

test('an unknown gate.mode fails on the mode, not on the gate key', async () => {
  const home = mkHome();
  writeConfig(home, { gate: { mode: 'sometimes' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /gate\.mode/);
  }
});

test('an unknown key inside gate fails', async () => {
  const home = mkHome();
  writeConfig(home, { gate: { strength: 'high' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /unknown gate key/);
  }
});

test('policy.mode accepts enforce and off and defaults to off', async () => {
  const readPolicyMode = (config: WingmanConfig): string | undefined =>
    (config as WingmanConfig & { policy?: { mode?: string } }).policy?.mode;

  const home = mkHome();
  writeConfig(home, { policy: { mode: 'off' } });
  const offResult = await loadConfig(envFor(home));
  assert.equal(offResult.ok, true);
  if (offResult.ok) {
    assert.equal(readPolicyMode(offResult.config), 'off');
  }

  const home2 = mkHome();
  writeConfig(home2, { policy: { mode: 'enforce' } });
  const enforceResult = await loadConfig(envFor(home2));
  assert.equal(enforceResult.ok, true);
  if (enforceResult.ok) {
    assert.equal(readPolicyMode(enforceResult.config), 'enforce');
  }

  const home3 = mkHome();
  const absentResult = await loadConfig(envFor(home3));
  assert.equal(absentResult.ok, true);
  if (absentResult.ok) {
    assert.equal(readPolicyMode(absentResult.config), 'off');
  }
});

test('policy.mode "maybe" fails with a policy-specific error', async () => {
  const home = mkHome();
  writeConfig(home, { policy: { mode: 'maybe' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /policy\.mode/);
  }
});

test('an unknown key inside policy fails', async () => {
  const home = mkHome();
  writeConfig(home, { policy: { strictness: 'high' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /unknown policy key/);
  }
});

test('policyModeOf defaults to off and honours an explicit enforce', async () => {
  const { policyModeOf, gateModeOf } = await import('../src/core/config.js');

  const home = mkHome();
  const absent = await loadConfig(envFor(home));
  assert.equal(absent.ok, true);
  if (absent.ok) {
    assert.equal(policyModeOf(absent.config), 'off');
    assert.equal(gateModeOf(absent.config), 'confirm');
  }

  const home2 = mkHome();
  writeConfig(home2, { policy: { mode: 'enforce' } });
  const enforced = await loadConfig(envFor(home2));
  assert.equal(enforced.ok, true);
  if (enforced.ok) {
    assert.equal(policyModeOf(enforced.config), 'enforce');
  }

  const home3 = mkHome();
  writeConfig(home3, { policy: { mode: 'off' } });
  const off = await loadConfig(envFor(home3));
  assert.equal(off.ok, true);
  if (off.ok) {
    assert.equal(policyModeOf(off.config), 'off');
  }
});

test('resolveKey prefers env then secrets_file and never returns a key for an empty value', () => {
  const home = mkHome();
  const secretsFile = path.join(home, 'secrets.env');
  fs.writeFileSync(secretsFile, 'TYPESAFE_API_KEY=from-file\n');

  const bothSet = resolveKey({ TYPESAFE_API_KEY: 'from-env' }, secretsFile);
  assert.deepEqual(bothSet, { key: 'from-env', source: 'env' });

  const onlyFile = resolveKey({}, secretsFile);
  assert.deepEqual(onlyFile, { key: 'from-file', source: 'secrets_file' });

  const emptyEnvValue = resolveKey({ TYPESAFE_API_KEY: '' }, secretsFile);
  assert.deepEqual(emptyEnvValue, { key: 'from-file', source: 'secrets_file' });

  const emptyFileValue = path.join(home, 'secrets-empty.env');
  fs.writeFileSync(emptyFileValue, 'TYPESAFE_API_KEY=\n');
  const neither = resolveKey({}, emptyFileValue);
  assert.deepEqual(neither, { source: 'none' });

  const noneAtAll = resolveKey({}, null);
  assert.deepEqual(noneAtAll, { source: 'none' });
});
