// WP-F2: `doctor` (§ 3.10). Nine read-only checks in DOCTOR_CHECK_IDS order;
// never edits anything and never launches the shared Chrome. The only launch
// is the ephemeral headless Chrome inside `jev-round`.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_VERSION } from '../contract/constants.js';
import {
  DOCTOR_CHECK_IDS,
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorReport,
  type Driver,
  type JevAsk,
  type Mode,
  type SensitiveHostCategory,
  type WingmanConfig,
  type WingmanPlugin,
} from '../contract/types.js';
import { loadConfig, resolveKey } from '../core/config.js';
import { loadPlugin } from '../core/plugin.js';
import { createMutex } from '../core/mutex.js';
import { ConfirmTokenStore } from '../core/tokens.js';
import { runCheck } from '../core/loop.js';
import { createDefaultAsk } from '../core/jev-client.js';
import { policySelfTest } from '../core/policy.js';
import { BUILTIN_HOSTS } from '../core/policy-data.js';
import { listChromeProcesses } from '../browser/process-list.js';
import {
  isDefaultUserDataDir,
  probeVersion,
  profileHolders,
} from '../browser/chrome.js';
import { resolveEndpoint } from '../browser/acquire.js';
import { launchEphemeralChrome } from '../browser/ephemeral.js';
import { startFixtureServer } from '../fixture-server.js';
import { CdpConnection } from '../adapters/cdp-connection.js';
import { createDriver } from '../adapters/index.js';
import {
  portabilityProblems,
  readRegistrations,
  type ClientId,
} from './registrations.js';
import { fingerprint, onlyUrlsChanged } from './coexistence-probe.js';

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  loadConfigFn?: typeof loadConfig;
  loadPluginFn?: typeof loadPlugin;
  driverFactory?: (config: WingmanConfig) => Driver;
  resolveEndpointFn?: typeof resolveEndpoint;
  listChromeProcessesFn?: typeof listChromeProcesses;
  probeVersionFn?: typeof probeVersion;
  profileHoldersFn?: typeof profileHolders;
  isDefaultUserDataDirFn?: typeof isDefaultUserDataDir;
  cdpConnect?: typeof CdpConnection.connect;
  launchEphemeralChromeFn?: typeof launchEphemeralChrome;
  startFixtureServerFn?: typeof startFixtureServer;
  ask?: JevAsk;
  readRegistrationsFn?: typeof readRegistrations;
  /** Replaces the built-in host lists wholesale; the known-bad injection point. */
  policyLists?: () => Record<SensitiveHostCategory, readonly string[]>;
}

function defaultClient(env: NodeJS.ProcessEnv): ClientId {
  if (env.CLAUDECODE) return 'claude';
  if (env.CODEX_CLI_PATH || env.CODEX_HOME) return 'codex';
  if (env.OPENCODE) return 'opencode';
  if (env.ANTIGRAVITY_AGENT) return 'agy';
  if (env.CHISEL_SESSION_DB) return 'devin';
  return 'claude';
}

function mergeLists(
  base: Record<SensitiveHostCategory, readonly string[]>,
  extra: Partial<Record<SensitiveHostCategory, string[]>>,
): Record<SensitiveHostCategory, readonly string[]> {
  const out = {} as Record<SensitiveHostCategory, readonly string[]>;
  for (const category of Object.keys(base) as SensitiveHostCategory[]) {
    out[category] = [...(base[category] ?? []), ...(extra?.[category] ?? [])];
  }
  return out;
}

