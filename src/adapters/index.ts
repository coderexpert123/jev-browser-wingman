// WP-E — adapter registry. The single place that maps an adapter name to its
// driver, so callers (WP-C7, WP-F1, WP-F2) never import an adapter module
// directly. Signatures are pinned by § 3.13.

import type { Driver } from '../contract/types.js';
import { createPlaywrightDriver } from './playwright.js';
import { createCdpDriver } from './cdp.js';

export const ADAPTERS = ['playwright', 'cdp'] as const;

export function createDriver(name: 'playwright' | 'cdp'): Driver {
  switch (name) {
    case 'playwright':
      return createPlaywrightDriver();
    case 'cdp':
      return createCdpDriver();
  }
}
