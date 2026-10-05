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
      const [rawPathname] = rawUrl.split('?');

      // r23 (D1) resolution order:
      // 1. '/' serves the fixture index.
      // 2. ONE trailing slash is stripped (the live index links end in '/').
      // 3. Anything containing '..' is rejected — guard unchanged; a
      //    backslash climb still needs '..' so it dies here too.
      // 4. Single-segment (unchanged rule) or ONE nested level. The '.html'
      //    suffix is optional in the URL (the bench task paths are
      //    extension-less); dots are excluded from nested segments, so '..'
      //    can never hide inside one, and three-plus segments fail both
      //    patterns (depth cap).
      // 5. Everything else 404s with the same body as before.
      const notFound = (): void => {
        res.statusCode = 404;
        res.end('Not found');
      };

      let relPath: string | null = null;
      let isCookieSpecialCase = false;
      if (rawPathname === '/') {
        relPath = 'index.html';
      } else {
        let pathname = rawPathname;
        if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
        if (!pathname.includes('..')) {
          const nestedMatch = /^\/([^/.]+)\/([^/.]+?)(?:\.html)?$/.exec(pathname);
          const nameMatch = nestedMatch ? null : /^\/([^/]+?)(?:\.html)?$/.exec(pathname);
          if (nameMatch) {
            relPath = `${nameMatch[1]}.html`;
            isCookieSpecialCase = nameMatch[1] === 'cookie';
          } else if (nestedMatch) {
            relPath = path.join(nestedMatch[1], `${nestedMatch[2]}.html`);
          }
        }
      }

      if (relPath === null) {
        notFound();
        return;
      }

      const filePath = path.join(pagesDir, relPath);

      let content: Buffer;
      try {
        content = await fs.readFile(filePath);
      } catch {
        notFound();
        return;
      }

      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (isCookieSpecialCase) {
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
