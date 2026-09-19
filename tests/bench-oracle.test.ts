// WP-H: oracle evaluation against a real headless Chrome and a fixture page
// (temp profile, port 0, through the package's ephemeral launcher).

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchTestChrome } from './helpers/chrome.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { startFixtureServer } from '../src/fixture-server.js';
import { evaluateOracle } from '../bench/oracle.js';

// Attach to a page target BEFORE navigating it: a session attached after
// Target.createTarget has already navigated stays bound to the page's
// pre-navigation context and evaluates against about:blank. The harness's
// resetPages uses the same attach-then-navigate order.
async function openFormPage(endpoint: string, pageUrl: string): Promise<{ conn: CdpConnection; targetId: string }> {
  const conn = await CdpConnection.connect(endpoint);
  const { targetInfos } = await conn.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
    'Target.getTargets',
  );
  let page = targetInfos.find((t) => t.type === 'page');
  let sessionId: string;
  if (page) {
    sessionId = (await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true }))
      .sessionId;
  } else {
    page = { targetId: (await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId, type: 'page', url: 'about:blank' };
    sessionId = (await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true }))
      .sessionId;
  }
  await conn.send('Page.navigate', { url: pageUrl }, sessionId);
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    ready = await evaluateOracle(conn, page.targetId, "document.readyState === 'complete'");
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  return { conn, targetId: page.targetId };
}

test('true only when the expression returns true', async () => {
  const browser = await launchTestChrome();
  const server = await startFixtureServer();
  try {
    const { conn, targetId } = await openFormPage(browser.endpoint, `${server.url}/form.html`);
    try {
      assert.equal(
        await evaluateOracle(conn, targetId, "document.querySelectorAll('input').length > 0"),
        true,
      );
      assert.equal(await evaluateOracle(conn, targetId, '1 + 1 === 2'), true);
      assert.equal(await evaluateOracle(conn, targetId, '1 === 2'), false);
      assert.equal(await evaluateOracle(conn, targetId, "'0'"), false);
      assert.equal(await evaluateOracle(conn, targetId, 'undefined'), false);
    } finally {
      await conn.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test('a throwing expression is false', async () => {
  const browser = await launchTestChrome();
  const server = await startFixtureServer();
  try {
    const { conn, targetId } = await openFormPage(browser.endpoint, `${server.url}/form.html`);
    try {
      assert.equal(
        await evaluateOracle(conn, targetId, "(() => { throw new Error('boom'); })()"),
        false,
      );
      assert.equal(await evaluateOracle(conn, targetId, '('), false);
    } finally {
      await conn.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
