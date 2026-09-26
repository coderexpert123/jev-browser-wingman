// Capability profiles (spec 2026-09-26-wingman-forced-handoff § 5.8a): DATA,
// never code. A profile maps a browsing tool's calls to capability classes so
// the forced handoff can derive a withheld set for any server. Browsing
// products are described only by profile data files; this module is pure and
// sync. Load order: shipped <package>/profiles, user <home>/profiles, then
// auto-classified <home>/profiles-auto; a later file with the same id replaces
// an earlier one.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CAPABILITY_CLASSES, CLASS_OPS, WITHHOLDABLE_CLASSES } from '../contract/constants.js';
import type { CapabilityClass, WithholdableClass } from '../contract/constants.js';
import type { Op } from '../contract/types.js';
import { packageRoot } from '../package-root.js';

export interface ProfileDetect {
  args_contain: string[];
  extension_flags: string[];
  endpoint_flags: string[];
}

export interface ProfileLaunch {
  endpoint_env: string | null;
  endpoint_arg: string | null;
  strip_args: string[];
}

export interface ArgRule {
  tool: string;
  args_equal?: Record<string, string>;
  args_present?: string[];
  class: CapabilityClass;
}

export interface Profile {
  id: string;
  description: string;
  detect: ProfileDetect;
  launch: ProfileLaunch;
  match_tools: string[];
  tools: Record<string, CapabilityClass>;
  arg_rules: ArgRule[];
  auto?: true;
}

export interface LoadProfilesDeps {
  readDir?: (dir: string) => string[];
  readFile?: (file: string) => string;
  packageDir?: string;
}

const ID_RE = /^[a-z0-9-]{1,40}$/;

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === 'string');
}

function isCapabilityClass(x: unknown): x is CapabilityClass {
  return typeof x === 'string' && (CAPABILITY_CLASSES as readonly string[]).includes(x);
}

/** Structural schema check. Returns null for anything that does not match
 * § 5.8a; the caller skips the file with one stderr line. */
function validateProfile(raw: unknown): Profile | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  if (typeof o.description !== 'string') return null;
  const detect = o.detect as Record<string, unknown> | undefined;
  if (
    detect === null || typeof detect !== 'object' ||
    !isStringArray(detect.args_contain) ||
    !isStringArray(detect.extension_flags) ||
    !isStringArray(detect.endpoint_flags)
  ) {
    return null;
  }
  const launch = o.launch as Record<string, unknown> | undefined;
  if (
    launch === null || typeof launch !== 'object' ||
    (launch.endpoint_env !== null && typeof launch.endpoint_env !== 'string') ||
    (launch.endpoint_arg !== null && typeof launch.endpoint_arg !== 'string') ||
    !isStringArray(launch.strip_args)
  ) {
    return null;
  }
  // An empty match_tools would match every runtime tool list; require at least one.
  if (!isStringArray(o.match_tools) || o.match_tools.length < 1) return null;
  if (o.tools === null || typeof o.tools !== 'object' || Array.isArray(o.tools)) return null;
  const tools: Record<string, CapabilityClass> = {};
  for (const [name, cls] of Object.entries(o.tools as Record<string, unknown>)) {
    if (!isCapabilityClass(cls)) return null;
    tools[name] = cls;
  }
  if (!Array.isArray(o.arg_rules)) return null;
  const argRules: ArgRule[] = [];
  for (const entry of o.arg_rules) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const r = entry as Record<string, unknown>;
    if (typeof r.tool !== 'string' || r.tool.length < 1) return null;
    if (!isCapabilityClass(r.class)) return null;
    if (r.args_equal !== undefined) {
      if (r.args_equal === null || typeof r.args_equal !== 'object' || Array.isArray(r.args_equal)) return null;
      const eq = r.args_equal as Record<string, unknown>;
      if (!Object.values(eq).every((v) => typeof v === 'string')) return null;
    }
    if (r.args_present !== undefined && !isStringArray(r.args_present)) return null;
    const rule: ArgRule = { tool: r.tool, class: r.class };
    if (r.args_equal !== undefined) rule.args_equal = r.args_equal as Record<string, string>;
    if (r.args_present !== undefined) rule.args_present = r.args_present;
    argRules.push(rule);
  }
  const profile: Profile = {
    id: o.id,
    description: o.description,
    detect: {
      args_contain: detect.args_contain,
      extension_flags: detect.extension_flags,
      endpoint_flags: detect.endpoint_flags,
    },
    launch: {
      endpoint_env: launch.endpoint_env,
      endpoint_arg: launch.endpoint_arg,
      strip_args: launch.strip_args,
    },
    match_tools: o.match_tools,
    tools,
    arg_rules: argRules,
  };
  if (o.auto === true) profile.auto = true;
  return profile;
}

function defaultReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return []; // missing or unreadable directory contributes nothing
  }
}

function defaultReadFile(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Load and merge every profile source (§ 5.8a). An invalid file is skipped
 * with one stderr line naming the file. */
export function loadProfiles(home: string, deps?: LoadProfilesDeps): Profile[] {
  const readDir = deps?.readDir ?? defaultReadDir;
  const readFile = deps?.readFile ?? defaultReadFile;
  const packageDir = deps?.packageDir ?? packageRoot();
  const dirs = [
    path.join(packageDir, 'profiles'),
    path.join(home, 'profiles'),
    path.join(home, 'profiles-auto'),
  ];
  const byId = new Map<string, Profile>();
  for (const dir of dirs) {
    for (const name of readDir(dir)) {
      const file = path.join(dir, name);
      let raw: unknown;
      try {
        raw = JSON.parse(readFile(file));
      } catch {
        console.error(`jev-browser-wingman: skipping invalid capability profile ${file}`);
        continue;
      }
      const profile = validateProfile(raw);
      if (!profile) {
        console.error(`jev-browser-wingman: skipping invalid capability profile ${file}`);
        continue;
      }
      byId.set(profile.id, profile); // a later file with the same id replaces an earlier one
    }
  }
  return [...byId.values()];
}

/** The profile whose detect.args_contain substring hits the registration's
 * command or args; the first hit wins. */
export function profileForArgv(profiles: Profile[], command: string, args: string[]): Profile | null {
  for (const profile of profiles) {
    const hit = profile.detect.args_contain.some(
      (s) => command.includes(s) || args.some((a) => a.includes(s)),
    );
    if (hit) return profile;
  }
  return null;
}

/** The first profile whose match_tools are all listed by the runtime. */
export function profileForTools(profiles: Profile[], toolNames: string[]): Profile | null {
  return profiles.find((p) => p.match_tools.every((t) => toolNames.includes(t))) ?? null;
}

/** The class of one browsing-tool call: the first matching argument rule, else
 * the tool's map entry, else unknown (retained). */
export function classOfCall(profile: Profile, tool: string, args: unknown): CapabilityClass {
  const a: Record<string, unknown> =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  for (const rule of profile.arg_rules) {
    if (rule.tool !== tool) continue;
    if (rule.args_equal && !Object.entries(rule.args_equal).every(([k, v]) => a[k] === v)) continue;
    if (
      rule.args_present &&
      !rule.args_present.every((k) => typeof a[k] === 'string' && (a[k] as string).length > 0)
    ) {
      continue;
    }
    return rule.class;
  }
  return profile.tools[tool] ?? 'unknown';
}

/** The derived withheld set (§ 10.4): every withholdable class whose ops the
 * adapter declares in full, minus the operator's retained classes. */
export function withheldClasses(adapterOps: readonly Op[], retain: readonly string[]): WithholdableClass[] {
  const ops = new Set<string>(adapterOps);
  return WITHHOLDABLE_CLASSES.filter(
    (c) => CLASS_OPS[c].every((op) => ops.has(op)) && !retain.includes(c),
  );
}

/** sha256 of the sorted tool names joined with newlines, first 16 hex chars. */
export function toolsFingerprint(toolNames: string[]): string {
  return createHash('sha256').update([...toolNames].sort().join('\n')).digest('hex').slice(0, 16);
}

/** Layer-2 deny entries for clients with a tool-level deny list. Map classes
 * only; a tool with any argument rule whose class is NOT withheld is skipped
 * (a deny entry would also block its retained calls — a dead-end). Other
 * clients have no known tool deny: null means instruction-only. */
export function denyEntries(
  client: string,
  server: string,
  profile: Profile,
  withheld: readonly string[],
): { file: 'settings' | 'config'; entries: string[] } | null {
  if (client !== 'claude' && client !== 'opencode') return null;
  const withheldSet = new Set(withheld);
  const entries: string[] = [];
  for (const [tool, cls] of Object.entries(profile.tools)) {
    if (!withheldSet.has(cls)) continue;
    if (profile.arg_rules.some((r) => r.tool === tool && !withheldSet.has(r.class))) continue;
    entries.push(client === 'claude' ? `mcp__${server}__${tool}` : `${server}_${tool}`);
  }
  return { file: client === 'claude' ? 'settings' : 'config', entries };
}
