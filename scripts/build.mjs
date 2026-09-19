#!/usr/bin/env node
// Build the jev-browser-wingman package.
//
// `node scripts/build.mjs` runs tsc -p tsconfig.json into dist.
// `node scripts/build.mjs --out <dir> <entry.ts ...>` writes <dir>/tsconfig.scoped.json
// extending the package tsconfig, scoped to the given entries, and builds only those.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

function usageExit() {
  console.error('Usage: node scripts/build.mjs [--out <dir> <entry.ts ...>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let outDir = null;
const entries = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    outDir = args[i + 1];
    i += 1;
  } else {
    entries.push(args[i]);
  }
}

if (entries.length > 0 && !outDir) {
  usageExit();
}

const tscBin = path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function countJsFiles(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countJsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      count += 1;
    }
  }
  return count;
}

let result;
let targetDir;
let outLabel;

if (outDir) {
  targetDir = path.resolve(process.cwd(), outDir);
  outLabel = outDir;
  fs.mkdirSync(targetDir, { recursive: true });
  const absEntries = entries.map((e) => path.resolve(process.cwd(), e));
  const scopedConfig = {
    extends: path.join(packageRoot, 'tsconfig.json'),
    compilerOptions: {
      outDir: targetDir,
      rootDir: packageRoot,
    },
    files: absEntries,
    include: [],
  };
  const scopedConfigPath = path.join(targetDir, 'tsconfig.scoped.json');
  fs.writeFileSync(scopedConfigPath, JSON.stringify(scopedConfig, null, 2));
  result = spawnSync(process.execPath, [tscBin, '-p', scopedConfigPath], {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
} else {
  targetDir = path.join(packageRoot, 'dist');
  outLabel = 'dist';
  result = spawnSync(process.execPath, [tscBin, '-p', path.join(packageRoot, 'tsconfig.json')], {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
}

if (result.error) {
  console.error(String(result.error));
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const fileCount = countJsFiles(targetDir);
console.log(`BUILD: ok out=${outLabel} files=${fileCount}`);
process.exit(0);
