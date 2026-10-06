import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePick, resolvePick, candidateOf, PICK_VALUE_OPS } from '../src/core/pick.js';
import { PICK_NTH_MAX } from '../src/contract/constants.js';
import { compileRedaction } from '../src/core/withhold.js';
import type { ElementRecord, Observation } from '../src/contract/types.js';

function el(partial: Partial<ElementRecord> & { id: string; role: string; name: string }): ElementRecord {
  return {
    path: `#e${partial.id}`,
    tag: 'input',
    type: '',
    attrName: '',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: true,
    inViewport: true,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    form: -1,
    fingerprint: { tag: 'input', role: partial.role, name: partial.name, x: 0, y: 0 },
    ...partial,
  } as ElementRecord;
}

function obsOf(elements: ElementRecord[]): Observation {
  return {
    url: 'https://example.test/form',
    title: 'Form',
    elements,
    forms: [],
    signals: {
      password: false, currentPassword: false, newPassword: false, otpAutocomplete: false,
      ccAutocomplete: false, otpText: false, captcha: false,
    },
    text: '',
    truncated: false,
  };
}

const VALUES = { full_name: 'Jane Doe', site: 'https://example.test/x' };

// --- validation table ---

test('validatePick rejects non-objects, arrays and scalars', () => {
  assert.equal(validatePick(null, VALUES).ok, false);
  assert.equal(validatePick(undefined, VALUES).ok, false);
  assert.equal(validatePick(['textbox'], VALUES).ok, false);
  assert.equal(validatePick('fill', VALUES).ok, false);
  assert.equal(validatePick(7, VALUES).ok, false);
});

test('validatePick rejects unknown keys', () => {
  assert.equal(validatePick({ action: 'scroll', selector: '#x' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'scroll', Name: 'x' }, VALUES).ok, false);
});

test('validatePick requires action to be a member of OPS', () => {
  assert.equal(validatePick({}, VALUES).ok, false);
  assert.equal(validatePick({ action: 'explode' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 3 }, VALUES).ok, false);
});

test('validatePick requires role and name for a targeted action', () => {
  assert.equal(validatePick({ action: 'click' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 'button' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', name: 'Show details' }, VALUES).ok, false);
});

test('validatePick enforces role typing: string, 1..40 characters', () => {
  assert.equal(validatePick({ action: 'click', role: '', name: 'x' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 'r'.repeat(41), name: 'x' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 7, name: 'x' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 'r'.repeat(40), name: 'x' }, VALUES).ok, true);
});

test('validatePick enforces name typing: string, 0..200 characters', () => {
  assert.equal(validatePick({ action: 'click', role: 'button', name: 7 }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'n'.repeat(201) }, VALUES).ok, false);
  // an empty name is a valid name (an unlabelled element)
  assert.equal(validatePick({ action: 'click', role: 'button', name: '' }, VALUES).ok, true);
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'n'.repeat(200) }, VALUES).ok, true);
});

test('validatePick makes role and name optional but typed for targetless actions', () => {
  assert.equal(validatePick({ action: 'scroll' }, VALUES).ok, true);
  assert.equal(validatePick({ action: 'wait' }, VALUES).ok, true);
  assert.equal(validatePick({ action: 'back' }, VALUES).ok, true);
  // present on a targetless action, they are typed the same
  assert.equal(validatePick({ action: 'scroll', role: '' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'scroll', role: 'r'.repeat(41) }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'scroll', name: 7 }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'scroll', role: 'document', name: '' }, VALUES).ok, true);
});

test('validatePick enforces nth: integer 1..PICK_NTH_MAX', () => {
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'x', nth: 0 }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'x', nth: PICK_NTH_MAX + 1 }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'x', nth: 1.5 }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'x', nth: '2' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'x', nth: 1 }, VALUES).ok, true);
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'x', nth: PICK_NTH_MAX }, VALUES).ok, true);
});

test('validatePick requires value exactly for PICK_VALUE_OPS', () => {
  for (const op of PICK_VALUE_OPS) {
    assert.equal(validatePick({ action: op, role: 'textbox', name: 'x' }, VALUES).ok, false, op);
  }
  // value forbidden outside PICK_VALUE_OPS
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'x', value: 'full_name' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'scroll', value: 'full_name' }, VALUES).ok, false);
});

test('validatePick requires value to match BINDING_RE and name a binding', () => {
  assert.equal(validatePick({ action: 'fill', role: 'textbox', name: 'x', value: 'missing' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'fill', role: 'textbox', name: 'x', value: '9bad' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'fill', role: 'textbox', name: 'x', value: 'Bad Name' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'fill', role: 'textbox', name: 'x', value: 7 }, VALUES).ok, false);
  // a prototype member is not a key of values (own keys only; 'constructor'
  // matches BINDING_RE, so it must be rejected by the binding check)
  assert.equal(validatePick({ action: 'fill', role: 'textbox', name: 'x', value: 'constructor' }, {}).ok, false);
  assert.equal(validatePick({ action: 'fill', role: 'textbox', name: 'x', value: 'full_name' }, VALUES).ok, true);
});

