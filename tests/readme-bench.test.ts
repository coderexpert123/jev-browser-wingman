// WP-H: tests for the README-numbers gate. Every test runs the real gate
// script against temp README and results fixtures; the real README gate
// itself runs at integration (I-3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageRoot } from '../src/package-root.js';

const root = packageRoot();
const GATE = path.join(root, 'scripts', 'gates', 'readme-bench.mjs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SUMMARY = {
  playwright: { success_rate: 0.875, median_wall_ms: 1234, median_usd: 0.012, fallback_rate: 0 },
};

function writeResults(dir: string, name: string, purpose: 'measure' | 'cap-proof', summary: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    JSON.stringify({
      date: name.replace(/\.json$/, ''),
      purpose,
      harness_version: 1,
      model: 'sonnet',
      cap_usd: 5,
      phase_cap_usd: 10,
      aborted: null,
      total_usd: 0.012,
      runs: [],
      summary,
    }),
  );
}

function expectedBlock(summary: object, fileName: string): string {
  const s = summary as Record<string, { success_rate: number; median_wall_ms: number; median_usd: number; fallback_rate: number }>;
  const lines = [
    '| route | success | median wall-clock | median cost (USD) | fallback rate |',
    '|---|---|---|---|---|',
  ];
  for (const [route, row] of Object.entries(s)) {
    lines.push(`| ${route} | ${row.success_rate} | ${row.median_wall_ms} | ${row.median_usd} | ${row.fallback_rate} |`);
  }
  lines.push(`Source: bench/results/${fileName}`);
  return lines.join('\n');
}

function writeReadme(dir: string, block: string): string {
  const readme = path.join(dir, 'README.md');
  fs.writeFileSync(readme, `# t\n\n<!-- bench:begin -->\n${block}\n<!-- bench:end -->\n`);
  return readme;
}

