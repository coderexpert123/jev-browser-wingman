// WP-T1a required tests (§ 4 WP-T1a): takeover contract additions, the
// takeover config block (§ 3.20) and the routing question set (§ 3.18).
// Helpers are written fresh in this file — helpers stay unimported between
// test files.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REASONS } from '../src/contract/types.js';
import type { ElementRecord, WingmanConfig } from '../src/contract/types.js';
import { DEFAULT_TAKEOVER, TAKEOVER_MODES, TAKEOVER_THRESHOLD_RANGE } from '../src/contract/constants.js';
import { loadConfig, takeoverOf } from '../src/core/config.js';
import {
  UNTRUSTED_SENTENCE,
  ROUTE_HANDLE_INSTRUCTION_BASE,
  ROUTE_EXEC_INSTRUCTION_BASE,
  ROUTE_EXEC_CRITERIA,
  buildRoutingRequest,
} from '../src/core/questions.js';
import { assertNoValues } from '../src/core/withhold.js';

function mkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-takeover-test-'));
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { ...process.env, WINGMAN_HOME: home };
}

function writeConfig(home: string, obj: unknown): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(obj));
}

function mkEl(overrides: Partial<ElementRecord> & { id: string }): ElementRecord {
  return {
    path: `#${overrides.id}`,
    tag: 'button',
    role: 'button',
    name: 'Continue',
    type: '',
    attrName: '',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: false,
    inViewport: true,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    form: -1,
    fingerprint: { tag: 'button', role: 'button', name: 'Continue', x: 0, y: 0 },
    ...overrides,
  } as ElementRecord;
}

test('the takeover reasons exist in REASONS', () => {
  const fallback = REASONS.fallback as readonly string[];
  assert.ok(fallback.includes('route-caller'));
  assert.ok(fallback.includes('takeover-offered'));
  assert.ok((REASONS.ambiguous as readonly string[]).includes('route-unclear'));
  // No existing reason moved: spot-check one from every pre-existing bucket.
  assert.ok((REASONS.done as readonly string[]).includes('goal-met'));
  assert.ok((REASONS.needs_confirmation as readonly string[]).includes('irreversible-heuristic'));
  assert.ok((REASONS.blocked as readonly string[]).includes('lock-held'));
  assert.ok((REASONS.login as readonly string[]).includes('login-page'));
  assert.ok((REASONS.error as readonly string[]).includes('invalid-input'));
  assert.ok(fallback.includes('sensitive-password'));
});

test('takeover config absent means threshold 0.7 and mode auto', async () => {
  assert.deepEqual(DEFAULT_TAKEOVER, { threshold: 0.7, mode: 'auto' });
  assert.deepEqual(TAKEOVER_THRESHOLD_RANGE, [0.5, 0.95]);
  assert.deepEqual([...TAKEOVER_MODES], ['auto', 'offer']);
  const home = mkHome();
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(takeoverOf(result.config), { threshold: 0.7, mode: 'auto' });
  }
});

test('takeover config accepts an explicit threshold and mode', async () => {
  const home = mkHome();
  writeConfig(home, { takeover: { threshold: 0.9, mode: 'offer' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(takeoverOf(result.config), { threshold: 0.9, mode: 'offer' });
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

test('buildRoutingRequest asks handle and exec exactly once per step', () => {
  const steps = ['click the search box', 'press Enter in the search box'];
  const request = buildRoutingRequest({
    state: {},
    steps,
    elements: [mkEl({ id: 'e1' })],
    bindings: {},
  });
  assert.deepEqual(Object.keys(request.questions), ['handle1', 'exec1', 'handle2', 'exec2']);
  assert.equal(request.questions.handle1.type, 'noul');
  assert.equal(request.questions.handle2.type, 'noul');
  const exec1 = request.questions.exec1;
  assert.equal(exec1.type, 'choice');
  if (exec1.type === 'choice') {
    assert.deepEqual(Object.keys(exec1.criteria), ['wingman', 'caller']);
  }
});

test('routing instructions end with the untrusted sentence', () => {
  const request = buildRoutingRequest({
    state: {},
    steps: ['click the search box'],
    elements: [mkEl({ id: 'e1' })],
    bindings: {},
  });
  for (const key of ['handle1', 'exec1']) {
    const q = request.questions[key];
    assert.ok('instructions' in q);
    assert.ok(q.instructions.endsWith(UNTRUSTED_SENTENCE), `${key} ends with the untrusted sentence`);
  }
  // The <step> placeholder is gone and the step text (redacted, cut to 300) is in.
  assert.equal(ROUTE_HANDLE_INSTRUCTION_BASE.includes('<step>'), true);
  assert.equal(ROUTE_EXEC_INSTRUCTION_BASE.includes('<step>'), true);
  const handle1 = request.questions.handle1;
  if ('instructions' in handle1) {
    assert.equal(handle1.instructions.includes('<step>'), false);
    assert.ok(handle1.instructions.includes('click the search box'));
  }
});

test('routing step text is redacted against bindings', () => {
  const bindings = { password: 's3cret-value-42' };
  const step = 'type s3cret-value-42 into the password field';
  const request = buildRoutingRequest({
    state: {},
    steps: [step],
    elements: [mkEl({ id: 'e1', name: 's3cret-value-42' })],
    bindings,
  });
  assertNoValues(JSON.stringify(request), bindings);

  // Known-bad (in-file proof): the same assembly with redactValues skipped
  // leaks the binding value, so the assertion above can fail.
  const unredacted = {
    state: {},
    questions: {
      handle1: {
        type: 'noul',
        instructions: `${ROUTE_HANDLE_INSTRUCTION_BASE.replace('<step>', step)} ${UNTRUSTED_SENTENCE}`,
      },
      exec1: {
        type: 'choice',
        instructions: `${ROUTE_EXEC_INSTRUCTION_BASE.replace('<step>', step)} ${UNTRUSTED_SENTENCE}`,
        criteria: { ...ROUTE_EXEC_CRITERIA },
      },
    },
  };
  assert.throws(() => assertNoValues(JSON.stringify(unredacted), bindings), /value leak/);
});

test('three steps produce six questions in call order', () => {
  const request = buildRoutingRequest({
    state: {},
    steps: ['click the search box', 'type the query', 'press Enter'],
    elements: [mkEl({ id: 'e1' }), mkEl({ id: 'e2' })],
    bindings: {},
  });
  assert.deepEqual(Object.keys(request.questions), [
    'handle1', 'exec1', 'handle2', 'exec2', 'handle3', 'exec3',
  ]);
});

test('takeoverOf reads the loaded config and defaults the missing key', async () => {
  const home = mkHome();
  writeConfig(home, { takeover: { threshold: 0.8, mode: 'offer' } });
  const result = await loadConfig(envFor(home));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(takeoverOf(result.config), { threshold: 0.8, mode: 'offer' });
  }
  // The pre-takeover (C28) shape without the key defaults, and the
  // WingmanConfig interface itself is not widened.
  const legacy = { mode: 'on' } as unknown as WingmanConfig;
  assert.deepEqual(takeoverOf(legacy), DEFAULT_TAKEOVER);
});