export async function runDoctor(
  opts: { client?: ClientId; json: boolean },
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const env = deps.env ?? process.env;
  const client = opts.client ?? defaultClient(env);
  const checks: DoctorCheck[] = [];
  const failed = new Set<DoctorCheckId>();
  const add = (id: DoctorCheckId, status: DoctorCheck['status'], detail: string): void => {
    checks.push({ id, status, detail });
    if (status === 'FAIL') failed.add(id);
  };
  const skip = (id: DoctorCheckId, dependency: DoctorCheckId): void => {
    add(id, 'SKIP', `skipped: ${dependency} failed`);
  };

  // Config is loaded once, up front: key-present needs the secrets_file path
  // even though the check order reports config-loaded second.
  const loaded = await (deps.loadConfigFn ?? loadConfig)(env);
  const config: WingmanConfig | null = loaded.ok ? loaded.config : null;
  const cfg = () => {
    if (!config) throw new Error('config not loaded');
    return config;
  };

  // 1. key-present — the key never appears in output.
  {
    const key = resolveKey(env, config?.secrets_file ?? null);
    if (key.key) {
      add('key-present', 'PASS', `source=${key.source}`);
    } else {
      add('key-present', 'FAIL', 'TYPESAFE_API_KEY is not set in the environment or in secrets_file');
    }
  }

  // 2. config-loaded
  let plugin: WingmanPlugin | null = null;
  {
    if (!loaded.ok) {
      add('config-loaded', 'FAIL', loaded.error);
    } else if (loaded.config.plugin) {
      const p = await (deps.loadPluginFn ?? loadPlugin)(loaded.config.plugin);
      if (!p.ok) {
        add('config-loaded', 'FAIL', p.error);
      } else {
        plugin = p.plugin;
        add('config-loaded', 'PASS', 'config and plugin loaded');
      }
    } else {
      add('config-loaded', 'PASS', loaded.source === 'defaults' ? 'defaults (no config file)' : 'config loaded');
    }
  }

  // 3. registration-portable (independent of the config)
  {
    const rr = await (deps.readRegistrationsFn ?? readRegistrations)(client, { env });
    if ('error' in rr) {
      add('registration-portable', 'FAIL', rr.error);
    } else {
      const relevant = rr.entries.filter(
        (e) => e.server === 'jev-browser-wingman' || e.command === 'jev-browser-wingman' || e.args.includes('with-chrome'),
      );
      if (relevant.length === 0) {
        add('registration-portable', 'SKIP', 'no jev-browser-wingman or with-chrome registration exists');
      } else {
        const problems = relevant.flatMap(portabilityProblems);
        if (problems.length > 0) {
          add('registration-portable', 'FAIL', problems.join('; '));
        } else {
          add('registration-portable', 'PASS', `${relevant.length} registration(s) portable`);
        }
      }
    }
  }

  // 4. policy-loaded
  if (failed.has('config-loaded')) {
    skip('policy-loaded', 'config-loaded');
  } else {
    const lists = deps.policyLists ? deps.policyLists() : mergeLists(BUILTIN_HOSTS, cfg().sensitive_hosts);
    const selfTest = policySelfTest(lists);
    if (selfTest.ok) {
      add('policy-loaded', 'PASS', 'policy lists load and the self-test host classifies sensitive-identity');
    } else {
      add('policy-loaded', 'FAIL', selfTest.detail);
    }
  }

  // 5. profile-safe
  if (failed.has('config-loaded')) {
    skip('profile-safe', 'config-loaded');
  } else {
    const c = cfg();
    const isDefault = deps.isDefaultUserDataDirFn ?? isDefaultUserDataDir;
    const holdersFn = deps.profileHoldersFn ?? profileHolders;
    const probe = deps.probeVersionFn ?? probeVersion;
    if (isDefault(c.profile_dir, process.platform, env)) {
      add('profile-safe', 'FAIL', `profile_dir ${c.profile_dir} is Chrome's default user-data dir`);
    } else {
      const holders = await holdersFn(c.profile_dir);
      if (holders.withoutPort.length > 0) {
        add(
          'profile-safe',
          'FAIL',
          `Chrome pid(s) ${holders.withoutPort.join(', ')} hold ${c.profile_dir} without a debug port`,
        );
      } else {
        const answer = await probe(c.port, 1500);
        if (!answer) {
          add('profile-safe', 'PASS', 'profile_dir is not the default dir and nothing answers on the port');
        } else {
          const onPort = holders.withPort.find((h) => h.port === c.port);
          if (!onPort) {
            add('profile-safe', 'FAIL', `the Chrome answering on port ${c.port} uses a different profile`);
          } else {
            add('profile-safe', 'PASS', `the Chrome answering on port ${c.port} uses profile_dir`);
          }
        }
      }
    }
  }

  // 6. adapter-attach
  let endpoint: string | null = null;
  if (failed.has('config-loaded')) {
    skip('adapter-attach', 'config-loaded');
  } else {
    const c = cfg();
    const resolved = await (deps.resolveEndpointFn ?? resolveEndpoint)(env, c);
    if (!resolved) {
      add('adapter-attach', 'FAIL', `nothing listening on port ${c.port} and no endpoint env is set`);
    } else {
      endpoint = resolved.endpoint;
      const driver = (deps.driverFactory ?? ((cf: WingmanConfig) => createDriver(cf.adapter)))(c);
      try {
        await driver.attach({ cdpEndpoint: endpoint });
        const pages = await driver.pages();
        add('adapter-attach', 'PASS', `attached to ${endpoint}; ${pages.length} page(s)`);
      } catch (e) {
        add('adapter-attach', 'FAIL', `attach failed: ${(e as Error).message}`);
      } finally {
        try {
          await driver.detach();
        } catch {
          // detach errors never mask the check result
        }
      }
    }
  }

  // 7. default-context
  if (failed.has('config-loaded')) {
    skip('default-context', 'config-loaded');
  } else if (failed.has('adapter-attach')) {
    skip('default-context', 'adapter-attach');
  } else {
    const c = cfg();
    let conn: CdpConnection | null = null;
    try {
      conn = await (deps.cdpConnect ?? CdpConnection.connect)(endpoint!);
      const before = await conn.send<{ browserContextIds?: string[] }>('Target.getBrowserContexts');
      const beforeIds = [...(before.browserContextIds ?? [])].sort();
      const driver = (deps.driverFactory ?? ((cf: WingmanConfig) => createDriver(cf.adapter)))(c);
      await driver.attach({ cdpEndpoint: endpoint! });
      let outside = -1;
      let cookieCount = -1;
      try {
        const pages = await driver.pages();
        const targets = await conn.send<{
          targetInfos: Array<{ targetId: string; type: string; browserContextId?: string }>;
        }>('Target.getTargets');
        const defaultPageIds = new Set(
          targets.targetInfos
            .filter((t) => t.type === 'page' && (!t.browserContextId || !beforeIds.includes(t.browserContextId)))
            .map((t) => t.targetId),
        );
        outside = pages.filter((p) => !defaultPageIds.has(p.id)).length;
        // Cookie counting: browser-level cookie commands are gone from
        // current Chrome (Network.getAllCookies removed; Storage.getCookies
        // never answers at browser scope), so count through a page session.
        const firstPage = targets.targetInfos.find((t) => t.type === 'page');
        if (firstPage) {
          const session = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId: firstPage.targetId,
            flatten: true,
          });
          try {
            const cookies = await conn.send<{ cookies?: unknown[] }>(
              'Storage.getCookies',
              {},
              session.sessionId,
            );
            cookieCount = cookies.cookies?.length ?? 0;
          } finally {
            await conn.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
          }
        }
      } finally {
        try {
          await driver.detach();
        } catch {
          // detach errors never mask the check result
        }
      }
      const after = await conn.send<{ browserContextIds?: string[] }>('Target.getBrowserContexts');
      const afterIds = [...(after.browserContextIds ?? [])].sort();
      const unchanged = JSON.stringify(beforeIds) === JSON.stringify(afterIds);
      if (outside === 0 && unchanged) {
        add('default-context', 'PASS', `attach stayed in the default context; cookies=${cookieCount}`);
      } else {
        add(
          'default-context',
          'FAIL',
          `pages outside the default context: ${outside}; contexts changed by attach/detach: ${!unchanged}`,
        );
      }
    } catch (e) {
      add('default-context', 'FAIL', (e as Error).message);
    } finally {
      if (conn) {
        await conn.close().catch(() => {});
      }
    }
  }

  // 8. coexistence
  if (failed.has('config-loaded')) {
    skip('coexistence', 'config-loaded');
  } else if (failed.has('adapter-attach')) {
    skip('coexistence', 'adapter-attach');
  } else {
    const c = cfg();
    let conn: CdpConnection | null = null;
    try {
      conn = await (deps.cdpConnect ?? CdpConnection.connect)(endpoint!);
      const before = await fingerprint(conn);
      const driver = (deps.driverFactory ?? ((cf: WingmanConfig) => createDriver(cf.adapter)))(c);
      await driver.attach({ cdpEndpoint: endpoint! });
      await driver.detach();
      let after = await fingerprint(conn);
      if (JSON.stringify(before) !== JSON.stringify(after) && onlyUrlsChanged(before, after)) {
        after = await fingerprint(conn);
      }
      if (JSON.stringify(before) === JSON.stringify(after)) {
        add('coexistence', 'PASS', `observer fingerprint identical across attach/detach (${after.pages.length} page(s))`);
      } else {
        add('coexistence', 'FAIL', 'observer fingerprint changed across attach/detach');
      }
    } catch (e) {
      add('coexistence', 'FAIL', (e as Error).message);
    } finally {
      if (conn) {
        await conn.close().catch(() => {});
      }
    }
  }

  // 9. jev-round
  if (failed.has('config-loaded')) {
    skip('jev-round', 'config-loaded');
  } else if (failed.has('key-present') && !plugin?.ask && !deps.ask) {
    skip('jev-round', 'key-present');
  } else {
    const c = cfg();
    const ephemeral = await (deps.launchEphemeralChromeFn ?? launchEphemeralChrome)({ headless: true });
    const fixture = await (deps.startFixtureServerFn ?? startFixtureServer)();
    let conn: CdpConnection | null = null;
    try {
      conn = await (deps.cdpConnect ?? CdpConnection.connect)(ephemeral.endpoint);
      // The observer opens the page; the driver never opens one (§ WP-F2 item 4).
      const created = await conn.send<{ targetId: string }>('Target.createTarget', {
        url: `${fixture.url}/doctor.html`,
      });
      // A fresh target still reports about:blank until the navigation
      // commits; wait for it, or runCheck would read about:blank and stop at
      // the policy with unsupported-page.
      const pageUrl = `${fixture.url}/doctor.html`;
      const loadDeadline = Date.now() + 10_000;
      while (Date.now() < loadDeadline) {
        let committed = false;
        try {
          const session = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId: created.targetId,
            flatten: true,
          });
          try {
            const r = await conn.send<{ result?: { value?: unknown } }>(
              'Runtime.evaluate',
              { expression: 'location.href', returnByValue: true },
              session.sessionId,
              1000,
            );
            committed = r.result?.value === pageUrl;
          } finally {
            await conn.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => {});
          }
        } catch {
          // page not ready; poll again
        }
        if (committed) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      await conn.close().catch(() => {});
      conn = null;

      let ask: JevAsk | null = deps.ask ?? plugin?.ask ?? null;
      if (!ask) {
        const key = resolveKey(env, c.secrets_file);
        if (!key.key) {
          add('jev-round', 'SKIP', 'skipped: key-present failed');
        } else {
          ask = createDefaultAsk({ apiKey: key.key });
        }
      }
      if (ask) {
        const result = await runCheck(
          { question: 'Is there a button labelled Continue on this page?', url_match: '/doctor.html' },
          {
            config: c,
            driverFactory: deps.driverFactory ?? ((cf: WingmanConfig) => createDriver(cf.adapter)),
            resolveEndpoint: async () => ephemeral.endpoint,
            ask,
            // No lockCheck: the ephemeral browser is not the shared one.
            mutex: createMutex(),
            tokens: new ConfirmTokenStore(),
            writeLog: async () => {},
            forceMode: 'on' as Mode,
          },
        );
        if (result.status === 'done' && result.reason === 'answered' && result.cost.jev_calls >= 1) {
          add('jev-round', 'PASS', `runCheck answered with ${result.cost.jev_calls} jev call(s)`);
        } else {
          add(
            'jev-round',
            'FAIL',
            `runCheck returned status=${result.status} reason=${result.reason} jev_calls=${result.cost.jev_calls}`,
          );
        }
      }
    } catch (e) {
      add('jev-round', 'FAIL', (e as Error).message);
    } finally {
      if (conn) {
        await conn.close().catch(() => {});
      }
      await fixture.close().catch(() => {});
      await ephemeral.close().catch(() => {});
    }
  }

  const verdict: DoctorReport['verdict'] = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS';
  const report: DoctorReport = { verdict, version: PACKAGE_VERSION, client, checks };
  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    for (const c of checks) {
      process.stdout.write(`${c.status} ${c.id}  ${c.detail}\n`);
    }
    process.stdout.write(`verdict: ${verdict}\n`);
  }
  return report;
}

/** Used by tests to build a valid config file in a temp home. */
export async function writeTempConfig(home: string, config: Partial<WingmanConfig>): Promise<string> {
  await mkdir(home, { recursive: true });
  const configPath = join(home, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  return configPath;
}
