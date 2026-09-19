import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEndpoint } from '../src/browser/acquire.js';

test('WINGMAN_CDP_ENDPOINT wins', async () => {
  const env = { WINGMAN_CDP_ENDPOINT: 'http://127.0.0.1:1111', PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:2222' };
  let probeCalled = false;
  const result = await resolveEndpoint(env, { port: 9222 }, { probeVersion: async () => { probeCalled = true; return null; } });
  assert.deepEqual(result, { endpoint: 'http://127.0.0.1:1111', source: 'WINGMAN_CDP_ENDPOINT' });
  assert.equal(probeCalled, false);
});

test('PLAYWRIGHT_MCP_CDP_ENDPOINT is second', async () => {
  const env = { PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:2222' };
  const result = await resolveEndpoint(env, { port: 9222 }, { probeVersion: async () => null });
  assert.deepEqual(result, { endpoint: 'http://127.0.0.1:2222', source: 'PLAYWRIGHT_MCP_CDP_ENDPOINT' });
});

test('probe is third', async () => {
  const env = {};
  const result = await resolveEndpoint(env, { port: 9222 }, { probeVersion: async () => ({ Browser: 'Chrome' }) });
  assert.deepEqual(result, { endpoint: 'http://127.0.0.1:9222', source: 'probe' });
});

test('nothing answering returns null and never launches', async () => {
  const env = {};
  let spawnCalls = 0;
  const result = await resolveEndpoint(env, { port: 9222 }, { probeVersion: async () => null });
  assert.equal(result, null);
  assert.equal(spawnCalls, 0);
});
