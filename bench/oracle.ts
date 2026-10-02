// WP-H: benchmark expression evaluation over a raw CDP connection.
// Expressions run in the page's main world (Runtime.evaluate with no
// contextId on a flattened page session).

import type { CdpConnection } from '../src/adapters/cdp-connection.js';

const ORACLE_TIMEOUT_MS = 5_000;

// Evaluates the expression and returns the raw result value — undefined on a
// throw, a timeout or CDP exceptionDetails. No verdict is applied here; the
// caller decides what the value means (r17 D8: evaluateOracle's literal-true
// contract lives beside this, and the bench end_state capture reads verbatim
// strings through it).
export async function evaluateExpression(
  conn: CdpConnection,
  targetId: string,
  expression: string,
): Promise<unknown> {
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
    if (!res || res.exceptionDetails !== undefined) return undefined;
    return res.result?.value;
  } catch {
    return undefined;
  }
}

// Anything but a literal `true` result — a throw, a timeout, a non-boolean —
// counts as false, so a broken page can never pass a task.
export async function evaluateOracle(
  conn: CdpConnection,
  targetId: string,
  expression: string,
): Promise<boolean> {
  return (await evaluateExpression(conn, targetId, expression)) === true;
}
