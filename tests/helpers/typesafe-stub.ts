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
