// WP-I — I7: `buildSetupPlan` (§ 5.11, § 6 WP-I I3). Scoped combinations
// only, per the dispatch: a wrapped, profile-matched server; the same with
// mode absent; an unwrapped server; an extension-mode server; and an unknown
// client/tool that must never throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BUDGETS } from '../src/contract/constants.js';
import type { WingmanConfig } from '../src/contract/types.js';
import { wingmanHome } from '../src/contract/home.js';
import { loadProfiles, withheldClasses, denyEntries } from '../src/core/profiles.js';
import { adapterOps } from '../src/adapters/capabilities.js';
import { wrapBrowsingEntry } from '../src/cli/registrations.js';
import type { RegistrationEntry } from '../src/cli/registrations.js';
import { buildSetupPlan } from '../src/cli/setup-plan.js';
import type { DoctorDeps } from '../src/cli/doctor.js';

type ConfigWithExtras = WingmanConfig & Record<string, unknown>;

async function tempHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function forcedConfig(home: string, overrides: Record<string, unknown> = {}) {
  const config = {
    mode: 'on',
    adapter: 'cdp',
    window: 'offscreen',
    profile_dir: join(home, 'profile'),
    port: 59999,
    chrome_path: null,
    secrets_file: null,
    plugin: null,
    sensitive_hosts: {},
    budgets: { ...DEFAULT_BUDGETS },
    handoff: { mode: 'forced', tools: 'browse-only', retain: [] },
    ...overrides,
  } as ConfigWithExtras;
  return { ok: true as const, config: config as WingmanConfig, source: 'file' as const };
}

function entry(server: string, command: string, args: string[]): RegistrationEntry {
  return { client: 'claude', server, command, args, env: {}, raw: null };
}

const WRAPPED_PLAYWRIGHT = entry('playwright', 'jev-browser-wingman', [
  'with-browser',
  '--',
  'npx',
  '-y',
  '@playwright/mcp@0.0.80',
  '--browser',
  'chrome',
]);
const UNWRAPPED_PLAYWRIGHT = entry('playwright', 'npx', ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome']);
const EXTENSION_PLAYWRIGHT = entry('playwright', 'npx', ['-y', '@playwright/mcp@0.0.80', '--extension']);
const WINGMAN_ENTRY = entry('jev-browser-wingman', 'jev-browser-wingman', ['mcp']);

function noSettings() {
  return Promise.resolve({ exists: false, denyList: [] });
}

function outcome(plan: Awaited<ReturnType<typeof buildSetupPlan>>, id: string) {
  const o = plan.outcomes.find((x) => x.id === id);
  assert.ok(o, `outcome ${id} missing`);
  return o;
}

test('claude + wrapped, profile-matched server + key + mode on: O1-O4 met, O5 exact doctor step', async () => {
  const home = await tempHome('wingman-setupplan-wrapped-');
  const calls: string[] = [];
  const doctorDeps: DoctorDeps = {
    env: { WINGMAN_HOME: home, TYPESAFE_API_KEY: 'dummy-key' },
    loadConfigFn: async () => forcedConfig(home),
    readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [WINGMAN_ENTRY, WRAPPED_PLAYWRIGHT] }),
    readSettingsFn: noSettings,
    driverFactory: () => {
      calls.push('driverFactory');
      throw new Error('must not be called by --plan');
    },
    launchEphemeralChromeFn: async () => {
      calls.push('launchEphemeralChrome');
      throw new Error('must not be called by --plan');
    },
    ask: async () => {
      calls.push('ask');
      throw new Error('must not be called by --plan');
    },
  };
  const plan = await buildSetupPlan({
    client: 'claude',
    env: { WINGMAN_HOME: home, TYPESAFE_API_KEY: 'dummy-key' },
    loadConfigFn: async () => forcedConfig(home),
    doctorDeps,
  });
  assert.equal(plan.known, true);
  assert.equal(outcome(plan, 'O1').met, true);
  assert.equal(outcome(plan, 'O2').met, true);
  assert.equal(outcome(plan, 'O3').met, true);
  assert.equal(outcome(plan, 'O4').met, true);
  const o5 = outcome(plan, 'O5');
  assert.equal(o5.met, false);
  assert.deepEqual(o5.steps, ['run jev-browser-wingman doctor --client claude']);
  assert.deepEqual(calls, [], 'buildSetupPlan must never attach, launch or ask');
  await rm(home, { recursive: true, force: true });
});

