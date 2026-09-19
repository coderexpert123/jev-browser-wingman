import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  REASONS,
  STATUSES,
  SENSITIVE_HOST_CATEGORIES,
  DOCTOR_CHECK_IDS,
} from '../src/contract/types.js';
import { DEFAULT_BUDGETS, BUDGET_LIMITS } from '../src/contract/constants.js';
import { wingmanHome, expandHome } from '../src/contract/home.js';
import {
  WingmanError,
  StaleElementError,
  CoveredTargetError,
  ActFailedError,
  AttachError,
  DialogOpenError,
  ConfigError,
} from '../src/contract/errors.js';

test('REASONS covers every status in STATUSES', () => {
  for (const status of STATUSES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(REASONS, status),
      `REASONS is missing status ${status}`,
    );
    assert.ok(Array.isArray((REASONS as Record<string, readonly string[]>)[status]));
  }
});

test('every sensitive host category has a sensitive-<category> fallback reason', () => {
  for (const category of SENSITIVE_HOST_CATEGORIES) {
    assert.ok(
      REASONS.fallback.includes(`sensitive-${category}` as (typeof REASONS.fallback)[number]),
      `fallback reasons are missing sensitive-${category}`,
    );
  }
});

test('DEFAULT_BUDGETS sit inside BUDGET_LIMITS', () => {
  for (const key of Object.keys(DEFAULT_BUDGETS) as Array<keyof typeof DEFAULT_BUDGETS>) {
    const [min, max] = BUDGET_LIMITS[key];
    const value = DEFAULT_BUDGETS[key];
    assert.ok(value >= min && value <= max, `${key}=${value} outside [${min}, ${max}]`);
  }
});

test('max_ms ceiling is below the codex 60 s tool timeout', () => {
  assert.ok(BUDGET_LIMITS.max_ms[1] <= 50_000);
});

test('DOCTOR_CHECK_IDS has 9 unique ids in the pinned order', () => {
  assert.equal(DOCTOR_CHECK_IDS.length, 9);
  assert.equal(new Set(DOCTOR_CHECK_IDS).size, 9);
  assert.deepEqual(DOCTOR_CHECK_IDS, [
    'key-present', 'config-loaded', 'registration-portable', 'policy-loaded', 'profile-safe',
    'adapter-attach', 'default-context', 'coexistence', 'jev-round',
  ]);
});

test('wingmanHome honours WINGMAN_HOME and falls back to ~/.jev-browser-wingman', () => {
  const withEnv = wingmanHome({ WINGMAN_HOME: '/custom/home' } as NodeJS.ProcessEnv, '/home/someone');
  assert.equal(withEnv, '/custom/home');

  const withoutEnv = wingmanHome({} as NodeJS.ProcessEnv, '/home/someone');
  assert.equal(withoutEnv, path.join('/home/someone', '.jev-browser-wingman'));
});

test('expandHome expands ~/ and ~\\ only', () => {
  assert.equal(expandHome('~/profile', '/home/someone'), '/home/someone/profile');
  assert.equal(expandHome('~\\profile', '/home/someone'), '/home/someone\\profile');
  assert.equal(expandHome('/absolute/path', '/home/someone'), '/absolute/path');
  assert.equal(expandHome('relative/path', '/home/someone'), 'relative/path');
  assert.equal(expandHome('~notactuallyhome', '/home/someone'), '~notactuallyhome');
});

test('error classes carry their codes', () => {
  assert.equal(new StaleElementError('m').code, 'stale-element');
  assert.equal(new CoveredTargetError('m').code, 'covered-target');
  assert.equal(new ActFailedError('m').code, 'act-failed');
  assert.equal(new AttachError('m').code, 'no-browser');
  assert.equal(new DialogOpenError('m').code, 'dialog-open');
  assert.equal(new ConfigError('m').code, 'config');
  for (const err of [
    new StaleElementError('m'),
    new CoveredTargetError('m'),
    new ActFailedError('m'),
    new AttachError('m'),
    new DialogOpenError('m'),
    new ConfigError('m'),
  ]) {
    assert.ok(err instanceof WingmanError);
    assert.equal(err.name, err.constructor.name);
  }
});
