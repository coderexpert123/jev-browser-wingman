// Teardown-hardening pass (2026-09-22): deliberate leak fixture.
//
// This fixture must simulate the specific failure the runner sweep exists
// for: a worker that is KILLED (SIGKILL / hard crash), where Node's own
// `process.on('exit')` hooks never run — as opposed to a worker that exits
// normally, which src/browser/ephemeral.ts's own exit-hook guard (added by
// the Chrome-leak fix, commit 9264991) already catches on its own. If this
// fixture merely finished without calling close(), that exit-hook guard
// would kill its chrome before the runner's sweep ever got a chance to, and
// the sweep's own kill-log assertion in tests/runner-sweep.test.ts would go
// unproven.
//
// So: launch the chrome in a CHILD process (inheriting WINGMAN_RUN_TOKEN, so
// ephemeral.ts still tags the chrome cmdline with the run token the sweep
// matches on), then SIGKILL that child from here once it has confirmed a
// live chrome. process.kill(pid, 'SIGKILL') causes unconditional termination
// on both POSIX (uncatchable signal) and Windows (TerminateProcess) — per
// Node's own child_process/process docs — so the child's 'exit' event never
// fires and its liveChromes exit-hook guard never gets to run. This test
// file's own process (which never calls launchEphemeralChrome itself) then
// finishes normally, with nothing of its own to leak; only the runner's
// exit sweep is left to catch the grandchild's abandoned chrome.
//
// This file must never be "fixed" to close() the chrome cleanly — when run
// through scripts/run-tests.mjs the sweep kills the leaked chrome before the
// runner exits; that kill (logged as `RUN-TESTS: chrome sweep ...`) is the
// tested behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');

test('leaks a token-tagged chrome on purpose (the runner sweep is the guarantee)', async () => {
  const ephemeralUrl = pathToFileURL(path.join(packageRoot, 'dist', 'src', 'browser', 'ephemeral.js')).href;
  const script = [
    `const { launchEphemeralChrome } = await import(${JSON.stringify(ephemeralUrl)});`,
    `const chrome = await launchEphemeralChrome({ headless: true });`,
    // READY only prints after launchEphemeralChrome saw DevToolsActivePort,
    // so stdout READY is proof a live chrome existed before this child is
    // killed. It must not exit on its own afterwards (an intentional hang) —
    // an exit here, even without close(), would let this child's own exit
    // hook run and defeat the fixture.
    `if (!chrome.pid || !chrome.endpoint) { throw new Error('fixture child failed to launch a live chrome'); }`,
    `console.log('READY');`,
    `await new Promise(() => {});`,
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-sweep-leak-'));
  const scriptPath = path.join(dir, 'leak-child.mjs');
  fs.writeFileSync(scriptPath, script);
  try {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const ready = await new Promise<boolean>((resolve) => {
      let out = '';
      const onData = (d: Buffer) => {
        out += d.toString();
        if (/^READY$/m.test(out)) resolve(true);
      };
      child.stdout?.on('data', onData);
      child.on('exit', () => resolve(false));
    });
    assert.ok(ready, 'fixture child did not report a live chrome before exiting on its own');
    // Kill unconditionally: no 'exit' handler in the child ever runs.
    child.kill('SIGKILL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
