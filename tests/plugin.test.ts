import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlugin } from '../src/core/plugin.js';

function mkTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-plugin-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test('loads an ESM plugin exporting wingmanPlugin', async () => {
  const file = mkTempFile(
    'plugin.mjs',
    "export const wingmanPlugin = { name: 'esm-plugin', ask: async () => ({}) };\n",
  );
  const result = await loadPlugin(file);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plugin.name, 'esm-plugin');
    assert.equal(typeof result.plugin.ask, 'function');
  }
});

test('loads a CommonJS plugin through default', async () => {
  const file = mkTempFile(
    'plugin.cjs',
    "exports.wingmanPlugin = { name: 'cjs-plugin' };\n",
  );
  const result = await loadPlugin(file);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plugin.name, 'cjs-plugin');
  }
});

test('rejects a module without wingmanPlugin', async () => {
  const file = mkTempFile('no-plugin.mjs', 'export const somethingElse = 1;\n');
  const result = await loadPlugin(file);
  assert.equal(result.ok, false);
});

test('rejects a non-function ask', async () => {
  const file = mkTempFile(
    'bad-ask.mjs',
    "export const wingmanPlugin = { name: 'bad-ask-plugin', ask: 'not-a-function' };\n",
  );
  const result = await loadPlugin(file);
  assert.equal(result.ok, false);
});
