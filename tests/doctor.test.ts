// WP-F2: doctor tests (§ 3.10 known-bad column + the clean nine-pass setup).
//
// The two tests that assert on runDoctor's stdout spawn a child process
// running a wrapper script: patching process.stdout.write in-process steals
// the node:test reporter's own writes (its flushes land inside the capture
// window), which makes the --test parent lose whole subtests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGETS } from '../src/contract/constants.js';
import { DOCTOR_CHECK_IDS } from '../src/contract/types.js';
import type { DoctorCheckId, DoctorReport, SensitiveHostCategory, WingmanConfig } from '../src/contract/types.js';
import { defaultUserDataDir } from '../src/browser/chrome.js';
import { BUILTIN_HOSTS } from '../src/core/policy-data.js';
import { createDefaultAsk } from '../src/core/jev-client.js';
import { resolveEndpoint } from '../src/browser/acquire.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { createCdpDriver } from '../src/adapters/cdp.js';
import { launchTestChrome } from './helpers/chrome.js';
import { startTypeSafeStub } from './helpers/typesafe-stub.js';
import { closePageOnDetach, injectGlobal, createContextOnAttach } from './helpers/known-bad-drivers.js';
import { runDoctor, type DoctorDeps, type ClientSettingsResult } from '../src/cli/doctor.js';
import type { RegistrationEntry } from '../src/cli/registrations.js';
import { loadProfiles, withheldClasses, denyEntries } from '../src/core/profiles.js';
import { adapterOps } from '../src/adapters/capabilities.js';

const buildRoot = join(fileURLToPath(import.meta.url), '..', '..');

const DOCTOR_WRAPPER = `
import { runDoctor } from ${JSON.stringify('file:///' + join(buildRoot, 'src', 'cli', 'doctor.js').replace(/\\/g, '/'))};

const config = {
  mode: 'on', adapter: 'cdp', window: 'offscreen',
  profile_dir: ${JSON.stringify(join(tmpdir(), 'wingman-doctor-profile-stub'))},
  port: 59999, chrome_path: null, secrets_file: null, plugin: null,
  sensitive_hosts: {},
  budgets: ${JSON.stringify(DEFAULT_BUDGETS)},
};
const stubs = {
  env: {},
  loadConfigFn: async () => ({ ok: true, config, source: 'file' }),
  readRegistrationsFn: async () => ({ file: 'fixture', exists: false, entries: [] }),
  probeVersionFn: async () => null,
  profileHoldersFn: async () => ({ withPort: [], withoutPort: [] }),
};
const scenario = process.argv[2];
if (scenario === 'key-present') {
  config.secrets_file = process.argv[3] || null;
  await runDoctor({ json: false }, stubs);
} else if (scenario === 'key-missing') {
  await runDoctor({ json: false }, stubs);
} else if (scenario === 'json') {
  await runDoctor({ json: true }, stubs);
}
process.exit(0);
`;

const scratch = await mkdtemp(join(tmpdir(), 'wingman-doctor-'));
const wrapperPath = join(scratch, 'doctor-wrapper.mjs');
await writeFile(wrapperPath, DOCTOR_WRAPPER, 'utf8');

function runWrapper(scenario: string, secretsFile?: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, scenario, ...(secretsFile ? [secretsFile] : [])], {
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Ephemeral Chrome launch with a retry: a cold machine can miss the 15 s
 * DevToolsActivePort window; a retry does not weaken any assertion below. */
async function launchWithRetry(): Promise<Awaited<ReturnType<typeof launchTestChrome>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await launchTestChrome();
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

function checkOf(report: DoctorReport, id: DoctorCheckId) {
  const hit = report.checks.find((c) => c.id === id);
  assert.ok(hit, `check ${id} missing from report`);
  return hit;
}

/** A free TCP port (bound once, then released). */
async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function stubConfig(overrides: Partial<WingmanConfig> = {}): { ok: true; config: WingmanConfig; source: 'file' } {
  return {
    ok: true,
    config: {
      mode: 'on',
      adapter: 'cdp',
      window: 'offscreen',
      profile_dir: join(tmpdir(), 'wingman-doctor-profile-stub'),
      port: 59999,
      chrome_path: null,
      secrets_file: null,
      plugin: null,
      sensitive_hosts: {},
      budgets: { ...DEFAULT_BUDGETS },
      ...overrides,
    },
    source: 'file',
  };
}

function baseDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: {},
    loadConfigFn: async () => stubConfig(),
    readRegistrationsFn: async () => ({ file: 'fixture', exists: false, entries: [] }),
    probeVersionFn: async () => null,
    profileHoldersFn: async () => ({ withPort: [], withoutPort: [] }),
    ...overrides,
  };
}

