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
    assert.equal(result.config.budgets.max_ms, 90_000);
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

test('gate.mode accepts confirm and off and defaults to off', async () => {
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
    assert.equal(readGateMode(absentResult.config), 'off');
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
    assert.equal(gateModeOf(absent.config), 'off');
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

// § 5.3 handoff config block (tests (1)-(10))
test('(1) handoff key absent loads { mode: forced, tools: browse-only, retain: [] }', async () => {
  const readHandoff = (config: WingmanConfig) =>
    (config as WingmanConfig & { handoff?: { mode?: string; tools?: string; retain?: string[] } }).handoff;

  const home = mkHome();
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(readHandoff(result.config), { mode: 'forced', tools: 'browse-only', retain: [] });
  }

  const home2 = mkHome();
  writeConfig(home2, { policy: { mode: 'enforce' } });
  const withPolicy = await loadConfig(envFor(home2));
  assert.equal(withPolicy.ok, true);
  if (withPolicy.ok) {
    assert.deepEqual(readHandoff(withPolicy.config), { mode: 'forced', tools: 'browse-only', retain: [] });
  }
});

test('(2) handoff.mode given, tools absent, derives tools from mode', async () => {
  const readHandoff = (config: WingmanConfig) =>
    (config as WingmanConfig & { handoff?: { mode?: string; tools?: string } }).handoff;

  const home = mkHome();
  writeConfig(home, { handoff: { mode: 'forced' } });
  const forced = await loadConfig(envFor(home));
  assert.equal(forced.ok, true);
  if (forced.ok) {
    assert.equal(readHandoff(forced.config)?.tools, 'browse-only');
  }

  const home2 = mkHome();
  writeConfig(home2, { handoff: { mode: 'optional' } });
  const optional = await loadConfig(envFor(home2));
  assert.equal(optional.ok, true);
  if (optional.ok) {
    assert.equal(readHandoff(optional.config)?.tools, 'all');
  }
});

test('(3) handoff.tools or handoff.retain given, mode absent, defaults mode to forced', async () => {
  const readHandoff = (config: WingmanConfig) =>
    (config as WingmanConfig & { handoff?: { mode?: string } }).handoff;

  const home = mkHome();
  writeConfig(home, { handoff: { tools: 'all' } });
  const withTools = await loadConfig(envFor(home));
  assert.equal(withTools.ok, true);
  if (withTools.ok) {
    assert.equal(readHandoff(withTools.config)?.mode, 'forced');
  }

  const home2 = mkHome();
  writeConfig(home2, { handoff: { retain: ['scroll'] } });
  const withRetain = await loadConfig(envFor(home2));
  assert.equal(withRetain.ok, true);
  if (withRetain.ok) {
    assert.equal(readHandoff(withRetain.config)?.mode, 'forced');
  }
});

test('(4) handoff.retain accepts withholdable classes (including script) and rejects an unknown class', async () => {
  const readHandoff = (config: WingmanConfig) =>
    (config as WingmanConfig & { handoff?: { retain?: string[] } }).handoff;

  const home = mkHome();
  writeConfig(home, { handoff: { retain: ['scroll', 'key'] } });
  const ok = await loadConfig(envFor(home));
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(readHandoff(ok.config)?.retain, ['scroll', 'key']);
  }

  // 'script' moved into WITHHOLDABLE_CLASSES (operator directive 2026-09-28: forced
  // mode withholds the caller's script tool by default); retain is how a user opts
  // back in, so it must validate.
  const home2 = mkHome();
  writeConfig(home2, { handoff: { retain: ['script'] } });
  const withScript = await loadConfig(envFor(home2));
  assert.equal(withScript.ok, true);
  if (withScript.ok) {
    assert.deepEqual(readHandoff(withScript.config)?.retain, ['script']);
  }

  const home3 = mkHome();
  writeConfig(home3, { handoff: { retain: ['read'] } }); // 'read' is a retained class, not withholdable
  const bad = await loadConfig(envFor(home3));
  assert.equal(bad.ok, false);
});

