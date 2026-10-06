import test from 'node:test';
import assert from 'node:assert/strict';
import {
  typeHint, redactValues, redactDeep, assertNoValues, isPathLike,
  compileRedaction, ValueMemory, backstopRequest, backstopLogRecord,
} from '../src/core/withhold.js';
import { PATH_VALUE_MAX } from '../src/contract/constants.js';
import type { JevRequest, WingmanLogRecord } from '../src/contract/types.js';

test('typeHint classifies email, phone, number, date, url and text', () => {
  assert.equal(typeHint('ada@example.com'), 'email');
  assert.equal(typeHint('+1 (555) 123-4567'), 'phone');
  assert.equal(typeHint('42.5'), 'number');
  assert.equal(typeHint('2026-09-19'), 'date');
  assert.equal(typeHint('https://example.com/path'), 'url');
  assert.equal(typeHint('short'), 'text-short');
  assert.equal(typeHint('x'.repeat(41)), 'text-long');
});

test('redactValues replaces every occurrence case-insensitively', () => {
  const out = redactValues('Ada LOVELACE met ada Lovelace twice', { fullname: 'Ada Lovelace' });
  assert.equal(out, '<value:fullname> met <value:fullname> twice');
});

test('values shorter than 4 chars are left alone', () => {
  const out = redactValues('the cat sat', { pet: 'cat' });
  assert.equal(out, 'the cat sat');
});

test('longest value is replaced first when values overlap', () => {
  const out = redactValues('Ada Lovelace', { fullname: 'Ada Lovelace', first: 'Ada' });
  assert.equal(out, '<value:fullname>');
});

test('assertNoValues throws on a planted leak', () => {
  assert.throws(
    () => assertNoValues('the value is Ada Lovelace here', { fullname: 'Ada Lovelace' }),
    /value leak: fullname/,
  );
  assert.doesNotThrow(() => assertNoValues('nothing sensitive here', { fullname: 'Ada Lovelace' }));
});

test('redactDeep walks nested arrays and objects', () => {
  const input = {
    a: 'Ada Lovelace is here',
    list: ['contains Ada Lovelace too', { nested: 'and Ada Lovelace again' }],
    n: 42,
  };
  const out = redactDeep(input, { fullname: 'Ada Lovelace' });
  assert.equal(out.a, '<value:fullname> is here');
  assert.equal(out.list[0], 'contains <value:fullname> too');
  assert.equal((out.list[1] as { nested: string }).nested, 'and <value:fullname> again');
  assert.equal(out.n, 42);
});

test('isPathLike accepts drive-letter, absolute-slash and UNC paths', () => {
  assert.equal(isPathLike('C:\\a\\b.txt'), true);
  assert.equal(isPathLike('/tmp/x'), true);
  assert.equal(isPathLike('\\\\srv\\s\\f'), true);
  // boundary: exactly PATH_VALUE_MAX characters still counts as a path
  assert.equal(isPathLike('/' + 'a'.repeat(PATH_VALUE_MAX - 1)), true);
});

test('isPathLike rejects urls, bare names, oversized and multiline values', () => {
  assert.equal(isPathLike('https://x/y'), false);
  assert.equal(isPathLike('notes.txt'), false);
  const oversized = '/' + 'a'.repeat(PATH_VALUE_MAX); // 1001 characters
  assert.equal(oversized.length, PATH_VALUE_MAX + 1);
  assert.equal(isPathLike(oversized), false);
  assert.equal(isPathLike('line1\nline2'), false);
});

// ---- r24c: cross-call redaction (spec .build-r24c-redaction-spec.md § 4) ----

test('T-r24c-wh-pass: one pass, longest first, a marker is never re-matched', () => {
  assert.equal(redactValues('x longvalue1 y', { name1: 'longvalue1', b: 'value' }), 'x <value:name1> y');
  const rs = compileRedaction({ a: 'Ada Lovelace' });
  const t = 'Ada Lovelace met ada lovelace';
  assert.equal(rs.redact(rs.redact(t)), rs.redact(t));
  assert.equal(rs.redact(t), '<value:a> met <value:a>');
});

