import test from 'node:test';
import assert from 'node:assert/strict';
import { originPath, buildState, buildLogRecord } from '../src/core/egress.js';
import type { Budgets } from '../src/contract/types.js';

const budgets: Budgets = {
  max_steps: 8,
  max_ms: 45_000,
  jev_timeout_ms: 10_000,
  max_elements: 240,
  max_text_chars: 3_000,
  max_state_chars: 24_000,
};

test('state carries origin and path but no query or fragment', () => {
  assert.equal(originPath('https://example.com/a/b?x=1#frag'), 'https://example.com/a/b');
  assert.equal(originPath('chrome://settings'), 'chrome:');
  const result = buildState(
    {
      goal: 'do the thing',
      url: 'https://example.com/checkout?token=secret123#step2',
      title: 'Checkout',
      text: 'hello world',
      history: [],
      bindings: {},
      round: 0,
    },
    budgets,
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  const state = result.state as { page: { location: string } };
  assert.equal(state.page.location, 'https://example.com/checkout');
  const json = JSON.stringify(state);
  assert.ok(!json.includes('token=secret123'));
  assert.ok(!json.includes('step2'));
});

test('state never contains a binding value even when page text echoes it', () => {
  const result = buildState(
    {
      goal: 'goal',
      url: 'https://example.com/form',
      title: 'Form',
      text: 'You entered Ada Lovelace as your name.',
      history: [],
      bindings: { fullname: 'Ada Lovelace' },
      round: 1,
    },
    budgets,
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  const json = JSON.stringify(result.state);
  assert.ok(!json.includes('Ada Lovelace'));
  assert.ok(json.includes('<value:fullname>'));
});

test('text is cut to max_text_chars', () => {
  const longText = 'a'.repeat(5_000);
  const result = buildState(
    {
      goal: 'goal',
      url: 'https://example.com/page',
      title: 'Page',
      text: longText,
      history: [],
      bindings: {},
      round: 0,
    },
    budgets,
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  const state = result.state as { text: string };
  assert.equal(state.text.length, budgets.max_text_chars);
  assert.ok(state.text.endsWith('…'));
});

test('an oversized state shrinks text first then reports ok false', () => {
  const smallButFits: Budgets = { ...budgets, max_text_chars: 3_000, max_state_chars: 500 };
  const shrinkResult = buildState(
    {
      goal: 'g',
      url: 'https://example.com/p',
      title: 't',
      text: 'x'.repeat(2_000),
      history: [],
      bindings: {},
      round: 0,
    },
    smallButFits,
  );
  assert.ok(shrinkResult.ok);
  if (shrinkResult.ok) {
    assert.ok(JSON.stringify(shrinkResult.state).length <= 500);
    const state = shrinkResult.state as { text: string };
    assert.ok(state.text.length < 2_000);
  }

  const tooSmall: Budgets = { ...budgets, max_text_chars: 3_000, max_state_chars: 10 };
  const failResult = buildState(
    {
      goal: 'g',
      url: 'https://example.com/p',
      title: 't',
      text: 'x'.repeat(2_000),
      history: [],
      bindings: {},
      round: 0,
    },
    tooSmall,
  );
  assert.equal(failResult.ok, false);
});

test('log record has exactly the WingmanLogRecord keys', () => {
  const record = buildLogRecord({
    tool: 'wingman_do',
    mode: 'on',
    adapter: 'playwright',
    status: 'done',
    reason: 'goal-met',
    steps: 3,
    host: 'example.com',
    gateHits: 1,
    jevCalls: 2,
    inputTokens: 100,
    outputTokens: 50,
    ms: 1234,
  });
  assert.deepEqual(
    Object.keys(record).sort(),
    ['adapter', 'gate_hits', 'host', 'input_tokens', 'jev_calls', 'ms', 'mode', 'output_tokens', 'reason', 'status', 'steps', 'tool', 'ts'].sort(),
  );
});

test('log record carries no path, title, label, value or page text', () => {
  const record = buildLogRecord({
    tool: 'wingman_do',
    mode: 'shadow',
    adapter: 'cdp',
    status: 'blocked',
    reason: 'dialog-open',
    steps: 1,
    host: 'MARKER_HOST',
    gateHits: 0,
    jevCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    ms: 5,
    would: { verb: 'click', role: 'button' },
  });
  const json = JSON.stringify(record);
  for (const forbidden of [
    'MARKER_PATH',
    'MARKER_TITLE',
    'MARKER_LABEL',
    'MARKER_VALUE',
    'MARKER_PAGE_TEXT',
  ]) {
    assert.ok(!json.includes(forbidden));
  }
  assert.ok(json.includes('MARKER_HOST'));
});
