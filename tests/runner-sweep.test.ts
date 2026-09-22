// Teardown-hardening pass (2026-09-22): proofs for the two leak guarantees.
//
// 1. Helper registry (tests/helpers/chrome.ts): a browser still registered
//    when its test process exits without close() is killed by the sync
//    `process.on('exit')` backstop.
// 2. Runner sweep (scripts/run-tests.mjs): before the runner exits, any
//    chrome.exe whose command line carries the runner's own WINGMAN_RUN_TOKEN
//    is killed (PID tree) and logged.
//
// Both tests drive the REAL compiled code over a REAL spawned chrome: test 1
// runs a child that launches through the compiled helper and exits uncleanly;
// test 2 runs the real runner over the real leak fixture
// (tests/runner-sweep-leak.test.ts) and asserts the sweep's own log.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listChromeProcesses } from '../src/browser/process-list.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');

async function pollUntil(cond: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

test('helper registry kills a browser whose test process exits without close', async () => {
  // The child sets its own unique token BEFORE importing the helper, so this
  // assertion can pick its chrome out from every other test chrome on the box.
  const token = `registry-${randomUUID()}`;
  // Windows ESM: an absolute import specifier must be a file:// URL, not a
  // bare drive path (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  const helperUrl = pathToFileURL(path.join(packageRoot, 'dist', 'tests', 'helpers', 'chrome.js')).href;
  const script = [
    `process.env.WINGMAN_RUN_TOKEN = ${JSON.stringify(token)};`,
    `const { launchTestChrome } = await import(${JSON.stringify(helperUrl)});`,
    `const chrome = await launchTestChrome();`,
    // READY only prints after launchEphemeralChrome saw DevToolsActivePort,
    // so stdout READY is proof a live chrome existed when the child exited.
    // The profile dir (not the token) keys the parent's check: the token
    // only reaches the chrome cmdline once ephemeral.ts tags it, and the
    // check must also be able to FAIL against the pre-registry helper.
    `console.log('READY ' + JSON.stringify({ pid: chrome.pid, profile: chrome.profileDir }));`,
    `process.exit(1);`, // no close() — the registry exit hook is the backstop
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-registry-test-'));
  const scriptPath = path.join(dir, 'leak-child.mjs');
  fs.writeFileSync(scriptPath, script);
  try {
    const child = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const ready = (child.stdout ?? '').match(/^READY (\{.*\})$/m);
    assert.ok(ready, `child did not launch a live chrome (status ${child.status}) stderr: ${child.stderr ?? ''}`);
    const { profile } = JSON.parse(ready[1]);
    const profileChromes = async () => {
      const all = await listChromeProcesses();
      return all.filter((p) => p.cmdline.includes(profile));
    };
    const gone = await pollUntil(async () => (await profileChromes()).length === 0, 20_000);
    assert.ok(
      gone,
      `helper registry did not kill the browser after the child exited (chrome on profile ${profile} still alive)`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run-tests sweep kills a chrome a test file leaks (token match)', async () => {
  // Run the REAL runner over the REAL leak fixture. The nested runner mints
  // its own WINGMAN_RUN_TOKEN; the fixture leaks a chrome tagged with it and
  // the sweep must kill it before the runner exits, logging the kill.
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(packageRoot, 'scripts', 'run-tests.mjs'), 'runner-sweep-leak'],
      { cwd: packageRoot, windowsHide: true },
    );
    let acc = '';
    child.stdout.on('data', (d) => (acc += d));
    child.stderr.on('data', (d) => (acc += d));
    child.on('error', reject);
    child.on('close', () => resolve(acc));
  });
  assert.match(
    out,
    /RUN-TESTS: chrome sweep \(post-run\): kill pid=\d+/,
    'runner sweep logged no kill — the leaked chrome was not caught',
  );
  assert.match(out, /RUN-TESTS: files=\d+ tests=\d+ pass=\d+ fail=0/, `nested runner did not pass:\n${out}`);
});
