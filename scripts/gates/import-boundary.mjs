#!/usr/bin/env node
// Fails when any source file imports something outside the package's own
// dependency surface: an undeclared bare package, an absolute path, a
// file: URL, or a relative specifier that resolves outside the root.

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

let pkg = {};
const pkgPath = path.join(root, 'package.json');
if (fs.existsSync(pkgPath)) {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}
const declaredPackages = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

const SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
];

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function bareName(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

function isAbsoluteLike(specifier) {
  if (specifier.startsWith('file:')) return true;
  if (path.isAbsolute(specifier)) return true;
  // Windows drive-letter paths (e.g. C:/, C:\)
  if (/^[A-Za-z]:[\\/]/.test(specifier)) return true;
  return false;
}

let violations = 0;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1];
      const key = `${match.index}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let allowed = false;

      if (specifier.startsWith('node:')) {
        allowed = true;
      } else if (isAbsoluteLike(specifier)) {
        allowed = false;
      } else if (specifier.startsWith('.')) {
        const resolvedDir = path.resolve(path.dirname(file), specifier);
        const relative = path.relative(root, resolvedDir);
        allowed = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        if (relative === '') allowed = true;
      } else {
        allowed = declaredPackages.has(bareName(specifier));
      }

      if (!allowed) {
        const line = lineOf(content, match.index);
        const relFile = path.relative(root, file).split(path.sep).join('/');
        console.log(`IMPORT-BOUNDARY: ${relFile}:${line} ${specifier}`);
        violations += 1;
      }
    }
  }
}

if (violations > 0) {
  process.exit(1);
}

console.log(`IMPORT-BOUNDARY: ok files=${files.length}`);
process.exit(0);
