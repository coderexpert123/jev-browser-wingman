// Library entry (§ WP-F1 item 2). The mutex and the confirm-token store are
// module-level on purpose: the MCP server builds one wingman instance per
// tools/call, and the busy lock and tokens must persist across those calls.

import { ConfigError } from './contract/errors.js';
import { wingmanHome } from './contract/home.js';
import { loadConfig, resolveKey } from './core/config.js';
import { loadPlugin } from './core/plugin.js';
import { writeLog } from './core/log.js';
import { createMutex } from './core/mutex.js';
import { ConfirmTokenStore } from './core/tokens.js';
import { createDefaultAsk } from './core/jev-client.js';
import { runDo, runCheck, runStep } from './core/loop.js';
import { resolveEndpoint } from './browser/acquire.js';
import { createDriver } from './adapters/index.js';
import type { Driver, JevAsk, WingmanConfig, WingmanPlugin, WingmanResult } from './contract/types.js';

export * from './contract/types.js';
export { createPlaywrightDriver } from './adapters/playwright.js';
export { createCdpDriver } from './adapters/cdp.js';

const mutex = createMutex();
const tokens = new ConfirmTokenStore();

export interface Wingman {
  do(input: unknown): Promise<WingmanResult>;
  check(input: unknown): Promise<WingmanResult>;
  step(input: unknown): Promise<WingmanResult>;
  config: WingmanConfig;
}

export async function createWingman(
  opts: { env?: NodeJS.ProcessEnv; driver?: 'playwright' | 'cdp' | Driver; ask?: JevAsk } = {},
): Promise<Wingman> {
  const env = opts.env ?? process.env;

  const loadedConfig = await loadConfig(env);
  if (!loadedConfig.ok) {
    throw new ConfigError(loadedConfig.error);
  }
  const config = loadedConfig.config;

  let plugin: WingmanPlugin | null = null;
  if (config.plugin) {
    const loadedPlugin = await loadPlugin(config.plugin);
    if (!loadedPlugin.ok) {
      throw new ConfigError(loadedPlugin.error);
    }
    plugin = loadedPlugin.plugin;
  }

  // Plugin hosts join the machine-local config, unioned per category (C6).
  if (plugin?.sensitiveHosts) {
    for (const [category, hosts] of Object.entries(plugin.sensitiveHosts)) {
      const merged = new Set(config.sensitive_hosts[category as keyof WingmanConfig['sensitive_hosts']] ?? []);
      for (const host of hosts ?? []) {
        merged.add(host);
      }
      config.sensitive_hosts[category as keyof WingmanConfig['sensitive_hosts']] = [...merged];
    }
  }

  const key = opts.ask === undefined ? resolveKey(env, config.secrets_file).key : undefined;
  const ask: JevAsk | null = opts.ask ?? plugin?.ask ?? (key ? createDefaultAsk({ apiKey: key }) : null);

  const driver = opts.driver;
  const driverFactory = (): Driver => {
    if (typeof driver === 'object' && driver !== null) {
      return driver;
    }
    return createDriver(driver ?? config.adapter);
  };

  const home = wingmanHome(env);
  const deps = {
    config,
    driverFactory,
    resolveEndpoint: async () => (await resolveEndpoint(env, config))?.endpoint ?? null,
    ask,
    ...(plugin?.lockCheck ? { lockCheck: plugin.lockCheck } : {}),
    mutex,
    tokens,
    writeLog: (record: Parameters<typeof writeLog>[0]) => writeLog(record, { home, plugin }),
  };

  return {
    do: (input: unknown) => runDo(input, deps),
    check: (input: unknown) => runCheck(input, deps),
    step: (input: unknown) => runStep(input, deps),
    config,
  };
}
