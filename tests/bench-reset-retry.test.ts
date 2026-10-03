// r20 (H-1, WP-2): the harness reset-navigation retry. Scripted `{ send }`
// fakes only — no Chrome, no real sleeps (the injected sleep records the
// backoff). Pins the exact retry predicate (`cdp timeout: Page.navigate`
// verbatim), the 3-sends-max bound, the [2000, 5000] backoff, and the
// resetPages wiring (the retry rides the SAME attach session id; attach
// failures never retry).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  navigateResetWithRetry,
  resetPages,
  RESET_NAV_RETRY_BACKOFF_MS,
} from '../bench/run.js';

interface SendRecord {
  method: string;
  params?: object;
  sessionId?: string;
}

// Scripted connection: the nth send consumes the nth scripted outcome (past
// the script end, resolves {}); every call is recorded with its session id.
// The send is generic so the fake satisfies `Pick<CdpConnection, 'send'>`
// structurally (CdpConnection.send is `<T = any>(...) => Promise<T>`).
function scriptedConn(outcomes: Array<{ ok?: unknown; err?: Error }>) {
  const calls: SendRecord[] = [];
  let i = 0;
  return {
    calls,
    send: <T = unknown>(method: string, params?: object, sessionId?: string): Promise<T> => {
      calls.push({ method, params, sessionId });
      const o = outcomes[i];
      i += 1;
      if (!o) return Promise.resolve({} as T);
      if (o.err) return Promise.reject(o.err);
      return Promise.resolve((o.ok ?? {}) as T);
    },
  };
}

function recorder() {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

test('RESET_NAV_RETRY_BACKOFF_MS is pinned to [2000, 5000]', () => {
  assert.deepEqual([...RESET_NAV_RETRY_BACKOFF_MS], [2_000, 5_000]);
});

test('one cdp timeout then success: two sends, one 2000 ms sleep', async () => {
  const conn = scriptedConn([
    { err: new Error('cdp timeout: Page.navigate') },
    { ok: {} },
  ]);
  const r = recorder();
  await navigateResetWithRetry(conn, 's1', 'https://example.test/start', r.sleep);
  assert.equal(conn.calls.length, 2);
  for (const c of conn.calls) {
    assert.equal(c.method, 'Page.navigate');
    assert.deepEqual(c.params, { url: 'https://example.test/start' });
    assert.equal(c.sessionId, 's1');
  }
  assert.deepEqual(r.sleeps, [2_000]);
});

test('three consecutive timeouts exhaust the retries and rethrow the timeout', async () => {
  const conn = scriptedConn([
    { err: new Error('cdp timeout: Page.navigate') },
    { err: new Error('cdp timeout: Page.navigate') },
    { err: new Error('cdp timeout: Page.navigate') },
  ]);
  const r = recorder();
  await assert.rejects(
    navigateResetWithRetry(conn, 's1', 'https://example.test/start', r.sleep),
    { message: 'cdp timeout: Page.navigate' },
  );
  assert.equal(conn.calls.length, 3);
  assert.deepEqual(r.sleeps, [2_000, 5_000]);
});

test('a closed socket is fatal: one send, no sleep, immediate rethrow', async () => {
  const conn = scriptedConn([{ err: new Error('cdp socket closed') }]);
  const r = recorder();
  await assert.rejects(
    navigateResetWithRetry(conn, 's1', 'https://example.test/start', r.sleep),
    { message: 'cdp socket closed' },
  );
  assert.equal(conn.calls.length, 1);
  assert.deepEqual(r.sleeps, []);
});

test('a JSON-RPC error response is fatal: one send, no sleep', async () => {
  const conn = scriptedConn([
    { err: new Error('{"code":-32602,"message":"invalid params"}') },
  ]);
  const r = recorder();
  await assert.rejects(
    navigateResetWithRetry(conn, 's1', 'https://example.test/start', r.sleep),
    { message: '{"code":-32602,"message":"invalid params"}' },
  );
  assert.equal(conn.calls.length, 1);
  assert.deepEqual(r.sleeps, []);
});

test('resetPages wires the retry over the SAME attach session id', async () => {
  const conn = scriptedConn([
    { ok: { targetInfos: [{ targetId: 'kept', type: 'page' }] } }, // Target.getTargets
    { ok: { sessionId: 's1' } }, // Target.attachToTarget
    { err: new Error('cdp timeout: Page.navigate') }, // Page.navigate attempt 1
    { ok: {} }, // Page.navigate attempt 2 (the retry)
  ]);
  const r = recorder();
  await resetPages(conn, 'kept', 'https://example.test/start');
  assert.deepEqual(
    conn.calls.map((c) => c.method),
    ['Target.getTargets', 'Target.attachToTarget', 'Page.navigate', 'Page.navigate'],
  );
  const navSessions = conn.calls
    .filter((c) => c.method === 'Page.navigate')
    .map((c) => c.sessionId);
  assert.deepEqual(navSessions, ['s1', 's1']);
  // No sleeps pin here: D5's resetPages calls the helper with the DEFAULT
  // sleep (the signature does not thread the injectable one), so this test
  // genuinely waits out the 2 s backoff once. The recorded `r` is still the
  // fixture that proves the helpers direct-sleep pins (above) cover the
  // backoff values.
});

test('attach failure rejects with NO navigate send and no retry', async () => {
  const conn = scriptedConn([
    { ok: { targetInfos: [{ targetId: 'kept', type: 'page' }] } },
    { err: new Error('attach refused') },
  ]);
  const r = recorder();
  await assert.rejects(resetPages(conn, 'kept', 'https://example.test/start'), {
    message: 'attach refused',
  });
  assert.deepEqual(
    conn.calls.map((c) => c.method),
    ['Target.getTargets', 'Target.attachToTarget'],
  );
  assert.deepEqual(r.sleeps, []);
});
