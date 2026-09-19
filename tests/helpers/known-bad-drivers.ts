// WP-F2: known-bad driver wrappers (§ WP-F2 item 7). Each wraps a real
// driver and performs its defect through its own raw CDP call, so the
// doctor checks have a case that provably fails.

import type { AttachTarget, Driver, Op } from '../../src/contract/types.js';
import { CdpConnection } from '../../src/adapters/cdp-connection.js';

function endpointOf(target: AttachTarget): string | null {
  return 'cdpEndpoint' in target ? target.cdpEndpoint : null;
}

/** Detach closes one page target — the after-fingerprint loses a page. */
export function closePageOnDetach(driver: Driver): Driver {
  let conn: CdpConnection | null = null;
  let targetId: string | null = null;
  return {
    name: driver.name + '-close-page-on-detach',
    async attach(target: AttachTarget) {
      await driver.attach(target);
      const endpoint = endpointOf(target);
      if (!endpoint) return;
      conn = await CdpConnection.connect(endpoint);
      const targets = await conn.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
      const page = targets.targetInfos.find((t) => t.type === 'page');
      targetId = page?.targetId ?? null;
    },
    async pages() {
      return driver.pages();
    },
    async observe(pageId) {
      return driver.observe(pageId);
    },
    async act(pageId, elementId, op: Op, value?: string) {
      return driver.act(pageId, elementId, op, value);
    },
    async settle(pageId, budgetMs) {
      return driver.settle(pageId, budgetMs);
    },
    onDialog(handler) {
      driver.onDialog(handler);
    },
    async detach() {
      try {
        if (conn && targetId) {
          await conn.send('Target.closeTarget', { targetId });
        }
      } finally {
        if (conn) {
          await conn.close().catch(() => {});
          conn = null;
        }
      }
      await driver.detach();
    },
  };
}

/** Attach injects a main-world global on the first page — the globals hash changes. */
export function injectGlobal(driver: Driver): Driver {
  return {
    name: driver.name + '-inject-global',
    async attach(target: AttachTarget) {
      await driver.attach(target);
      const endpoint = endpointOf(target);
      if (!endpoint) return;
      const conn = await CdpConnection.connect(endpoint);
      try {
        const targets = await conn.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
        const page = targets.targetInfos.find((t) => t.type === 'page');
        if (!page) return;
        const session = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: page.targetId,
          flatten: true,
        });
        try {
          // A unique name per attach: a second attach must change the
          // globals hash again (the doctor runs several attaches in a row).
          const name = `__wingmanInjected${Date.now()}${Math.floor(Math.random() * 1e9)}`;
          await conn.send(
            'Runtime.evaluate',
            { expression: `globalThis[${JSON.stringify(name)}] = true; "ok"`, returnByValue: true },
            session.sessionId,
          );
        } finally {
          await conn.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
        }
      } finally {
        await conn.close().catch(() => {});
      }
    },
    async pages() {
      return driver.pages();
    },
    async observe(pageId) {
      return driver.observe(pageId);
    },
    async act(pageId, elementId, op: Op, value?: string) {
      return driver.act(pageId, elementId, op, value);
    },
    async settle(pageId, budgetMs) {
      return driver.settle(pageId, budgetMs);
    },
    onDialog(handler) {
      driver.onDialog(handler);
    },
    async detach() {
      await driver.detach();
    },
  };
}

/** Attach creates a browser context — Target.getBrowserContexts changes. */
export function createContextOnAttach(driver: Driver): Driver {
  let conn: CdpConnection | null = null;
  return {
    name: driver.name + '-create-context-on-attach',
    async attach(target: AttachTarget) {
      await driver.attach(target);
      const endpoint = endpointOf(target);
      if (!endpoint) return;
      conn = await CdpConnection.connect(endpoint);
      await conn.send('Target.createBrowserContext');
    },
    async pages() {
      return driver.pages();
    },
    async observe(pageId) {
      return driver.observe(pageId);
    },
    async act(pageId, elementId, op: Op, value?: string) {
      return driver.act(pageId, elementId, op, value);
    },
    async settle(pageId, budgetMs) {
      return driver.settle(pageId, budgetMs);
    },
    onDialog(handler) {
      driver.onDialog(handler);
    },
    async detach() {
      try {
        await driver.detach();
      } finally {
        if (conn) {
          await conn.close().catch(() => {});
          conn = null;
        }
      }
    },
  };
}
