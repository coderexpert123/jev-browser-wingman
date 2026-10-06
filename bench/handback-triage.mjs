#!/usr/bin/env node
// Hand-back triage (r24). Mechanical, deterministic classification of every
// non-done, non-login, non-error browse_step end in a bench results file, using
// the run's log slice for per-round evidence. Run IDENTICALLY on r23b and r24.
//
//   node bench/handback-triage.mjs --results <results.json> --log <log-slice.jsonl> [--json <out.json>]
//
// Alignment: the forced cells' handoff_records (results order) must match a
// CONTIGUOUS run of browse_step log records on (status, reason, rounds, steps).
// The script searches every offset; exactly one must match, else exit 2.
// (r23b: the slice starts with 5 part-1 records, so the offset is 5.)
//
// Classes (first match wins, on the END record of each hand-back):
//   landed-not-advanced  the end clause has an own act whose annotated result
//                        landed (LANDED set) — WP1's target
//   press-split          the end clause names one key (KEY_RE) and has no landed own act — WP3
//   not-ready            why not-ready, end round rightPageP >= 0.5 and errorP < 0.3 — WP2
//   error-page           why not-ready/wrong-page/no-match with end round errorP >= 0.3
//                        or rightPageP < 0.5 (genuine-shaped)
//   stuck-exhausted      the end record ran a stuck round (stuck=back|open_*) on the end clause — WP7
//   target-uncertain     why no-match / low-confidence / multi-match (floor, verb misfit,
//                        step wording, dialog split) — WP4/WP5/WP6
//   other                anything else (no-value, repeat, target-covered, budget-*, ...)
// Plain-English provenance: tool calls per run = sum(tool_use_counts) — the results
// file carries no caller turn count, so tool calls are the turn proxy.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// r24 telemetry flags (PhaseRound) set ONLY on the round where an r24 rule fired.
export const R24_FLAGS = ['sameDocEvidence', 'finalNavEvidence', 'hoverEvidence', 'waitEvidence', 'readySkipped', 'pressFocusSum', 'verbCoerced', 'stuckSecond'];
const LANDED = new Set(['page changed', 'element gone', 'focus changed', 'filled', 'checked', 'unchecked', 'uploaded']);
const KEY_RE =
  /\b(?:press|hit|push)\s+(?:the\s+)?(arrow\s*down|arrow\s*up|arrow\s*left|arrow\s*right|shift\s*tab|shift\s*\+\s*tab|ctrl\s*\+\s*a|cmd\s*\+\s*a|select\s*all|backspace|space|space\s*bar|escape|esc|enter|return|tab|down|up|left|right)\b/gi;

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results' || a === '--log' || a === '--json') o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.results || !o.log) throw new Error('usage: --results <file> --log <file> [--json <out>]');
  return o;
}

const isLanded = (r) => typeof r === 'string' && (LANDED.has(r) || r.startsWith('selected: '));
const keyNamed = (t) => Array.from(String(t ?? '').matchAll(KEY_RE)).length === 1;
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r6 = (x) => (x === null ? null : Math.round(x * 1e6) / 1e6);

/** Own acts per round: an act round's step_text owns the act; its result is the
 * NEXT round's historyResult when that round carries one. Waits carry none. */
export function ownLandedActs(rec, clause) {
  const rounds = rec.phases?.rounds ?? [];
  let n = 0;
  for (let i = 0; i < rounds.length - 1; i++) {
    const p = rounds[i];
    if (p.kind !== 'act' || p.stuck !== undefined) continue;
    if (p.recover !== undefined && p.recover !== 'continue' && p.recover !== 'give-up') continue;
    if (p.step_text !== clause) continue;
    if (isLanded(rounds[i + 1].historyResult)) n += 1;
  }
  return n;
}

export function classify(rec) {
  const rounds = rec.phases?.rounds ?? [];
  const end = rounds[rounds.length - 1] ?? {};
  const clause = end.step_text;
  const why = rec.step_review?.why;
  if (clause !== undefined && ownLandedActs(rec, clause) > 0) return 'landed-not-advanced';
  if (keyNamed(clause)) return 'press-split';
  const errorP = typeof end.errorP === 'number' ? end.errorP : 0;
  const rightP = typeof end.rightPageP === 'number' ? end.rightPageP : 1;
  if (why === 'not-ready' && rightP >= 0.5 && errorP < 0.3) return 'not-ready';
  if ((why === 'not-ready' || why === 'wrong-page' || why === 'no-match') && (errorP >= 0.3 || rightP < 0.5)) return 'error-page';
  if (rounds.some((p) => p.step_text === clause && typeof p.stuck === 'string' && p.stuck !== 'give-up')) return 'stuck-exhausted';
  if (why === 'no-match' || why === 'low-confidence' || why === 'multi-match') return 'target-uncertain';
  return 'other';
}

export function align(forced, logRecs) {
  const want = forced.flatMap((run) => run.handoff_records ?? []);
  const key = (h) => `${h.status}|${h.reason}|${h.rounds}|${h.steps}`;
  const logKey = (r) => `${r.status}|${r.reason}|${(r.phases?.rounds ?? []).length}|${r.steps}`;
  const hits = [];
  for (let off = 0; off + want.length <= logRecs.length; off++) {
    let ok = true;
    for (let i = 0; i < want.length && ok; i++) ok = key(want[i]) === logKey(logRecs[off + i]);
    if (ok) hits.push(off);
  }
  return { offset: hits.length === 1 ? hits[0] : null, hits, n: want.length };
}

