// WP-F2: `detect` — a read-only inventory of browser-tool registrations,
// the shared Chrome's state, and the endpoint env markers. Prints nothing
// (§ 3.13); the caller formats.

import { homedir } from 'node:os';
import { loadConfig } from '../core/config.js';
import { DEFAULT_BUDGETS, DEFAULT_PORT, DEFAULT_PROFILE_DIR } from '../contract/constants.js';
import type { WingmanConfig } from '../contract/types.js';
import { probeVersion, profileHolders } from '../browser/chrome.js';
import {
  clientConfigPath,
  readRegistrations,
  type ClientId,
  type RegistrationEntry,
} from './registrations.js';

export type DetectKind = 'playwright-mcp' | 'chrome-devtools-mcp' | 'jev-browser-wingman' | 'other';
export type DetectMode = 'launch' | 'cdp-endpoint' | 'extension' | 'wrapped' | 'n/a';

export interface DetectServer {
  name: string;
  command: string;
  args: string[];
  kind: DetectKind;
  mode: DetectMode;
}

export interface DetectClientReport {
  client: ClientId;
  config: string;
  exists: boolean;
  servers: DetectServer[];
}

export interface DetectReport {
  clients: DetectClientReport[];
  browser: {
    port: number;
    answering: boolean;
    profile_dir: string;
    holders: { withPort: Array<{ pid: number; port: number }>; withoutPort: number[] };
  };
  env: { WINGMAN_CDP_ENDPOINT: boolean; PLAYWRIGHT_MCP_CDP_ENDPOINT: boolean };
}

export const DETECT_CLIENTS: readonly ClientId[] = ['claude', 'codex', 'opencode', 'agy', 'devin', 'cursor'];

export interface DetectDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  clients?: readonly ClientId[];
  readRegistrationsFn?: typeof readRegistrations;
  probeVersionFn?: typeof probeVersion;
  profileHoldersFn?: typeof profileHolders;
  loadConfigFn?: typeof loadConfig;
}

const DEFAULT_CONFIG: WingmanConfig = {
  mode: 'off',
  adapter: 'playwright',
  window: 'offscreen',
  profile_dir: DEFAULT_PROFILE_DIR.replace(/^~(?=\/|\\|$)/, homedir()),
  port: DEFAULT_PORT,
  chrome_path: null,
  secrets_file: null,
  plugin: null,
  sensitive_hosts: {},
  budgets: { ...DEFAULT_BUDGETS },
};

function withTilde(p: string, home: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/') || p.startsWith(home + '\\')) return '~' + p.slice(home.length);
  return p;
}

function classifyServer(e: RegistrationEntry): { kind: DetectKind; mode: DetectMode } {
  const argsInclude = (needle: string) => e.args.some((a) => a.includes(needle));
  if (argsInclude('@playwright/mcp') || e.command.includes('@playwright/mcp')) {
    let mode: DetectMode = 'launch';
    if (argsInclude('--cdp-endpoint')) mode = 'cdp-endpoint';
    else if (e.args.some((a) => a === '--extension' || a.startsWith('--extension='))) mode = 'extension';
    else if (e.args[0] === 'with-chrome') mode = 'wrapped';
    return { kind: 'playwright-mcp', mode };
  }
  if (argsInclude('chrome-devtools-mcp') || e.command.includes('chrome-devtools-mcp')) {
    const mode: DetectMode = argsInclude('--browserUrl') || argsInclude('--browser-url') ? 'cdp-endpoint' : 'launch';
    return { kind: 'chrome-devtools-mcp', mode };
  }
  if (e.command === 'jev-browser-wingman' && e.args.includes('mcp')) {
    return { kind: 'jev-browser-wingman', mode: 'n/a' };
  }
  return { kind: 'other', mode: 'n/a' };
}

function maskSecrets(args: string[]): string[] {
  return args.map((a) => (/(key|token|secret)=/i.test(a) ? '***' : a));
}

export async function detect(deps: DetectDeps = {}): Promise<DetectReport> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const clients = deps.clients ?? DETECT_CLIENTS;
  const readReg = deps.readRegistrationsFn ?? readRegistrations;
  const probe = deps.probeVersionFn ?? probeVersion;
  const holders = deps.profileHoldersFn ?? profileHolders;

  const loaded = await (deps.loadConfigFn ?? loadConfig)(env);
  const config: WingmanConfig = loaded.ok ? loaded.config : DEFAULT_CONFIG;

  const clientReports: DetectClientReport[] = [];
  for (const client of clients) {
    const result = await readReg(client, { env, home });
    if ('error' in result) {
      clientReports.push({ client, config: withTilde(clientConfigPath(client, env, process.platform, home), home), exists: true, servers: [] });
      continue;
    }
    const servers: DetectServer[] = result.entries.map((e) => {
      const { kind, mode } = classifyServer(e);
      return { name: e.server, command: e.command, args: maskSecrets(e.args), kind, mode };
    });
    clientReports.push({
      client,
      config: withTilde(result.file, home),
      exists: result.exists,
      servers,
    });
  }

  const answering = (await probe(config.port, 1500)) !== null;
  const holdersResult = await holders(config.profile_dir);

  return {
    clients: clientReports,
    browser: {
      port: config.port,
      answering,
      profile_dir: withTilde(config.profile_dir, home),
      holders: { withPort: holdersResult.withPort, withoutPort: holdersResult.withoutPort },
    },
    env: {
      WINGMAN_CDP_ENDPOINT: Boolean(env.WINGMAN_CDP_ENDPOINT),
      PLAYWRIGHT_MCP_CDP_ENDPOINT: Boolean(env.PLAYWRIGHT_MCP_CDP_ENDPOINT),
    },
  };
}