test('key-present fails with no key and never prints a planted key', async () => {
  // FAIL status with no key anywhere.
  const failReport = await runDoctor({ json: false }, baseDeps());
  assert.equal(checkOf(failReport, 'key-present').status, 'FAIL');

  // PASS via secrets_file; the child-process output must not contain the key.
  const home = await tempDir('wingman-doctor-key-');
  const secretsFile = join(home, 'secrets.env');
  await writeFile(secretsFile, 'TYPESAFE_API_KEY=planted-secret-abc123\n');
  const passRun = await runWrapper('key-present', secretsFile);
  assert.equal(passRun.code, 0);
  assert.match(passRun.stdout, /PASS key-present/);
  assert.match(passRun.stdout, /source=secrets_file/);
  assert.ok(!passRun.stdout.includes('planted-secret-abc123'), 'the key leaked into doctor output');

  const missingRun = await runWrapper('key-missing');
  assert.match(missingRun.stdout, /FAIL key-present/);
  await rm(home, { recursive: true, force: true });
});

test('config-loaded fails on malformed JSON', async () => {
  const home = await tempDir('wingman-doctor-badcfg-');
  await writeFile(join(home, 'config.json'), '{ this is not json', 'utf8');
  const report = await runDoctor(
    { json: false },
    baseDeps({ env: { WINGMAN_HOME: home }, loadConfigFn: undefined }),
  );
  assert.equal(checkOf(report, 'config-loaded').status, 'FAIL');
  await rm(home, { recursive: true, force: true });
});

test('registration-portable fails on a planted absolute path', async () => {
  const entries: RegistrationEntry[] = [
    {
      client: 'claude',
      server: 'jev-browser-wingman',
      command: 'C:/evil/jev-mcp.js',
      args: ['mcp'],
      env: {},
      raw: null,
    },
  ];
  const report = await runDoctor(
    { json: false },
    baseDeps({ readRegistrationsFn: async () => ({ file: 'f', exists: true, entries }) }),
  );
  const check = checkOf(report, 'registration-portable');
  assert.equal(check.status, 'FAIL');
  assert.match(check.detail, /absolute-path:C:\/evil\/jev-mcp\.js/);
});

test('policy-loaded fails on an emptied list', async () => {
  const report = await runDoctor(
    { json: false },
    baseDeps({
      policyLists: () => ({ ...BUILTIN_HOSTS, identity: [] }) as Record<SensitiveHostCategory, readonly string[]>,
    }),
  );
  assert.equal(checkOf(report, 'policy-loaded').status, 'FAIL');
});

test('profile-safe fails on the default user-data dir', async () => {
  const report = await runDoctor(
    { json: false },
    baseDeps({ loadConfigFn: async () => stubConfig({ profile_dir: defaultUserDataDir() }) }),
  );
  assert.equal(checkOf(report, 'profile-safe').status, 'FAIL');
});

test('profile-safe fails on a holder without a debug port', async () => {
  const report = await runDoctor(
    { json: false },
    baseDeps({ profileHoldersFn: async () => ({ withPort: [], withoutPort: [4242] }) }),
  );
  const check = checkOf(report, 'profile-safe');
  assert.equal(check.status, 'FAIL');
  assert.match(check.detail, /4242/);
});

