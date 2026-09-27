// WP-F2: `doctor` (§ 3.10). Ten read-only checks in DOCTOR_CHECK_IDS order;
// never edits anything and never launches the shared Chrome. The only launch
// is the ephemeral headless Chrome inside `jev-round`. `handoff` (§ 5.10,
// forced-handoff spec) is offline: it never spawns or attaches to a browser
// and never calls TypeSafe, so `--plan` (setup-plan.ts) can reuse it.

import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
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
import { loadConfig, resolveKey, handoffOf, policyModeOf, gateModeOf } from '../core/config.js';
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
import { wingmanHome } from '../contract/home.js';
import { loadProfiles, profileForArgv, withheldClasses, denyEntries } from '../core/profiles.js';
import { adapterOps } from '../adapters/capabilities.js';
import {
  clientConfigPath,
  portabilityProblems,
  readRegistrations,
  type ClientId,
  type RegistrationEntry,
} from './registrations.js';
import { fingerprint, onlyUrlsChanged } from './coexistence-probe.js';

/** An extension/endpoint flag entry matches an argument equal to the flag or
 * starting with <flag>= (§ 5.8a; mirrors detect.ts's own copy — that file is
 * WP-H's, this one is WP-I's). */
function flagPresent(args: readonly string[], flags: readonly string[]): boolean {
  return flags.some((f) => args.some((a) => a === f || a.startsWith(`${f}=`)));
}

/** The result of reading a client's own settings/config for layer-2 (tool
 * deny list) enforcement (§ 5.10). `denyList` entries are in the same shape
 * `denyEntries()` produces (`mcp__<server>__<tool>` for claude,
 * `<server>_<tool>` for opencode). */
export interface ClientSettingsResult {
  exists: boolean;
  denyList: string[];
}

/** Best-effort default reader for the two clients with a known tool-deny
 * shape. Any other client, or any read/parse failure, reports no deny list
 * (never throws): the `handoff` check then falls through to its other rows. */
async function defaultReadSettings(
  client: ClientId,
  env: NodeJS.ProcessEnv,
): Promise<ClientSettingsResult> {
  try {
    if (client === 'claude') {
      const raw = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')) as {
        permissions?: { deny?: unknown };
      };
      const deny = raw.permissions?.deny;
      return { exists: true, denyList: Array.isArray(deny) ? deny.filter((d): d is string => typeof d === 'string') : [] };
    }
    if (client === 'opencode') {
      const p = clientConfigPath('opencode', env);
      // opencode.jsonc allows line comments; a JSON parse of most real files
      // still succeeds, and a best-effort comment strip covers the rest.
      const text = (await readFile(p, 'utf8')).replace(/^\s*\/\/.*$/gm, '');
      const raw = JSON.parse(text) as { mcp?: Record<string, { tools?: Record<string, unknown> }> };
      const denyList: string[] = [];
      for (const [server, serverCfg] of Object.entries(raw.mcp ?? {})) {
        for (const [tool, enabled] of Object.entries(serverCfg.tools ?? {})) {
          if (enabled === false) denyList.push(`${server}_${tool}`);
        }
      }
      return { exists: true, denyList };
    }
  } catch {
    // no settings file, or it does not parse: report no deny list.
  }
  return { exists: false, denyList: [] };
}

/** Tool names an auto-classification profile left `unknown` (§ 10.2): every
 * `<home>/profiles-auto/*.json`'s `tools` map entries whose class is
 * `'unknown'`. `null` when the directory does not exist or holds no files
 * (nothing auto-classified yet). */
async function unclassifiedToolNames(home: string): Promise<string[] | null> {
  const dir = join(home, 'profiles-auto');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const jsonNames = names.filter((n) => n.endsWith('.json'));
  if (jsonNames.length === 0) return null;
  const out: string[] = [];
  for (const name of jsonNames) {
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as { tools?: Record<string, string> };
      for (const [tool, cls] of Object.entries(raw.tools ?? {})) {
        if (cls === 'unknown') out.push(tool);
      }
    } catch {
      // an invalid auto profile contributes no names; loadProfiles itself
      // already reports it with its own stderr line.
    }
  }
  return out;
}

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
  loadProfilesFn?: typeof loadProfiles;
  readSettingsFn?: typeof defaultReadSettings;
}

/** `defaultClient` is exported for `setup-plan.ts` (I3), which picks the same
 * client `doctor` would when the caller passes none. */
