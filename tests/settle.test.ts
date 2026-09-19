import test from 'node:test';
import assert from 'node:assert/strict';
import { settleByProbe } from '../src/core/settle.js';

test('settles after three stable polls', async () => {
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return { readyState: 'complete', sig: 'stable-sig' };
  };

  const result = await settleByProbe(probe, 2000);
  assert.strictEqual(result.settled, true);
  assert.ok(calls >= 3);
  assert.ok(result.ms < 2000);
});

test('null probes reset stability', async () => {
  let call = 0;
  const probe = async () => {
    call += 1;
    if (call === 3) return null; // resets stability right before it would settle
    return { readyState: 'complete', sig: 'sig-a' };
  };

  const result = await settleByProbe(probe, 3000);
  // The reset at call 3 means three MORE consecutive stable polls (calls
  // 4, 5, 6) are needed before it settles, well inside the 3 s budget.
  assert.strictEqual(result.settled, true);
  assert.ok(call >= 6);
});

test('returns settled false when the budget runs out', async () => {
  const probe = () => new Promise<{ readyState: string; sig: string } | null>(() => {}); // never resolves

  const start = Date.now();
  const result = await settleByProbe(probe, 400);
  const elapsed = Date.now() - start;
  assert.strictEqual(result.settled, false);
  assert.ok(elapsed >= 380 && elapsed < 2000, `elapsed=${elapsed}`);
});

test('a rejecting probe is treated as not answering, never an unhandled rejection', async () => {
  let calls = 0;
  const probe = async () => {
    calls += 1;
    if (calls > 2) throw new Error('context gone');
    return { readyState: 'complete', sig: 'sig' };
  };
  const result = await settleByProbe(probe, 400);
  assert.strictEqual(result.settled, false);
  assert.ok(calls >= 3);
});