test('validatePick returns the typed pick on success', () => {
  const r = validatePick(
    { role: 'Textbox', name: 'Full name', action: 'fill', value: 'full_name' },
    VALUES,
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.pick, { role: 'Textbox', name: 'Full name', action: 'fill', value: 'full_name' });
  }
});

// --- resolution ---

const OBS = obsOf([
  el({ id: 'e1', role: 'textbox', name: 'Full name' }),
  el({ id: 'e2', role: 'textbox', name: '  full   NAME ' }),
  el({ id: 'e3', role: 'button', name: 'Show details' }),
  el({ id: 'e4', role: 'textbox', name: 'Email' }),
]);

test('resolvePick is case- and whitespace-insensitive', () => {
  // a unique target: case differences alone
  const r = resolvePick(OBS, { role: 'BUTTON', name: 'SHOW DETAILS', action: 'click' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.el?.id, 'e3');
  // whitespace differences alone: e2's name collapses to e1's, so this is a 2-match…
  const w = resolvePick(OBS, { role: 'textbox', name: 'full name', action: 'click' });
  assert.equal(w.ok, false);
  if (!w.ok) assert.deepEqual(w.matches.map((m) => m.id), ['e1', 'e2']);
  // …and nth disambiguates to the whitespace-padded element
  const wn = resolvePick(OBS, { role: 'textbox', name: '  FULL   name ', action: 'click', nth: 2 });
  assert.equal(wn.ok, true);
  if (wn.ok) assert.equal(wn.el?.id, 'e2');
});

test('resolvePick with nth returns the nth match', () => {
  const r = resolvePick(OBS, { role: 'textbox', name: 'full name', action: 'click', nth: 2 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.el?.id, 'e2');
});

test('resolvePick with an out-of-range nth returns no-match with up to 3 matches', () => {
  const r = resolvePick(OBS, { role: 'textbox', name: 'full name', action: 'click', nth: 3 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.why, 'no-match');
    assert.deepEqual(r.matches.map((m) => m.id), ['e1', 'e2']);
  }
});

test('resolvePick without nth returns multi-match with the first 3', () => {
  const r = resolvePick(OBS, { role: 'textbox', name: 'full name', action: 'click' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.why, 'multi-match');
    assert.deepEqual(r.matches.map((m) => m.id), ['e1', 'e2']);
  }
});

test('resolvePick returns no-match with the first 3 same-role elements on zero matches', () => {
  const r = resolvePick(OBS, { role: 'textbox', name: 'Missing field', action: 'click' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.why, 'no-match');
    assert.deepEqual(r.matches.map((m) => m.id), ['e1', 'e2', 'e4']);
  }
});

test('resolvePick matches a single element exactly', () => {
  const r = resolvePick(OBS, { role: 'button', name: 'show details', action: 'click' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.el?.id, 'e3');
});

test('resolvePick resolves a targetless action to el null', () => {
  for (const action of ['scroll', 'scroll_up', 'wait', 'navigate', 'back', 'reload'] as const) {
    const r = resolvePick(OBS, { action });
    assert.equal(r.ok, true, action);
    if (r.ok) assert.equal(r.el, null, action);
  }
});

// --- candidateOf ---

test('candidateOf redacts a planted value in the name and the label', () => {
  const e = el({ id: 'e1', role: 'textbox', name: 'Jane Doe field' });
  const c = candidateOf(e, compileRedaction({ full_name: 'Jane Doe' }));
  assert.equal(c.role, 'textbox');
  assert.equal(c.name, '<value:full_name> field');
  assert.equal(c.label.includes('Jane Doe'), false);
  assert.equal(c.label.includes('<value:full_name>'), true);
});

test('candidateOf caps label and name at 80 characters', () => {
  const e = el({ id: 'e1', role: 'textbox', name: 'x'.repeat(100) });
  const c = candidateOf(e, compileRedaction(VALUES));
  assert.equal(c.name.length, 80);
  assert.equal(c.label.length, 80);
});

// ---- r17 (spec .build-r17-spec.md, WP-B): press picks ----

test('r17 pick: key is press-only and must be a PRESS_KEYS member', () => {
  assert.equal(validatePick({ action: 'press', key: 'Tab' }, VALUES).ok, true);
  assert.equal(validatePick({ action: 'click', role: 'button', name: 'x', key: 'Tab' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'press', key: 'Nope' }, VALUES).ok, false);
});

test('r17 pick: a press pick takes role and name together or neither', () => {
  assert.equal(validatePick({ action: 'press' }, VALUES).ok, true);
  assert.equal(validatePick({ action: 'press', role: 'button' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'press', name: 'Go' }, VALUES).ok, false);
  assert.equal(validatePick({ action: 'press', role: 'button', name: 'Go' }, VALUES).ok, true);
});

test('r17 resolvePick: a press pick with no role and name resolves targetless (el null)', () => {
  const r = resolvePick(OBS, { action: 'press', key: 'Tab' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.el, null);
});
