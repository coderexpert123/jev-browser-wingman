import { createRequire } from 'node:module';
const require = createRequire('/home/user/jev-browser-wingman/package.json');
const { chromium } = require('playwright-core');
const { createDriver } = await import('/home/user/jev-browser-wingman/dist/src/adapters/index.js');
const { launchEphemeralChrome } = await import('/home/user/jev-browser-wingman/dist/src/browser/ephemeral.js');
const { startFixtureServer } = await import('/home/user/jev-browser-wingman/dist/src/fixture-server.js');
const fx = await startFixtureServer();
const eph = await launchEphemeralChrome({ headless: true });
const b = await chromium.connectOverCDP(eph.endpoint);
const page = b.contexts()[0].pages()[0] || await b.contexts()[0].newPage();
await page.goto(fx.baseUrl ? fx.baseUrl + '/double-click.html' : fx.url + '/double-click.html');
for (const adapter of ['playwright', 'cdp']) {
  const d = createDriver(adapter);
  await d.attach({ cdpEndpoint: eph.endpoint });
  const pg = (await d.pages()).filter(p => p.visible);
  const o = await d.observe(pg[0].id);
  console.log(adapter, 'elements', JSON.stringify(o.elements.map(e => ({ id: e.id, role: e.role, name: e.name, tag: e.tag }))));
  await d.detach();
}
// by hand: does a real dblclick satisfy the oracle?
await page.dblclick('#dbl-target').catch(async () => { const t = await page.evaluate(() => document.body.innerHTML.slice(0, 400)); console.log('no #dbl-target; body:', t); });
console.log('oracle-by-hand', await page.evaluate(() => document.querySelector('#dbl-count')?.textContent));
await b.close().catch(() => {}); await eph.close(); await fx.close?.();
