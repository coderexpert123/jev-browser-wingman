#!/usr/bin/env node
// First-use launch gate, spec § WP-F1 item 7 (decision 2 / C23). Plain ESM, no
// build step of its own; it imports the freshly built dist.
//
//   node scripts/gates/lazy-chrome.mjs [--dist <dir>] [--known-bad eager-ensure|tool-call]
//
// Starts `main.js with-chrome -- npx -y @playwright/mcp@0.0.80 --browser
// chrome` over the MCP SDK on a temp home, lists tools, and asserts that no
// Chrome was launched and the debug port never answered: with-chrome must
// ensure Chrome only when it forwards the first gated tools/call, never at
// startup or for tools/list. Known-bad modes prove the gate can fail:
//   eager-ensure — `chrome ensure` before the session (a start-up launch)
//   tool-call    — one browser_navigate, which legitimately triggers the ensure
// Both must print LAZY-CHROME: FAIL ... answered=true with chrome >= 1.
// Exit codes: 0 ok, 1 FAIL, 3 harness error. Chrome safety: temp profile, free
// port found at run time, never 9222; ends with `chrome stop`, a tree kill of
// anything left on the temp profile, and temp-dir removal.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function fail(msg) {
  console.error(`lazy-chrome: ${msg}`);
  process.exit(3);
}

const args = process.argv.slice(2);
let dist = 'dist';
let knownBad = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dist') {
    dist = args[++i];
  } else if (args[i] === '--known-bad') {
    knownBad = args[++i];
    if (knownBad !== 'eager-ensure' && knownBad !== 'tool-call') {
      fail(`unknown --known-bad mode: ${knownBad}`);
    }
  } else {
    fail(`unknown argument: ${args[i]}`);
  }
}

const distDir = path.resolve(process.cwd(), dist);
const mainJs = path.join(distDir, 'src', 'cli', 'main.js');
if (!fs.existsSync(mainJs)) {
  fail(`main.js not found at ${mainJs} — build first`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-lazy-'));
const profileDir = path.join(home, 'profile');
const port = await freePort();
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({ profile_dir: profileDir, port, window: 'headless' }),
);

const { listChromeProcesses, killTree } = await import(
  pathToFileURL(path.join(distDir, 'src', 'browser', 'process-list.js')).href
);
const { probeVersion, profileMarkerMatches } = await import(
  pathToFileURL(path.join(distDir, 'src', 'browser', 'chrome.js')).href
);

function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'WINGMAN_CDP_ENDPOINT' && k !== 'PLAYWRIGHT_MCP_CDP_ENDPOINT') {
      env[k] = v;
    }
  }
  env.WINGMAN_HOME = home;
  return env;
}

async function sample() {
  const procs = await listChromeProcesses();
  const chrome = procs.filter((p) => profileMarkerMatches(p.cmdline, profileDir)).length;
  const answered = (await probeVersion(port)) !== null;
  return { chrome, answered };
}

let client = null;
let exitCode = 0;
let listed = 0;
let chrome = 0;
let answered = false;

try {
  if (knownBad === 'eager-ensure') {
    const ensure = spawnSync(process.execPath, [mainJs, 'chrome', 'ensure'], {
      env: childEnv(),
      stdio: 'inherit',
      windowsHide: true,
    });
    if (ensure.error) {
      fail(`chrome ensure failed to run: ${String(ensure.error)}`);
    }
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mainJs, 'with-chrome', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
    env: childEnv(),
  });
  client = new Client({ name: 'lazy-chrome-gate', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    fail(`client connect failed: ${(e && e.message) || String(e)}`);
  }

  const tools = await client.listTools();
  listed = tools.tools.length;
  if (listed === 0) {
    fail('tools/list returned zero tools');
  }

  await sleep(3000);
  const s1 = await sample();

  if (knownBad === 'tool-call') {
    const call = await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } });
    if (call.isError) {
      fail('browser_navigate returned an error result');
    }
  }

  await client.close();
  client = null;
  await sleep(2000);
  const s2 = await sample();

  chrome = Math.max(s1.chrome, s2.chrome);
  answered = s1.answered || s2.answered;

  const ok = chrome === 0 && !answered;
  if (ok) {
    console.log(`LAZY-CHROME: ok listed=${listed} chrome=${chrome} answered=${answered}`);
    exitCode = 0;
  } else {
    console.log(`LAZY-CHROME: FAIL listed=${listed} chrome=${chrome} answered=${answered}`);
    exitCode = 1;
  }
} finally {
  if (client !== null) {
    try {
      await client.close();
    } catch {
      // already gone
    }
  }
  // Always end with `chrome stop` for this home, then a tree kill of any
  // Chrome still on the temp profile, then removal of the temp dirs.
  spawnSync(process.execPath, [mainJs, 'chrome', 'stop'], {
    env: childEnv(),
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const procs = await listChromeProcesses();
    for (const p of procs) {
      if (profileMarkerMatches(p.cmdline, profileDir)) {
        await killTree(p.pid).catch(() => {});
      }
    }
  } catch {
    // process listing unavailable; `chrome stop` already ran
  }
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
      break;
    } catch {
      await sleep(200);
    }
  }
}

process.exit(exitCode);
