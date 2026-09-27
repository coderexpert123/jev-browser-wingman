// WP-F F5: the verdict tool for the forced-route bench cells.
//
//   node dist/bench/forced-verdict.js [--validity|--smoke] <results.json>
//
// Reads one bench results file and prints one `FORCED-VERDICT: ` line per
// check; exit 0 on PASS, 1 on FAIL. Like bench/run.ts this is a measurement
// harness, never run by a builder: the operator runs it on a cloud bench
// cell (spec § 10.B).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { BenchRunRecord } from './run.js';

export type VerdictMode = 'default' | 'validity' | 'smoke';

export interface VerdictResult {
  /** Every printed line, each with the exact `FORCED-VERDICT: ` prefix. */
  lines: string[];
  /** True only when every non-informational check passes. */
  pass: boolean;
  /** The names of the checks that failed. */
  failures: string[];
}

interface ForcedStats {
  forcedRuns: BenchRunRecord[];
  playwrightRuns: BenchRunRecord[];
  forcedRecords: NonNullable<BenchRunRecord['handoff_records']> | [];
}

function statsOf(runs: BenchRunRecord[]): ForcedStats {
  const forcedRuns = runs.filter((r) => r.route === 'forced');
  const playwrightRuns = runs.filter((r) => r.route === 'playwright');
  const forcedRecords = forcedRuns.flatMap((r) => r.handoff_records ?? []);
  return { forcedRuns, playwrightRuns, forcedRecords };
}

