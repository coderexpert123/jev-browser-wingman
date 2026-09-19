// WP-F2: doctor tests (§ 3.10 known-bad column + the clean nine-pass setup).
//
// The two tests that assert on runDoctor's stdout spawn a child process
// running a wrapper script: patching process.stdout.write in-process steals
// the node:test reporter's own writes (its flushes land inside the capture
// window), which makes the --test parent lose whole subtests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
import { runDoctor, type DoctorDeps } from '../src/cli/doctor.js';
import type { RegistrationEntry } from '../src/cli/registrations.js';

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

test('all nine checks pass on a clean ephemeral setup', async () => {
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

// The scratch dir (the doctor output-capture wrapper) goes away with the
// process; a synchronous best-effort removal keeps the gate at 13 tests.
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
