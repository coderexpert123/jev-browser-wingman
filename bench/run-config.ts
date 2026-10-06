// r24b: the run configuration every bench results file records (top-level
// `config`) and the zero-spend baseline preflight behind --baseline /
// --expect-diff (spec .build-r24b-spec.md section 3). Every value is EFFECTIVE
// (after the stance env, BENCH_MODEL and flags) and machine-independent: no
// absolute path enters a value or a hash, and file hashes fold CRLF to LF so an
// autocrlf Windows checkout and a Linux checkout agree. Pure except readGitInfo
// (git), readCallerVersion (claude --version) and the file readers.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { SERVED_TOOLS } from '../src/surfaces/tool-text.js';
import type { CallerLists } from './claude-run.js';

export const RUN_CONFIG_VERSION = 1;

export interface GitInfo {
  head: string | null;
  dirty: boolean | null;
}

export interface BenchRunConfig {
  config_version: number;
  gate_mode: 'off' | 'confirm';
  policy_mode: 'off' | 'enforce';
  git_head: string | null;
  git_dirty: boolean | null;
  routes: string[];
  repeats: number;
  tasks: string[];
  model: string;
  log_labels: boolean;
  caller_cli_version: string | null;
  adapter: string;
  harness_version: number;
  playwright_mcp: string;
  wingman_config_sha256: Record<string, string>;
  mcp_config_sha256: Record<string, string>;
  caller_argv_sha256: Record<string, string>;
  tool_text_sha256: string;
  tasks_sha256: string;
  prompts_sha256: string;
  fixtures_sha256: string;
  profile_sha256: string;
  fixture_server: boolean;
  max_turns_by_route: Record<string, number>;
  per_run_timeout_ms: number;
  caller_model: string | null;
}

/** The compared keys, in the order the preflight reports them. */
export const CONFIG_KEYS: ReadonlyArray<keyof BenchRunConfig> = [
  'config_version', 'gate_mode', 'policy_mode', 'git_head', 'git_dirty', 'routes', 'repeats', 'tasks', 'model',
  'log_labels', 'caller_cli_version', 'adapter', 'harness_version', 'playwright_mcp', 'wingman_config_sha256',
  'mcp_config_sha256', 'caller_argv_sha256', 'tool_text_sha256', 'tasks_sha256', 'prompts_sha256', 'fixtures_sha256',
  'profile_sha256', 'fixture_server', 'max_turns_by_route', 'per_run_timeout_ms', 'caller_model',
];
/** Keys known before any cell: compared by the zero-spend preflight (25). */
export const PRE_KEYS: ReadonlyArray<keyof BenchRunConfig> = CONFIG_KEYS.filter((k) => k !== 'caller_model');
/** Keys learned from the first cell's stream: compared right after it (1). */
export const POST_KEYS: ReadonlyArray<keyof BenchRunConfig> = ['caller_model'];

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** One bench-home config.json (benchConfigText's output) hashed without its two
 * machine paths (profile_dir, secrets_file); key order is benchConfigText's. */
export function wingmanConfigSha256(configText: string): string {
  const obj = JSON.parse(configText) as Record<string, unknown>;
  delete obj.profile_dir;
  delete obj.secrets_file;
  return sha256Hex(JSON.stringify(obj));
}

/** The served tool list: [{name, description, inputSchema}] in tools/list order. */
export function toolTextSha256(tools: unknown = SERVED_TOOLS): string {
  return sha256Hex(JSON.stringify(tools));
}

/** Every regular file under `dir` (recursive), labelled by its forward-slash path relative to `dir`. */
export function treeEntries(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push([path.relative(dir, abs).split(path.sep).join('/'), abs]);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** sha256 over labelled files in label order: label, NUL, content with every CRLF folded to LF, NUL. */
export function filesSha256(entries: Array<[string, string]>): string {
  const h = crypto.createHash('sha256');
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [label, abs] of sorted) {
    const content = Buffer.from(fs.readFileSync(abs).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    h.update(label, 'utf8');
    h.update('\0');
    h.update(content);
    h.update('\0');
  }
  return h.digest('hex');
}

/** Key-sorted JSON, so a hand-written baseline's key order never reads as a difference. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  const s = JSON.stringify(v);
  return s === undefined ? 'null' : s;
}

/** HEAD and tracked-file dirtiness of the checkout at `cwd`; nulls when git is unavailable or slow (15 s each). */
export function readGitInfo(cwd: string): GitInfo {
  try {
    const opts = { cwd, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 15_000 };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], opts);
    return { head: /^[0-9a-f]{40}$/.test(head) ? head : null, dirty: status.trim().length > 0 };
  } catch {
    return { head: null, dirty: null };
  }
}

