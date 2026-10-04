import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { packageRoot } from './package-root.js';

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startFixtureServer(opts?: { port?: number }): Promise<FixtureServer> {
  const root = packageRoot();
  const pagesDir = path.join(root, 'fixtures', 'pages');

  const server = http.createServer((req, res) => {
    void (async () => {
      const rawUrl = req.url ?? '/';
      const [pathname] = rawUrl.split('?');

      // Reject anything containing '..' or a second slash beyond the leading one.
      const withoutLeadingSlash = pathname.startsWith('/') ? pathname.slice(1) : pathname;
      const isTraversal = pathname.includes('..');
      const hasSecondSlash = withoutLeadingSlash.includes('/');
      const nameMatch = /^\/([^/]+)\.html$/.exec(pathname);

      if (isTraversal || hasSecondSlash || !nameMatch) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const name = nameMatch[1];
      const filePath = path.join(pagesDir, `${name}.html`);

      let content: Buffer;
      try {
        content = await fs.readFile(filePath);
      } catch {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (name === 'cookie') {
        res.setHeader('Set-Cookie', 'wingman_fixture=1; Max-Age=86400; Path=/; SameSite=Lax');
      }
      // r21 (P-1, D13): `?delay=<ms>` holds the response before res.end — a
      // navigation the click must not wait on. Clamped to [0, 30000] ms so a
      // bad argument can never wedge a suite; the 404 paths above stay
      // immediate.
      const delayMatch = /[?&]delay=(\d{1,5})/.exec(rawUrl);
      const delayMs = delayMatch ? Math.max(0, Math.min(30_000, Number(delayMatch[1]))) : 0;
      res.statusCode = 200;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      res.end(content);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts?.port ?? 0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server failed to bind a port');
  }
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
