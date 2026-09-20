import type { PageSignals, Reason, SensitiveHostCategory } from '../contract/types.js';
import { SENSITIVE_HOST_CATEGORIES } from '../contract/types.js';
import { DEFAULT_POLICY_MODE, POLICY_SELF_TEST_HOST } from '../contract/constants.js';
import type { PolicyMode } from '../contract/constants.js';
import { AUTH_PATH_RE, BUILTIN_HOSTS } from './policy-data.js';

export interface PolicyVerdict {
  sensitive: boolean;
  reason?: Reason;
}

function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

export function hostMatches(host: string, suffix: string): boolean {
  const h = normalizeHost(host);
  const s = normalizeHost(suffix);
  return h === s || h.endsWith('.' + s);
}

function matchCategory(
  host: string,
  lists: Record<SensitiveHostCategory, readonly string[]>,
  extra?: Partial<Record<SensitiveHostCategory, string[]>>,
): Reason | null {
  for (const category of SENSITIVE_HOST_CATEGORIES) {
    const suffixes: readonly string[] = [...(lists[category] ?? []), ...((extra?.[category]) ?? [])];
    for (const suffix of suffixes) {
      if (hostMatches(host, suffix)) {
        return `sensitive-${category}` as Reason;
      }
    }
  }
  return null;
}

const NEVER_SENSITIVE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function classifyUrl(
  url: string,
  extra?: Partial<Record<SensitiveHostCategory, string[]>>,
  policyMode: PolicyMode = DEFAULT_POLICY_MODE,
): PolicyVerdict {
  if (policyMode === 'off') {
    // § 3.7 policy.mode 'off': no host is sensitive — every URL, including
    // non-http protocols, is treated as ordinary. Only the sensitive-surface
    // fallback is disabled; the irreversible gate is unaffected.
    return { sensitive: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { sensitive: true, reason: 'unsupported-page' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { sensitive: true, reason: 'unsupported-page' };
  }
  const host = parsed.hostname.toLowerCase();
  if (NEVER_SENSITIVE_HOSTS.has(host)) {
    return { sensitive: false };
  }
  const categoryHit = matchCategory(host, BUILTIN_HOSTS, extra);
  if (categoryHit) {
    return { sensitive: true, reason: categoryHit };
  }
  if (AUTH_PATH_RE.test(parsed.pathname)) {
    return { sensitive: true, reason: 'sensitive-auth-path' };
  }
  return { sensitive: false };
}

export function classifySignals(s: PageSignals, policyMode: PolicyMode = DEFAULT_POLICY_MODE): PolicyVerdict {
  if (policyMode === 'off') {
    return { sensitive: false };
  }
  if (s.password || s.currentPassword || s.newPassword) {
    return { sensitive: true, reason: 'sensitive-password' };
  }
  if (s.otpAutocomplete || s.otpText) {
    return { sensitive: true, reason: 'sensitive-otp' };
  }
  if (s.ccAutocomplete) {
    return { sensitive: true, reason: 'sensitive-payment-field' };
  }
  return { sensitive: false };
}

export function evaluatePolicy(
  url: string,
  signals: PageSignals,
  extra?: Partial<Record<SensitiveHostCategory, string[]>>,
  policyMode: PolicyMode = DEFAULT_POLICY_MODE,
): PolicyVerdict {
  const urlVerdict = classifyUrl(url, extra, policyMode);
  if (urlVerdict.sensitive) {
    return urlVerdict;
  }
  return classifySignals(signals, policyMode);
}

export function policySelfTest(
  lists: Record<SensitiveHostCategory, readonly string[]> = BUILTIN_HOSTS,
): { ok: boolean; detail: string } {
  for (const category of SENSITIVE_HOST_CATEGORIES) {
    const suffixes = lists[category];
    if (!suffixes || suffixes.length === 0) {
      return { ok: false, detail: `category ${category} is empty` };
    }
  }
  const reason = matchCategory(POLICY_SELF_TEST_HOST, lists);
  if (reason !== 'sensitive-identity') {
    return { ok: false, detail: `${POLICY_SELF_TEST_HOST} classified as ${reason ?? 'not sensitive'}` };
  }
  return { ok: true, detail: 'ok' };
}
