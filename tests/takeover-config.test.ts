// WP-T1a required tests (§ 4 WP-T1a, amendment 2026-09-21d): the takeover
// contract reason pins and the takeover config block (§ 3.20, including the
// `retry` flag). The routing question-set tests of the previous revision were
// removed with buildRoutingRequest (§ 3.18 retired). Helpers are written fresh
// in this file — helpers stay unimported between test files.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REASONS } from '../src/contract/types.js';
import type { WingmanConfig } from '../src/contract/types.js';
import { DEFAULT_TAKEOVER, TAKEOVER_MODES, TAKEOVER_SINGLE_FLOOR, TAKEOVER_THRESHOLD_RANGE } from '../src/contract/constants.js';
import { loadConfig, takeoverOf } from '../src/core/config.js';

function mkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-takeover-test-'));
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { ...process.env, WINGMAN_HOME: home };
}

function writeConfig(home: string, obj: unknown): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(obj));
}

test('the takeover reasons match the amended REASONS', () => {
  const fallback = REASONS.fallback as readonly string[];
  assert.ok(fallback.includes('step-uncertain'));
  assert.ok(fallback.includes('takeover-offered'));
  assert.ok(!fallback.includes('route-caller'), 'route-caller was removed with the routing path');
  assert.ok(!(REASONS.ambiguous as readonly string[]).includes('route-unclear'), 'route-unclear was removed with the routing path');
  // No other reason moved: spot-check one from every pre-existing bucket.
  assert.ok((REASONS.done as readonly string[]).includes('goal-met'));
  assert.ok((REASONS.needs_confirmation as readonly string[]).includes('irreversible-heuristic'));
  assert.ok((REASONS.blocked as readonly string[]).includes('lock-held'));
  assert.ok((REASONS.login as readonly string[]).includes('login-page'));
  assert.ok((REASONS.error as readonly string[]).includes('invalid-input'));
  assert.ok((REASONS.ambiguous as readonly string[]).includes('no-value'));
  assert.ok(fallback.includes('sensitive-password'));
});

test('takeover config absent means threshold 0.7, mode auto, retry true', async () => {
  assert.deepEqual(DEFAULT_TAKEOVER, { threshold: 0.7, mode: 'auto', retry: true });
  assert.deepEqual(TAKEOVER_THRESHOLD_RANGE, [0.5, 0.95]);
  assert.deepEqual([...TAKEOVER_MODES], ['auto', 'offer']);
  assert.equal(TAKEOVER_SINGLE_FLOOR, 0.5);
  const home = mkHome();
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(takeoverOf(result.config), { threshold: 0.7, mode: 'auto', retry: true });
  }
});

test('takeover config accepts an explicit threshold and mode', async () => {
  const home = mkHome();
  writeConfig(home, { takeover: { threshold: 0.9, mode: 'offer' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    const t = takeoverOf(result.config);
    assert.equal(t.threshold, 0.9);
    assert.equal(t.mode, 'offer');
    assert.equal(t.retry, true, 'retry defaults on when the written config omits it');
  }
  // § 3.20 boundary: the range edges themselves load (0.5 ≤ threshold ≤ 0.95).
  const homeLow = mkHome();
  writeConfig(homeLow, { takeover: { threshold: 0.5, mode: 'auto' } });
  const low = await loadConfig(envFor(homeLow));
  assert.equal(low.ok, true);
  if (low.ok) assert.equal(takeoverOf(low.config).threshold, 0.5);

  const homeHigh = mkHome();
  writeConfig(homeHigh, { takeover: { threshold: 0.95, mode: 'offer' } });
  const high = await loadConfig(envFor(homeHigh));
  assert.equal(high.ok, true);
  if (high.ok) assert.equal(takeoverOf(high.config).threshold, 0.95);
});

test('a threshold outside 0.5 to 0.95, or not a number, fails', async () => {
  for (const bad of [0.4, 0.96, '0.7']) {
    const home = mkHome();
    writeConfig(home, { takeover: { threshold: bad, mode: 'auto' } });
    const result = await loadConfig(envFor(home));
    assert.equal(result.ok, false, `threshold ${JSON.stringify(bad)} must fail`);
    if (!result.ok) {
      assert.ok(result.error.includes('takeover'), `error mentions takeover: ${result.error}`);
    }
  }
});

test('a takeover mode outside auto and offer fails', async () => {
  const home = mkHome();
  writeConfig(home, { takeover: { threshold: 0.7, mode: 'sometimes' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});

test('an unknown key inside takeover fails', async () => {
  const home = mkHome();
  writeConfig(home, { takeover: { bogus: 1 } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});

test('a non-object takeover fails', async () => {
  const home = mkHome();
  writeConfig(home, { takeover: 3 });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});

test('a missing retry key normalises to true', async () => {
  // The C28 shape without the key at all: the accessor defaults per key and
  // the WingmanConfig interface itself is not widened.
  const legacy = { mode: 'on' } as unknown as WingmanConfig;
  assert.deepEqual(takeoverOf(legacy), { threshold: 0.7, mode: 'auto', retry: true });
  // A written config that predates `retry`.
  const home = mkHome();
  writeConfig(home, { takeover: { threshold: 0.8, mode: 'auto' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(takeoverOf(result.config).retry, true);
    assert.equal(takeoverOf(result.config).threshold, 0.8);
  }
});

test('retry false loads', async () => {
  const home = mkHome();
  writeConfig(home, { takeover: { retry: false } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    const t = takeoverOf(result.config);
    assert.equal(t.retry, false);
    assert.equal(t.threshold, 0.7, 'sibling keys still default');
  }
});

test('a non-boolean retry fails', async () => {
  const home = mkHome();
  writeConfig(home, { takeover: { retry: 'yes' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, false);
});