/** The first x.y.z token of `claude --version` output ('2.1.291 (Claude Code)' gives '2.1.291'); null when absent. */
export function parseCallerVersion(text: string): string | null {
  const m = /\b(\d+\.\d+\.\d+)\b/.exec(text);
  return m ? m[1] : null;
}

/** `claude --version`, spawned the way runClaude spawns the caller (the literal `claude`; win32 through cmd /c). Zero spend. */
export function readCallerVersion(bin = 'claude'): string | null {
  try {
    const r =
      process.platform === 'win32'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${bin} --version"`], {
            encoding: 'utf8',
            timeout: 15_000,
            windowsHide: true,
            windowsVerbatimArguments: true,
          })
        : spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    if (r.error !== undefined || r.status !== 0) return null;
    return parseCallerVersion(String(r.stdout ?? ''));
  } catch {
    return null;
  }
}

/** The one caller_model string for a set of runs: the single init model, `mixed:<a>|<b>` (sorted) when they disagree, null when none. */
export function callerModelOf(models: ReadonlyArray<string | null | undefined>): string | null {
  const uniq = [...new Set(models.filter((m): m is string => typeof m === 'string' && m.length > 0))].sort();
  if (uniq.length === 0) return null;
  return uniq.length === 1 ? uniq[0] : `mixed:${uniq.join('|')}`;
}

export type StanceEnv =
  | { ok: true; gateOn: boolean; gateOff: boolean; policyOn: boolean; policyOff: boolean }
  | { ok: false; line: string };

/** O6: the stance env. `BENCH_<X>_ON` turns that stance on; `BENCH_<X>_OFF` is the legacy spelling of the (now default)
 * off stance. A value other than unset, '' , '1' or 'true' is refused, and so is ON together with OFF. */
export function parseStanceEnv(env: NodeJS.ProcessEnv): StanceEnv {
  const out = { gateOn: false, gateOff: false, policyOn: false, policyOff: false };
  const read = (v: string | undefined): boolean | 'bad' => (v === undefined || v === '' ? false : v === '1' || v === 'true' ? true : 'bad');
  const refuse = (msg: string): StanceEnv => ({ ok: false, line: `BENCH-REFUSED: ${msg}` });
  for (const [what, onName, offName] of [
    ['gate', 'BENCH_GATE_ON', 'BENCH_GATE_OFF'],
    ['policy', 'BENCH_POLICY_ON', 'BENCH_POLICY_OFF'],
  ] as const) {
    const on = read(env[onName]);
    const off = read(env[offName]);
    if (on === 'bad') return refuse(`${onName} must be 1 or true when set`);
    if (off === 'bad') {
      return refuse(`${offName} must be 1 or true when set (the default stance is already off; use ${onName}=1 to turn the ${what} on)`);
    }
    if (on === true && off === true) return refuse(`${onName} and ${offName} are both set`);
    if (what === 'gate') {
      out.gateOn = on === true;
      out.gateOff = off === true;
    } else {
      out.policyOn = on === true;
      out.policyOff = off === true;
    }
  }
  return { ok: true, ...out };
}

export function readBaselineConfig(
  file: string,
): { ok: true; config: Record<string, unknown>; observed: Record<string, unknown> | null } | { ok: false; line: string } {
  const name = path.basename(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, line: `BENCH-REFUSED: baseline ${name} unreadable` };
  }
  const cfg = (parsed as { config?: unknown } | null)?.config;
  if (cfg === null || cfg === undefined || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return {
      ok: false,
      line: `BENCH-REFUSED: baseline ${name} has no config object (a results file written before r24b records none; use bench/baselines/<run>.json)`,
    };
  }
  const obs = (parsed as { observed?: unknown } | null)?.observed;
  const observed = obs !== null && obs !== undefined && typeof obs === 'object' && !Array.isArray(obs) ? (obs as Record<string, unknown>) : null;
  return { ok: true, config: cfg as Record<string, unknown>, observed };
}