test('(5) the five handoff error strings', async () => {
  const home = mkHome();
  writeConfig(home, { handoff: 'not-an-object' });
  const notObject = await loadConfig(envFor(home));
  assert.equal(notObject.ok, false);
  if (!notObject.ok) assert.equal(notObject.error, 'handoff must be an object');

  const home2 = mkHome();
  writeConfig(home2, { handoff: { unknown_key: true } });
  const unknownKey = await loadConfig(envFor(home2));
  assert.equal(unknownKey.ok, false);
  if (!unknownKey.ok) assert.equal(unknownKey.error, 'unknown handoff key: unknown_key');

  const home3 = mkHome();
  writeConfig(home3, { handoff: { mode: 'sometimes' } });
  const invalidMode = await loadConfig(envFor(home3));
  assert.equal(invalidMode.ok, false);
  if (!invalidMode.ok) assert.equal(invalidMode.error, 'invalid handoff.mode: "sometimes"');

  const home4 = mkHome();
  writeConfig(home4, { handoff: { tools: 'everything' } });
  const invalidTools = await loadConfig(envFor(home4));
  assert.equal(invalidTools.ok, false);
  if (!invalidTools.ok) assert.equal(invalidTools.error, 'invalid handoff.tools: "everything"');

  const home5 = mkHome();
  writeConfig(home5, { handoff: { retain: ['not-a-class'] } });
  const invalidRetain = await loadConfig(envFor(home5));
  assert.equal(invalidRetain.ok, false);
  if (!invalidRetain.ok) assert.equal(invalidRetain.error, 'invalid handoff.retain: ["not-a-class"]');
});

test('(6) forced + policy.mode enforce is not a config error and handoffOf reads forced (Q4)', async () => {
  const { handoffOf } = await import('../src/core/config.js');

  const home = mkHome();
  writeConfig(home, { mode: 'on', policy: { mode: 'enforce' }, handoff: { mode: 'forced' } });
  const explicit = await loadConfig(envFor(home));
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(handoffOf(explicit.config).mode, 'forced');
  }

  const home2 = mkHome();
  writeConfig(home2, { mode: 'on', policy: { mode: 'enforce' } });
  const implicit = await loadConfig(envFor(home2));
  assert.equal(implicit.ok, true);
  if (implicit.ok) {
    assert.equal(handoffOf(implicit.config).mode, 'forced');
  }
});

test('(7) handoffOf on a hand-built object with no handoff key returns optional', async () => {
  const { handoffOf } = await import('../src/core/config.js');
  const handBuilt = { mode: 'on' } as unknown as WingmanConfig;
  assert.deepEqual(handoffOf(handBuilt), { mode: 'optional', tools: 'all', retain: [] });
});

test('(8) handoffOf reads retain from a loaded config', async () => {
  const { handoffOf } = await import('../src/core/config.js');
  const home = mkHome();
  writeConfig(home, { mode: 'on', handoff: { mode: 'forced', retain: ['scroll'] } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(handoffOf(result.config).retain, ['scroll']);
  }
});

test('(9) handoffOf on a hand-built forced object with top-level mode on returns forced', async () => {
  const { handoffOf } = await import('../src/core/config.js');
  const forced = { mode: 'on', handoff: { mode: 'forced', tools: 'browse-only', retain: [] } } as unknown as WingmanConfig;
  assert.equal(handoffOf(forced).mode, 'forced');
});

test('(10) handoffOf returns optional whenever top-level mode is not on, whatever handoff says', async () => {
  const { handoffOf } = await import('../src/core/config.js');

  const off = { mode: 'off', handoff: { mode: 'forced' } } as unknown as WingmanConfig;
  assert.equal(handoffOf(off).mode, 'optional');

  const shadow = { mode: 'shadow', handoff: { mode: 'forced' } } as unknown as WingmanConfig;
  assert.equal(handoffOf(shadow).mode, 'optional');

  const on = { mode: 'on', handoff: { mode: 'forced' } } as unknown as WingmanConfig;
  assert.equal(handoffOf(on).mode, 'forced');
});

// § 5.3a gate default OFF (Q6) (tests (11)-(12))
test('(11) gateModeOf on a hand-built config: absent gate is off, explicit confirm is confirm', async () => {
  const { gateModeOf } = await import('../src/core/config.js');

  const noGate = {} as unknown as WingmanConfig;
  assert.equal(gateModeOf(noGate), 'off');

  const confirmGate = { gate: { mode: 'confirm' } } as unknown as WingmanConfig;
  assert.equal(gateModeOf(confirmGate), 'confirm');
});

test('(12) DEFAULT_GATE deep-equals { mode: off }', async () => {
  const { DEFAULT_GATE } = await import('../src/contract/constants.js');
  assert.deepEqual(DEFAULT_GATE, { mode: 'off' });
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
