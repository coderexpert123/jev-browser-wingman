const { createDefaultAsk } = await import('/home/user/jev-browser-wingman/dist/src/core/jev-client.js');
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) { console.log('no key'); process.exit(1); }
const oldAsk = createDefaultAsk({ apiKey, fetchFn: fetch });
const newAsk = createDefaultAsk({ apiKey });
const req = { state: { page: 'a simple page with one button labelled Continue', url: 'example.test' }, questions: { done: { type: 'noul', instructions: 'Is the page showing a success confirmation?' } } };
const rows = [];
for (let i = 0; i < 12; i++) {
  const arm = i % 2 === 0 ? 'old' : 'new';
  const ask = arm === 'old' ? oldAsk : newAsk;
  const r = await ask(req, { purpose: 'keepalive-probe', timeoutMs: 20000 });
  rows.push({ i, arm, ok: r.ok, ms: r.latencyMs, retries: r.retries, tok: r.ok ? r.usage.inputTokens + '/' + r.usage.outputTokens : r.error });
  console.log(JSON.stringify(rows[rows.length - 1]));
  if (i < 11) await new Promise((res) => setTimeout(res, 8000));
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const arm of ['old', 'new']) { const v = rows.filter((r) => r.arm === arm && r.ok).map((r) => r.ms); console.log(arm, 'n=', v.length, 'min', Math.min(...v), 'median', med(v), 'max', Math.max(...v), 'first', v[0], 'rest-median', med(v.slice(1))); }