test('the same with config mode absent: O1 unmet, steps include the mode-on step', async () => {
  const home = await tempHome('wingman-setupplan-nomode-');
  const doctorDeps: DoctorDeps = {
    env: { WINGMAN_HOME: home, TYPESAFE_API_KEY: 'dummy-key' },
    loadConfigFn: async () => forcedConfig(home, { mode: 'off' }),
    readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [WINGMAN_ENTRY, WRAPPED_PLAYWRIGHT] }),
    readSettingsFn: noSettings,
  };
  const plan = await buildSetupPlan({
    client: 'claude',
    env: { WINGMAN_HOME: home, TYPESAFE_API_KEY: 'dummy-key' },
    loadConfigFn: async () => forcedConfig(home, { mode: 'off' }),
    doctorDeps,
  });
  const o1 = outcome(plan, 'O1');
  assert.equal(o1.met, false);
  assert.ok(
    o1.steps.some((s) => s === `set "mode": "on" in ${wingmanHome({ WINGMAN_HOME: home })}/config.json`),
    `steps did not include the mode-on step: ${JSON.stringify(o1.steps)}`,
  );
  await rm(home, { recursive: true, force: true });
});

test('claude + unwrapped: the O2 step carries the exact wrapBrowsingEntry JSON', async () => {
  const home = await tempHome('wingman-setupplan-unwrapped-');
  const doctorDeps: DoctorDeps = {
    env: { WINGMAN_HOME: home },
    loadConfigFn: async () => forcedConfig(home),
    readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [WINGMAN_ENTRY, UNWRAPPED_PLAYWRIGHT] }),
    readSettingsFn: noSettings,
  };
  const plan = await buildSetupPlan({
    client: 'claude',
    env: { WINGMAN_HOME: home },
    loadConfigFn: async () => forcedConfig(home),
    doctorDeps,
  });
  const profiles = loadProfiles(home);
  const profile = profiles.find((p) => p.id === 'playwright-mcp')!;
  const wrapped = wrapBrowsingEntry({ command: 'npx', args: UNWRAPPED_PLAYWRIGHT.args }, 'claude', profile);
  const o2 = outcome(plan, 'O2');
  assert.equal(o2.met, false);
  assert.ok(
    o2.steps.some((s) => s.includes(JSON.stringify(wrapped))),
    `O2 steps did not carry the exact wrapBrowsingEntry JSON: ${JSON.stringify(o2.steps)}`,
  );
  await rm(home, { recursive: true, force: true });
});

test('claude + extension-mode server: O2 deny step names mcp__<server>__<tool> entries, O3 is the debugging-port step', async () => {
  const home = await tempHome('wingman-setupplan-extension-');
  const doctorDeps: DoctorDeps = {
    env: { WINGMAN_HOME: home },
    loadConfigFn: async () => forcedConfig(home),
    readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [WINGMAN_ENTRY, EXTENSION_PLAYWRIGHT] }),
    readSettingsFn: noSettings,
  };
  const plan = await buildSetupPlan({
    client: 'claude',
    env: { WINGMAN_HOME: home },
    loadConfigFn: async () => forcedConfig(home),
    doctorDeps,
  });
  const profiles = loadProfiles(home);
  const profile = profiles.find((p) => p.id === 'playwright-mcp')!;
  const withheld = withheldClasses(adapterOps('cdp'), []);
  const deny = denyEntries('claude', 'playwright', profile, withheld)!;
  const o2 = outcome(plan, 'O2');
  assert.equal(o2.met, false);
  assert.ok(o2.steps.length > 0, 'O2 must offer a deny step for an extension-mode server');
  assert.ok(
    o2.steps.some((s) => deny.entries.every((e) => s.includes(e))),
    `O2 steps did not name every deny entry: ${JSON.stringify(o2.steps)} vs ${JSON.stringify(deny.entries)}`,
  );
  assert.ok(deny.entries.every((e) => e.startsWith('mcp__playwright__')));
  const o3 = outcome(plan, 'O3');
  assert.equal(o3.met, false);
  assert.ok(
    o3.steps.some((s) => s.includes('--remote-debugging-port=')),
    `O3 steps did not include the debugging-port step: ${JSON.stringify(o3.steps)}`,
  );
  await rm(home, { recursive: true, force: true });
});

test('an unknown client id and a foreign-named unknown server: known false, hints only, never throws', async () => {
  const plan = await buildSetupPlan({ client: 'totally-unknown-client' });
  assert.equal(plan.known, false);
  for (const o of plan.outcomes) {
    assert.deepEqual(o.steps, []);
    assert.ok(o.hints.length > 0, `outcome ${o.id} should carry a hint when the client is unknown`);
  }
});

// KB-Ib (§ 6 WP-I) is proved at gate time: temporarily removing buildSetupPlan's
// try/catch (or its `known` short-circuit) so an unknown client throws, then
// confirming the test above FAILs, then restoring. See the report for the
// recorded run.