test('adapter-attach fails with nothing listening', async () => {
  const port = await freePort();
  const report = await runDoctor(
    { json: false },
    baseDeps({
      env: {},
      loadConfigFn: async () => stubConfig({ port }),
      resolveEndpointFn: (env, config) => resolveEndpoint(env, config),
    }),
  );
  assert.equal(checkOf(report, 'adapter-attach').status, 'FAIL');
  // Dependent checks skip.
  assert.equal(checkOf(report, 'default-context').status, 'SKIP');
  assert.equal(checkOf(report, 'coexistence').status, 'SKIP');
});

/** Extra pages so the defective detaches cannot exhaust the browser. */
async function addPages(endpoint: string, count: number): Promise<void> {
  const conn = await CdpConnection.connect(endpoint);
  try {
    for (let i = 0; i < count; i++) {
      await conn.send('Target.createTarget', { url: 'about:blank' });
    }
  } finally {
    await conn.close().catch(() => {});
  }
}

function ephemeralDeps(
  ephemeral: Awaited<ReturnType<typeof launchTestChrome>>,
  overrides: Partial<DoctorDeps> = {},
): DoctorDeps {
  return baseDeps({
    loadConfigFn: async () =>
      stubConfig({ profile_dir: ephemeral.profileDir, port: ephemeral.port }),
    resolveEndpointFn: async () => ({ endpoint: ephemeral.endpoint, source: 'probe' as const }),
    profileHoldersFn: async () => ({
      withPort: [{ pid: ephemeral.pid, port: ephemeral.port }],
      withoutPort: [],
    }),
    // jev-round reuses this browser instead of launching a second one; the
    // doctor's own close() in its finally is a no-op here.
    launchEphemeralChromeFn: async () => ({
      endpoint: ephemeral.endpoint,
      port: ephemeral.port,
      profileDir: ephemeral.profileDir,
      pid: ephemeral.pid,
      close: async () => {},
    }),
    ...overrides,
  });
}

test('default-context fails with a driver that creates a context', async () => {
  const ephemeral = await launchWithRetry();
  try {
    const report = await runDoctor(
      { json: false },
      ephemeralDeps(ephemeral, {
        driverFactory: () => createContextOnAttach(createCdpDriver()),
      }),
    );
    assert.equal(checkOf(report, 'adapter-attach').status, 'PASS');
    assert.equal(checkOf(report, 'default-context').status, 'FAIL');
  } finally {
    await ephemeral.close();
  }
});

test('coexistence fails with a driver that closes a page on detach', async () => {
  const ephemeral = await launchWithRetry();
  try {
    await addPages(ephemeral.endpoint, 3);
    const report = await runDoctor(
      { json: false },
      ephemeralDeps(ephemeral, {
        driverFactory: () => closePageOnDetach(createCdpDriver()),
      }),
    );
    assert.equal(checkOf(report, 'default-context').status, 'PASS');
    assert.equal(checkOf(report, 'coexistence').status, 'FAIL');
  } finally {
    await ephemeral.close();
  }
});

test('coexistence fails with a driver that injects a global', async () => {
  const ephemeral = await launchWithRetry();
  try {
    const report = await runDoctor(
      { json: false },
      ephemeralDeps(ephemeral, {
        driverFactory: () => injectGlobal(createCdpDriver()),
      }),
    );
    assert.equal(checkOf(report, 'coexistence').status, 'FAIL');
  } finally {
    await ephemeral.close();
  }
});

test('jev-round fails against a stub answering 500', async () => {
  const stub = await startTypeSafeStub(() => ({ status: 500 }));
  const ephemeral = await launchWithRetry();
  try {
    const report = await runDoctor(
      { json: false },
      ephemeralDeps(ephemeral, {
        ask: createDefaultAsk({ apiKey: 'stub-key', baseUrl: stub.url }),
      }),
    );
    assert.equal(checkOf(report, 'jev-round').status, 'FAIL');
  } finally {
    await ephemeral.close();
    await stub.close();
  }
});

