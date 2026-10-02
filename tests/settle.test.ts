import test from 'node:test';
import assert from 'node:assert/strict';
import { settleByProbe, waitForScrollGrowth, type SettleClock, type ScrollGrowthSnapshot } from '../src/core/settle.js';

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

// ---- r17c (D-B): waitForScrollGrowth — injected clock, no real sleeps ----

/** A fake SettleClock whose sleep() advances virtual time by the slept amount
 * and resolves on a macrotask, so a wait that runs its full budget does so in
 * zero real wall time. Two properties the raced-poll shape needs:
 * (1) the raced sleep never beats an already-answered probe — the probe's
 * microtasks settle the Promise.race first, the sleep resolves later;
 * (2) only the NEWEST pending sleep records (a superseded raced sleep is
 * abandoned by the wait's next poll sleep, and must not advance the clock or
 * pollute `sleeps`). `sleeps` records every recorded sleep duration. */
function fakeClock(): SettleClock & { sleeps: number[] } {
  let vt = 0;
  const sleeps: number[] = [];
  let pending: Array<{ record: boolean }> = [];
  return {
    sleeps,
    now: () => vt,
    sleep: (ms: number): Promise<void> =>
      new Promise((resolve) => {
        for (const p of pending) p.record = false;
        pending = [];
        const entry = { record: true };
        pending.push(entry);
        setTimeout(() => {
          if (entry.record) {
            sleeps.push(ms);
            vt += ms;
          }
          pending = pending.filter((p) => p !== entry);
          resolve();
        }, 0);
      }),
  };
}

const BASELINE: ScrollGrowthSnapshot = { scrollY: 0, growth: '10:20' };

test('waitForScrollGrowth returns changed true on the first differing probe', async () => {
  const clock = fakeClock();
  const result = await waitForScrollGrowth(
    async () => ({ scrollY: 600, growth: '10:20' }),
    BASELINE,
    1_500,
    clock,
  );
  assert.deepStrictEqual(result, { changed: true, ms: 0 });
  assert.equal(clock.sleeps.length, 0, 'no sleep before the first answered probe');
});

test('waitForScrollGrowth returns changed false at the budget when the probe never differs', async () => {
  const clock = fakeClock();
  const result = await waitForScrollGrowth(async () => BASELINE, BASELINE, 1_500, clock);
  assert.deepStrictEqual(result, { changed: false, ms: 1_500 });
  // Every poll interval is the 200 ms poll cap (the last slice may be smaller)
  // and the sleeps sum to the budget exactly.
  assert.ok(clock.sleeps.length >= 2, `polled more than once: ${JSON.stringify(clock.sleeps)}`);
  for (const s of clock.sleeps.slice(0, -1)) {
    assert.equal(s, 200, `each full poll interval is the poll cap, got ${s}`);
  }
  const total = clock.sleeps.reduce((a, b) => a + b, 0);
  assert.equal(total, 1_500, `sleeps sum to the budget, got ${total}`);
});

test('a rejected probe counts as no answer and the wait continues to the budget', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await waitForScrollGrowth(
    async () => {
      calls += 1;
      throw new Error('context gone');
    },
    BASELINE,
    1_500,
    clock,
  );
  assert.deepStrictEqual(result, { changed: false, ms: 1_500 });
  assert.ok(calls >= 2, `the probe was re-polled after rejections, calls=${calls}`);
});
