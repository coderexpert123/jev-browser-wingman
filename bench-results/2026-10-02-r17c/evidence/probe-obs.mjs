import { createRequire } from 'node:module';
const require = createRequire('/home/user/jev-browser-wingman/package.json');
const { chromium } = require('playwright-core');
const { createDriver } = await import('/home/user/jev-browser-wingman/dist/src/adapters/index.js');
const { launchEphemeralChrome } = await import('/home/user/jev-browser-wingman/dist/src/browser/ephemeral.js');
const eph = await launchEphemeralChrome({ headless: true });
const endpoint = eph.endpoint;
const b = await chromium.connectOverCDP(endpoint);
const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
for (const adapter of ['playwright', 'cdp']) {
  for (const url of ['about:blank', 'https://the-internet.herokuapp.com/key_presses']) {
    if (url !== 'about:blank') await page.goto(url, { waitUntil: 'load', timeout: 30000 }); else await page.goto('about:blank');
    const d = createDriver(adapter);
    try {
      await d.attach({ cdpEndpoint: endpoint });
      const pg = await d.pages(); const vis = pg.filter(p => p.visible);
      const o = await d.observe(vis[0].id);
      console.log(adapter, url, 'OK elements=', o.elements?.length, 'scrollY=', o.scrollY, 'focus=', JSON.stringify(o.focus));
    } catch (e) { console.log(adapter, url, 'THROW', String(e).slice(0, 220)); }
    try { await d.detach(); } catch {}
  }
}
await b.close().catch(() => {}); await eph.close();
