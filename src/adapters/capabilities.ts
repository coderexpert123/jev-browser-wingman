// WP-A — adapter op declaration (spec 2026-09-26-wingman-forced-handoff § 5.7).
// Dependency-free by contract: the proxy, doctor and bench import this module
// without loading playwright-core or opening a browser. Every declared entry
// is proven by tests/conformance-ops.test.ts on that adapter.

import type { Op } from '../contract/types.js';
import { LEGACY_OPS, OPS } from '../contract/types.js';

/** Ops each shipped adapter executes; every entry is proven by tests/conformance-ops.test.ts on that adapter. */
export const ADAPTER_OPS: Record<'playwright' | 'cdp', readonly Op[]> = { playwright: OPS, cdp: OPS };

/** The declared op set of an adapter by name; an unknown name gets LEGACY_OPS (the pre-0.3.0 set). */
export function adapterOps(name: string): readonly Op[] {
  if (name === 'playwright' || name === 'cdp') {
    return ADAPTER_OPS[name];
  }
  return LEGACY_OPS;
}