function runGate(readme: string, resultsDir: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [GATE, '--readme', readme, '--results-dir', resultsDir, ...extra], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('no results expects the placeholder', () => {
  const dir = tmpDir('jevw-readmebench-');
  const readme = writeReadme(dir, 'No benchmark results yet.');
  const resultsDir = path.join(dir, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const res = runGate(readme, resultsDir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^README-BENCH: ok \(no results\)$/m);
});

test('a hand-edited number fails', () => {
  const dir = tmpDir('jevw-readmebench-');
  const fileName = '2026-01-01-0000.json';
  const resultsDir = path.join(dir, 'results');
  writeResults(resultsDir, fileName, 'measure', SUMMARY);
  const handEdited = expectedBlock(SUMMARY, fileName).replace('1234', '9999');
  const readme = writeReadme(dir, handEdited);
  const res = runGate(readme, resultsDir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, new RegExp(`^README-BENCH: block differs from ${fileName}$`, 'm'));
});

test('--write then check passes', () => {
  const dir = tmpDir('jevw-readmebench-');
  const fileName = '2026-01-01-0000.json';
  const resultsDir = path.join(dir, 'results');
  writeResults(resultsDir, fileName, 'measure', SUMMARY);
  const readme = writeReadme(dir, 'stale numbers 42');
  const written = runGate(readme, resultsDir, ['--write']);
  assert.equal(written.status, 0);
  assert.match(written.stdout, new RegExp(`^README-BENCH: ok \\(${fileName}\\)$`, 'm'));
  const checked = runGate(readme, resultsDir);
  assert.equal(checked.status, 0);
  assert.match(checked.stdout, new RegExp(`^README-BENCH: ok \\(${fileName}\\)$`, 'm'));
  const text = fs.readFileSync(readme, 'utf8');
  assert.ok(text.includes(expectedBlock(SUMMARY, fileName)), 'rewritten block missing');
});

test('cap-proof files are ignored', () => {
  const dir = tmpDir('jevw-readmebench-');
  const measureName = '2026-01-01-0000.json';
  const capProofName = '2026-01-02-0000.json';
  const resultsDir = path.join(dir, 'results');
  writeResults(resultsDir, measureName, 'measure', SUMMARY);
  writeResults(resultsDir, capProofName, 'cap-proof', {
    playwright: { success_rate: 0, median_wall_ms: 1, median_usd: 1, fallback_rate: 1 },
  });
  const readme = writeReadme(dir, expectedBlock(SUMMARY, measureName));
  const res = runGate(readme, resultsDir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, new RegExp(`^README-BENCH: ok \\(${measureName}\\)$`, 'm'));
});

// ---------------------------------------------------------------------------
// r19 WP-5 (M-2): the publish format. A results file whose summary rows carry
// the wall spread (wall_min_ms/wall_max_ms) renders one context line above a
// five-column table; the exact cost sentence is pinned verbatim from the spec.

const R19_SUMMARY = {
  playwright: { success_rate: 0.875, median_wall_ms: 1234, median_usd: 0.012, fallback_rate: 0, wall_min_ms: 900, wall_max_ms: 2100 },
  forced: { success_rate: 1, median_wall_ms: 800, median_usd: 0.008, fallback_rate: 0.5, wall_min_ms: 700, wall_max_ms: 1000 },
};

const COST_SENTENCE = 'cost is the normalized token index at bench/prices.json list prices, not billing.';

function expectedR19Block(summary: object, fileName: string): string {
  const s = summary as Record<
    string,
    { success_rate: number; median_wall_ms: number; median_usd: number; fallback_rate: number; wall_min_ms: number; wall_max_ms: number }
  >;
  const wallS = (ms: number): string => (ms / 1000).toFixed(1);
  const date = fileName.replace(/\.json$/, '');
  const lines = [
    `Benchmark: ${fileName} · model=sonnet · harness=1 · ${date} · medians over interleaved cells; ${COST_SENTENCE}`,
    '| route | success | median wall-clock | wall spread (min-max) | median cost (USD) | fallback rate |',
    '|---|---|---|---|---|---|',
  ];
  for (const [route, row] of Object.entries(s)) {
    lines.push(
      `| ${route} | ${row.success_rate} | ${wallS(row.median_wall_ms)} | ${wallS(row.wall_min_ms)}-${wallS(row.wall_max_ms)} | ${row.median_usd} | ${row.fallback_rate} |`,
    );
  }
  lines.push(`Source: bench/results/${fileName}`);
  return lines.join('\n');
}

test('a results file with the r19 spread fields renders the context line, the spread column and the exact cost sentence', () => {
  const dir = tmpDir('jevw-readmebench-');
  const fileName = '2026-01-01-0000.json';
  const resultsDir = path.join(dir, 'results');
  writeResults(resultsDir, fileName, 'measure', R19_SUMMARY);
  const readme = writeReadme(dir, 'stale numbers 42');
  const written = runGate(readme, resultsDir, ['--write']);
  assert.equal(written.status, 0);
  const text = fs.readFileSync(readme, 'utf8');
  assert.ok(text.includes(expectedR19Block(R19_SUMMARY, fileName)), 'the r19 publish block is missing or differs');
  // The exact cost sentence from the spec, pinned verbatim.
  assert.ok(text.includes(COST_SENTENCE), 'the exact cost sentence is missing');
  // The gate then stays green against the rewritten block.
  const checked = runGate(readme, resultsDir);
  assert.equal(checked.status, 0);
  assert.match(checked.stdout, new RegExp(`^README-BENCH: ok \\(${fileName}\\)$`, 'm'));
});

test('an old results file without the spread fields keeps the old four-column block (no context line)', () => {
  const dir = tmpDir('jevw-readmebench-');
  const fileName = '2026-01-01-0000.json';
  const resultsDir = path.join(dir, 'results');
  writeResults(resultsDir, fileName, 'measure', SUMMARY);
  const readme = writeReadme(dir, expectedBlock(SUMMARY, fileName));
  const res = runGate(readme, resultsDir);
  assert.equal(res.status, 0);
  const text = fs.readFileSync(readme, 'utf8');
  assert.ok(!text.includes('Benchmark: '), 'an old-format file must not gain the r19 context line');
  assert.ok(!text.includes('wall spread (min-max)'), 'an old-format file must not gain the spread column');
});