// ---- r24b (O7): the observed environment, compared as WARNINGS (never a refusal) ----

/** The init-event lists the bench records by name (hashed, and listed once per results file). */
export const LIST_NAMES = ['tools', 'skills', 'plugins', 'agents', 'mcp_servers', 'hooks'] as const;
export type ListName = (typeof LIST_NAMES)[number];
/** Observed keys: what the run can see about its own environment. Compared to the baseline's `observed` object, warn-only.
 * A list key's value is a map route -> hash ('mixed' when that route's cells disagreed): the caller's tool list differs by route. */
export const SCALAR_OBSERVED_KEYS = ['node_version', 'chrome_version'] as const;
export const LIST_OBSERVED_KEYS = [
  'caller_tools_sha256', 'caller_skills_sha256', 'caller_plugins_sha256', 'caller_agents_sha256',
  'caller_mcp_servers_sha256', 'caller_hooks_sha256',
] as const;
export const OBSERVED_KEYS = [...SCALAR_OBSERVED_KEYS, ...LIST_OBSERVED_KEYS] as const;
export type ScalarObservedKey = (typeof SCALAR_OBSERVED_KEYS)[number];
export type ListObservedKey = (typeof LIST_OBSERVED_KEYS)[number];
export type ObservedKey = (typeof OBSERVED_KEYS)[number];
export type ObservedEnv = Record<ScalarObservedKey, string | null> & Record<ListObservedKey, Record<string, string> | null>;

export function emptyObserved(): ObservedEnv {
  return Object.fromEntries(OBSERVED_KEYS.map((k) => [k, null])) as ObservedEnv;
}

/** sha256 of the sorted names (order-insensitive). */
export function listSha256(names: readonly string[]): string {
  return sha256Hex(JSON.stringify([...names].sort()));
}

export function callerListHashes(l: CallerLists): Record<ListName, string> {
  return {
    tools: listSha256(l.tools),
    skills: listSha256(l.skills),
    plugins: listSha256(l.plugins),
    agents: listSha256(l.agents),
    mcp_servers: listSha256(l.mcp_servers),
    hooks: listSha256(l.hooks),
  };
}

export function applyListHashes(o: ObservedEnv, route: string, h: Record<string, string>): void {
  for (const n of LIST_NAMES) {
    const v = h[n];
    if (typeof v === 'string') {
      const k = `caller_${n}_sha256` as ListObservedKey;
      o[k] = { ...(o[k] ?? {}), [route]: v };
    }
  }
}

/** Per-run list hashes folded per route: the single hash, 'mixed' when that route's cells disagree; absent when none. */
export function mergeListHashes(
  per: Array<{ route: string; hashes: Record<string, string> | undefined }>,
): Partial<Record<ListObservedKey, Record<string, string>>> {
  const out: Partial<Record<ListObservedKey, Record<string, string>>> = {};
  for (const n of LIST_NAMES) {
    const byRoute = new Map<string, Set<string>>();
    for (const p of per) {
      const v = p.hashes?.[n];
      if (typeof v !== 'string') continue;
      if (!byRoute.has(p.route)) byRoute.set(p.route, new Set());
      byRoute.get(p.route)!.add(v);
    }
    if (byRoute.size > 0) {
      out[`caller_${n}_sha256` as ListObservedKey] = Object.fromEntries(
        [...byRoute].map(([route, set]) => [route, set.size === 1 ? [...set][0] : 'mixed']),
      );
    }
  }
  return out;
}

/** WARN lines for the observed keys that differ from the baseline's `observed` object or are unrecorded there; list keys are
 * compared per route (`onlyRoute` limits that to one). Never refuses. */
