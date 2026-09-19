// WP-D2: cdp-connection tests.
// Uses the package's own ephemeral Chrome launcher (temp profile, port 0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchTestChrome } from './helpers/chrome.js';
import { CdpConnection, wsEndpointFrom } from '../src/adapters/cdp-connection.js';

test('resolves an http endpoint to the browser websocket', async () => {
  const browser = await launchTestChrome();
  try {
    const ws = await wsEndpointFrom(browser.endpoint);
    const ver = (await (await fetch(`${browser.endpoint}/json/version`)).json()) as {
      webSocketDebuggerUrl?: string;
    };
    assert.equal(ws, ver.webSocketDebuggerUrl);
    assert.match(ws, /^ws:/);
  } finally {
    await browser.close();
  }
});

test('rejects a command after its timeout', async () => {
  const browser = await launchTestChrome();
  try {
    const conn = await CdpConnection.connect(browser.endpoint);
    try {
      const { targetInfos } = await conn.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
        'Target.getTargets',
      );
      const page = targetInfos.find((t) => t.type === 'page');
      assert.ok(page, 'no page target');
      const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: page.targetId,
        flatten: true,
      });
      await assert.rejects(
        conn.send(
          'Runtime.evaluate',
          { expression: 'new Promise(() => {})', returnByValue: true, awaitPromise: true },
          sessionId,
          100,
        ),
        (err: unknown) => err instanceof Error && err.message === 'cdp timeout: Runtime.evaluate',
      );
    } finally {
      await conn.close();
    }
  } finally {
    await browser.close();
  }
});

test('close rejects pending commands', async () => {
  const browser = await launchTestChrome();
  try {
    const conn = await CdpConnection.connect(browser.endpoint);
    const { targetInfos } = await conn.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
      'Target.getTargets',
    );
    const page = targetInfos.find((t) => t.type === 'page');
    assert.ok(page, 'no page target');
    const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    const pending = conn.send(
      'Runtime.evaluate',
      { expression: 'new Promise(() => {})', returnByValue: true, awaitPromise: true },
      sessionId,
    );
    await conn.close();
    await assert.rejects(pending, (err: unknown) => err instanceof Error && err.message === 'cdp socket closed');
  } finally {
    await browser.close();
  }
});
