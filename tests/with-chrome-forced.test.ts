// WP-C C5: with-chrome-forced tests (§ 6 WP-C, spec 2026-09-26-wingman-
// forced-handoff § 5.9). Chrome file: real launchTestChrome + real
// `npx -y @playwright/mcp@0.0.80 --browser chrome` through
// `node <build>/src/cli/main.js with-browser --`, with the endpoint preset
// and a temp WINGMAN_HOME configured as in tests/with-chrome.test.ts (C4)
// (`mode: 'on'`; F2 adds `handoff: {mode:'optional'}`).
//
// PHASE 2 of the WP-C gate (§ 6 WP-C): this file needs `main.ts`'s
// `with-browser`/`with-chrome` dispatch, which is WP-I's file, built
// alongside it (`node scripts/build.mjs --out .build/fh-wpc2
// tests/with-chrome-forced.test.ts src/cli/main.ts`). Do not build or run
// this file until the orchestrator reports "WP-I gate green" — and even
// then it is a Chrome file (§ 3 coordination rule 6): claim
// @jev-browser-wingman/.chrome-gate, check free RAM, and record the
// leftover wingman-ephemeral-* count before running.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchTestChrome } from './helpers/chrome.js';

const buildRoot = join(fileURLToPath(import.meta.url), '..', '..');
const mainJsPath = join(buildRoot, 'src', 'cli', 'main.js');

async function writeForcedConfig(home: string, handoff: { mode: 'forced' | 'optional' }): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.json'), JSON.stringify({ mode: 'on', adapter: 'cdp', handoff }), 'utf8');
}

interface ToolListResult {
  tools: Array<{ name: string }>;
}
interface ToolCallResult {
  isError?: boolean;
}

async function withForcedSession(
  command: 'with-browser' | 'with-chrome',
  handoff: { mode: 'forced' | 'optional' },
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const chrome = await launchTestChrome();
  try {
    const home = await mkdtemp(join(tmpdir(), 'wingman-forced-'));
    await writeForcedConfig(home, handoff);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mainJsPath, command, '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
      env: { ...process.env, WINGMAN_CDP_ENDPOINT: chrome.endpoint, WINGMAN_HOME: home },
    });
    const client = new Client({ name: 'jevw-forced-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await chrome.close();
  }
}

test('F1: forced — no withheld-class name listed; browser_snapshot/browser_tabs listed; browser_click refused', async () => {
  await withForcedSession('with-browser', { mode: 'forced' }, async (client) => {
    const tools = (await client.listTools()) as ToolListResult;
    const names = tools.tools.map((t) => t.name);
    assert.ok(!names.includes('browser_click'), `browser_click should be withheld: ${names}`);
    assert.ok(names.includes('browser_snapshot'), `browser_snapshot should be listed: ${names}`);
    assert.ok(names.includes('browser_tabs'), `browser_tabs should be listed: ${names}`);
    const click = (await client.callTool({ name: 'browser_click', arguments: {} })) as ToolCallResult;
    assert.equal(click.isError, true, 'browser_click must be refused under forced handoff');
    const snapshot = (await client.callTool({ name: 'browser_snapshot', arguments: {} })) as ToolCallResult;
    assert.notEqual(snapshot.isError, true, 'browser_snapshot (read, retained) must not error');
  });
});

test('F2: optional — browser_click is listed', async () => {
  await withForcedSession('with-browser', { mode: 'optional' }, async (client) => {
    const tools = (await client.listTools()) as ToolListResult;
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes('browser_click'), `optional handoff must list browser_click: ${names}`);
  });
});

test('F3: with-chrome (deprecated alias) — same result as F1', async () => {
  await withForcedSession('with-chrome', { mode: 'forced' }, async (client) => {
    const tools = (await client.listTools()) as ToolListResult;
    const names = tools.tools.map((t) => t.name);
    assert.ok(!names.includes('browser_click'), `browser_click should be withheld: ${names}`);
    assert.ok(names.includes('browser_snapshot'), `browser_snapshot should be listed: ${names}`);
    assert.ok(names.includes('browser_tabs'), `browser_tabs should be listed: ${names}`);
  });
});
