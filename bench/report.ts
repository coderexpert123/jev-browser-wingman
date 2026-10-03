// r18 D9: the results-file reporter (measurement-only; no price table).
//
//   node dist/bench/report.js <results.json>
//
// Prints one header line, one `cell` line per run in file order (RAW caller
// in/out/cache-read/cache-write tokens plus the Jev calls/input tokens), one
// `route` line per route present with the min/median/max spread, one `phases`
// line per run that carries a non-null `wingman_phases` record, and a legend.
// Exit 2 with a stderr line when the positional file is missing or unreadable.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BenchResultsFile, BenchRunRecord } from './run.js';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Numbers: wall_s 1 decimal; usd as recorded; tokens integers.
function wallS(wallMs: number): string {
  return (wallMs / 1000).toFixed(1);
}

function cellLine(run: BenchRunRecord): string {
  const rounds = run.wingman_phases?.rounds ?? 0;
  return [
    'cell',
    run.task,
    run.route,
    `ok=${run.ok === true ? 'true' : 'false'}`,
    `wall_s=${wallS(run.wall_ms)}`,
    `usd=${run.usd}`,
    `llm_in=${run.llm.input_tokens}`,
    `llm_out=${run.llm.output_tokens}`,
    `llm_cache_read=${run.llm.cache_read_tokens}`,
    `llm_cache_write=${run.llm.cache_write_tokens}`,
    `ts_calls=${run.typesafe.calls}`,
    `ts_in=${run.typesafe.input_tokens}`,
    `ts_out=${run.typesafe.output_tokens}`,
    `fallbacks=${run.wingman.fallback}`,
    `rounds=${rounds}`,
  ].join(' ');
}

// First-seen order in the file, so the report is deterministic per results
// file regardless of which routes ran.
function routeLines(runs: BenchRunRecord[]): string[] {
  const order: string[] = [];
  const byRoute = new Map<string, BenchRunRecord[]>();
  for (const run of runs) {
    let rows = byRoute.get(run.route);
    if (!rows) {
      rows = [];
      byRoute.set(run.route, rows);
      order.push(run.route);
    }
    rows.push(run);
  }
  const lines: string[] = [];
  for (const name of order) {
    const rows = byRoute.get(name)!;
    const oks = rows.filter((r) => r.ok === true).length;
    const walls = rows.map((r) => r.wall_ms);
    const usds = rows.map((r) => r.usd);
    lines.push([
      'route',
      name,
      `n=${rows.length}`,
      `ok=${oks}/${rows.length}`,
      `wall_s min=${wallS(Math.min(...walls))} med=${wallS(median(walls))} max=${wallS(Math.max(...walls))}`,
      `usd min=${Math.min(...usds)} med=${median(usds)} max=${Math.max(...usds)}`,
    ].join(' '));
  }
  return lines;
}

// r19 D9 (M-2): one pair line per task x route present in the file's
// `task_pairs` field (per-task x-route min/med/max over repeats), rendered
// after the `route` lines. Old results files without the field render no
// pair lines at all.
function pairLines(file: BenchResultsFile): string[] {
  if (!file.task_pairs) return [];
  const lines: string[] = [];
  for (const [task, byRoute] of Object.entries(file.task_pairs)) {
    for (const [route, p] of Object.entries(byRoute)) {
      lines.push([
        'pair',
        task,
        route,
        `n=${p.n}`,
        `ok=${p.ok}/${p.n}`,
        `wall_s min=${wallS(p.wall_min_ms)} med=${wallS(p.wall_med_ms)} max=${wallS(p.wall_max_ms)}`,
        `usd_med=${p.median_usd}`,
      ].join(' '));
    }
  }
  return lines;
}

function phasesLine(run: BenchRunRecord): string | null {
  const phases = run.wingman_phases;
  if (!phases) return null;
  // Tolerance for pre-r18 (harness 2) records: every r18-added numeric reads
  // 0 when absent (the legend's "0 when the bucket is empty" convention), and
  // an absent round_kinds puts the whole round count in `other`, so the R3
  // invariant rounds == sum(round_kinds) holds for old files too.
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const kinds = phases.round_kinds;
  const kind = (name: keyof NonNullable<BenchRunRecord['wingman_phases']>['round_kinds']): number =>
    num(kinds?.[name]);
  const other = kinds ? kind('other') : phases.rounds;
  return [
    `phases ${run.task}/${run.route}`,
    `attach=${num(phases.attach_ms)}`,
    `first_observe=${num(phases.first_observe_ms)}`,
    `observe=${num(phases.observe_ms)}+${num(phases.observe_sum_ms)}`,
    `jev=${num(phases.jev_ms)}+${num(phases.jev_sum_ms)}`,
    `jev first/rest=${num(phases.jev_first_ms)}/${num(phases.jev_rest_ms)}`,
    `act=${num(phases.act_ms)}+${num(phases.act_sum_ms)}`,
    `settle=${num(phases.settle_ms)}+${num(phases.settle_sum_ms)}`,
    `kinds act=${kind('act')} advance=${kind('advance')} wait=${kind('wait')} bounce=${kind('bounce')} done=${kind('done')} error=${kind('error')} other=${other}`,
  ].join(' ');
}

// The pure renderer; the entry point writes exactly this text to stdout.
export function renderReport(file: BenchResultsFile, fileName: string): string {
  const lines: string[] = [
    `BENCH REPORT ${fileName} purpose=${file.purpose} model=${file.model} harness=${file.harness_version} aborted=${file.aborted} total_usd=${file.total_usd} runs=${file.runs.length}`,
  ];
  for (const run of file.runs) lines.push(cellLine(run));
  lines.push(...routeLines(file.runs));
  lines.push(...pairLines(file));
  for (const run of file.runs) {
    const line = phasesLine(run);
    if (line) lines.push(line);
  }
  lines.push(
    'legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty; pair lines aggregate repeats',
  );
  return lines.join('\n') + '\n';
}

export function reportMain(argv: string[]): number {
  if (argv.length !== 1) {
    process.stderr.write('usage: node dist/bench/report.js <results.json>\n');
    return 2;
  }
  const file = argv[0];
  let parsed: BenchResultsFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BenchResultsFile;
  } catch (err) {
    process.stderr.write(`bench report: cannot read ${file}: ${(err as Error).message}\n`);
    return 2;
  }
  process.stdout.write(renderReport(parsed, path.basename(file)));
  return 0;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  process.exit(reportMain(process.argv.slice(2)));
}