test('T-r24c-wh-teeth: longest value at one position, an existing marker is a fixed point, the first name keeps a shared value', () => {
  // r24c recheck: deleting the length sort, the marker alternative of the matcher or the current-call dedupe each left
  // every test green (single-guard deletions in a scratch build).
  // (1) a value that is a prefix of another, listed FIRST: leftmost-longest must take the longer one whole.
  const pre = compileRedaction({ short: 'ab12', long: 'ab12cd' });
  assert.equal(pre.redact('x ab12cd y ab12 z'), 'x <value:long> y <value:short> z');
  // (2) a marker already in the text is never matched again, even when a member value occurs inside the marker text.
  const inner = compileRedaction({ name1: 'longvalue1', b: 'value' });
  const once = inner.redact('x longvalue1 y');
  assert.equal(once, 'x <value:name1> y');
  assert.equal(inner.redact(once), once);
  assert.equal(inner.redact('<value:name1> <value:name1 (earlier)>'), '<value:name1> <value:name1 (earlier)>');
  // (3) two names holding one value in the current call: the first name in insertion order owns the marker.
  assert.equal(compileRedaction({ a: 'shared val', b: 'shared val' }).redact('shared val'), '<value:a>');
  assert.equal(compileRedaction({ a: 'Shared Val', b: 'shared val' }).size, 1);
});

test('T-r24c-wh-shape: redactDeep keeps arrays as arrays and never rewrites a key; the request backstop names array leaves with an index', () => {
  // r24c recheck: deleting the array branch of redactDeep (arrays became index-keyed objects) and rewriting object keys
  // each left every test green; the Jev request carries arrays (state.history, repeatedGroups) and keys are element ids.
  const rs = compileRedaction({ v: 'zzqq' });
  const deep = rs.redactDeep({ 'zzqq key': 'x zzqq y', list: ['a zzqq', { n: ['zzqq'] }], k: null, n: 7 });
  assert.deepEqual(deep, { 'zzqq key': 'x <value:v> y', list: ['a <value:v>', { n: ['<value:v>'] }], k: null, n: 7 });
  assert.equal(Array.isArray(deep.list), true);
  const hits: string[] = [];
  const out = backstopRequest(
    { state: { history: [{ label: 'x zzqq y' }, 'plain'], text: 'ok' }, questions: {} } as unknown as JevRequest,
    rs,
    (path) => hits.push(path),
  );
  assert.deepEqual(hits, ['state.history[0].label']);
  assert.equal(Array.isArray((out.state as { history: unknown }).history), true);
});

test('T-r24c-wh-mem-markers: remembered values keep their name; a rebound name marks its old value (earlier)', () => {
  const m = new ValueMemory();
  m.bind({ item1: 'buy oat milk' });
  assert.equal(compileRedaction({}, m).redact('Buy oat milk!'), '<value:item1>!');
  m.bind({ item1: 'walk the dog' });
  const out = compileRedaction({ item1: 'walk the dog' }, m).redact('buy oat milk, walk the dog');
  assert.equal(out, '<value:item1 (earlier)>, <value:item1>');
  assert.equal(compileRedaction({ item1: 'walk the dog' }, m).redact(out), out);
  const m2 = new ValueMemory();
  m2.bind({ a: 'shared val', b: 'shared val' });
  assert.equal(compileRedaction({}, m2).redact('shared val'), '<value:a>');
  m2.bind({ c: 'shared val' });
  assert.equal(compileRedaction({}, m2).redact('shared val'), '<value:c>');
  assert.throws(() => compileRedaction({}, m).assertClean('has buy oat milk'), /value leak: item1/);
});

