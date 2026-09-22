// Teardown-hardening pass (2026-09-22): deliberate leak fixture.
//
// Launches a real Chrome tagged with the runner's WINGMAN_RUN_TOKEN and exits
// WITHOUT closing it. This file exists so tests/runner-sweep.test.ts can prove
// the runner's exit sweep catches a genuine leak. It must never be "fixed" —
// when run through scripts/run-tests.mjs the sweep kills its chrome before the
// runner exits; that kill (logged as `RUN-TESTS: chrome sweep ...`) is the
// tested behaviour.

import test from 'node:test';
import { launchEphemeralChrome } from '../src/browser/ephemeral.js';

test('leaks a token-tagged chrome on purpose (the runner sweep is the guarantee)', async () => {
  const chrome = await launchEphemeralChrome({ headless: true });
  // Prove the chrome is really live (the launch already waited for
  // DevToolsActivePort), then abandon it — no close().
  if (!chrome.pid || !chrome.endpoint) {
    throw new Error('fixture failed to launch a live chrome');
  }
});
