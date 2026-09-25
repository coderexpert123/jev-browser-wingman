// Ephemeral-Chrome leak fix (2026-09-25): tests for the orphan sweep that
// cleans up chromes/dirs left behind by a killed or hung launcher process.
//
// These tests use ONLY injected fakes (no real Chrome is ever spawned) —
// listChromeProcesses/killTree/isAlive/readdir/stat/rm are all passed via
// the `deps` param of sweepOrphanedEphemeralChromes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sweepOrphanedEphemeralChromes } from '../src/browser/ephemeral.js';

const FAKE_ROOT = '/faketmp';

function chromeCmdline(userDataDir: string, opts: { type?: string } = {}): string {
  const typeFlag = opts.type ? ` --type=${opts.type}` : '';
  return `"C:\\fake\\chrome.exe" --headless=new${typeFlag} --remote-debugging-port=0 --user-data-dir="${userDataDir}" --no-first-run --no-default-browser-check about:blank`;
}

function makeDeps(overrides: {
  chromes?: Array<{ pid: number; cmdline: string }>;
  aliveOwners?: Set<number>;
  dirs?: string[];
  mtimes?: Record<string, number>;
}) {
  const killed: number[] = [];
  const removed: string[] = [];
  const chromes = overrides.chromes ?? [];
  const aliveOwners = overrides.aliveOwners ?? new Set<number>();
  const dirs = overrides.dirs ?? [];
  const mtimes = overrides.mtimes ?? {};

  const deps = {
    listChromeProcesses: async () => chromes,
    killTree: async (pid: number) => {
      killed.push(pid);
    },
    isAlive: (pid: number) => aliveOwners.has(pid),
    readdir: async (dir: string) => {
      assert.equal(dir, FAKE_ROOT);
      return dirs;
    },
    stat: async (path: string) => {
      const mtimeMs = mtimes[path];
      if (mtimeMs === undefined) throw new Error(`no fake mtime for ${path}`);
      return { mtimeMs };
    },
    rm: async (path: string) => {
      removed.push(path);
    },
    tmpdir: () => FAKE_ROOT,
  };
  return { deps, killed, removed };
}

test('(a) dead-owner tagged chrome is killed and its dir removed', async () => {
  const dirName = 'wingman-ephemeral-tok1-p111-aaaa';
  const dir = join(FAKE_ROOT, dirName);
  const { deps, killed, removed } = makeDeps({
    chromes: [{ pid: 222, cmdline: chromeCmdline(dir) }],
    aliveOwners: new Set(), // 111 is dead
    dirs: [dirName],
  });
  const result = await sweepOrphanedEphemeralChromes(deps);
  assert.deepEqual(killed, [222]);
  assert.deepEqual(removed, [dir]);
  assert.deepEqual(result, { killed: 1, removedDirs: 1 });
});

test('(b) live-owner tagged chrome is untouched', async () => {
  const dirName = 'wingman-ephemeral-tok2-p333-bbbb';
  const dir = join(FAKE_ROOT, dirName);
  const { deps, killed, removed } = makeDeps({
    chromes: [{ pid: 444, cmdline: chromeCmdline(dir) }],
    aliveOwners: new Set([333]),
    dirs: [dirName],
  });
  const result = await sweepOrphanedEphemeralChromes(deps);
  assert.deepEqual(killed, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(result, { killed: 0, removedDirs: 0 });
});

test('(c) legacy untagged chrome (still running) is untouched', async () => {
  const dirName = 'wingman-ephemeral-legacyrunning';
  const dir = join(FAKE_ROOT, dirName);
  const { deps, killed, removed } = makeDeps({
    chromes: [{ pid: 555, cmdline: chromeCmdline(dir) }],
    aliveOwners: new Set(),
    dirs: [dirName],
  });
  const result = await sweepOrphanedEphemeralChromes(deps);
  assert.deepEqual(killed, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(result, { killed: 0, removedDirs: 0 });
});

test('(d) legacy dir: older than 24h + unreferenced is removed, younger is kept', async () => {
  const now = Date.now();
  const oldName = 'wingman-ephemeral-legacy-old';
  const youngName = 'wingman-ephemeral-legacy-young';
  const oldDir = join(FAKE_ROOT, oldName);
  const youngDir = join(FAKE_ROOT, youngName);
  const { deps, killed, removed } = makeDeps({
    chromes: [], // nothing references either dir
    dirs: [oldName, youngName],
    mtimes: {
      [oldDir]: now - 25 * 60 * 60 * 1000,
      [youngDir]: now - 1 * 60 * 60 * 1000,
    },
  });
  const result = await sweepOrphanedEphemeralChromes(deps);
  assert.deepEqual(killed, []);
  assert.deepEqual(removed, [oldDir]);
  assert.deepEqual(result, { killed: 0, removedDirs: 1 });
});

test('(e) dir referenced by a live chrome cmdline is kept even if stale legacy', async () => {
  const now = Date.now();
  const dirName = 'wingman-ephemeral-legacy-referenced';
  const dir = join(FAKE_ROOT, dirName);
  // A renderer child process (carries --type= and --user-data-dir, never the
  // debug port) still references the dir — see CLAUDE.md "Chrome's own child
  // processes carry --user-data-dir but never the debug port".
  const { deps, killed, removed } = makeDeps({
    chromes: [{ pid: 777, cmdline: chromeCmdline(dir, { type: 'renderer' }) }],
    dirs: [dirName],
    mtimes: { [dir]: now - 25 * 60 * 60 * 1000 },
  });
  const result = await sweepOrphanedEphemeralChromes(deps);
  assert.deepEqual(killed, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(result, { killed: 0, removedDirs: 0 });
});

test('(f) owner-pid tag parses correctly with and without a run token, token before pid', async () => {
  const withTokenName = 'wingman-ephemeral-9f8e7d6c5b4a-p4321-suffix1';
  const withoutTokenName = 'wingman-ephemeral-p4321-suffix2';
  const withTokenDir = join(FAKE_ROOT, withTokenName);
  const withoutTokenDir = join(FAKE_ROOT, withoutTokenName);
  const { deps, killed, removed } = makeDeps({
    chromes: [
      { pid: 888, cmdline: chromeCmdline(withTokenDir) },
      { pid: 999, cmdline: chromeCmdline(withoutTokenDir) },
    ],
    aliveOwners: new Set(), // 4321 is dead in both cases
    dirs: [withTokenName, withoutTokenName],
  });
  const result = await sweepOrphanedEphemeralChromes(deps);
  assert.deepEqual(killed.sort(), [888, 999]);
  assert.deepEqual(removed.sort(), [withTokenDir, withoutTokenDir].sort());
  assert.deepEqual(result, { killed: 2, removedDirs: 2 });
});

test('never throws even when every injected dependency rejects', async () => {
  const result = await sweepOrphanedEphemeralChromes({
    listChromeProcesses: async () => {
      throw new Error('boom');
    },
    killTree: async () => {
      throw new Error('boom');
    },
    isAlive: () => {
      throw new Error('boom');
    },
    readdir: async () => {
      throw new Error('boom');
    },
    stat: async () => {
      throw new Error('boom');
    },
    rm: async () => {
      throw new Error('boom');
    },
    tmpdir: () => FAKE_ROOT,
  });
  assert.deepEqual(result, { killed: 0, removedDirs: 0 });
});
