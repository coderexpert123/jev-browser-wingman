import test from 'node:test';
import assert from 'node:assert/strict';
import { typeHint, redactValues, redactDeep, assertNoValues } from '../src/core/withhold.js';

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
