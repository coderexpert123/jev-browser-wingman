import { launchEphemeralChrome } from '../../src/browser/ephemeral.js';

export const launchTestChrome = (opts?: { headless?: boolean; chromePath?: string | null }) =>
  launchEphemeralChrome({ headless: true, ...opts });