export function compareObserved(
  run: ObservedEnv,
  baselineObserved: Record<string, unknown> | null,
  keys: readonly ObservedKey[],
  onlyRoute?: string,
): string[] {
  const lines: string[] = [];
  const base = (key: string): unknown =>
    baselineObserved !== null && Object.prototype.hasOwnProperty.call(baselineObserved, key) ? baselineObserved[key] : undefined;
  const warn = (label: string, b: unknown, r: unknown): void => {
    const unrecorded = b === undefined || b === null;
    if (!unrecorded && r !== null && r !== undefined && canonicalJson(b) === canonicalJson(r)) return;
    lines.push(`BENCH-OBSERVED-WARN: observed ${label} baseline=${unrecorded ? '<unrecorded>' : canonicalJson(b)} run=${canonicalJson(r ?? null)}`);
  };
  for (const key of keys) {
    if ((SCALAR_OBSERVED_KEYS as readonly string[]).includes(key)) {
      warn(key, base(key), run[key as ScalarObservedKey]);
      continue;
    }
    const mine = run[key as ListObservedKey];
    if (mine === null) continue;
    const bMap = base(key);
    for (const route of Object.keys(mine).sort()) {
      if (onlyRoute !== undefined && route !== onlyRoute) continue;
      const b = bMap !== null && typeof bMap === 'object' ? (bMap as Record<string, unknown>)[route] : undefined;
      warn(`${key}[${route}]`, b, mine[route]);
    }
  }
  return lines;
}

/** The verdict over `opts.keys` (default PRE_KEYS): every key compared; the expect-diff list must name exactly the keys
 * that differ (a listed key outside `opts.keys` is ignored here). `opts.tag` prefixes the lines; `opts.refuse` builds the
 * closing line on failure. The pre-run call uses the defaults; the post-run caller_model check passes all three. */
export function compareToBaseline(
  run: BenchRunConfig,
  baseline: Record<string, unknown>,
  expectDiff: readonly string[],
  baselineLabel: string,
  opts: {
    keys?: ReadonlyArray<keyof BenchRunConfig>;
    tag?: string;
    refuse?: (bad: number, total: number) => string;
  } = {},
): { ok: boolean; lines: string[] } {
  const keys = opts.keys ?? PRE_KEYS;
  const tag = opts.tag ?? 'BENCH-BASELINE';
  const refuse = opts.refuse ?? ((bad: number, total: number) => `BENCH-REFUSED: baseline mismatch: ${bad} of ${total} keys; nothing ran`);
  const lines: string[] = [];
  const expected = new Set(expectDiff);
  const runRec = run as unknown as Record<string, unknown>;
  let bad = 0;
  for (const key of keys) {
    const b = Object.prototype.hasOwnProperty.call(baseline, key) ? canonicalJson(baseline[key]) : '<absent>';
    const r = canonicalJson(runRec[key]);
    if (b !== r) {
      if (expected.has(key)) {
        lines.push(`${tag}: expected-diff ${key} baseline=${b} run=${r}`);
      } else {
        bad += 1;
        lines.push(`${tag}: MISMATCH ${key} baseline=${b} run=${r}`);
      }
    } else if (expected.has(key)) {
      bad += 1;
      lines.push(`${tag}: EXPECTED-DIFF-ABSENT ${key} value=${r}`);
    }
  }
  if (bad === 0) {
    lines.push(
      `${tag}: ok baseline=${baselineLabel} keys=${keys.length} expected_diffs=${expectDiff.length > 0 ? expectDiff.join(',') : 'none'}`,
    );
  } else {
    lines.push(refuse(bad, keys.length));
  }
  return { ok: bad === 0, lines };
}

// ---- r24b amendment (spec section 16): the pushed results JSON carries hashes and counts only ----

/** One init-event list as the PUSHED results file records it: its hash and its length, never its names. */
export interface ListSummary {
  sha256: string;
  count: number;
}

/** `observed_lists[route]` in the results file: per list, hash + count. The name arrays go to the separate local file. */
export type ListSummaries = Record<ListName, ListSummary>;

export function callerListSummaries(l: CallerLists): ListSummaries {
  const h = callerListHashes(l);
  const out = {} as ListSummaries;
  for (const n of LIST_NAMES) out[n] = { sha256: h[n], count: l[n].length };
  return out;
}

/** Route -> summaries for the results file; null when no cell produced an init event. */
export function summarizeObservedLists(lists: Record<string, CallerLists> | null): Record<string, ListSummaries> | null {
  if (lists === null) return null;
  return Object.fromEntries(Object.entries(lists).map(([route, l]) => [route, callerListSummaries(l)]));
}

/** The local-only sibling of a results file that holds the name lists (never pushed): `<stamp>.observed-lists.json`. */
export function observedListsFileName(resultsName: string): string {
  return resultsName.replace(/\.json$/, '') + '.observed-lists.json';
}
