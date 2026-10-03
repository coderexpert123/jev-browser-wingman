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
import type { DoctorCheckId, DoctorReport, Driver, SensitiveHostCategory, WingmanConfig } from '../src/contract/types.js';
import { defaultUserDataDir } from '../src/browser/chrome.js';
import { BUILTIN_HOSTS } from '../src/core/policy-data.js';
import { createDefaultAsk } from '../src/core/jev-client.js';
import { resolveEndpoint } from '../src/browser/acquire.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { createCdpDriver } from '../src/adapters/cdp.js';
import { fingerprint, fingerprintsReconcile, type ProbeFingerprint } from '../src/cli/coexistence-probe.js';
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

// Flake fix 2026-10-02 (cloud Part-1): one sentinel eval timeout must NOT be
// read as a dialog — a slow renderer answers the retry, a real dialog never
// does. Drives the REAL fingerprint over a scripted connection; no Chrome.
type SendLog = Array<[string, object?, string?, number?]>;
function scriptedConn(evalPlan: (callIndex: number, expression: string) => unknown): {
  conn: CdpConnection;
  sent: SendLog;
} {
  let evalCalls = 0;
  const sent: SendLog = [];
  const fake = {
    send: (method: string, params?: object, sessionId?: string, timeoutMs?: number) => {
      sent.push([method, params, sessionId, timeoutMs]);
      if (method === 'Target.getBrowserContexts') {
        return Promise.resolve({ browserContextIds: [] });
      }
      if (method === 'Target.getTargets') {
        return Promise.resolve({ targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank#frag' }] });
      }
      if (method === 'Target.attachToTarget') {
        return Promise.resolve({ sessionId: 's1' });
      }
      if (method === 'Target.detachFromTarget') {
        return Promise.resolve({});
      }
      if (method === 'Storage.getCookies') {
        // The default-context check counts cookies through a page session;
        // an empty list keeps that check green so coexistence really runs.
        return Promise.resolve({ cookies: [] });
      }
      if (method === 'Runtime.evaluate') {
        const outcome = evalPlan(++evalCalls, String((params as { expression?: string })?.expression));
        if (outcome instanceof Error) return Promise.reject(outcome);
        return Promise.resolve({ result: { value: outcome } });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    },
    on: () => () => {},
    close: () => Promise.resolve(),
  };
  return { conn: fake as unknown as CdpConnection, sent };
}

const TIMEOUT = new Error('cdp timeout: Runtime.evaluate');
const EVAL_ANSWERS: Record<string, unknown> = {
  '1': 1,
  'JSON.stringify(Object.getOwnPropertyNames(globalThis).sort())': '["a"]',
  'document.documentElement.attributes.length + ":" + (document.body ? document.body.attributes.length : -1)': '0:0',
  'JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })':
    '{"w":800,"h":600,"dpr":1}',
};

test('coexistence probe: one slow sentinel is not a dialog; the retry answers (flake fix)', async () => {
  const { conn, sent } = scriptedConn((callIndex, expression) => {
    if (callIndex === 1) return TIMEOUT; // first sentinel: slow, not blocked
    return EVAL_ANSWERS[expression] ?? new Error(`unplanned eval: ${expression}`);
  });
  const fp = await fingerprint(conn);
  const page = fp.pages[0];
  assert.equal(page.url, 'about:blank'); // fragment stripped
  assert.equal(page.dialogOpen, false, 'a slow-but-answering sentinel must not be reported as a dialog');
  assert.equal(page.globalsHash, '0eb5b8d6f81b'); // sha256('["a"]') slice 12
  assert.equal(page.htmlAttrs, '0:0');
  assert.deepEqual(page.viewport, { w: 800, h: 600, dpr: 1 });
  assert.deepEqual(
    Object.keys(page).sort(),
    ['dialogOpen', 'globalsHash', 'htmlAttrs', 'targetId', 'url', 'viewport'],
    'visibility is ambient renderer state, not write evidence — it must stay out of the fingerprint',
  );
  // The sentinel retry gets the long budget; a real dialog never answers it.
  const sentinelBudgets = sent
    .filter(([m, p]) => m === 'Runtime.evaluate' && (p as { expression?: string })?.expression === '1')
    .map(([, , , t]) => t);
  assert.deepEqual(sentinelBudgets, [500, 4000]);
});

test('coexistence probe: a persistently blocked page is still reported as a dialog', async () => {
  const { conn } = scriptedConn(() => TIMEOUT);
  const fp = await fingerprint(conn);
  const page = fp.pages[0];
  assert.equal(page.dialogOpen, true, 'a page that never answers the sentinel is a dialog');
  assert.equal(page.globalsHash, null);
  assert.equal(page.htmlAttrs, null);
  assert.equal(page.viewport, null);
});

// D-4 (r19, amended): reconciliation is gated on DEGRADED sides. The
// pre-r19 retry was nested inside `onlyUrlsChanged`, so a starved before-side
// fingerprint (sentinel timeouts -> dialogOpen + nulls) never reconciled: the
// nulls differ from a clean after in globalsHash/htmlAttrs/viewport,
// onlyUrlsChanged is false, and the retry never fired. An earlier draft that
// re-fingerprinted BOTH sides on any mismatch was falsified by the known-bad
// pins — a persistent attach-time write is absorbed into the re-read `before`
// and real mutations escaped — so the shipped rule re-reads only a side whose
// read was itself degraded (sentinel marker); healthy-vs-healthy mismatches
// fail immediately with zero extra probes.
function noOpDriver(): Driver {
  return {
    name: 'no-op',
    attach: async () => {},
    detach: async () => {},
    pages: async () => [],
    observe: async () => {
      throw new Error('no-op driver: observe');
    },
    act: async () => {},
    settle: async () => ({ settled: true, ms: 0 }),
    onDialog: () => {},
    answerDialog: async () => {},
  } as unknown as Driver;
}

/** Full-doctor deps over a scripted connection: endpoint resolution is stubbed,
 * every check shares the one fake connection, and the driver is a no-op, so
 * the coexistence fingerprints are the ONLY Runtime.evaluate traffic. */
function scriptedConnDeps(conn: CdpConnection): Partial<DoctorDeps> {
  return {
    resolveEndpointFn: async () => ({ endpoint: 'http://127.0.0.1:59999', source: 'probe' as const }),
    cdpConnect: async () => conn,
    driverFactory: () => noOpDriver(),
  };
}

test('coexistence reconciles a starved before-side fingerprint (D-4 discriminating pin)', async () => {
  // Pass 1 (the doctor's `before` fingerprint) starves: sentinel + its long
  // retry both time out -> dialogOpen: true + null detail fields. Every later
  // pass answers stable clean values.
  const { conn } = scriptedConn((callIndex, expression) => {
    if (callIndex <= 2) return TIMEOUT;
    return EVAL_ANSWERS[expression] ?? new Error(`unplanned eval: ${expression}`);
  });
  const report = await runDoctor({ json: false }, baseDeps(scriptedConnDeps(conn)) as DoctorDeps);
  // The prerequisites ran clean over the scripted connection, so coexistence
  // really executed (a SKIP here would make the pin vacuous).
  assert.equal(checkOf(report, 'adapter-attach').status, 'PASS');
  assert.equal(checkOf(report, 'default-context').status, 'PASS');
  assert.equal(
    checkOf(report, 'coexistence').status,
    'PASS',
    `starved-before must reconcile through a both-sides re-fingerprint: ${checkOf(report, 'coexistence').detail}`,
  );
});

test('coexistence still FAILs a genuine persistent mutation through the reconcile (D-4)', async () => {
  // The before side always reads clean; the after side always reads with one
  // extra global — a write that persists in every re-read, so no number of
  // reconcile rounds may accept it.
  let sentinelCalls = 0;
  const { conn } = scriptedConn((_callIndex, expression) => {
    if (expression === '1') {
      sentinelCalls++;
      return 1;
    }
    if (expression.startsWith('JSON.stringify(Object.getOwnPropertyNames')) {
      // The sentinel of the current pass was just consumed; odd pass = before
      // side (stable), even pass = after side (mutated).
      return sentinelCalls % 2 === 1 ? '["a"]' : '["a","m"]';
    }
    return EVAL_ANSWERS[expression] ?? new Error(`unplanned eval: ${expression}`);
  });
  const report = await runDoctor({ json: false }, baseDeps(scriptedConnDeps(conn)) as DoctorDeps);
  assert.equal(
    checkOf(report, 'coexistence').status,
    'FAIL',
    'a persistent after-side mutation must stay FAIL no matter how many reconcile rounds run',
  );
});

// Unit pins on the reconcile helper itself (D-4, amended): the common case
// must cost ZERO extra probes, only a DEGRADED side earns a single re-read,
// and a healthy-vs-healthy mismatch (the known-bad drivers' shape) fails
// immediately without spending any probe.
function cleanPage(globalsHash = 'h0'): ProbeFingerprint['pages'][number] {
  return {
    targetId: 't1',
    url: 'about:blank',
    dialogOpen: false,
    globalsHash,
    htmlAttrs: '0:0',
    viewport: { w: 800, h: 600, dpr: 1 },
  };
}
function starvedPage(): ProbeFingerprint['pages'][number] {
  return {
    targetId: 't1',
    url: 'about:blank',
    dialogOpen: true,
    globalsHash: null,
    htmlAttrs: null,
    viewport: null,
  };
}
function fpOf(...pages: Array<ProbeFingerprint['pages'][number]>): ProbeFingerprint {
  return { contexts: [], pages };
}

test('fingerprintsReconcile: exact match accepts with zero reprobe rounds', async () => {
  let reprobeCalls = 0;
  const result = await fingerprintsReconcile(fpOf(cleanPage()), fpOf(cleanPage()), async () => {
    reprobeCalls++;
    return fpOf(cleanPage('other'));
  });
  assert.equal(result.match, true);
  assert.equal(reprobeCalls, 0, 'an exact match must not spend any reprobe');
  assert.deepEqual(result.after, fpOf(cleanPage()));
});

test('fingerprintsReconcile: a url-only difference accepts with zero reprobe rounds (lenience kept)', async () => {
  let reprobeCalls = 0;
  const after = fpOf({ ...cleanPage(), url: 'http://example.com/other' });
  const result = await fingerprintsReconcile(fpOf(cleanPage()), after, async () => {
    reprobeCalls++;
    return fpOf(cleanPage());
  });
  assert.equal(result.match, true, 'the de78ea2 url-only lenience must survive the reconcile');
  assert.equal(reprobeCalls, 0);
  assert.deepEqual(result.after, after);
});

test('fingerprintsReconcile: a starved before earns exactly one BEFORE-side re-read', async () => {
  const sides: string[] = [];
  const result = await fingerprintsReconcile(fpOf(starvedPage()), fpOf(cleanPage()), async (side) => {
    sides.push(side);
    return fpOf(cleanPage('h0'));
  });
  assert.equal(result.match, true, 'a before-side read artifact must reconcile against the healthy after');
  assert.deepEqual(sides, ['before'], 'only the degraded side is re-read, exactly once');
  assert.deepEqual(result.after, fpOf(cleanPage()), 'the untouched after side is the freshest after');
});

test('fingerprintsReconcile: a degraded after earns exactly one AFTER-side re-read (the generalised retry)', async () => {
  const sides: string[] = [];
  const freshAfter = fpOf(cleanPage());
  const before = fpOf(cleanPage());
  const result = await fingerprintsReconcile(before, fpOf(starvedPage()), async (side) => {
    sides.push(side);
    return freshAfter;
  });
  assert.equal(result.match, true, 'an after-side read artifact must reconcile against the healthy before');
  assert.deepEqual(sides, ['after']);
  assert.equal(result.after, freshAfter, 'the re-read after is the freshest fingerprint (reference-equal)');
});

test('fingerprintsReconcile: healthy-vs-healthy mismatch FAILs immediately with zero reprobes (the teeth)', async () => {
  let reprobeCalls = 0;
  const result = await fingerprintsReconcile(fpOf(cleanPage()), fpOf(cleanPage('mutant')), async (side) => {
    reprobeCalls++;
    return fpOf(cleanPage());
  });
  assert.equal(result.match, false, 'a healthy before plus a healthy differing after is a genuine write');
  assert.equal(reprobeCalls, 0, 'the injectGlobal/closePageOnDetach shape must not spend any reconcile probe');
});

test('fingerprintsReconcile: both sides degraded FAILs conservatively with zero reprobes', async () => {
  let reprobeCalls = 0;
  // Two DEGRADED but genuinely differing reads (different targets), so the
  // exact/url-only fast paths do not absorb the case first.
  const result = await fingerprintsReconcile(fpOf(starvedPage()), fpOf({ ...starvedPage(), targetId: 't2' }), async () => {
    reprobeCalls++;
    return fpOf(cleanPage());
  });
  assert.equal(result.match, false, 'two unreadable reads cannot be told apart from a write — fail');
  assert.equal(reprobeCalls, 0);
});

test('fingerprintsReconcile: a degraded after whose re-read still differs ends { match: false } after one re-read', async () => {
  let reprobeCalls = 0;
  const before = fpOf(cleanPage());
  const result = await fingerprintsReconcile(before, fpOf(starvedPage()), async () => {
    reprobeCalls++;
    return fpOf(cleanPage(`stillDegrading${reprobeCalls}`));
  });
  assert.equal(result.match, false);
  assert.equal(reprobeCalls, 1, 'the single-side retry is bounded at one round');
  assert.deepEqual(result.after, fpOf(cleanPage('stillDegrading1')), 'the returned after is the last one seen');
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
