import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveKey } from '../src/core/config.js';

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
