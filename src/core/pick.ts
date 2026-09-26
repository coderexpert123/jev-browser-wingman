// browse_step `pick` (spec 2026-09-26-wingman-forced-handoff § 5.6). WP-D owns
// this module; only its integration lives in loop.ts (WP-B2).
import { PICK_NTH_MAX, LABEL_MAX } from '../contract/constants.js';
import { OPS, TARGETLESS_OPS, type Op, type PickInput, type ElementRecord, type Observation } from '../contract/types.js';
import { elementCriterion } from './questions.js';
import { redactValues } from './withhold.js';

/** Pick actions that carry a binding value (§ 5.6). fill/select/upload take it
 * from values; navigate takes a url-typed binding. */
export const PICK_VALUE_OPS: readonly Op[] = ['fill', 'select', 'navigate', 'upload'];

// Same pattern as loop.ts's BINDING_RE (§ 5.5.1) and the § 5.8 schema pattern;
// loop.ts keeps its own copy because this module must not depend on it.
const BINDING_RE = /^[a-z][a-z0-9_]{0,39}$/;

const PICK_KEYS = ['role', 'name', 'action', 'nth', 'value'];

function isTargetless(action: Op): boolean {
  return (TARGETLESS_OPS as readonly string[]).includes(action);
}

export function validatePick(
  x: unknown,
  values: Record<string, string>,
): { ok: true; pick: PickInput } | { ok: false } {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return { ok: false };
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!PICK_KEYS.includes(k)) return { ok: false };
  }
  // action: required, a member of OPS
  if (typeof o.action !== 'string' || !(OPS as readonly string[]).includes(o.action)) return { ok: false };
  const action = o.action as Op;
  const targetless = isTargetless(action);
  // role: required for a targeted action (1..40 characters); optional but
  // typed the same for a targetless one
  if (o.role !== undefined) {
    if (typeof o.role !== 'string' || o.role.length < 1 || o.role.length > 40) return { ok: false };
  } else if (!targetless) {
    return { ok: false };
  }
  // name: required for a targeted action (0..200 characters); optional but
  // typed the same for a targetless one. An empty name is a valid name (an
  // unlabelled element).
  if (o.name !== undefined) {
    if (typeof o.name !== 'string' || o.name.length > 200) return { ok: false };
  } else if (!targetless) {
    return { ok: false };
  }
  // nth: integer 1..PICK_NTH_MAX
  if (o.nth !== undefined) {
    if (typeof o.nth !== 'number' || !Number.isInteger(o.nth) || o.nth < 1 || o.nth > PICK_NTH_MAX) {
      return { ok: false };
    }
  }
  // value: required iff the action is in PICK_VALUE_OPS, forbidden otherwise;
  // it must match BINDING_RE and name a key of values.
  if (PICK_VALUE_OPS.includes(action)) {
    if (typeof o.value !== 'string' || !BINDING_RE.test(o.value) || !(o.value in values)) {
      return { ok: false };
    }
  } else if (o.value !== undefined) {
    return { ok: false };
  }
  const pick: PickInput = { action };
  if (o.role !== undefined) pick.role = o.role as string;
  if (o.name !== undefined) pick.name = o.name as string;
  if (o.nth !== undefined) pick.nth = o.nth as number;
  if (o.value !== undefined) pick.value = o.value as string;
  return { ok: true, pick };
}

/** Collapses whitespace, trims and lower-cases (§ 5.6 resolution). */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export type PickResolution =
  | { ok: true; el: ElementRecord | null }
  | { ok: false; why: 'no-match' | 'multi-match'; matches: ElementRecord[] };

export function resolvePick(obs: Observation, pick: PickInput): PickResolution {
  if (isTargetless(pick.action)) return { ok: true, el: null };
  const role = (pick.role ?? '').trim().toLowerCase();
  const wantName = norm(pick.name ?? '');
  // obs.elements is in document order (ids e1, e2, …); filter preserves it.
  const matches = obs.elements.filter((el) => norm(el.role) === role && norm(el.name) === wantName);
  if (pick.nth !== undefined) {
    const el = matches[pick.nth - 1];
    if (!el) return { ok: false, why: 'no-match', matches: matches.slice(0, 3) };
    return { ok: true, el };
  }
  if (matches.length === 0) {
    const sameRole = obs.elements.filter((el) => norm(el.role) === role).slice(0, 3);
    return { ok: false, why: 'no-match', matches: sameRole };
  }
  if (matches.length > 1) return { ok: false, why: 'multi-match', matches: matches.slice(0, 3) };
  return { ok: true, el: matches[0] };
}

/** Candidate evidence for a resolved-or-not element: redacted criterion label,
 * role and redacted name, each cut to LABEL_MAX. Page-derived text is redacted
 * like every criterion string. */
export function candidateOf(
  el: ElementRecord,
  values: Record<string, string>,
): { label: string; role: string; name: string } {
  return {
    label: redactValues(elementCriterion(el), values).slice(0, LABEL_MAX),
    role: el.role,
    name: redactValues(el.name, values).slice(0, LABEL_MAX),
  };
}
