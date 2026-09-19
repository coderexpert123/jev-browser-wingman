#!/usr/bin/env node
// CLI entry (§ WP-F1 item 6). Before anything else runs, console.log,
// console.info and console.debug are rerouted to stderr: a host plugin may log
// through console.log (PA's log() writes every `info` line to stdout, and
// askSystemOne logs `info` on every successful call), and on stdout that would
// corrupt the MCP stream and the one-line JSON outputs. Every intended stdout
// write (JSON results, --version, guide, doctor output) uses
// process.stdout.write; the MCP SDK's stdio transport already does.

const logToStderr = (...a: unknown[]) => console.error(...a);
console.log = logToStderr;
console.info = logToStderr;
console.debug = logToStderr;

import { PACKAGE_NAME, PACKAGE_VERSION } from '../contract/constants.js';
import { runMcpServer } from '../surfaces/mcp-server.js';
import { chromeCommand } from './chrome-cmd.js';
import { detect } from './detect.js';
import { guideCommand } from './guide.js';
import { runDoctor } from './doctor.js';
import type { ClientId } from './registrations.js';
import { checkCommand, runCommand, USAGE_CHECK, USAGE_RUN } from './run-cmd.js';
import { runWithChrome } from './with-chrome.js';

const CLIENTS: readonly ClientId[] = ['claude', 'codex', 'opencode', 'agy', 'devin', 'cursor'];

const USAGE = [
  `${PACKAGE_NAME} — a step tool for browser agents`,
  USAGE_RUN,
  USAGE_CHECK,
  'usage: jev-browser-wingman mcp',
  'usage: jev-browser-wingman chrome ensure|status|stop',
  'usage: jev-browser-wingman with-chrome -- <command> [args...]',
  'usage: jev-browser-wingman doctor [--json] [--detect] [--client <claude|codex|opencode|agy|devin|cursor>]',
  'usage: jev-browser-wingman guide',
  'usage: jev-browser-wingman --version | --help',
].join('\n');

async function main(argv: string[]): Promise<number | null> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (cmd === '--version') {
    process.stdout.write(`${PACKAGE_NAME} ${PACKAGE_VERSION}\n`);
    return 0;
  }

  switch (cmd) {
    case 'mcp':
      // Resolves only when the transport closes; returning null keeps the
      // process alive until then instead of exiting after connect.
      await runMcpServer();
      return null;
    case 'run':
      return runCommand(rest);
    case 'check':
      return checkCommand(rest);
    case 'guide':
      return guideCommand();
    case 'chrome': {
      const sub = rest[0];
      if (sub !== 'ensure' && sub !== 'status' && sub !== 'stop') {
        process.stderr.write('usage: jev-browser-wingman chrome ensure|status|stop\n');
        return 2;
      }
      return chromeCommand(sub);
    }
    case 'with-chrome': {
      const dd = rest.indexOf('--');
      if (dd === -1) {
        process.stderr.write('usage: jev-browser-wingman with-chrome -- <command> [args...]\n');
        return 2;
      }
      return runWithChrome(rest.slice(dd + 1));
    }
    case 'doctor': {
      const json = rest.includes('--json');
      const doDetect = rest.includes('--detect');
      const clientIndex = rest.indexOf('--client');
      let client: ClientId | undefined;
      if (clientIndex !== -1) {
        const value = rest[clientIndex + 1] as ClientId;
        if (!value || !CLIENTS.includes(value)) {
          process.stderr.write(`unknown client: ${String(rest[clientIndex + 1])}\n`);
          return 2;
        }
        client = value;
      }
      if (doDetect) {
        process.stdout.write(`${JSON.stringify(await detect())}\n`);
        return 0;
      }
      const report = await runDoctor(client ? { client, json } : { json });
      return report.verdict === 'PASS' ? 0 : 1;
    }
  }

  process.stderr.write(`${USAGE}\n`);
  return 2;
}

const code = await main(process.argv.slice(2));
if (code !== null) {
  process.exit(code);
}
