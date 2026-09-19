import { pathToFileURL } from 'node:url';
import { SENSITIVE_HOST_CATEGORIES } from '../contract/types.js';
import type { WingmanPlugin } from '../contract/types.js';

type LoadResult = { ok: true; plugin: WingmanPlugin } | { ok: false; error: string };

export async function loadPlugin(path: string): Promise<LoadResult> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `cannot load plugin ${path}: ${(e as Error).message}` };
  }

  const defaultExport = mod.default as Record<string, unknown> | undefined;
  const candidate = (mod.wingmanPlugin ?? defaultExport?.wingmanPlugin) as
    | Record<string, unknown>
    | undefined;

  if (typeof candidate !== 'object' || candidate === null) {
    return { ok: false, error: `${path} does not export wingmanPlugin` };
  }

  if (typeof candidate.name !== 'string') {
    return { ok: false, error: 'wingmanPlugin.name must be a string' };
  }

  for (const fnKey of ['ask', 'lockCheck', 'log'] as const) {
    if (fnKey in candidate && candidate[fnKey] !== undefined && typeof candidate[fnKey] !== 'function') {
      return { ok: false, error: `wingmanPlugin.${fnKey} must be a function` };
    }
  }

  if ('sensitiveHosts' in candidate && candidate.sensitiveHosts !== undefined) {
    const sh = candidate.sensitiveHosts;
    if (typeof sh !== 'object' || sh === null || Array.isArray(sh)) {
      return { ok: false, error: 'wingmanPlugin.sensitiveHosts must be an object' };
    }
    for (const [category, hosts] of Object.entries(sh as Record<string, unknown>)) {
      if (!(SENSITIVE_HOST_CATEGORIES as readonly string[]).includes(category)) {
        return { ok: false, error: `wingmanPlugin.sensitiveHosts has unknown category: ${category}` };
      }
      if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== 'string')) {
        return { ok: false, error: `wingmanPlugin.sensitiveHosts.${category} must be a string array` };
      }
    }
  }

  return { ok: true, plugin: candidate as unknown as WingmanPlugin };
}
