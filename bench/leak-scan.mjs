#!/usr/bin/env node
// r24c leak scan for pushed bench evidence (spec .build-r24c-redaction-spec.md WP-D).
//
//   node bench/leak-scan.mjs <dir-or-file> [<dir-or-file> ...]
//
// Values: every string in bench/tasks.json `values` at least REDACT_MIN_LEN long (read from
// src/contract/constants.ts, the server's own floor) that is not an @REPO@ placeholder.
// Files: a file argument is scanned as given; under a directory argument, every file whose
// forward-slash path matches FILE_RE (log slices, triage text/json, results.md, explain/).
// Match: case-insensitive and bounded by non-letters/non-digits on both sides, so `Wing`
// (t10 first) hits `Wing Man` but never `wingman`. Prints `LEAK <file> <task>.<binding> hits=<n>`
// per hit (never the value) and a closing `leaks=<files> files=<scanned> hits=<total>`.
// Exit 1 when any file leaks, 2 on a setup error, else 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE_RE = /\.jsonl$|triage[^/]*\.(txt|json)$|\/results\.md$|\/explain\//;

function fail(msg) {
  process.stderr.write(`leak-scan: ${msg}\n`);
  process.exit(2);
}

const constants = fs.readFileSync(path.join(ROOT, 'src', 'contract', 'constants.ts'), 'utf8');
const floorMatch = /export const REDACT_MIN_LEN = (\d+);/.exec(constants);
if (!floorMatch) fail('REDACT_MIN_LEN not found in src/contract/constants.ts');
const floor = Number(floorMatch[1]);

const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'tasks.json'), 'utf8'));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const values = [];
for (const t of tasks) {
  for (const [name, v] of Object.entries(t.values ?? {})) {
    if (typeof v !== 'string' || v.length < floor || v.startsWith('@REPO@')) continue;
    values.push({ label: `${t.id}.${name}`, re: new RegExp(`(?<![\\p{L}\\p{N}])${escape(v)}(?![\\p{L}\\p{N}])`, 'giu') });
  }
}

const args = process.argv.slice(2);
if (args.length === 0) fail('usage: node bench/leak-scan.mjs <dir-or-file> [...]');
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && FILE_RE.test(p.split(path.sep).join('/'))) files.push(p);
  }
};
for (const a of args) {
  if (!fs.existsSync(a)) fail(`no such path: ${a}`);
  if (fs.statSync(a).isDirectory()) walk(a);
  else files.push(a);
}
files.sort();

let leaks = 0;
let total = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  let leaked = false;
  for (const v of values) {
    const n = (text.match(v.re) ?? []).length;
    if (n > 0) {
      process.stdout.write(`LEAK ${f.split(path.sep).join('/')} ${v.label} hits=${n}\n`);
      leaked = true;
      total += n;
    }
  }
  if (leaked) leaks += 1;
}
process.stdout.write(`leaks=${leaks} files=${files.length} hits=${total}\n`);
process.exit(leaks > 0 ? 1 : 0);
