import { REDACT_MIN_LEN, PATH_VALUE_MAX, VALUE_MEMORY_MAX } from '../contract/constants.js';
import type { JevRequest, WingmanLogRecord } from '../contract/types.js';

export function typeHint(
  value: string,
): 'email' | 'phone' | 'number' | 'date' | 'url' | 'text-short' | 'text-long' {
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return 'email';
  if (/^https?:\/\//i.test(value)) return 'url';
  if (/^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(value)) return 'date';
  if (/^-?\d+([.,]\d+)?$/.test(value)) return 'number';
  if (/^\+?[\d\s()-]{7,}$/.test(value)) return 'phone';
  if (value.length <= 40) return 'text-short';
  return 'text-long';
}

/** True when a supplied value looks like a local file path (spec 2026-09-26
 * § 5.4, B1-1): within PATH_VALUE_MAX, single-line, not a web address, and
 * starting with a drive letter, a UNC prefix or an absolute slash. The value
 * itself never leaves this module — callers use it only to type bindings. */
export function isPathLike(value: string): boolean {
  return (
    value.length <= PATH_VALUE_MAX
    && !/[\r\n]/.test(value)
    && typeHint(value) !== 'url'
    && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** r24c KB proof switch: flip = the redaction set ignores the value memory (current-call values only, the pre-r24c
 * behaviour). Never flip in shipped code. */
const KB_CROSS_CALL_REDACT = false;

/** r24d KB proof switch: flip = the redaction set matches literal value text only (no percent-encoded variants,
 * the pre-r24d behaviour). Never flip in shipped code. */
const KB_ENCODED_VARIANTS = false;

/** r24d: the percent-encoded spellings of a value that a page address (or a text copied from one) can carry:
 * encodeURIComponent, encodeURI, both with `+` for each encoded space, and the WHATWG path form (what
 * `new URL(...).pathname` yields, which leaves some characters encodeURI encodes). Lower-case percent-hex needs no
 * entry of its own: every matcher is case-insensitive, so `%c3%a9` already matches `%C3%A9`. Forms equal to the
 * value are omitted; a value that cannot be encoded (a lone surrogate) gets only the forms that can be built. */
export function encodedVariants(value: string): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    if (s !== value && !out.includes(s)) out.push(s);
  };
  try {
    const comp = encodeURIComponent(value);
    const uri = encodeURI(value);
    add(comp);
    add(uri);
    add(comp.replace(/%20/g, '+'));
    add(uri.replace(/%20/g, '+'));
  } catch {
    /* lone surrogate: no component/URI forms */
  }
  try {
    add(new URL('http://h/' + value.replace(/[?#]/g, encodeURIComponent)).pathname.slice(1));
  } catch {
    /* unparseable: no path form */
  }
  return out;
}

/** r24c: the marker suffix of a remembered value whose binding name now holds a different value. */
export const EARLIER_SUFFIX = ' (earlier)';

interface RedactionMember { value: string; name: string; marker: string }

/** r24c: the process's remembered values (never persisted, logged or returned). Least recently bound is evicted first. */
export class ValueMemory {
  private readonly max: number;
  /** lower-cased value -> original value and the name it was bound under; Map insertion order = recency. */
  private readonly entries = new Map<string, { value: string; name: string }>();
  /** binding name -> the lower-cased value it holds now (any length), decides the (earlier) marker. */
  private readonly latest = new Map<string, string>();

  constructor(max: number = VALUE_MEMORY_MAX) {
    this.max = max;
  }

  /** Remember one call's validated values. */
  bind(values: Record<string, string>): void {
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(values)) {
      const key = value.toLowerCase();
      this.latest.set(name, key);
      if (value.length < REDACT_MIN_LEN || value === 'true' || value === 'false') continue;
      if (seen.has(key)) continue;
      seen.add(key);
      this.entries.delete(key);
      this.entries.set(key, { value, name });
    }
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /** Number of remembered values. */
  size(): number {
    return this.entries.size;
  }

  /** Internal (compileRedaction): the remembered values with their current markers, oldest bound first. */
  members(): RedactionMember[] {
    const out: RedactionMember[] = [];
    for (const [key, e] of this.entries) {
      const current = this.latest.get(e.name) === key;
      out.push({ value: e.value, name: e.name, marker: current ? `<value:${e.name}>` : `<value:${e.name}${EARLIER_SUFFIX}>` });
    }
    return out;
  }
}

export interface RedactionSet {
  /** Member values replaced by their markers in ONE pass, longest value first; existing markers untouched. */
  redact(text: string): string;
  /** redact() over every string leaf of a JSON-shaped value; keys untouched; returns a copy. */
  redactDeep<T>(x: T): T;
  /** Test helper: throws Error(`value leak: <name>`) when serialized contains a member value, case-insensitively. */
  assertClean(serialized: string): void;
  readonly size: number;
}

export function compileRedaction(current: Record<string, string>, memory?: ValueMemory): RedactionSet {
  const members: RedactionMember[] = [];
  const known = new Set<string>();
  if (!KB_CROSS_CALL_REDACT && memory !== undefined) {
    for (const m of memory.members()) {
      known.add(m.value.toLowerCase());
      members.push(m);
    }
  }
  for (const [name, value] of Object.entries(current)) {
    if (value.length < REDACT_MIN_LEN) continue;
    const key = value.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    members.push({ value, name, marker: `<value:${name}>` });
  }
  members.sort((a, b) => b.value.length - a.value.length);
  // r24d: percent-encoded forms of each member ride the same marker. Variants are alternatives of a member, never
  // members: they never move `size`, the memory cap or the floor. A variant equal (case-insensitively) to any member
  // value or to an earlier variant is dropped, so a value with no encodable character compiles exactly as before.
  const alternatives: Array<{ text: string; marker: string; name: string }> = members.map((m) => ({ text: m.value, marker: m.marker, name: m.name }));
  if (!KB_ENCODED_VARIANTS) {
    const taken = new Set<string>(members.map((m) => m.value.toLowerCase()));
    for (const m of members) {
      for (const v of encodedVariants(m.value)) {
        const key = v.toLowerCase();
        if (taken.has(key)) continue;
        taken.add(key);
        alternatives.push({ text: v, marker: m.marker, name: m.name });
      }
    }
    alternatives.sort((a, b) => b.text.length - a.text.length);
  }
  const byValue = new Map<string, string>();
  for (const a of alternatives) byValue.set(a.text.toLowerCase(), a.marker);
  const matchers = alternatives.map((a) => ({ re: new RegExp('^' + escapeRegExp(a.text) + '$', 'i'), marker: a.marker }));
  const re = alternatives.length === 0
    ? null
    : new RegExp(
      `(<value:[a-z][a-z0-9_]{0,39}(?: \\(earlier\\))?>)|(${alternatives.map((a) => escapeRegExp(a.text)).join('|')})`,
      'gi',
    );
  const redact = (text: string): string => {
    if (re === null) return text;
    return text.replace(re, (whole: string, marker: string | undefined) => {
      if (marker !== undefined) return marker;
      const hit = byValue.get(whole.toLowerCase());
      if (hit !== undefined) return hit;
      for (const m of matchers) if (m.re.test(whole)) return m.marker;
      return whole;
    });
  };
  const redactDeep = <T>(x: T): T => {
    if (typeof x === 'string') return redact(x) as unknown as T;
    if (Array.isArray(x)) return x.map((item) => redactDeep(item)) as unknown as T;
    if (x !== null && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[k] = redactDeep(v);
      return out as unknown as T;
    }
    return x;
  };
  const assertClean = (serialized: string): void => {
    const lower = serialized.toLowerCase();
    for (const a of alternatives) {
      if (lower.includes(a.text.toLowerCase())) throw new Error(`value leak: ${a.name}`);
    }
  };
  return { redact, redactDeep, assertClean, size: members.length };
}

export function redactValues(text: string, values: Record<string, string>): string {
  return compileRedaction(values).redact(text);
}

export function redactDeep<T>(x: T, values: Record<string, string>): T {
  return compileRedaction(values).redactDeep(x);
}

/** r24c: the log record's free-text fields the log backstop reads (`[]` = every element). Nothing else is touched. */
export const LOG_BACKSTOP_FIELDS: readonly string[] = [
  'step_texts_start',
  'step_texts[]',
  'act_error.head',
  'act_error.tail',
  'phases.rounds[].url',
  'phases.rounds[].title',
  'phases.rounds[].step_text',
  'phases.rounds[].historyResult',
  'phases.rounds[].stuck',
  'phases.rounds[].cands[].label',
  'phases.rounds[].pickArgs.name',
  'phases.rounds[].pickArgs.role',
  'phases.rounds[].pickArgs.binding',
  'phases.rounds[].gate.label',
  'phases.rounds[].act.label',
  'phases.rounds[].act.binding',
  'phases.rounds[].act.key',
];

type Json = unknown;
type Container = Record<string, Json> | Json[];

function cloneJson(x: Json): Json {
  if (Array.isArray(x)) return x.map(cloneJson);
  if (x !== null && typeof x === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(x as Record<string, Json>)) out[k] = cloneJson(v);
    return out;
  }
  return x;
}

/** Redact `parent[key]` when it is a string; report `path` when it changed. */
function backstopLeaf(parent: Container, key: string | number, path: string, rs: RedactionSet, onHit: (path: string) => void): void {
  const p = parent as Record<string | number, Json>;
  const v = p[key];
  if (typeof v !== 'string') return;
  const r = rs.redact(v);
  if (r !== v) {
    p[key] = r;
    onHit(path);
  }
}

/** Redact every string leaf under `node` (any depth), reporting each changed leaf with its path. */
function backstopAll(node: Json, path: string, rs: RedactionSet, onHit: (path: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === 'string') backstopLeaf(node, i, `${path}[${i}]`, rs, onHit);
      else backstopAll(v, `${path}[${i}]`, rs, onHit);
    });
  } else if (node !== null && typeof node === 'object') {
    const rec = node as Record<string, Json>;
    for (const k of Object.keys(rec)) {
      if (typeof rec[k] === 'string') backstopLeaf(rec, k, `${path}.${k}`, rs, onHit);
      else backstopAll(rec[k], `${path}.${k}`, rs, onHit);
    }
  }
}

/** Request backstop (§ 2.4): redacts the in-scope string leaves of a copy; onHit(path) per leaf that changed. */
export function backstopRequest(request: JevRequest, rs: RedactionSet, onHit: (path: string) => void): JevRequest {
  const copy = cloneJson(request) as Record<string, Json>;
  if (typeof copy.state === 'string') backstopLeaf(copy, 'state', 'state', rs, onHit);
  else backstopAll(copy.state, 'state', rs, onHit);
  const qs = copy.questions;
  if (qs !== null && typeof qs === 'object') {
    const questions = qs as Record<string, Json>;
    for (const id of Object.keys(questions)) {
      const q = questions[id];
      if (q === null || typeof q !== 'object') continue;
      const rec = q as Record<string, Json>;
      backstopLeaf(rec, 'instructions', `questions.${id}.instructions`, rs, onHit);
      const crit = rec.criteria;
      if (crit !== null && typeof crit === 'object') {
        const c = crit as Record<string, Json>;
        for (const k of Object.keys(c)) backstopLeaf(c, k, `questions.${id}.criteria.${k}`, rs, onHit);
      }
    }
  }
  return copy as unknown as JevRequest;
}

function backstopFieldPath(node: Json, segs: string[], path: string, rs: RedactionSet, onHit: (path: string) => void): void {
  if (segs.length === 0 || node === null || typeof node !== 'object') return;
  const [head, ...rest] = segs;
  const isArr = head.endsWith('[]');
  const key = isArr ? head.slice(0, -2) : head;
  const rec = node as Record<string, Json>;
  const child = rec[key];
  if (child === undefined) return;
  const childPath = path === '' ? key : `${path}.${key}`;
  if (isArr) {
    if (!Array.isArray(child)) return;
    child.forEach((el, i) => {
      if (rest.length === 0) backstopLeaf(child, i, `${childPath}[${i}]`, rs, onHit);
      else backstopFieldPath(el, rest, `${childPath}[${i}]`, rs, onHit);
    });
  } else if (rest.length === 0) {
    backstopLeaf(rec, key, childPath, rs, onHit);
  } else {
    backstopFieldPath(child, rest, childPath, rs, onHit);
  }
}

/** Log backstop (§ 2.4): same over the log record's free-text fields only. */
export function backstopLogRecord(record: WingmanLogRecord, rs: RedactionSet, onHit: (path: string) => void): WingmanLogRecord {
  const copy = cloneJson(record) as Record<string, Json>;
  for (const field of LOG_BACKSTOP_FIELDS) backstopFieldPath(copy, field.split('.'), '', rs, onHit);
  return copy as unknown as WingmanLogRecord;
}

export function assertNoValues(serialized: string, values: Record<string, string>): void {
  const lower = serialized.toLowerCase();
  for (const [name, value] of Object.entries(values)) {
    if (value.length < REDACT_MIN_LEN) continue;
    if (lower.includes(value.toLowerCase())) {
      throw new Error(`value leak: ${name}`);
    }
  }
}
