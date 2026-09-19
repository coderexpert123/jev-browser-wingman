#!/usr/bin/env node
// Cross-checks "ported from <repo>@<sha> <path>" markers in source against
// "## <repo>@<sha>" headings in THIRD_PARTY_NOTICES.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
let root = defaultRoot;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') {
    root = path.resolve(args[i + 1]);
    i += 1;
  }
}

const SCAN_TARGETS = [
  { dir: 'src', ext: '.ts' },
  { dir: 'tests', ext: '.ts' },
  { dir: 'bench', ext: '.ts' },
  { dir: 'scripts', ext: '.mjs' },
  { dir: 'spike', ext: '.mjs' },
];

function walk(dir, ext, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, ext, out);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
}

const files = [];
for (const target of SCAN_TARGETS) {
  walk(path.join(root, target.dir), target.ext, files);
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

const MARKER_RE = /ported from (\S+)@([0-9a-f]{7,40}) (\S+)/g;
const markers = []; // { repo, sha, file, line }
const markerKeys = new Set();

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  MARKER_RE.lastIndex = 0;
  let match;
  while ((match = MARKER_RE.exec(content)) !== null) {
    const [, repo, sha] = match;
    const line = lineOf(content, match.index);
    const relFile = path.relative(root, file).split(path.sep).join('/');
    markers.push({ repo, sha, file: relFile, line });
    markerKeys.add(`${repo}@${sha}`);
  }
}

const noticesPath = path.join(root, 'THIRD_PARTY_NOTICES');
let noticesContent = '';
if (fs.existsSync(noticesPath)) {
  noticesContent = fs.readFileSync(noticesPath, 'utf8');
}

const HEADING_RE = /^## (\S+)@([0-9a-f]{7,40})$/gm;
const entries = []; // { repo, sha }
const entryKeys = new Set();
let headingMatch;
while ((headingMatch = HEADING_RE.exec(noticesContent)) !== null) {
  const [, repo, sha] = headingMatch;
  entries.push({ repo, sha });
  entryKeys.add(`${repo}@${sha}`);
}

let violations = 0;

for (const marker of markers) {
  const key = `${marker.repo}@${marker.sha}`;
  if (!entryKeys.has(key)) {
    console.log(`NOTICES: ${marker.file}:${marker.line} missing entry ${marker.repo}@${marker.sha}`);
    violations += 1;
  }
}

for (const entry of entries) {
  const key = `${entry.repo}@${entry.sha}`;
  if (!markerKeys.has(key)) {
    console.log(`NOTICES: entry ${entry.repo}@${entry.sha} has no marker`);
    violations += 1;
  }
}

if (violations > 0) {
  process.exit(1);
}

console.log(`NOTICES: ok markers=${markers.length} entries=${entries.length}`);
process.exit(0);
