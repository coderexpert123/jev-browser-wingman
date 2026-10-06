// r24c recheck: bench/leak-scan.mjs is the instrument behind every `leaks=0` of the cloud prompt (Parts 0, 3, 5b, 6)
// and had no test. A scan that cannot fail certifies instead of checking, so each leg below runs the real script on a
// planted case it must flag and on a near miss it must not (floor 4, letter/digit bounds, the file filter, exit codes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scan = path.join(process.cwd(), 'bench', 'leak-scan.mjs');
const tasks = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'bench', 'tasks.json'), 'utf8')) as Array<{ id: string; values?: Record<string, string> }>;
const valueOf = (id: string, name: string): string => {
  const v = tasks.find((t) => t.id === id)?.values?.[name];
  assert.equal(typeof v, 'string', `bench/tasks.json no longer carries ${id}.${name}`);
  return v as string;
};
const SHORT4 = valueOf('t10-saucedemo-checkout', 'first'); // 'Wing': four characters, a substring of "wingman"
const LONG = valueOf('t11-todomvc-spa', 'item1'); // 'write spec'
const BELOW_FLOOR = valueOf('t10-saucedemo-checkout', 'last'); // 'Man': three characters

function run(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [scan, ...args], { encoding: 'utf8', windowsHide: true, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-scan-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const write = (dir: string, rel: string, text: string): string => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

test('leak-scan: the floor-4 value is flagged as a whole word, once per hit, and the value is never printed', () => {
  assert.equal(SHORT4.length, 4);
  withDir((dir) => {
    const f = write(dir, 'log-slice.jsonl', `{"label":"${SHORT4}"}\n{"label":"x ${SHORT4.toUpperCase()} y ${SHORT4.toLowerCase()}-z"}\n{"label":"${LONG}"}\n`);
    const r = run([f]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /LEAK .*log-slice\.jsonl t10-saucedemo-checkout\.first hits=3/);
    assert.match(r.out, /LEAK .*log-slice\.jsonl t11-todomvc-spa\.item1 hits=1/);
    assert.match(r.out, /^leaks=1 files=1 hits=4$/m);
    assert.equal(r.out.includes(LONG), false, 'the value itself is never printed');
  });
});

test('leak-scan: the same four characters inside a longer word, a value under the floor and a clean file never flag', () => {
  withDir((dir) => {
    const f = write(dir, 'log-slice.jsonl', `{"tool":"mcp__jev-browser-wingman__browse_step","note":"Wingman WINGMAN2 Wing2 swing 4wing ${BELOW_FLOOR} ${BELOW_FLOOR}"}\n`);
    const r = run([f]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^leaks=0 files=1 hits=0$/m);
  });
});

test('leak-scan: a directory argument scans only log slices, triage text/json, results.md and explain files', () => {
  withDir((dir) => {
    const bad = `{"label":"${LONG}"}\n`;
    write(dir, 'gauntlet/log-slice.jsonl', bad);
    write(dir, 'gauntlet/triage-r24c.txt', bad);
    write(dir, 'gauntlet/triage-r24c.json', bad);
    write(dir, 'results.md', bad);
    write(dir, 'gauntlet/explain/t11-1.txt', bad);
    write(dir, 'gauntlet/run.txt', bad); // not a scanned file shape
    write(dir, 'gauntlet/report.txt', bad);
    const r = run([dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^leaks=5 files=5 hits=5$/m);
    assert.equal(/run\.txt|report\.txt/.test(r.out), false, 'unscanned file shapes stay out');
  });
});

test('leak-scan: no argument and a missing path are setup errors (exit 2), never a clean zero', () => {
  assert.equal(run([]).status, 2);
  const r = run([path.join(os.tmpdir(), 'leak-scan-no-such-path-xyz')]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /no such path/);
});
