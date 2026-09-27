import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEndpoint } from '../src/browser/acquire.js';
import type { Profile } from '../src/core/profiles.js';

function profileWith(endpointEnv: string | null): Profile {
  return {
    id: 'test-tool',
    description: 'test profile',
    detect: { args_contain: [], extension_flags: [], endpoint_flags: [] },
    launch: { endpoint_env: endpointEnv, endpoint_arg: null, strip_args: [] },
    match_tools: ['some_tool'],
    tools: {},
    arg_rules: [],
  };
}

test('WINGMAN_CDP_ENDPOINT wins over everything', async () => {
  const env = { WINGMAN_CDP_ENDPOINT: 'http://127.0.0.1:1111', MY_TOOL_ENDPOINT: 'http://127.0.0.1:3333' };
  let probeCalled = false;
  const result = await resolveEndpoint(
    env,
    { port: 9222 },
    {
      probeVersion: async () => {
        probeCalled = true;
        return null;
      },
      loadProfiles: () => [profileWith('MY_TOOL_ENDPOINT')],
    },
  );
  assert.deepEqual(result, { endpoint: 'http://127.0.0.1:1111', source: 'WINGMAN_CDP_ENDPOINT' });
  assert.equal(probeCalled, false);
});

test('an endpoint env declared by a loaded profile is honoured with source = that name', async () => {
  const env = { MY_TOOL_ENDPOINT: 'http://127.0.0.1:3333' };
  let profilesHome = '';
  const result = await resolveEndpoint(env, { port: 9222 }, {
    probeVersion: async () => null,
    loadProfiles: (home) => {
      profilesHome = home;
      return [profileWith('MY_TOOL_ENDPOINT')];
    },
  });
  assert.deepEqual(result, { endpoint: 'http://127.0.0.1:3333', source: 'MY_TOOL_ENDPOINT' });
  assert.equal(typeof profilesHome, 'string');
  assert.ok(profilesHome.length > 0);
});

test('profile endpoint envs are consulted in load order: the first present wins', async () => {
  const env = { SECOND_ENDPOINT: 'http://127.0.0.1:4444' };
  const result = await resolveEndpoint(env, { port: 9222 }, {
    probeVersion: async () => null,
    loadProfiles: () => [profileWith('FIRST_ENDPOINT'), profileWith('SECOND_ENDPOINT')],
  });
  assert.deepEqual(result, { endpoint: 'http://127.0.0.1:4444', source: 'SECOND_ENDPOINT' });
});

test('an endpoint env no profile declares is ignored: the probe answers instead', async () => {
  const env = { PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:2222' };
  const result = await resolveEndpoint(env, { port: 9222 }, {
    probeVersion: async () => ({ Browser: 'Chrome' }),
    loadProfiles: () => [],
  });
  assert.deepEqual(result, { endpoint: 'http://127.0.0.1:9222', source: 'probe' });
});

test('probe is the fallback', async () => {
  const env = {};
  const result = await resolveEndpoint(env, { port: 9222 }, {
    probeVersion: async () => ({ Browser: 'Chrome' }),
    loadProfiles: () => [],
  });
  assert.deepEqual(result, { endpoint: 'http://127.0.0.1:9222', source: 'probe' });
});

test('nothing answering returns null and never launches', async () => {
  const env = {};
  let spawnCalls = 0;
  const result = await resolveEndpoint(env, { port: 9222 }, {
    probeVersion: async () => null,
    loadProfiles: () => [],
  });
  assert.equal(result, null);
  assert.equal(spawnCalls, 0);
});
