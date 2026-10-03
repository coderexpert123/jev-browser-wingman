import fs from 'node:fs';
const { summarizePairs } = await import('/home/user/jev-browser-wingman/dist/bench/run.js');
const R = '/home/user/jev-browser-wingman/bench/results/';
const p1 = JSON.parse(fs.readFileSync(R + '2026-10-03-102309.json', 'utf8'));
const p2 = JSON.parse(fs.readFileSync(R + '2026-10-03-104024.json', 'utf8'));
const p3 = JSON.parse(fs.readFileSync(R + '2026-10-03-104311.json', 'utf8'));
const dropped = p1.runs.filter((r) => r.task === 't6-dynamic-loading' && r.route === 'playwright');
const keep1 = p1.runs.filter((r) => !(r.task === 't6-dynamic-loading' && r.route === 'playwright'));
const order = (t) => parseInt(t.split('-')[0].slice(1), 10);
const runs = [...keep1, ...p3.runs, ...p2.runs].sort((a, b) => order(a.task) - order(b.task));
const med = (v) => { const s = [...v].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const summary = {};
for (const route of ['playwright', 'wingman', 'browse', 'forced']) {
  const rows = runs.filter((r) => r.route === route); if (!rows.length) continue;
  summary[route] = { success_rate: r6(rows.filter((r) => r.ok === true).length / rows.length), median_wall_ms: r6(med(rows.map((r) => r.wall_ms))), median_usd: r6(med(rows.map((r) => r.usd))), fallback_rate: r6(rows.filter((r) => (r.wingman?.fallback ?? 0) > 0).length / rows.length), wall_min_ms: r6(Math.min(...rows.map((r) => r.wall_ms))), wall_max_ms: r6(Math.max(...rows.map((r) => r.wall_ms))) };
}
const out = { date: 'r19-publish-merged', purpose: 'measure', harness_version: 3, model: p2.model, cap_usd: 3, phase_cap_usd: 31.532306, aborted: null, total_usd: r6(p1.total_usd + p2.total_usd + p3.total_usd), merged_from: ['2026-10-03-102309.json (aborted at 11 cells; 10 kept)', '2026-10-03-104024.json (48 cells, complete)', '2026-10-03-104311.json (10 cells, complete)'], merge_note: 'Single-invocation 68-cell run aborted on a harness cdp navigate timeout after 11 cells; remaining cells re-run in two invocations within the same cap; the first invocation\'s t6-dynamic-loading/playwright sample (usd ' + dropped[0].usd + ') is dropped to keep n=2. total_usd is the sum of all three invocations including the dropped cell.', summary, task_pairs: summarizePairs(runs), runs };
fs.writeFileSync('/tmp/claude-0/r17/bench/publish-merged.json', JSON.stringify(out, null, 2));
console.log('runs', runs.length, 'total_usd', out.total_usd);
