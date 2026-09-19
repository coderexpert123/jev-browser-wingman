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

function renderBlock(result, fileName) {
  const lines = [
    '| route | success | median wall-clock | median cost (USD) | fallback rate |',
    '|---|---|---|---|---|',
  ];
  for (const [route, s] of Object.entries(result.summary ?? {})) {
    lines.push(
      `| ${route} | ${String(s.success_rate)} | ${String(s.median_wall_ms)} | ${String(s.median_usd)} | ${String(s.fallback_rate)} |`,
    );
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