function frac(a: number, n: number): number {
  return n === 0 ? 0 : a / n;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function two(n: number): string {
  return n.toFixed(2);
}

/** Pure verdict over one results file. Default mode prints the full § 6 WP-F
 * line table; `validity` and `smoke` print their single informational line. */
export function forcedVerdict(file: { runs?: BenchRunRecord[] }, mode: VerdictMode = 'default'): VerdictResult {
  const runs = file.runs ?? [];
  const { forcedRuns, playwrightRuns, forcedRecords } = statsOf(runs);
  const failures: string[] = [];
  const lines: string[] = [];

  if (mode === 'validity') {
    const b = playwrightRuns.filter((r) => r.ok === true).length;
    const m = playwrightRuns.length;
    const ok = b >= 2 && m >= 3;
    lines.push(`FORCED-VERDICT: validity playwright=${b}/${m}`);
    if (!ok) failures.push('validity');
    return { lines, pass: failures.length === 0, failures };
  }

  if (mode === 'smoke') {
    const needsConfirmation = forcedRecords.filter((r) => r.status === 'needs_confirmation').length;
    const ok = forcedRuns.every((r) => r.ok === true);
    lines.push(`FORCED-VERDICT: smoke ok=${ok} needs_confirmation=${needsConfirmation}`);
    return { lines, pass: true, failures };
  }

  // completion: forced completion rate must not trail the playwright control.
  const a = forcedRuns.filter((r) => r.ok === true).length;
  const n = forcedRuns.length;
  const b = playwrightRuns.filter((r) => r.ok === true).length;
  const m = playwrightRuns.length;
  lines.push(`FORCED-VERDICT: completion forced=${a}/${n} playwright=${b}/${m}`);
  if (!(frac(a, n) >= frac(b, m))) failures.push('completion');

  // wingman-share: wingman acts over all browsing acts in the forced cells.
  const wingmanActs = forcedRuns.reduce((s, r) => s + (r.wingman_acts ?? 0), 0);
  const rawActs = forcedRuns.reduce((s, r) => s + (r.raw_acts ?? 0), 0);
  const share = wingmanActs + rawActs === 0 ? null : wingmanActs / (wingmanActs + rawActs);
  lines.push(`FORCED-VERDICT: wingman-share ${share === null ? 'n/a' : two(share)}`);
  if (share === null || !(share >= 0.9)) failures.push('wingman-share');

  // raw-acts: no withheld-class caller tool call may appear.
  lines.push(`FORCED-VERDICT: raw-acts ${rawActs}`);
  if (rawActs !== 0) failures.push('raw-acts');

  // handoffs: every forced run hands off, 1..4 times.
  const handoffCounts = forcedRuns.map((r) => r.handoffs ?? 0);
  const maxHandoffs = handoffCounts.length > 0 ? Math.max(...handoffCounts) : 0;
  lines.push(`FORCED-VERDICT: handoffs max=${maxHandoffs}`);
  if (!handoffCounts.every((h) => h >= 1 && h <= 4)) failures.push('handoffs');

  // picks: pick corrections must stay a minority of handoffs.
  const picks = forcedRuns.reduce((s, r) => s + (r.picks ?? 0), 0);
  const handoffs = forcedRuns.reduce((s, r) => s + (r.handoffs ?? 0), 0);
  lines.push(`FORCED-VERDICT: picks ${picks}/${handoffs}`);
  if (!(2 * picks < handoffs)) failures.push('picks');

  // zero-step-done: a done that did nothing.
  const zeroStepDone = forcedRecords.filter((r) => r.status === 'done' && r.steps === 0).length;
  lines.push(`FORCED-VERDICT: zero-step-done ${zeroStepDone}`);
  if (zeroStepDone !== 0) failures.push('zero-step-done');

  // first-call-success: each forced run's first handoff must be well-formed.
  const nRuns = forcedRuns.length;
  const kFirst = forcedRuns.filter((r) => {
    const first = (r.handoff_records ?? [])[0];
    return first !== undefined && first.reason !== 'invalid-input';
  }).length;
  lines.push(`FORCED-VERDICT: first-call-success ${kFirst}/${nRuns}`);
  if (!(kFirst === nRuns && nRuns > 0)) failures.push('first-call-success');

  // median-steps: the median handoff must do real chain work.
  const med = median(forcedRecords.map((r) => r.steps ?? 0));
  lines.push(`FORCED-VERDICT: median-steps ${two(med)}`);
  if (!(med >= 4)) failures.push('median-steps');

  // no-page-error-end: a run must not end on a page error.
  const pageErrorEnd = forcedRuns.filter((r) => {
    const recs = r.handoff_records ?? [];
    const last = recs[recs.length - 1];
    return last !== undefined && last.status === 'error' && last.reason === 'page-error';
  }).length;
  lines.push(`FORCED-VERDICT: no-page-error-end ${pageErrorEnd}`);
  if (pageErrorEnd !== 0) failures.push('no-page-error-end');

  // raw-script: informational — the retained script class stays visible.
  const rawScript = forcedRuns.reduce((s, r) => s + (r.raw_script ?? 0), 0);
  lines.push(`FORCED-VERDICT: raw-script ${rawScript}`);

  // why-breakdown: informational only (WP-outcome-evidence WP-C) — splits
  // step-uncertain non-commits by cause, from each handoff's step_review.why.
  // Never gates; purely for tuning thresholds from data.
  const whyCounts: Record<string, number> = {};
  for (const rec of forcedRecords) {
    if (typeof rec.why === 'string') whyCounts[rec.why] = (whyCounts[rec.why] ?? 0) + 1;
  }
  const whyBreakdown = Object.entries(whyCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([why, n]) => `${why}=${n}`)
    .join(' ');
  lines.push(`FORCED-VERDICT: why-breakdown ${whyBreakdown || 'n/a'}`);

  lines.push(`FORCED-VERDICT: overall ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  return { lines, pass: failures.length === 0, failures };
}

function printUsage(): void {
  process.stderr.write('usage: node dist/bench/forced-verdict.js [--validity|--smoke] <results.json>\n');
}

export async function runVerdictCli(argv: string[]): Promise<number> {
  let mode: VerdictMode = 'default';
  let fileArg: string | null = null;
  for (const arg of argv) {
    if (arg === '--validity' || arg === '--smoke') {
      if (mode !== 'default') {
        printUsage();
        return 2;
      }
      mode = arg === '--validity' ? 'validity' : 'smoke';
    } else if (arg.startsWith('--')) {
      printUsage();
      return 2;
    } else if (fileArg === null) {
      fileArg = arg;
    } else {
      printUsage();
      return 2;
    }
  }
  if (!fileArg) {
    printUsage();
    return 2;
  }
  let file: { runs?: BenchRunRecord[] };
  try {
    file = JSON.parse(fs.readFileSync(fileArg, 'utf8'));
  } catch (e) {
    process.stderr.write(`forced-verdict: cannot read ${fileArg}: ${(e as Error).message}\n`);
    return 2;
  }
  const v = forcedVerdict(file, mode);
  for (const line of v.lines) process.stdout.write(line + '\n');
  return v.pass ? 0 : 1;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void runVerdictCli(process.argv.slice(2)).then((code) => process.exit(code));
}
