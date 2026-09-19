import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLog } from '../src/core/log.js';
import { createMutex } from '../src/core/mutex.js';
import type { WingmanLogRecord } from '../src/contract/types.js';

function mkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-log-test-'));
}

function record(overrides: Partial<WingmanLogRecord> = {}): WingmanLogRecord {
  return {
    ts: new Date().toISOString(),
    tool: 'wingman_do',
    mode: 'on',
    adapter: 'playwright',
    status: 'done',
    reason: 'goal-met',
    steps: 1,
    host: 'example.com',
    gate_hits: 0,
    jev_calls: 1,
    input_tokens: 10,
    output_tokens: 5,
    ms: 100,
    ...overrides,
  };
}

test('appends one JSON line per record', async () => {
  const home = mkHome();
  await writeLog(record(), { home });
  await writeLog(record({ steps: 2 }), { home });

  const content = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).steps, 1);
  assert.equal(JSON.parse(lines[1]).steps, 2);
});

test('routes to plugin.log instead of the file when present', async () => {
  const home = mkHome();
  const seen: WingmanLogRecord[] = [];
  await writeLog(record(), {
    home,
    plugin: { name: 'test-plugin', log: (r) => seen.push(r) },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'wingman_do');
  assert.equal(fs.existsSync(path.join(home, 'log.jsonl')), false);
});

test('mutex refuses a second holder until release', () => {
  const mutex = createMutex();
  assert.equal(mutex.tryAcquire(), true);
  assert.equal(mutex.tryAcquire(), false);
  mutex.release();
  assert.equal(mutex.tryAcquire(), true);
});