export function defaultClient(env: NodeJS.ProcessEnv): ClientId {
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
  opts: { client?: ClientId; json: boolean; offlineOnly?: boolean; print?: boolean },
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
    // § 5.10 Q6: the PASS detail always ends with the gate mode in force.
    const gateSuffix = (config: WingmanConfig): string =>
      gateModeOf(config) === 'confirm'
        ? '; gate: confirm'
        : '; gate: off (optional toggle; set gate.mode "confirm" to require confirmation of irreversible actions)';
    if (!loaded.ok) {
      add('config-loaded', 'FAIL', loaded.error);
    } else if (loaded.config.plugin) {
      const p = await (deps.loadPluginFn ?? loadPlugin)(loaded.config.plugin);
      if (!p.ok) {
        add('config-loaded', 'FAIL', p.error);
      } else {
        plugin = p.plugin;
        add('config-loaded', 'PASS', `config and plugin loaded${gateSuffix(loaded.config)}`);
      }
    } else {
      add(
        'config-loaded',
        'PASS',
        `${loaded.source === 'defaults' ? 'defaults (no config file)' : 'config loaded'}${gateSuffix(loaded.config)}`,
      );
    }
  }

  // 3. registration-portable (independent of the config)
  {
    const rr = await (deps.readRegistrationsFn ?? readRegistrations)(client, { env });
    if ('error' in rr) {
      add('registration-portable', 'FAIL', rr.error);
    } else {
      const relevant = rr.entries.filter(
        (e) =>
          e.server === 'jev-browser-wingman' ||
          e.command === 'jev-browser-wingman' ||
          e.args.includes('with-chrome') ||
          e.args.includes('with-browser'),
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
  if (opts.offlineOnly) {
    add('adapter-attach', 'SKIP', 'not run: doctor --plan is offline only');
  } else if (failed.has('config-loaded')) {
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
  if (opts.offlineOnly) {
    add('default-context', 'SKIP', 'not run: doctor --plan is offline only');
  } else if (failed.has('config-loaded')) {
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
  if (opts.offlineOnly) {
    add('coexistence', 'SKIP', 'not run: doctor --plan is offline only');
  } else if (failed.has('config-loaded')) {
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

  // 9. handoff (§ 5.10; offline: no attach, no launch, no TypeSafe call, so
  // it runs the same whether or not offlineOnly is set).
  if (failed.has('config-loaded')) {
    skip('handoff', 'config-loaded');
  } else {
    const c = cfg();
    const handoff = handoffOf(c);
    if (handoff.mode !== 'forced') {
      const suffix = c.mode !== 'on' ? ` (wingman mode is ${c.mode}; forced needs mode on)` : '';
      add('handoff', 'PASS', `optional: nothing withheld${suffix}`);
    } else {
      const profiles = (deps.loadProfilesFn ?? loadProfiles)(wingmanHome(env));
      const withheld = withheldClasses(adapterOps(c.adapter), handoff.retain);
      const rr = await (deps.readRegistrationsFn ?? readRegistrations)(client, { env });
      const entries: RegistrationEntry[] = 'entries' in rr ? rr.entries : [];
      const settings = await (deps.readSettingsFn ?? defaultReadSettings)(client, env);

      const rows: Array<{ status: 'PASS' | 'FAIL'; detail: string }> = [];
      for (const e of entries) {
        const wrapped = e.args[0] === 'with-browser' || e.args[0] === 'with-chrome';
        const profile = profileForArgv(profiles, e.command, e.args);
        if (!wrapped && !profile) continue; // not a browsing server (§ 5.10)

        let status: 'PASS' | 'FAIL';
        let detail: string;
        if (wrapped) {
          if (profile) {
            status = 'PASS';
            detail = `enforced by proxy: ${e.server} (${profile.id})`;
          } else {
            status = 'PASS';
            detail = `enforced by proxy after auto-classification: ${e.server} (first session classifies; needs a TypeSafe key)`;
          }
        } else {
          const deny = denyEntries(client, e.server, profile!, withheld);
          const denyPresent = deny !== null && deny.entries.every((x) => settings.denyList.includes(x));
          const extensionMode = flagPresent(e.args, profile!.detect.extension_flags);
          if (deny !== null && denyPresent) {
            status = 'PASS';
            detail = `enforced by deny config: ${e.server}`;
          } else if (extensionMode) {
            if (deny !== null) {
              status = 'FAIL';
              detail = `not enforced: ${e.server} is a browser extension; add the deny entries printed by doctor --plan`;
            } else {
              status = 'PASS';
              detail = `NOT ENFORCED: ${e.server} is a browser extension and ${client} has no tool deny list; handoff is instruction-only`;
            }
          } else {
            status = 'FAIL';
            detail = `not enforced: wrap ${e.server} with with-browser (doctor --plan prints the entry)`;
          }
        }
        detail += `; withheld classes: ${withheld.join(', ')}`;
        if (wrapped && !profile) {
          const names = await unclassifiedToolNames(wingmanHome(env));
          detail += names === null ? '; not yet classified' : `; left with the caller (unclassified): ${names.join(', ')}`;
        }
        rows.push({ status, detail });
      }

      let status: DoctorCheck['status'];
      let detail: string;
      if (rows.length === 0) {
        status = 'SKIP';
        detail = 'no browsing tool registered';
      } else {
        status = rows.some((r) => r.status === 'FAIL') ? 'FAIL' : 'PASS';
        detail = rows.map((r) => r.detail).join('; ');
      }
      if (policyModeOf(c) === 'enforce') {
        detail += '; WARNING: policy.mode enforce with forced handoff: sensitive pages come back for pick or the user';
      }
      add('handoff', status, detail);
    }
  }

  // 10. jev-round
  if (opts.offlineOnly) {
    add('jev-round', 'SKIP', 'not run: doctor --plan is offline only');
  } else if (failed.has('config-loaded')) {
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
  // `print` defaults to true for the `doctor` CLI command's own stdout
  // contract; `setup-plan.ts` (I3) calls runDoctor as a pure data source for
  // its offline checks and sets it false, so `doctor --plan [--json]` prints
  // exactly one object/block instead of leaking this inner report first.
  if (opts.print ?? true) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(report) + '\n');
    } else {
      for (const c of checks) {
        process.stdout.write(`${c.status} ${c.id}  ${c.detail}\n`);
      }
      process.stdout.write(`verdict: ${verdict}\n`);
    }
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
