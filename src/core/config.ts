import fs from 'node:fs';
import path from 'node:path';
import { expandHome, wingmanHome } from '../contract/home.js';
import { BUDGET_LIMITS, DEFAULT_BUDGETS, DEFAULT_PORT, DEFAULT_PROFILE_DIR, DEFAULT_GATE, DEFAULT_POLICY, DEFAULT_TAKEOVER, GATE_MODES, POLICY_MODES, TAKEOVER_MODES, TAKEOVER_THRESHOLD_RANGE } from '../contract/constants.js';
import type { GateMode, PolicyMode, TakeoverMode } from '../contract/constants.js';
import { SENSITIVE_HOST_CATEGORIES, WINDOW_MODES } from '../contract/types.js';
import type { Budgets, Mode, SensitiveHostCategory, WindowMode, WingmanConfig } from '../contract/types.js';

const TOP_LEVEL_KEYS = new Set([
  'mode',
  'adapter',
  'window',
  'profile_dir',
  'port',
  'chrome_path',
  'secrets_file',
  'plugin',
  'sensitive_hosts',
  'budgets',
  'gate',
  'policy',
  'takeover',
]);

type LoadResult =
  | { ok: true; config: WingmanConfig; source: 'file' | 'defaults' }
  | { ok: false; error: string };

function validatePath(
  value: unknown,
  key: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `${key} must be a string or null` };
  }
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: `${key} must be an absolute path or start with ~/: ${value}` };
  }
  return { ok: true, value: expanded };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadResult> {
  const home = wingmanHome(env);
  const configPath = path.join(home, 'config.json');

  let raw: unknown;
  let source: 'file' | 'defaults';
  if (fs.existsSync(configPath)) {
    let text: string;
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
      return { ok: false, error: `cannot read config: ${(e as Error).message}` };
    }
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: `malformed JSON in ${configPath}` };
    }
    source = 'file';
  } else {
    raw = {};
    source = 'defaults';
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'config must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, error: `unknown key: ${key}` };
    }
  }

  let mode: Mode = 'off';
  if ('mode' in obj) {
    if (obj.mode !== 'shadow' && obj.mode !== 'on') {
      return { ok: false, error: `invalid mode: ${JSON.stringify(obj.mode)}` };
    }
    mode = obj.mode;
  }

  let adapter: 'playwright' | 'cdp' = 'playwright';
  if ('adapter' in obj) {
    if (obj.adapter !== 'playwright' && obj.adapter !== 'cdp') {
      return { ok: false, error: `invalid adapter: ${JSON.stringify(obj.adapter)}` };
    }
    adapter = obj.adapter;
  }

  let windowMode: WindowMode = 'offscreen';
  if ('window' in obj) {
    if (!(WINDOW_MODES as readonly unknown[]).includes(obj.window)) {
      return { ok: false, error: `invalid window: ${JSON.stringify(obj.window)}` };
    }
    windowMode = obj.window as WindowMode;
  }

  const profileDirRaw = 'profile_dir' in obj ? obj.profile_dir : DEFAULT_PROFILE_DIR;
  if (typeof profileDirRaw !== 'string') {
    return { ok: false, error: 'profile_dir must be a string' };
  }
  const profileDirResult = validatePath(profileDirRaw, 'profile_dir');
  if (!profileDirResult.ok) {
    return profileDirResult;
  }
  const profileDir = profileDirResult.value as string;

  let port = DEFAULT_PORT;
  if ('port' in obj) {
    const p = obj.port;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1024 || p > 65535) {
      return { ok: false, error: `invalid port: ${JSON.stringify(p)}` };
    }
    port = p;
  }

  let chromePath: string | null = null;
  if ('chrome_path' in obj) {
    const r = validatePath(obj.chrome_path, 'chrome_path');
    if (!r.ok) return r;
    chromePath = r.value;
  }

  let secretsFile: string | null = null;
  if ('secrets_file' in obj) {
    const r = validatePath(obj.secrets_file, 'secrets_file');
    if (!r.ok) return r;
    secretsFile = r.value;
  }

  let plugin: string | null = null;
  if ('plugin' in obj) {
    const r = validatePath(obj.plugin, 'plugin');
    if (!r.ok) return r;
    plugin = r.value;
  }

  const sensitiveHosts: Partial<Record<SensitiveHostCategory, string[]>> = {};
  if ('sensitive_hosts' in obj) {
    const sh = obj.sensitive_hosts;
    if (typeof sh !== 'object' || sh === null || Array.isArray(sh)) {
      return { ok: false, error: 'sensitive_hosts must be an object' };
    }
    for (const [category, hosts] of Object.entries(sh as Record<string, unknown>)) {
      if (!(SENSITIVE_HOST_CATEGORIES as readonly string[]).includes(category)) {
        return { ok: false, error: `unknown sensitive_hosts category: ${category}` };
      }
      if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== 'string')) {
        return { ok: false, error: `sensitive_hosts.${category} must be a string array` };
      }
      sensitiveHosts[category as SensitiveHostCategory] = hosts as string[];
    }
  }

  const budgets: Budgets = { ...DEFAULT_BUDGETS };
  if ('budgets' in obj) {
    const b = obj.budgets;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) {
      return { ok: false, error: 'budgets must be an object' };
    }
    const bObj = b as Record<string, unknown>;
    for (const key of Object.keys(BUDGET_LIMITS) as Array<keyof Budgets>) {
      if (!(key in bObj)) continue;
      const value = bObj[key as string];
      const [min, max] = BUDGET_LIMITS[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        return { ok: false, error: `budgets.${key} outside [${min}, ${max}]: ${JSON.stringify(value)}` };
      }
      budgets[key] = value;
    }
  }

  let gate: { mode: GateMode } = { ...DEFAULT_GATE };
  if ('gate' in obj) {
    const g = obj.gate;
    if (typeof g !== 'object' || g === null || Array.isArray(g)) {
      return { ok: false, error: 'gate must be an object' };
    }
    const gObj = g as Record<string, unknown>;
    for (const key of Object.keys(gObj)) {
      if (key !== 'mode') {
        return { ok: false, error: `unknown gate key: ${key}` };
      }
    }
    if ('mode' in gObj) {
      if (!(GATE_MODES as readonly unknown[]).includes(gObj.mode)) {
        return { ok: false, error: `invalid gate.mode: ${JSON.stringify(gObj.mode)}` };
      }
      gate = { mode: gObj.mode as GateMode };
    }
  }

  let policy: { mode: PolicyMode } = { ...DEFAULT_POLICY };
  if ('policy' in obj) {
    const p = obj.policy;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      return { ok: false, error: 'policy must be an object' };
    }
    const pObj = p as Record<string, unknown>;
    for (const key of Object.keys(pObj)) {
      if (key !== 'mode') {
        return { ok: false, error: `unknown policy key: ${key}` };
      }
    }
    if ('mode' in pObj) {
      if (!(POLICY_MODES as readonly unknown[]).includes(pObj.mode)) {
        return { ok: false, error: `invalid policy.mode: ${JSON.stringify(pObj.mode)}` };
      }
      policy = { mode: pObj.mode as PolicyMode };
    }
  }

  let takeover: { threshold: number; mode: TakeoverMode } = { ...DEFAULT_TAKEOVER };
  if ('takeover' in obj) {
    const t = obj.takeover;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      return { ok: false, error: 'takeover must be an object' };
    }
    const tObj = t as Record<string, unknown>;
    for (const key of Object.keys(tObj)) {
      if (key !== 'threshold' && key !== 'mode') {
        return { ok: false, error: `unknown takeover key: ${key}` };
      }
    }
    if ('threshold' in tObj) {
      const th = tObj.threshold;
      const [min, max] = TAKEOVER_THRESHOLD_RANGE;
      if (typeof th !== 'number' || !Number.isFinite(th) || th < min || th > max) {
        return { ok: false, error: `takeover.threshold outside [${min}, ${max}]: ${JSON.stringify(th)}` };
      }
      takeover.threshold = th;
    }
    if ('mode' in tObj) {
      if (!(TAKEOVER_MODES as readonly unknown[]).includes(tObj.mode)) {
        return { ok: false, error: `invalid takeover.mode: ${JSON.stringify(tObj.mode)}` };
      }
      takeover.mode = tObj.mode as TakeoverMode;
    }
  }

  const config: WingmanConfig & {
    gate: { mode: GateMode };
    policy: { mode: PolicyMode };
    takeover: { threshold: number; mode: TakeoverMode };
  } = {
    mode,
    adapter,
    window: windowMode,
    profile_dir: profileDir,
    port,
    chrome_path: chromePath,
    secrets_file: secretsFile,
    plugin,
    sensitive_hosts: sensitiveHosts,
    budgets,
    gate,
    policy,
    takeover,
  };

  return { ok: true, config, source };
}

