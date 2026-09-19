#!/usr/bin/env node
// Run the package's compiled tests.
//
// `node scripts/run-tests.mjs [--dist <dir>] [basename ...]`
// <dir> defaults to `dist`. Test files are `<dir>/tests/*.test.js` (not recursive).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
let dist = 'dist';
const basenames = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dist') {
    dist = args[i + 1];
    i += 1;
  } else {
    basenames.push(args[i]);
  }
}

const distDir = path.resolve(process.cwd(), dist);
const testsDir = path.join(distDir, 'tests');

let allTestFiles = [];
if (fs.existsSync(testsDir)) {
  allTestFiles = fs
    .readdirSync(testsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
    .map((e) => path.join(testsDir, e.name));
}

let files;
if (basenames.length === 0) {
  files = allTestFiles;
} else {
  files = [];
  for (const basename of basenames) {
    const expected = `${basename}.test.js`;
    const match = allTestFiles.find((f) => path.basename(f) === expected);
    if (!match) {
      console.log(`No test files matched: ${basename}`);
      process.exit(1);
    }
    files.push(match);
  }
}

// An empty file list would make a bare `node --test` (no file arguments)
// discover test files under the cwd instead of running nothing. Refuse before spawning.
if (files.length === 0) {
  console.log('RUN-TESTS: zero tests registered');
  process.exit(1);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-test-'));

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
delete childEnv.TYPESAFE_API_KEY;
delete childEnv.TYPESAFE_BASE_URL;
delete childEnv.WINGMAN_CDP_ENDPOINT;
delete childEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT;
childEnv.WINGMAN_HOME = tmpHome;

let result;
try {
  result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd: packageRoot,
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

const stdout = result.stdout ?? '';
process.stdout.write(stdout);
if (result.stderr) {
  process.stderr.write(result.stderr);
}

const testsMatch = stdout.match(/^# tests (\d+)/m);
const passMatch = stdout.match(/^# pass (\d+)/m);
const failMatch = stdout.match(/^# fail (\d+)/m);

const tests = testsMatch ? Number(testsMatch[1]) : 0;
const pass = passMatch ? Number(passMatch[1]) : 0;
const fail = failMatch ? Number(failMatch[1]) : 0;

// Zero-tests rule (C25): Node 22 reports a file with no real tests as one
// passing synthetic test named by the file's own (normalised) path, so
// `# tests 0` never appears for that case. Detect it by comparing each
// top-level `ok <n> - <name>` TAP line against the files we passed in.
function unescapeTapName(raw) {
  // Cut a trailing ` # SKIP` / ` # TODO` directive, then undo TAP's own
  // escaping of backslash and `#` (in that order; the two patterns are
  // disjoint so order does not matter).
  let name = raw.replace(/ # (SKIP|TODO)\b.*$/, '');
  name = name.replace(/\\\\/g, '\\').replace(/\\#/g, '#');
  return name;
}

const okLineRe = /^ok \d+ - (.*)$/gm;
const zeroTestFiles = [];
let match;
while ((match = okLineRe.exec(stdout)) !== null) {
  const name = unescapeTapName(match[1]);
  const resolvedName = path.resolve(packageRoot, name);
  const hit = files.find((f) => path.resolve(packageRoot, f) === resolvedName);
  if (hit && !zeroTestFiles.includes(hit)) {
    zeroTestFiles.push(hit);
  }
}

if (zeroTestFiles.length > 0) {
  for (const f of zeroTestFiles) {
    console.log(`RUN-TESTS: zero tests registered: ${path.basename(f)}`);
  }
  process.exit(1);
}

if (tests === 0) {
  console.log('RUN-TESTS: zero tests registered');
  process.exit(1);
}

console.log(`RUN-TESTS: files=${files.length} tests=${tests} pass=${pass} fail=${fail}`);

if (fail === 0 && result.status === 0) {
  process.exit(0);
}
process.exit(1);
