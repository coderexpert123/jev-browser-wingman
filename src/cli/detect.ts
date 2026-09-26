// WP-F2: `detect` — a read-only inventory of browser-tool registrations,
// the shared Chrome's state, and the endpoint env markers. Prints nothing
// (§ 3.13); the caller formats. Browsing tools are recognised through their
// capability profiles (spec 2026-09-26-wingman-forced-handoff § 5.8a); no
// browsing product is named in code (C8).

import { homedir } from 'node:os';
import { loadConfig } from '../core/config.js';
import { DEFAULT_BUDGETS, DEFAULT_PORT, DEFAULT_PROFILE_DIR } from '../contract/constants.js';
import type { WingmanConfig } from '../contract/types.js';
import { wingmanHome } from '../contract/home.js';
import { loadProfiles, profileForArgv, type Profile } from '../core/profiles.js';
import { probeVersion, profileHolders } from '../browser/chrome.js';
import {
  clientConfigPath,
  readRegistrations,
  type ClientId,
  type RegistrationEntry,
} from './registrations.js';

// kind is a profile id, 'jev-browser-wingman', or 'other' (§ 5.8a); today's
// tool-family strings survive as profile data, not code.
export type DetectKind = string;
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
  env: Record<string, boolean>;
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
  loadProfilesFn?: typeof loadProfiles;
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

/** An extension/endpoint flag entry matches an argument equal to the flag or
 * starting with <flag>= (§ 5.8a). */
function flagPresent(args: string[], flags: readonly string[]): boolean {
  return flags.some((f) => args.some((a) => a === f || a.startsWith(`${f}=`)));
}

/** § 5.8a mode order, first match wins: the exact wrapper check, then the
 * profile's extension flags, then its endpoint flags, else launch. */
function detectMode(args: string[], profile: Profile | null): DetectMode {
  if (args[0] === 'with-browser' || args[0] === 'with-chrome') return 'wrapped';
  if (flagPresent(args, profile?.detect.extension_flags ?? [])) return 'extension';
  if (flagPresent(args, profile?.detect.endpoint_flags ?? [])) return 'cdp-endpoint';
  return 'launch';
}

function classifyServer(e: RegistrationEntry, profiles: Profile[]): { kind: DetectKind; mode: DetectMode } {
  if (e.command === 'jev-browser-wingman' && e.args.includes('mcp')) {
    return { kind: 'jev-browser-wingman', mode: 'n/a' };
  }
  const profile = profileForArgv(profiles, e.command, e.args);
  return { kind: profile ? profile.id : 'other', mode: detectMode(e.args, profile) };
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
  const profiles = (deps.loadProfilesFn ?? loadProfiles)(wingmanHome(env));

  const clientReports: DetectClientReport[] = [];
  for (const client of clients) {
    const result = await readReg(client, { env, home });
    if ('error' in result) {
      clientReports.push({ client, config: withTilde(clientConfigPath(client, env, process.platform, home), home), exists: true, servers: [] });
      continue;
    }
    const servers: DetectServer[] = result.entries.map((e) => {
      const { kind, mode } = classifyServer(e, profiles);
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
    env: (() => {
      // Every endpoint env marker the profiles know, plus wingman's own.
      const markers: Record<string, boolean> = {
        WINGMAN_CDP_ENDPOINT: Boolean(env.WINGMAN_CDP_ENDPOINT),
      };
      for (const p of profiles) {
        if (p.launch.endpoint_env) markers[p.launch.endpoint_env] = Boolean(env[p.launch.endpoint_env]);
      }
      return markers;
    })(),
  };
}