/** The gate mode in force for a config: `gate.mode` when the loaded config
 * carries it, the default ('confirm') otherwise (§ 3.8). Read through this
 * accessor everywhere; the WingmanConfig type predates the key. */
export function gateModeOf(config: WingmanConfig): GateMode {
  const gate = (config as WingmanConfig & { gate?: { mode?: unknown } }).gate;
  return gate !== null && typeof gate === 'object' && gate.mode === 'off' ? 'off' : 'confirm';
}

/** The policy mode in force for a config: `policy.mode` when the loaded config
 * carries it, the default ('enforce') otherwise (§ 3.7). Read through this
 * accessor everywhere; the WingmanConfig type predates the key. */
export function policyModeOf(config: WingmanConfig): PolicyMode {
  const policy = (config as WingmanConfig & { policy?: { mode?: unknown } }).policy;
  return policy !== null && typeof policy === 'object' && policy.mode === 'off' ? 'off' : 'enforce';
}

/** The takeover config in force for a config: `takeover.threshold`/`takeover.mode`
 * when the loaded config carries the key, the defaults (0.7 / 'auto') otherwise
 * (§ 3.20). Read through this accessor everywhere; the WingmanConfig type
 * predates the key. */
export function takeoverOf(config: WingmanConfig): { threshold: number; mode: TakeoverMode } {
  const takeover = (
    config as WingmanConfig & { takeover?: { threshold: number; mode: TakeoverMode } }
  ).takeover;
  return takeover ?? { ...DEFAULT_TAKEOVER };
}

export function resolveKey(
  env: NodeJS.ProcessEnv,
  secretsFile: string | null,
): { key?: string; source: 'env' | 'secrets_file' | 'none' } {
  const envKey = env.TYPESAFE_API_KEY;
  if (envKey) {
    return { key: envKey, source: 'env' };
  }

  if (secretsFile) {
    let content: string;
    try {
      content = fs.readFileSync(secretsFile, 'utf8');
    } catch {
      return { source: 'none' };
    }
    for (const rawLine of content.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('export ')) {
        line = line.slice('export '.length).trim();
      }
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key !== 'TYPESAFE_API_KEY') continue;
      let value = line.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (value) {
        return { key: value, source: 'secrets_file' };
      }
    }
  }

  return { source: 'none' };
}
