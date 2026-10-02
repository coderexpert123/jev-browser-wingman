import { chromium } from 'playwright-core';
import { startFixtureServer } from '/home/user/jev-browser-wingman/dist/src/fixture-server.js';
import { buildEnumerateExpression } from '/home/user/jev-browser-wingman/dist/src/core/page-scripts.js';
const server = await startFixtureServer(); const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage(); await page.goto(server.url + '/hidden-controls.html');
const obs = await page.evaluate(buildEnumerateExpression({ maxElements: 240, maxTextChars: 3000 }));
for (const e of obs.elements.filter(x => ['t1','t2','t6','t7'].includes(x.htmlId))) console.log(JSON.stringify({htmlId:e.htmlId,name:e.name,path:e.path,controlPath:e.controlPath,state:e.state,role:e.role}));
const t1 = obs.elements.find(x => x.htmlId === 't1');
await page.click(t1.path);                       // what a click act on the proxy does
console.log('after click on proxy path', t1.path, '-> #t1.checked =', await page.evaluate(() => document.getElementById('t1').checked));
await page.evaluate(() => { document.getElementById('t1').checked = false; });
await page.click(t1.controlPath, { force: true }); // click on the input itself
console.log('after FORCE click on controlPath', t1.controlPath, '-> #t1.checked =', await page.evaluate(() => document.getElementById('t1').checked));
const t6 = obs.elements.find(x => x.htmlId === 't6');
await page.click(t6.path); console.log('label[for] proxy (t6) click -> #t6.checked =', await page.evaluate(() => document.getElementById('t6').checked));
await browser.close(); await server.close();
