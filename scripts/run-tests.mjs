#!/usr/bin/env node
// Run the package's compiled tests.
//
// `node scripts/run-tests.mjs [--dist <dir>] [basename ...]`
// <dir> defaults to `dist`. Test files are `<dir>/tests/*.test.js` (not recursive).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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

// Teardown-hardening (2026-09-22): this invocation's unique run token. It
// rides every spawned test's env; launchEphemeralChrome copies it onto each
// chrome command line inside its `--user-data-dir` value (profile dir
// `wingman-ephemeral-<token>-`), and the sweep below
// kills any chrome still carrying it before this runner exits — normal exit,
// test failure, or delivered signal. This is the LEAK GUARANTEE; per-test
// finally-blocks (and tests/helpers/chrome.ts's exit registry) are
// best-effort only.
const runToken = randomUUID();

function execP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 * 16, ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function listChromes() {
  try {
    if (process.platform === 'win32') {
      const stdout = await execP(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true },
      );
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      let parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) parsed = [parsed];
      return parsed
        .filter((row) => typeof row.ProcessId === 'number' && typeof row.CommandLine === 'string')
        .map((row) => ({ pid: row.ProcessId, cmdline: row.CommandLine }));
    }
    const stdout = await execP('ps', ['-ax', '-o', 'pid=,command='], { windowsHide: false });
    const out = [];
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && /chrome|chromium/i.test(m[2])) out.push({ pid: Number(m[1]), cmdline: m[2] });
    }
    return out;
  } catch {
    return [];
  }
}

let sweepDone = false;

async function sweepRunChromes(reason) {
  if (sweepDone) return;
  sweepDone = true;
  const marker = `wingman-ephemeral-${runToken}`;
  let leaked = [];
  try {
    leaked = (await listChromes()).filter((p) => p.cmdline.includes(marker));
  } catch {
    leaked = [];
  }
  if (leaked.length === 0) {
    console.log(`RUN-TESTS: chrome sweep (${reason}): 0 matching chromes`);
    return;
  }
  for (const p of leaked) {
    console.log(`RUN-TESTS: chrome sweep (${reason}): kill pid=${p.pid}`);
    try {
      if (process.platform === 'win32') {
        await execP('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
      } else {
        try {
          process.kill(-p.pid);
        } catch {
          // best-effort
        }
        try {
          process.kill(p.pid);
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort: logged the attempt either way
    }
  }
  console.log(
    `RUN-TESTS: chrome sweep (${reason}): ${leaked.length} leaked chrome process(es) killed (run token ${runToken.slice(0, 8)})`,
  );
}

// Sync fallback for exit paths the async sweep cannot cover (a signal delivered
// mid-run that Node turns into process exit before the handler's promise
// settles). 'exit' handlers must be synchronous — hence execFileSync. Runs at
// most once: the async sweep sets sweepDone first on the normal paths.
function installExitHooks() {
  process.on('exit', () => {
    if (sweepDone) return;
    sweepDone = true;
    const marker = `wingman-ephemeral-${runToken}`;
    try {
      let rows = [];
      if (process.platform === 'win32') {
        const stdout = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
          ],
          { windowsHide: true, timeout: 20_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const trimmed = stdout.trim();
        if (trimmed) {
          rows = JSON.parse(trimmed);
          if (!Array.isArray(rows)) rows = [rows];
        }
      } else {
        const stdout = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
          timeout: 20_000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        rows = stdout
          .split('\n')
          .map((line) => {
            const m = line.trim().match(/^(\d+)\s+(.*)$/);
            return m ? { ProcessId: Number(m[1]), CommandLine: m[2] } : null;
          })
          .filter((r) => r && /chrome|chromium/i.test(r.CommandLine));
      }
      for (const row of rows) {
        if (typeof row.CommandLine !== 'string' || !row.CommandLine.includes(marker)) continue;
        console.log(`RUN-TESTS: chrome sweep (exit): kill pid=${row.ProcessId}`);
        try {
          if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(row.ProcessId), '/T', '/F'], {
              windowsHide: true,
              timeout: 15_000,
              stdio: 'ignore',
            });
          } else {
            try {
              process.kill(-row.ProcessId);
            } catch {
              // best-effort
            }
            try {
              process.kill(row.ProcessId);
            } catch {
              // best-effort
            }
          }
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort — nothing more can run at exit
    }
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, () => {
        sweepRunChromes(`signal ${sig}`)
          .catch(() => {})
          .finally(() => process.exit(1));
      });
    } catch {
      // not every platform has every signal
    }
  }
}

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
delete childEnv.TYPESAFE_API_KEY;
delete childEnv.TYPESAFE_BASE_URL;
delete childEnv.WINGMAN_CDP_ENDPOINT;
delete childEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT;
childEnv.WINGMAN_HOME = tmpHome;
childEnv.WINGMAN_RUN_TOKEN = runToken;

installExitHooks();

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

// The leak guarantee runs on every post-run exit path (pass or fail) before
// the process exits.
const exitCode = zeroTestFiles.length > 0 || tests === 0 || fail !== 0 || result.status !== 0 ? 1 : 0;

if (zeroTestFiles.length > 0) {
  for (const f of zeroTestFiles) {
    console.log(`RUN-TESTS: zero tests registered: ${path.basename(f)}`);
  }
}
if (zeroTestFiles.length === 0 && tests === 0) {
  console.log('RUN-TESTS: zero tests registered');
}

console.log(`RUN-TESTS: files=${files.length} tests=${tests} pass=${pass} fail=${fail}`);

await sweepRunChromes('post-run');
process.exit(exitCode);
