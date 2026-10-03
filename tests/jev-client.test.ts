import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDefaultAsk } from '../src/core/jev-client.js';
import { startTypeSafeStub } from './helpers/typesafe-stub.js';
import type { JevRequest } from '../src/contract/types.js';

const REQUEST: JevRequest = {
  state: { url: 'https://example.com' },
  questions: {
    done: { type: 'noul', instructions: 'done?' },
  },
};

const noSleep = () => Promise.resolve();

test('returns answers on 200', async () => {
  const stub = await startTypeSafeStub(() => ({
    status: 200,
    body: { answers: { done: { noul: 0.7 } }, usage: { input_tokens: 10, output_tokens: 2 } },
  }));
  try {
    const ask = createDefaultAsk({ apiKey: 'k', baseUrl: stub.url, sleep: noSleep });
    const result = await ask(REQUEST, { purpose: 'test' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.answers.done, { type: 'noul', noul: 0.7 });
      assert.equal(result.usage.inputTokens, 10);
      assert.equal(result.usage.outputTokens, 2);
      assert.equal(result.retries, 0);
    }
  } finally {
    await stub.close();
  }
});

test('retries a 500 once then reports http', async () => {
  let calls = 0;
  const stub = await startTypeSafeStub(() => {
    calls += 1;
    return { status: 500, body: { error: 'boom' } };
  });
  try {
    const ask = createDefaultAsk({ apiKey: 'k', baseUrl: stub.url, sleep: noSleep });
    const result = await ask(REQUEST, { purpose: 'test', timeoutMs: 5000 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'http');
      assert.equal(result.status, 500);
      assert.equal(result.retries, 1);
    }
    assert.equal(calls, 2);
  } finally {
    await stub.close();
  }
});

test('honours retry-after-ms on 429', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const stub = await startTypeSafeStub(() => {
    calls += 1;
    if (calls === 1) {
      return { status: 429, headers: { 'retry-after-ms': '17' }, body: { error: 'slow down' } };
    }
    return { status: 200, body: { answers: { done: { noul: 0.4 } }, usage: {} } };
  });
  try {
    const ask = createDefaultAsk({
      apiKey: 'k',
      baseUrl: stub.url,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const result = await ask(REQUEST, { purpose: 'test', timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.deepEqual(sleeps, [17]);
    assert.equal(calls, 2);
  } finally {
    await stub.close();
  }
});

test('invalid answers report invalid-response', async () => {
  const stub = await startTypeSafeStub(() => ({ status: 200, body: { answers: { done: { noul: 'not-a-number' } } } }));
  try {
    const ask = createDefaultAsk({ apiKey: 'k', baseUrl: stub.url, sleep: noSleep });
    const result = await ask(REQUEST, { purpose: 'test' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'invalid-response');
      assert.equal(result.status, 200);
    }
  } finally {
    await stub.close();
  }
});

test('a hung server reports timeout within the budget', async () => {
  const stub = await startTypeSafeStub(() => ({ status: 200, body: { answers: { done: { noul: 0.5 } } }, delayMs: 2000 }));
  try {
    const ask = createDefaultAsk({ apiKey: 'k', baseUrl: stub.url, sleep: noSleep });
    const started = Date.now();
    const result = await ask(REQUEST, { purpose: 'test', timeoutMs: 150 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'timeout');
    assert.ok(elapsed < 1500, `expected timeout well under the 2000ms delay, took ${elapsed}ms`);
  } finally {
    await stub.close();
  }
});

test('sends Bearer auth and the jev-latest model', async () => {
  const stub = await startTypeSafeStub(() => ({ status: 200, body: { answers: { done: { noul: 0.5 } } } }));
  try {
    const ask = createDefaultAsk({ apiKey: 'secret-key', baseUrl: stub.url, sleep: noSleep });
    await ask(REQUEST, { purpose: 'test' });
    assert.equal(stub.requests.length, 1);
    const req = stub.requests[0] as { headers: Record<string, string>; body: { model: string } };
    assert.equal(req.headers.authorization, 'Bearer secret-key');
    assert.equal(req.body.model, 'jev-latest');
  } finally {
    await stub.close();
  }
});

test('the default fetch path reuses one connection across idle-spaced asks (keep-alive)', async () => {
  let connections = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { done: { noul: 0.5 } } }));
    });
  });
  server.on('connection', () => {
    connections += 1;
  });
  // Node's http server defaults keepAliveTimeout to 5 s and advertises a
  // `Keep-Alive: timeout=5` hint — and undici lets the SERVER hint override
  // the client's own configured idle (risk-register R1). keepAliveTimeout 0
  // sends no hint at all, so each client side's own idle governs: the global
  // dispatcher's ~4 s default closes the socket inside the 5 s gap, the
  // configured 55 s agent does not. Without this the test cannot discriminate.
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    // Default path (no fetchFn): the shared keep-alive agent applies. The 5 s
    // gap sits above undici's ~4 s default idle timeout (a pre-change global
    // dispatcher closes the socket and pays a second TCP setup) and well
    // below the configured 55 s.
    const ask = createDefaultAsk({ apiKey: 'k', baseUrl: `http://127.0.0.1:${address.port}` });
    const first = await ask(REQUEST, { purpose: 'test' });
    assert.equal(first.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const second = await ask(REQUEST, { purpose: 'test' });
    assert.equal(second.ok, true);
    assert.equal(connections, 1, `expected one TCP connection for both asks, saw ${connections}`);
  } finally {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('fetchFn callers are unaffected: the captured init carries no dispatcher key', async () => {
  let captured: Record<string, unknown> | undefined;
  const fetchFn = (async (_url: unknown, init?: unknown) => {
    captured = (init ?? {}) as Record<string, unknown>;
    return new Response(JSON.stringify({ answers: { done: { noul: 0.5 } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const ask = createDefaultAsk({ apiKey: 'k', fetchFn });
  const result = await ask(REQUEST, { purpose: 'test' });
  assert.equal(result.ok, true);
  assert.ok(captured, 'fetchFn was never called');
  assert.equal('dispatcher' in captured, false);
});