test('T-r24c-wh-mem-floor: the floor and the boolean literals', () => {
  const m = new ValueMemory();
  m.bind({ flag: 'true', pin: '1234', ab: 'abc' });
  assert.equal(m.size(), 1);
  assert.equal(
    compileRedaction({ flag: 'true', pin: '1234', ab: 'abc' }, m).redact('true 1234 abc'),
    '<value:flag> <value:pin> abc',
  );
  assert.equal(compileRedaction({}, m).redact('true 1234 abc'), 'true <value:pin> abc');
});

test('T-r24c-wh-mem-cap: the default memory keeps the 1,024 most recently bound values (the README number)', () => {
  // r24c recheck: the README and the release notes state 1,024; nothing pinned VALUE_MEMORY_MAX itself.
  const m = new ValueMemory();
  const values: Record<string, string> = {};
  for (let i = 0; i < 1030; i += 1) {
    values['v' + (i % 10)] = 'cap-value-' + String(i).padStart(4, '0');
    m.bind({ ['v' + (i % 10)]: values['v' + (i % 10)] });
  }
  assert.equal(m.size(), 1024);
  const rs = compileRedaction({}, m);
  assert.equal(rs.redact('cap-value-0005 cap-value-0006 cap-value-1029').includes('cap-value-1029'), false);
  assert.equal(rs.redact('cap-value-0005').includes('cap-value-0005'), true, 'the 6 oldest were evicted');
  assert.equal(rs.redact('cap-value-0006').includes('cap-value-0006'), false, 'the 1,024th most recent is kept');
});

test('T-r24c-wh-mem-evict: least recently bound is evicted; re-binding refreshes; dedupe ignores case', () => {
  const m = new ValueMemory(3);
  m.bind({ a: 'aaaa1' });
  m.bind({ b: 'bbbb2' });
  m.bind({ c: 'cccc3' });
  m.bind({ b: 'bbbb2' });
  m.bind({ d: 'dddd4' });
  assert.equal(m.size(), 3);
  assert.equal(compileRedaction({}, m).redact('aaaa1 bbbb2 cccc3 dddd4'), 'aaaa1 <value:b> <value:c> <value:d>');
  m.bind({ e: 'eeee5' });
  assert.equal(
    compileRedaction({}, m).redact('aaaa1 bbbb2 cccc3 dddd4 eeee5'),
    'aaaa1 <value:b> cccc3 <value:d> <value:e>',
  );
  m.bind({ x: 'MiXeD' });
  m.bind({ y: 'mixed' });
  assert.equal(m.size(), 3);
  assert.equal(compileRedaction({}, m).redact('MIXED'), '<value:y>');
});

function logRecordBase(): WingmanLogRecord {
  return {
    ts: 'now', tool: 'wingman_do', mode: 'on', adapter: 'fake', status: 'done', reason: 'goal-met', steps: 0,
    host: '', gate_hits: 0, jev_calls: 0, input_tokens: 0, output_tokens: 0, ms: 0,
  } as WingmanLogRecord;
}

test('T-r24c-wh-scope-log: the log backstop rewrites free text only', () => {
  const rs = compileRedaction({ item: 'done' });
  const rec: WingmanLogRecord = {
    ...logRecordBase(),
    step_texts: ['mark done'],
    phases: {
      rounds: [{ observeMs: 0, jevMs: 0, actMs: 0, settleMs: 0, kind: 'done', cands: [{ id: 'e1', p: 0.9, label: 'done list' }] }],
    },
  };
  const before = JSON.stringify(rec);
  const hits: string[] = [];
  const out = backstopLogRecord(rec, rs, (p) => hits.push(p));
  assert.equal(out.status, 'done');
  assert.equal(out.phases!.rounds[0].kind, 'done');
  assert.equal(out.step_texts![0], 'mark <value:item>');
  assert.equal(out.phases!.rounds[0].cands![0].label, '<value:item> list');
  assert.deepEqual(hits.sort(), ['phases.rounds[0].cands[0].label', 'step_texts[0]']);
  assert.equal(JSON.stringify(rec), before);
  const again: string[] = [];
  backstopLogRecord(out, rs, (p) => again.push(p));
  assert.deepEqual(again, []);
});