test('all ten checks pass on a clean ephemeral setup', async () => {
  const stub = await startTypeSafeStub((body) => {
    const questions = body.questions ?? {};
    if (questions['answer']) {
      return { status: 200, body: { answers: { answer: { type: 'noul', noul: 0.9 } } } };
    }
    return { status: 500 };
  });
  const ephemeral = await launchWithRetry();
  try {
    const entries: RegistrationEntry[] = [
      {
        client: 'claude',
        server: 'jev-browser-wingman',
        command: 'jev-browser-wingman',
        args: ['mcp'],
        env: {},
        raw: null,
      },
      {
        client: 'claude',
        server: 'playwright',
        command: 'jev-browser-wingman',
        args: ['with-chrome', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
        env: {},
        raw: null,
      },
    ];
    const report = await runDoctor(
      { json: false },
      ephemeralDeps(ephemeral, {
        env: { TYPESAFE_API_KEY: 'dummy-key' },
        ask: createDefaultAsk({ apiKey: 'dummy-key', baseUrl: stub.url }),
        readRegistrationsFn: async () => ({ file: 'fixture', exists: true, entries }),
      }),
    );
    for (const id of DOCTOR_CHECK_IDS) {
      const check = checkOf(report, id);
      assert.equal(check.status, 'PASS', `${id} did not pass: ${check.detail}`);
    }
    assert.equal(report.verdict, 'PASS');
  } finally {
    await ephemeral.close();
    await stub.close();
  }
});

test('json output is one parseable line with the pinned check order', async () => {
  const { stdout } = await runWrapper('json');
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 1, `expected one output line, got ${lines.length}`);
  const report = JSON.parse(lines[0]) as DoctorReport;
  assert.deepEqual(
    report.checks.map((c) => c.id),
    [...DOCTOR_CHECK_IDS],
  );
  assert.equal(typeof report.version, 'string');
  assert.ok(['PASS', 'FAIL'].includes(report.verdict));
});

// ---------------------------------------------------------------------------
// I6: the `handoff` check (§ 5.10) and the config-loaded gate suffix (Q6).
// ---------------------------------------------------------------------------

type ConfigWithExtras = WingmanConfig & Record<string, unknown>;

function forcedConfig(overrides: Record<string, unknown> = {}): { ok: true; config: WingmanConfig; source: 'file' } {
  const config = {
    mode: 'on',
    adapter: 'cdp',
    window: 'offscreen',
    profile_dir: join(tmpdir(), 'wingman-doctor-profile-stub'),
    port: 59999,
    chrome_path: null,
    secrets_file: null,
    plugin: null,
    sensitive_hosts: {},
    budgets: { ...DEFAULT_BUDGETS },
    handoff: { mode: 'forced', tools: 'browse-only', retain: [] },
    ...overrides,
  } as ConfigWithExtras;
  return { ok: true, config: config as WingmanConfig, source: 'file' };
}

function entry(server: string, command: string, args: string[]): RegistrationEntry {
  return { client: 'claude', server, command, args, env: {}, raw: null };
}

const PLAYWRIGHT_ENTRY = entry('playwright', 'npx', ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome']);
const WRAPPED_PLAYWRIGHT_ENTRY = entry('playwright', 'jev-browser-wingman', [
  'with-browser',
  '--',
  'npx',
  '-y',
  '@playwright/mcp@0.0.80',
  '--browser',
  'chrome',
]);
const WINGMAN_ENTRY = entry('jev-browser-wingman', 'jev-browser-wingman', ['mcp']);
const FOREIGN_WRAPPED_ENTRY = entry('some-other-browser', 'jev-browser-wingman', [
  'with-browser',
  '--',
  'npx',
  '-y',
  'some-other-browser-mcp',
]);

function noSettings(): Promise<ClientSettingsResult> {
  return Promise.resolve({ exists: false, denyList: [] });
}

test('handoff PASSes optional when the config has no handoff key (hand-built object)', async () => {
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({ readSettingsFn: noSettings }),
  );
  const check = checkOf(report, 'handoff');
  assert.equal(check.status, 'PASS');
  assert.match(check.detail, /^optional: nothing withheld$/);
});

