// Standalone geometry probe for the adapter-cdp F1-successor finding.
// Launches an ephemeral chrome via the product's own launcher, navigates to
// fixtures/pages/form.html, and prints computed rects + viewport width.
import { launchEphemeralChrome } from 'file:///home/user/jev-browser-wingman/dist/src/browser/ephemeral.js';
import { CdpConnection } from 'file:///home/user/jev-browser-wingman/dist/src/adapters/cdp-connection.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fixturePath = '/home/user/jev-browser-wingman/fixtures/pages/form.html';

async function main() {
  const launched = await launchEphemeralChrome({ headless: true });
  const conn = await CdpConnection.connect(launched.endpoint);
  const { targetInfos } = await conn.send('Target.getTargets');
  let pageId = targetInfos.find((t) => t.type === 'page')?.targetId;
  if (!pageId) {
    const created = await conn.send('Target.createTarget', { url: 'about:blank' });
    pageId = created.targetId;
  }
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId: pageId, flatten: true });
  await conn.send('Page.navigate', { url: pathToFileURL(fixturePath).href }, sessionId);
  await new Promise((r) => setTimeout(r, 500));
  const metrics = await conn.send('Page.getLayoutMetrics', {}, sessionId);
  console.log('layoutMetrics.cssVisualViewport:', JSON.stringify(metrics.cssVisualViewport));
  console.log('layoutMetrics.cssLayoutViewport:', JSON.stringify(metrics.cssLayoutViewport));
  const evalRes = await conn.send(
    'Runtime.evaluate',
    {
      expression: `
        JSON.stringify({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          bodyMarginLeft: getComputedStyle(document.body).marginLeft,
          rects: ['fullname','email','notes','country','continue','place'].map(id => {
            const el = document.getElementById(id);
            const r = el.getBoundingClientRect();
            return { id, x: r.x, y: r.y, w: r.width, h: r.height };
          })
        })
      `,
      returnByValue: true,
    },
    sessionId,
  );
  console.log('page eval:', evalRes.result.value);
  await conn.close();
  await launched.close();
}

main().catch((e) => {
  console.error('PROBE ERROR', e);
  process.exit(1);
});