test('T-r24c-wh-scope-log-all: every listed free-text field is backstopped, fixed-vocabulary fields never', () => {
  const rs = compileRedaction({ v: 'zzqq' });
  const T = 'x zzqq y';
  const rec = {
    ...logRecordBase(),
    status: 'zzqq', reason: 'zzqq', host: 'zzqq', adapter: 'zzqq', ts: 'zzqq',
    step_texts_start: T,
    step_texts: [T, T],
    act_error: { op: 'zzqq', head: T, tail: T },
    phases: {
      rounds: [
        {
          observeMs: 0, jevMs: 0, actMs: 0, settleMs: 0,
          kind: 'zzqq', action: 'zzqq', target1: 'zzqq',
          url: T, title: T, step_text: T, historyResult: T, stuck: T,
          cands: [{ id: 'zzqq', p: 0.5, role: 'zzqq', tag: 'zzqq', label: T }],
          pickArgs: { action: 'zzqq', key: 'zzqq', name: T, role: T, binding: T },
          gate: { rule: 'zzqq', id: 'zzqq', role: 'zzqq', verb: 'zzqq', tag: 'zzqq', type: 'zzqq', label: T },
          act: { verb: 'zzqq', id: 'zzqq', role: 'zzqq', tag: 'zzqq', flip: 'zzqq', label: T, binding: T, key: T },
          policy: { reason: 'zzqq' },
        },
      ],
    },
  } as unknown as WingmanLogRecord;
  const hits: string[] = [];
  const out = backstopLogRecord(rec, rs, (p) => hits.push(p)) as unknown as Record<string, any>;
  const want = [
    'step_texts_start', 'step_texts[0]', 'step_texts[1]', 'act_error.head', 'act_error.tail',
    'phases.rounds[0].url', 'phases.rounds[0].title', 'phases.rounds[0].step_text', 'phases.rounds[0].historyResult',
    'phases.rounds[0].stuck', 'phases.rounds[0].cands[0].label', 'phases.rounds[0].pickArgs.name',
    'phases.rounds[0].pickArgs.role', 'phases.rounds[0].pickArgs.binding', 'phases.rounds[0].gate.label',
    'phases.rounds[0].act.label', 'phases.rounds[0].act.binding', 'phases.rounds[0].act.key',
  ];
  assert.deepEqual(hits.sort(), [...want].sort());
  assert.equal(out.step_texts_start, 'x <value:v> y');
  const r0 = out.phases.rounds[0];
  for (const bad of [
    out.status, out.reason, out.host, out.adapter, out.ts, out.act_error.op, r0.kind, r0.action, r0.target1,
    r0.cands[0].id, r0.cands[0].role, r0.cands[0].tag, r0.pickArgs.action, r0.pickArgs.key,
    r0.gate.id, r0.gate.role, r0.gate.verb, r0.gate.tag, r0.gate.type, r0.gate.rule,
    r0.act.verb, r0.act.id, r0.act.role, r0.act.tag, r0.act.flip, r0.policy.reason,
  ]) {
    assert.equal(bad, 'zzqq');
  }
});

test('T-r24c-wh-scope-request: the request backstop never touches question types', () => {
  const rs = compileRedaction({ c: 'choice' });
  const req = {
    state: { text: 'one choice here' },
    questions: { action: { type: 'choice', instructions: 'pick a choice', criteria: { none: 'no choice' } } },
  } as unknown as JevRequest;
  const hits: string[] = [];
  const out = backstopRequest(req, rs, (p) => hits.push(p)) as unknown as {
    state: { text: string };
    questions: { action: { type: string } };
  };
  assert.equal(out.questions.action.type, 'choice');
  assert.equal(out.state.text, 'one <value:c> here');
  assert.deepEqual(hits.sort(), ['questions.action.criteria.none', 'questions.action.instructions', 'state.text']);
});