export function triage(results, logText) {
  const logRecs = logText
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((r) => r && r.tool === 'browse_step');
  const forced = results.runs.filter((r) => r.route === 'forced');
  const al = align(forced, logRecs);
  if (al.offset === null) {
    throw Object.assign(new Error(`alignment failed: ${al.hits.length} matching offsets for ${al.n} handoff records in ${logRecs.length} log records`), { code: 2 });
  }
  let idx = al.offset;
  const cells = [];
  const classes = {};
  const handbacks = [];
  const flags = [];
  const rep = {};
  for (const run of forced) {
    rep[run.task] = (rep[run.task] ?? 0) + 1;
    const recs = (run.handoff_records ?? []).map(() => logRecs[idx++]);
    let hb = 0;
    // r24 false-advance audit: every round where an r24 rule fired; SUSPECT when a
    // LATER call of the same cell runs a round on the same clause text (the caller
    // re-did that clause, so it did not believe it was done). Suspects need a human read.
    recs.forEach((rec, k) => {
      (rec.phases?.rounds ?? []).forEach((p, ri) => {
        for (const f of R24_FLAGS) {
          if (p[f] === undefined) continue;
          const later = recs.slice(k + 1).some((r2) => (r2.phases?.rounds ?? []).some((q) => q.step_text === p.step_text));
          flags.push({ task: run.task, rep: rep[run.task], call: k + 1, round: ri + 1, flag: f, suspect: later });
        }
      });
    });
    for (let k = 0; k < recs.length; k++) {
      const rec = recs[k];
      if (rec.status === 'done' || rec.status === 'login' || rec.status === 'error') continue;
      const c = classify(rec);
      classes[c] = (classes[c] ?? 0) + 1;
      hb += 1;
      handbacks.push({ task: run.task, rep: rep[run.task], call: k + 1, end: `${rec.status}/${rec.reason}`, why: rec.step_review?.why ?? null, class: c });
    }
    cells.push({
      task: run.task,
      rep: rep[run.task],
      ok: run.ok,
      calls: recs.length,
      handbacks: hb,
      wingman_done: recs.some((r) => r.status === 'done'),
      tool_calls: Object.values(run.tool_use_counts ?? {}).reduce((s, v) => s + v, 0),
      usd: run.usd,
    });
  }
  const byRoute = {};
  for (const route of [...new Set(results.runs.map((r) => r.route))]) {
    const rs = results.runs.filter((r) => r.route === route);
    const tc = rs.map((r) => Object.values(r.tool_use_counts ?? {}).reduce((s, v) => s + v, 0));
    byRoute[route] = {
      runs: rs.length,
      ok: rs.filter((r) => r.ok).length,
      usd_total: r6(rs.reduce((s, r) => s + r.usd, 0)),
      usd_median: r6(median(rs.map((r) => r.usd))),
      tool_calls_total: tc.reduce((s, v) => s + v, 0),
      tool_calls_median: median(tc),
      tool_calls_mean: r6(tc.reduce((s, v) => s + v, 0) / Math.max(1, tc.length)),
      wall_median_ms: median(rs.map((r) => r.wall_ms)),
    };
  }
  return {
    offset: al.offset,
    handback_total: handbacks.length,
    classes,
    no_wingman_done_cells: cells.filter((c) => !c.wingman_done).map((c) => `${c.task}#${c.rep}`),
    byRoute,
    handbacks,
    flags,
    cells,
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  const results = JSON.parse(fs.readFileSync(opts.results, 'utf8'));
  let out;
  try {
    out = triage(results, fs.readFileSync(opts.log).toString('utf8'));
  } catch (e) {
    process.stderr.write(`HANDBACK-TRIAGE: ${e.message}\n`);
    process.exit(e.code ?? 1);
  }
  const lines = [];
  lines.push(`HANDBACK-TRIAGE results=${opts.results} offset=${out.offset} handbacks=${out.handback_total}`);
  for (const [c, n] of Object.entries(out.classes).sort()) lines.push(`class ${c} ${n}`);
  lines.push(`no_wingman_done_cells ${out.no_wingman_done_cells.length} ${out.no_wingman_done_cells.join(' ')}`);
  for (const [route, s] of Object.entries(out.byRoute)) {
    lines.push(`route ${route} runs=${s.runs} ok=${s.ok} usd_total=${s.usd_total} usd_median=${s.usd_median} tool_calls_total=${s.tool_calls_total} tool_calls_median=${s.tool_calls_median} tool_calls_mean=${s.tool_calls_mean} wall_median_ms=${s.wall_median_ms}`);
  }
  const flagCounts = {};
  for (const f of out.flags) flagCounts[f.flag] = (flagCounts[f.flag] ?? 0) + 1;
  lines.push(`r24_flags ${out.flags.length} ${Object.entries(flagCounts).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`.trimEnd());
  const suspects = out.flags.filter((f) => f.suspect);
  lines.push(`r24_flag_suspects ${suspects.length} ${suspects.map((f) => `${f.task}#${f.rep}/call${f.call}/r${f.round}/${f.flag}`).join(' ')}`.trimEnd());
  for (const h of out.handbacks) lines.push(`handback ${h.task}#${h.rep} call${h.call} ${h.end} why=${h.why} class=${h.class}`);
  process.stdout.write(lines.join('\n') + '\n');
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(out, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
