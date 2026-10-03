#!/usr/bin/env node
// WP-H gate: keep the README benchmark block in sync with the newest
// `measure` results file.
//
//   node scripts/gates/readme-bench.mjs [--readme <file>] [--results-dir <dir>] [--write]
//
// The README must hold, between the `<!-- bench:begin -->` and
// `<!-- bench:end -->` markers, exactly the rendered block (comparison is on
// both sides trimmed of leading/trailing whitespace). `--write` rewrites the
// span. `cap-proof` results files never feed the README.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
let readmePath = path.join(packageRoot, 'README.md');
let resultsDir = path.join(packageRoot, 'bench', 'results');
let write = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--readme') {
    readmePath = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === '--results-dir') {
    resultsDir = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === '--write') {
    write = true;
  } else {
    console.error(`Usage: node scripts/gates/readme-bench.mjs [--readme <file>] [--results-dir <dir>] [--write]`);
    process.exit(2);
  }
}

const BEGIN = '<!-- bench:begin -->';
const END = '<!-- bench:end -->';
const PLACEHOLDER = 'No benchmark results yet.';

function newestMeasureFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .reverse();
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (parsed && parsed.purpose === 'measure') return { name, parsed };
    } catch {
      // unreadable file: not a measure file
    }
  }
  return null;
}

// r19 M-2: wall seconds at one decimal, same convention as bench/report.ts.
function wallS(ms) {
  return (ms / 1000).toFixed(1);
}

function renderBlock(result, fileName) {
  const rows = Object.entries(result.summary ?? {});
  // r19 M-2: a results file whose summary rows carry the route wall spread
  // (wall_min_ms/wall_max_ms on every route row) renders the publish format —
  // one context line with the exact cost sentence, and a spread column.
  // Files without those fields render the original four-column table exactly
  // (the gate stays green on old results).
  const hasSpread =
    rows.length > 0 && rows.every(([, s]) => Number.isFinite(s.wall_min_ms) && Number.isFinite(s.wall_max_ms));
  let header;
  if (hasSpread) {
    header = [
      `Benchmark: ${fileName} · model=${result.model} · harness=${result.harness_version} · ${result.date ?? fileName} · medians over interleaved cells; cost is the normalized token index at bench/prices.json list prices, not billing.`,
      '| route | success | median wall-clock | wall spread (min-max) | median cost (USD) | fallback rate |',
      '|---|---|---|---|---|---|',
    ];
  } else {
    header = [
      '| route | success | median wall-clock | median cost (USD) | fallback rate |',
      '|---|---|---|---|---|',
    ];
  }
  const lines = [...header];
  for (const [route, s] of rows) {
    if (hasSpread) {
      lines.push(
        `| ${route} | ${String(s.success_rate)} | ${wallS(s.median_wall_ms)} | ${wallS(s.wall_min_ms)}-${wallS(s.wall_max_ms)} | ${String(s.median_usd)} | ${String(s.fallback_rate)} |`,
      );
    } else {
      lines.push(
        `| ${route} | ${String(s.success_rate)} | ${String(s.median_wall_ms)} | ${String(s.median_usd)} | ${String(s.fallback_rate)} |`,
      );
    }
  }
  lines.push(`Source: bench/results/${fileName}`);
  return lines.join('\n');
}

const measure = newestMeasureFile(resultsDir);
const block = measure ? renderBlock(measure.parsed, measure.name) : PLACEHOLDER;
const sourceLabel = measure ? measure.name : 'no results';

const readme = fs.readFileSync(readmePath, 'utf8');
const beginIdx = readme.indexOf(BEGIN);
const endIdx = readme.indexOf(END);
if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
  console.log(`README-BENCH: markers missing in ${path.basename(readmePath)}`);
  process.exit(1);
}

const current = readme.slice(beginIdx + BEGIN.length, endIdx).trim();
if (current === block.trim()) {
  console.log(`README-BENCH: ok (${sourceLabel})`);
  process.exit(0);
}

if (write) {
  const replaced =
    readme.slice(0, beginIdx) + `${BEGIN}\n${block}\n${END}` + readme.slice(endIdx + END.length);
  fs.writeFileSync(readmePath, replaced);
  console.log(`README-BENCH: ok (${sourceLabel})`);
  process.exit(0);
}

console.log(`README-BENCH: block differs from ${sourceLabel}`);
process.exit(1);
