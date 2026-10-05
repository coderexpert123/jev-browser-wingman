// r23 WP-B — fixture-server path-rule pins (D1). Plain node fetch against
// startFixtureServer; NO Chrome. Each pin asserts status + a body substring
// or header. Fail-first (2026-10-05, recorded in the round report): run
// against the UNMODIFIED server, the 8 new-behavior pins RED (404 today):
// `/`, `/status_codes/404`, `/dynamic_loading/2`, `/add_remove_elements/`,
// `/cookie`, `/cookie/`, the delay pin and the content-type pin. The
// old-rule pins (`/checkboxes.html`, `/missing.html`) and the traversal
// pins stay green. `/cookie` is NEW behavior too — the old rule required
// `.html`, so `/cookie` 404'd under it; it is distinguished from the other
// red pins only by exercising the Set-Cookie special case.
//
// Traversal note: WHATWG URL parsing (what `fetch` uses) normalizes `..`
// segments CLIENT-side (`/a/../b` is sent as `/b`), so the two traversal
// pins go over a raw node:http request whose path reaches the server
// verbatim — a passing pin there proves the guard saw the dots. `/a/../
// checkboxes.html` is the discriminating leg: normalized client-side it
// would return 200, so a 404 can only come from the server-side `..` guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFixtureServer } from '../src/fixture-server.js';

interface RawResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;

test.before(async () => {
  fixture = await startFixtureServer();
});

test.after(async () => {
  await fixture.close();
});

async function get(pathname: string): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`${fixture.url}${pathname}`);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

function getRaw(pathname: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: fixture.port, path: pathname }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

// ---- new rules (D1) ----

test('root / serves the fixture index', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /Welcome to the-internet/);
});

test('nested /status_codes/404 serves the nested fixture', async () => {
  const r = await get('/status_codes/404');
  assert.equal(r.status, 200);
  assert.match(r.body, /returned a 404 status code/);
});

test('nested /dynamic_loading/2 serves the nested fixture', async () => {
  const r = await get('/dynamic_loading/2');
  assert.equal(r.status, 200);
  assert.match(r.body, /Example 2/);
});

test('trailing slash /add_remove_elements/ serves the page', async () => {
  const r = await get('/add_remove_elements/');
  assert.equal(r.status, 200);
  assert.match(r.body, /Add Element/);
});

test('/cookie/ normalization feeds the cookie special case', async () => {
  const r = await get('/cookie/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') ?? '', /wingman_fixture=1/);
});

test('?delay holds the response on a real page', async () => {
  const started = Date.now();
  const r = await get('/checkboxes?delay=80');
  const elapsed = Date.now() - started;
  assert.equal(r.status, 200);
  assert.ok(elapsed >= 70, `elapsed ${elapsed}ms < 70ms`);
});

test('nested fixture content-type is text/html; charset=utf-8', async () => {
  const r = await get('/status_codes/404');
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
});

// ---- unchanged rules (no-regression) ----

test('/cookie keeps the Set-Cookie special case', async () => {
  const r = await get('/cookie');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') ?? '', /wingman_fixture=1/);
});

test('/cookie.html keeps the Set-Cookie special case (the old URL, unchanged)', async () => {
  const r = await get('/cookie.html');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') ?? '', /wingman_fixture=1/);
});

test('existing single-segment .html serving is unchanged', async () => {
  const r = await get('/checkboxes.html');
  assert.equal(r.status, 200);
  assert.match(r.body, /id='checkboxes'/);
});

test('traversal /../secret.html is rejected (raw path, verbatim)', async () => {
  const r = await getRaw('/../secret.html');
  assert.equal(r.status, 404);
});

test('traversal /a/../checkboxes.html is rejected (raw path, verbatim)', async () => {
  const r = await getRaw('/a/../checkboxes.html');
  assert.equal(r.status, 404);
});

test('three-segment depth /a/b/checkboxes.html is rejected', async () => {
  const r = await get('/a/b/checkboxes.html');
  assert.equal(r.status, 404);
});

test('missing file /missing.html is 404', async () => {
  const r = await get('/missing.html');
  assert.equal(r.status, 404);
});
