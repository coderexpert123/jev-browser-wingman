import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  REASONS,
  STATUSES,
  SENSITIVE_HOST_CATEGORIES,
  DOCTOR_CHECK_IDS,
  OPS,
  TARGETLESS_OPS,
  LEGACY_OPS,
  PRESS_KEYS,
} from '../src/contract/types.js';
import {
  DEFAULT_BUDGETS,
  BUDGET_LIMITS,
  WITHHOLDABLE_CLASSES,
  RETAINED_CLASSES,
  CLASS_OPS,
  HANDOFF_REFUSAL_TEXT,
} from '../src/contract/constants.js';
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

test('default max_steps budget is 24 (whole-goal delegation)', () => {
  // 24 must fit a long-chain goal (t9 is 19 steps) in one wingman_do call.
  assert.equal(DEFAULT_BUDGETS.max_steps, 24);
});

test('max_ms default is 90 s and the ceiling is 120 s', () => {
  assert.equal(DEFAULT_BUDGETS.max_ms, 90_000);
  assert.equal(BUDGET_LIMITS.max_ms[1], 120_000);
});

test('DOCTOR_CHECK_IDS has 10 unique ids in the pinned order', () => {
  assert.equal(DOCTOR_CHECK_IDS.length, 10);
  assert.equal(new Set(DOCTOR_CHECK_IDS).size, 10);
  assert.deepEqual(DOCTOR_CHECK_IDS, [
    'key-present', 'config-loaded', 'registration-portable', 'policy-loaded', 'profile-safe',
    'adapter-attach', 'default-context', 'coexistence', 'handoff', 'jev-round',
  ]);
});

test('OPS, TARGETLESS_OPS, LEGACY_OPS and PRESS_KEYS are pinned (§ 5.1)', () => {
  assert.deepEqual(OPS, [
    'click', 'fill', 'select', 'check', 'uncheck', 'press', 'scroll',
    'scroll_up', 'dblclick', 'hover', 'upload', 'navigate', 'back', 'wait', 'scroll_to', 'reload',
  ]);
  for (const op of TARGETLESS_OPS) {
    assert.ok((OPS as readonly string[]).includes(op), `TARGETLESS_OPS entry ${op} must be in OPS`);
  }
  assert.deepEqual(TARGETLESS_OPS, ['scroll', 'scroll_up', 'wait', 'navigate', 'back', 'reload']);
  assert.deepEqual(LEGACY_OPS, ['click', 'fill', 'select', 'check', 'uncheck', 'press', 'scroll']);
  assert.deepEqual(PRESS_KEYS, [
    'Enter', 'Tab', 'ShiftTab', 'Escape', 'Space', 'Backspace', 'SelectAll',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ]);
  assert.equal(PRESS_KEYS.length, 11);
});

test('WITHHOLDABLE_CLASSES and RETAINED_CLASSES are pinned and disjoint (§ 5.2, amended 2026-09-28: script moved to withholdable)', () => {
  // `script` moved here from RETAINED_CLASSES (operator directive 2026-09-28):
  // forced mode withholds the caller's script-class tools by default, though
  // no adapter op covers script (profiles.ts's withheldClasses() special-cases
  // it rather than deriving it from CLASS_OPS). Opt back in with
  // `handoff.retain: ["script"]`.
  assert.deepEqual(WITHHOLDABLE_CLASSES, [
    'element-act', 'type', 'select', 'key', 'hover', 'upload', 'navigate', 'back', 'scroll', 'script',
  ]);
  assert.deepEqual(RETAINED_CLASSES, [
    'pointer-xy', 'drag', 'tabs', 'dialog', 'read', 'wait', 'session', 'unknown',
  ]);
  for (const c of WITHHOLDABLE_CLASSES) {
    assert.ok(!(RETAINED_CLASSES as readonly string[]).includes(c), `${c} must not be both withholdable and retained`);
  }
});

test('CLASS_OPS keys are exactly WITHHOLDABLE_CLASSES, and every op it lists is in OPS', () => {
  assert.deepEqual(Object.keys(CLASS_OPS).sort(), [...WITHHOLDABLE_CLASSES].sort());
  for (const [cls, ops] of Object.entries(CLASS_OPS)) {
    for (const op of ops) {
      assert.ok((OPS as readonly string[]).includes(op), `CLASS_OPS.${cls} lists ${op}, not in OPS`);
    }
  }
});

test('HANDOFF_REFUSAL_TEXT is the pinned literal (§ 5.2)', () => {
  assert.equal(
    HANDOFF_REFUSAL_TEXT,
    'jev-browser-wingman forced handoff: this browser action is handled by the wingman. Call browse_step with your goal, the ordered remaining steps in steps, and every URL, file path and text in values; if it returns a step to you, call it again with pick naming the element by role and name.',
  );
});

test('REASONS.fallback includes unsupported-op', () => {
  assert.ok(REASONS.fallback.includes('unsupported-op' as (typeof REASONS.fallback)[number]));
});

test('constants.ts never names a browsing product except the marked ENV.PLAYWRIGHT_CDP line', () => {
  // run-tests.mjs spawns the compiled test with cwd = the package root ("P/"),
  // so this reads the real TypeScript source, not the compiled scratch build.
  const constantsPath = path.join(process.cwd(), 'src', 'contract', 'constants.ts');
  const source = fs.readFileSync(constantsPath, 'utf8');
  for (const line of source.split(/\r?\n/)) {
    if (/playwright/i.test(line)) {
      assert.ok(
        line.includes('PLAYWRIGHT_CDP') && line.includes('deleted by WP-R'),
        `unexpected product-name leak: ${line}`,
      );
    }
  }
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
