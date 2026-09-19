import test from 'node:test';
import assert from 'node:assert/strict';
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