test('handoff PASSes optional with the mode-off suffix when wingman mode is not on', async () => {
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      loadConfigFn: async () => forcedConfig({ mode: 'off' }),
      readSettingsFn: noSettings,
    }),
  );
  const check = checkOf(report, 'handoff');
  assert.equal(check.status, 'PASS');
  assert.match(check.detail, /^optional: nothing withheld \(wingman mode is off; forced needs mode on\)$/);
});

test('handoff SKIPs when no browsing tool is registered', async () => {
  const home = await tempDir('wingman-doctor-handoff-none-');
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      env: { WINGMAN_HOME: home },
      loadConfigFn: async () => forcedConfig(),
      readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [WINGMAN_ENTRY] }),
      readSettingsFn: noSettings,
    }),
  );
  const check = checkOf(report, 'handoff');
  assert.equal(check.status, 'SKIP');
  assert.equal(check.detail, 'no browsing tool registered');
  await rm(home, { recursive: true, force: true });
});

test('handoff PASSes "enforced by proxy" for a wrapped, profile-matched server', async () => {
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      loadConfigFn: async () => forcedConfig(),
      readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [WINGMAN_ENTRY, WRAPPED_PLAYWRIGHT_ENTRY] }),
      readSettingsFn: noSettings,
    }),
  );
  const check = checkOf(report, 'handoff');
  assert.equal(check.status, 'PASS');
  assert.match(check.detail, /enforced by proxy: playwright \(playwright-mcp\)/);
  assert.match(check.detail, /withheld classes: /);
});

test('handoff PASSes "enforced by proxy after auto-classification" for a wrapped, unmatched server', async () => {
  const home = await tempDir('wingman-doctor-handoff-auto-');
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      env: { WINGMAN_HOME: home },
      loadConfigFn: async () => forcedConfig(),
      readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [FOREIGN_WRAPPED_ENTRY] }),
      readSettingsFn: noSettings,
    }),
  );
  const check = checkOf(report, 'handoff');
  assert.equal(check.status, 'PASS');
  assert.match(check.detail, /enforced by proxy after auto-classification: some-other-browser \(first session classifies; needs a TypeSafe key\)/);
  assert.match(check.detail, /not yet classified/);
  await rm(home, { recursive: true, force: true });
});

test('handoff appends the unclassified tool names once an auto profile exists', async () => {
  const home = await tempDir('wingman-doctor-handoff-autolist-');
  const autoDir = join(home, 'profiles-auto');
  await mkdir(autoDir, { recursive: true });
  await writeFile(
    join(autoDir, 'auto-abc123.json'),
    JSON.stringify({
      id: 'auto-abc123',
      auto: true,
      description: 'auto-classified',
      detect: { args_contain: [], extension_flags: [], endpoint_flags: [] },
      launch: { endpoint_env: null, endpoint_arg: null, strip_args: [] },
      match_tools: ['weird_tool'],
      tools: { weird_tool: 'unknown' },
      arg_rules: [],
    }),
  );
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      env: { WINGMAN_HOME: home },
      loadConfigFn: async () => forcedConfig(),
      readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [FOREIGN_WRAPPED_ENTRY] }),
      readSettingsFn: noSettings,
    }),
  );
  const check = checkOf(report, 'handoff');
  assert.match(check.detail, /left with the caller \(unclassified\): weird_tool/);
  await rm(home, { recursive: true, force: true });
});

test('handoff PASSes "enforced by deny config" when the client settings list every withheld tool', async () => {
  const home = await tempDir('wingman-doctor-handoff-deny-');
  const profiles = loadProfiles(home);
  const profile = profiles.find((p) => p.id === 'playwright-mcp')!;
  const withheld = withheldClasses(adapterOps('cdp'), []);
  const deny = denyEntries('claude', 'playwright', profile, withheld)!;
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      env: { WINGMAN_HOME: home },
      loadConfigFn: async () => forcedConfig(),
      readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [PLAYWRIGHT_ENTRY] }),
      readSettingsFn: async () => ({ exists: true, denyList: deny.entries }),
    }),
  );
  const check = checkOf(report, 'handoff');
  assert.equal(check.status, 'PASS');
  assert.match(check.detail, /enforced by deny config: playwright/);
  await rm(home, { recursive: true, force: true });
});

