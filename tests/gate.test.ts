import test from 'node:test';
import assert from 'node:assert/strict';
import { gateHeuristic } from '../src/core/gate.js';
import type { ElementRecord, FormRecord, Op } from '../src/contract/types.js';

function el(overrides: Partial<ElementRecord> = {}): ElementRecord {
  return {
    id: 'e1',
    path: '#e1',
    tag: 'div',
    role: 'generic',
    name: '',
    type: '',
    attrName: '',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: false,
    inViewport: true,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    form: -1,
    fingerprint: { tag: 'div', role: 'generic', name: '', x: 0, y: 0 },
    ...overrides,
  };
}

function form(overrides: Partial<FormRecord> = {}): FormRecord {
  return { index: 0, id: '', name: '', actionPath: '', method: 'GET', ...overrides };
}

function hit(e: ElementRecord, f: FormRecord | undefined, op: Op) {
  return gateHeuristic(e, f, op);
}

test('Place order button is type-submit', () => {
  const r = hit(
    el({ tag: 'button', type: 'submit', name: 'Place order', form: 0 }),
    form({ id: 'checkout' }),
    'click',
  );
  assert.equal(r.hit, true);
  assert.equal(r.rule, 'type-submit');
});

test('a button without a type inside a form is type-submit', () => {
  const r = hit(el({ tag: 'button', type: 'submit', name: 'OK', form: 0 }), form(), 'click');
  assert.equal(r.hit, true);
  assert.equal(r.rule, 'type-submit');
});

test('Remove item is a word hit', () => {
  const r = hit(el({ tag: 'a', name: 'Remove item' }), undefined, 'click');
  assert.equal(r.hit, true);
  assert.equal(r.rule, 'word');
});

test('Continue outside any form is not a hit', () => {
  const r = hit(el({ tag: 'button', type: 'button', name: 'Continue' }), undefined, 'click');
  assert.equal(r.hit, false);
});

test('Enter in a form field hits enter-in-form', () => {
  const r = hit(el({ tag: 'input', type: 'text', name: 'username', form: 0 }), undefined, 'press');
  assert.equal(r.hit, true);
  assert.equal(r.rule, 'enter-in-form');
});

test('a click inside form id checkout hits form-word', () => {
  const r = hit(
    el({ tag: 'button', type: 'button', name: 'Go', form: 0 }),
    form({ id: 'checkout' }),
    'click',
  );
  assert.equal(r.hit, true);
  assert.equal(r.rule, 'form-word');
});

test('scroll never hits', () => {
  const r = hit(el({ tag: 'button', type: 'submit', name: 'delete' }), undefined, 'scroll');
  assert.equal(r.hit, false);
});

// § 5.5.3 (B2-E13): targetless and non-committal verbs never gate — the gate
// needs an element-directed, potentially irreversible act. On a button named
// "Delete" (a word hit for click/press), the eight exempt ops must NOT hit,
// while dblclick still does.
test('the exempt ops never hit and dblclick still hits on a Delete button', () => {
  const del = (): ElementRecord => el({ tag: 'button', type: 'button', name: 'Delete' });
  const exempt: Op[] = ['scroll', 'scroll_up', 'scroll_to', 'hover', 'wait', 'navigate', 'back', 'reload'];
  for (const op of exempt) {
    const r = hit(del(), undefined, op);
    assert.equal(r.hit, false, `op ${op} must never gate`);
  }
  const r = hit(del(), undefined, 'dblclick');
  assert.equal(r.hit, true);
  assert.equal(r.rule, 'word');
});

test('fill into a field labelled Send to hits word', () => {
  const r = hit(el({ tag: 'input', type: 'text', ariaLabel: 'Send to' }), undefined, 'fill');
  assert.equal(r.hit, true);
  assert.equal(r.rule, 'word');
});
