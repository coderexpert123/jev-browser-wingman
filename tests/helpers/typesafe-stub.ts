// Local HTTP server scripted per test, standing in for TypeSafe System One.
// Reused by C5 (`jev-client.test.ts`), C7 and F2.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TypeSafeStubResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

/** The bits of a `JevQuestion` a stub needs to pick a default answer; matches
 * the shape `body.questions[id]` arrives in over the wire. */
export interface StubQuestion {
  type: string;
  criteria?: Record<string, unknown>;
}

/**
 * Fill in any question the request asks that `explicit` does not already
 * answer, with a neutral default that cannot change a scripted stub's
 * intended outcome — real Jev answers every asked question
 * (`parseJevAnswers` in src/core/jev-client.ts rejects a response missing
 * one), and the e2e stubs must too:
 *
 *  - noul -> a low, non-committing probability (0.05): "no" to every
 *    yes/no read (done, blocked, login, error, irreversible, step_done) and
 *    "not yet" to right_page/ready — a test that actually needs those high
 *    (chain-e2e, pick-e2e) already answers them explicitly, which wins.
 *  - choice with a `none` criterion (action, target, value, key, url, file,
 *    option) -> `none` at a low confidence, so it never fires an act, a fill
 *    or a press on its own.
 *  - choice with no `none` criterion (recover is the only one) -> its first
 *    criterion key, at a low confidence; loop.ts only reads `recover` once
 *    the `error` noul has already crossed its threshold, which the 0.05
 *    default here never does, so the choice itself is inert.
 *
 * Explicit answers always win: any id already in `explicit` passes through
 * unchanged, byte for byte.
 */
export function fillDefaultAnswers(
  questions: Record<string, StubQuestion>,
  explicit: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...explicit };
  for (const [id, question] of Object.entries(questions ?? {})) {
    if (id in out) continue;
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria ?? {});
      const choice = keys.includes('none') ? 'none' : (keys[0] ?? 'none');
      out[id] = { type: 'choice', choice, probabilities: { [choice]: 0.05 }, confidence: 0.05 };
    } else {
      out[id] = { type: 'noul', noul: 0.05 };
    }
  }
  return out;
}

export async function startTypeSafeStub(
  handler: (body: { questions: Record<string, unknown>; state: unknown }) => TypeSafeStubResult,
): Promise<{ url: string; requests: unknown[]; close(): Promise<void> }> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsedBody: { questions: Record<string, unknown>; state: unknown } = { questions: {}, state: undefined };
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        // leave the default; the handler sees an empty body
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsedBody });
      const result = handler(parsedBody);
      const send = () => {
        res.writeHead(result.status, {
          'Content-Type': 'application/json',
          ...(result.headers ?? {}),
        });
        res.end(result.body !== undefined ? JSON.stringify(result.body) : '');
      };
      if (result.delayMs) {
        setTimeout(send, result.delayMs);
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