test('handoff FAILs a proxiable, unwrapped server with no deny entries', async () => {
  const home = await tempDir('wingman-doctor-handoff-nowrap-');
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      env: { WINGMAN_HOME: home },
      loadConfigFn: async () => forcedConfig(),
      readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [PLAYWRIGHT_ENTRY] }),
      readSettingsFn: noSettings,
    }),
  );
  const check = checkOf(report, 'handoff');
  assert.equal(check.status, 'FAIL');
  assert.match(check.detail, /not enforced: wrap playwright with with-browser \(doctor --plan prints the entry\)/);
  await rm(home, { recursive: true, force: true });
});

test('handoff aggregates: one enforced + one unenforced server yields FAIL with both details', async () => {
  const home = await tempDir('wingman-doctor-handoff-agg-');
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      env: { WINGMAN_HOME: home },
      loadConfigFn: async () => forcedConfig(),
      readRegistrationsFn: async () => ({
        file: 'f',
        exists: true,
        entries: [WRAPPED_PLAYWRIGHT_ENTRY, entry('devtools', 'npx', ['-y', 'chrome-devtools-mcp@1.10.1'])],
      }),
      readSettingsFn: noSettings,
    }),
  );
  const check = checkOf(report, 'handoff');
  assert.equal(check.status, 'FAIL');
  assert.match(check.detail, /enforced by proxy: playwright \(playwright-mcp\)/);
  assert.match(check.detail, /not enforced: wrap devtools with with-browser/);
  await rm(home, { recursive: true, force: true });
});

test('handoff Q4: forced + policy.mode enforce appends the WARNING, status unchanged', async () => {
  const home = await tempDir('wingman-doctor-handoff-q4-');
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      env: { WINGMAN_HOME: home },
      loadConfigFn: async () => forcedConfig({ policy: { mode: 'enforce' } }),
      readSettingsFn: noSettings,
    }),
  );
  const check = checkOf(report, 'handoff');
  // No browsing server is registered here (SKIP), and the warning still rides.
  assert.equal(check.status, 'SKIP');
  assert.match(
    check.detail,
    /; WARNING: policy\.mode enforce with forced handoff: sensitive pages come back for pick or the user$/,
  );
  await rm(home, { recursive: true, force: true });
});

test('registration-portable counts a with-browser-wrapped entry as relevant', async () => {
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({
      readRegistrationsFn: async () => ({ file: 'f', exists: true, entries: [WRAPPED_PLAYWRIGHT_ENTRY] }),
    }),
  );
  const check = checkOf(report, 'registration-portable');
  assert.notEqual(check.status, 'SKIP', 'a with-browser-wrapped entry must be counted relevant');
});

test('config-loaded ends with the off gate suffix by default (Q6)', async () => {
  const report = await runDoctor({ json: false, offlineOnly: true }, baseDeps());
  const check = checkOf(report, 'config-loaded');
  assert.match(
    check.detail,
    /; gate: off \(optional toggle; set gate\.mode "confirm" to require confirmation of irreversible actions\)$/,
  );
});

test('config-loaded ends with the confirm gate suffix when gate.mode is confirm (Q6)', async () => {
  const report = await runDoctor(
    { json: false, offlineOnly: true },
    baseDeps({ loadConfigFn: async () => forcedConfig({ gate: { mode: 'confirm' }, handoff: undefined }) }),
  );
  const check = checkOf(report, 'config-loaded');
  assert.match(check.detail, /; gate: confirm$/);
});

// KB-Ic and KB-Id (§ 6 WP-I) are proved at gate time by flipping doctor.ts's
// source (dropping the gate suffix / the Q4 WARNING append) and confirming
// the two tests just above — "config-loaded ends with the confirm gate
// suffix…" and "handoff Q4: forced + policy.mode enforce appends the
// WARNING…" — FAIL, then restoring. See the report for the recorded run.

// The scratch dir (the doctor output-capture wrapper) goes away with the
// process; a synchronous best-effort removal keeps the gate clean.
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
