// WP-H: benchmark oracle evaluation over a raw CDP connection.
// The expression runs in the page's main world (Runtime.evaluate with no
// contextId on a flattened page session). Anything but a literal `true`
// result — a throw, a timeout, a non-boolean — counts as false, so a broken
// page can never pass a task.

import type { CdpConnection } from '../src/adapters/cdp-connection.js';

const ORACLE_TIMEOUT_MS = 5_000;

export async function evaluateOracle(
  conn: CdpConnection,
  targetId: string,
  expression: string,
): Promise<boolean> {
  try {
    const attach = await conn.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
      undefined,
      ORACLE_TIMEOUT_MS,
    );
    const sessionId = attach.sessionId;
    const res = await conn.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      sessionId,
      ORACLE_TIMEOUT_MS,
    );
    if (!res || res.exceptionDetails !== undefined) return false;
    return res.result?.value === true;
  } catch {
    return false;
  }
}
