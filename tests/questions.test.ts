import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUCTIONS,
  UNTRUSTED_SENTENCE,
  elementCriterion,
  buildRoundRequest,
  buildGroupRequest,
  buildTargetRequest,
  buildOptionRequests,
  buildOptionFinalRequest,
  buildCheckRequest,
} from '../src/core/questions.js';
import { assertNoValues } from '../src/core/withhold.js';
import type { ElementRecord } from '../src/contract/types.js';

function mkEl(overrides: Partial<ElementRecord> & { id: string }): ElementRecord {
  return {
    path: `#${overrides.id}`,
    tag: 'button',
    role: 'button',
    name: 'Continue',
    type: '',
    attrName: '',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: false,
    inViewport: true,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    form: -1,
    fingerprint: { tag: 'button', role: 'button', name: 'Continue', x: 0, y: 0 },
    ...overrides,
  } as ElementRecord;
}

test('every instruction ends with the untrusted-data sentence', () => {
  for (const [id, text] of Object.entries(INSTRUCTIONS)) {
    assert.ok(text.endsWith(UNTRUSTED_SENTENCE), `${id} does not end with the untrusted-data sentence`);
  }
});

test('round 1 has no error question and round 2 has one', () => {
  const elements = [mkEl({ id: 'e1' })];
  const req1 = buildRoundRequest({ state: {}, elements, bindings: {}, round: 1 });
  const req2 = buildRoundRequest({ state: {}, elements, bindings: {}, round: 2 });
  assert.equal('error' in req1.questions, false);
  assert.equal('error' in req2.questions, true);
});

test('value question only when bindings exist', () => {
  const elements = [mkEl({ id: 'e1' })];
  const noBindings = buildRoundRequest({ state: {}, elements, bindings: {}, round: 1 });
  const withBindings = buildRoundRequest({ state: {}, elements, bindings: { name: 'Alice' }, round: 1 });
  assert.equal('value' in noBindings.questions, false);
  assert.equal('value' in withBindings.questions, true);
});

test('target criteria render role, name and state suffixes', () => {
  const checked = mkEl({ id: 'e1', role: 'checkbox', name: 'Subscribe', state: { checked: true, disabled: false } });
  assert.equal(elementCriterion(checked), 'checkbox "Subscribe" (checked)');

  const unchecked = mkEl({ id: 'e2', role: 'checkbox', name: 'Subscribe', state: { checked: false, disabled: false } });
  assert.equal(elementCriterion(unchecked), 'checkbox "Subscribe" (unchecked)');

  const empty = mkEl({ id: 'e3', role: 'textbox', name: 'Email', tag: 'input', state: { filled: false, disabled: false } });
  assert.equal(elementCriterion(empty), 'textbox "Email" (empty)');

  const filled = mkEl({ id: 'e4', role: 'textbox', name: 'Email', tag: 'input', state: { filled: true, disabled: false } });
  assert.equal(elementCriterion(filled), 'textbox "Email" (filled)');

  const disabled = mkEl({ id: 'e5', role: 'button', name: 'Submit', state: { disabled: true } });
  assert.equal(elementCriterion(disabled), 'button "Submit" (disabled)');

  const selected = mkEl({
    id: 'e6',
    role: 'combobox',
    name: 'Country',
    tag: 'select',
    state: { disabled: false, selected: 'India' },
  });
  assert.equal(elementCriterion(selected), 'combobox "Country" (selected: India)');

  const combined = mkEl({
    id: 'e7',
    role: 'checkbox',
    name: 'Terms',
    state: { checked: true, disabled: true },
  });
  assert.equal(elementCriterion(combined), 'checkbox "Terms" (checked) (disabled)');
});

test('an empty name renders (no label)', () => {
  const el = mkEl({ id: 'e1', role: 'button', name: '', state: { disabled: false } });
  assert.equal(elementCriterion(el), 'button (no label)');
});

test('target criteria include none and ambiguous', () => {
  const elements = [mkEl({ id: 'e1' })];
  const req = buildRoundRequest({ state: {}, elements, bindings: {}, round: 1 });
  const target = req.questions.target;
  assert.equal(target.type, 'choice');
  if (target.type === 'choice') {
    assert.ok('none' in target.criteria);
    assert.ok('ambiguous' in target.criteria);
  }
});

test('300 elements produce a group request with 10 groups and no target', () => {
  const elements: ElementRecord[] = [];
  for (let i = 1; i <= 300; i++) elements.push(mkEl({ id: `e${i}`, name: `Item ${i}` }));
  const { request, groups } = buildGroupRequest({ state: {}, elements, bindings: {}, round: 1 });
  assert.equal(groups.length, 10);
  assert.equal('target' in request.questions, false);
  assert.equal('group' in request.questions, true);
});

test('the target request covers only the top 3 groups', () => {
  const elements: ElementRecord[] = [];
  for (let i = 1; i <= 300; i++) elements.push(mkEl({ id: `e${i}`, name: `Item ${i}` }));
  const { groups } = buildGroupRequest({ state: {}, elements, bindings: {}, round: 1 });
  const topGroupsElements = groups.slice(0, 3).flat();
  assert.equal(topGroupsElements.length, 90);
  const targetReq = buildTargetRequest({ state: {}, elements: topGroupsElements, bindings: {}, round: 2 });
  const target = targetReq.questions.target;
  assert.equal(target.type, 'choice');
  if (target.type === 'choice') {
    const nonExtraKeys = Object.keys(target.criteria).filter((k) => k !== 'none' && k !== 'ambiguous');
    assert.equal(nonExtraKeys.length, 90);
  }
});

test('300 options produce 2 chunk requests of at most 251 criteria', () => {
  const options = Array.from({ length: 300 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
  const select = mkEl({ id: 'e1', role: 'combobox', tag: 'select', options });
  const requests = buildOptionRequests({ state: {}, select });
  assert.equal(requests.length, 2);
  for (const { request } of requests) {
    const optionQ = request.questions.option;
    assert.equal(optionQ.type, 'choice');
    if (optionQ.type === 'choice') {
      assert.ok(Object.keys(optionQ.criteria).length <= 251);
    }
  }
  assert.equal(Object.keys((requests[0].request.questions.option as { criteria: Record<string, string> }).criteria).length, 251);
  assert.equal(Object.keys((requests[1].request.questions.option as { criteria: Record<string, string> }).criteria).length, 51);
});

test('binding values never appear in any request', () => {
  const bindings = { email: 'leaktest@example.com' };
  const elements = [mkEl({ id: 'e1', name: `Field for ${bindings.email}` })];
  const roundReq = buildRoundRequest({ state: {}, elements, bindings, round: 2 });
  assertNoValues(JSON.stringify(roundReq), bindings);

  const { request: groupReq } = buildGroupRequest({ state: {}, elements, bindings, round: 1 });
  assertNoValues(JSON.stringify(groupReq), bindings);

  const targetReq = buildTargetRequest({ state: {}, elements, bindings, round: 2 });
  assertNoValues(JSON.stringify(targetReq), bindings);

  const checkReq = buildCheckRequest({ state: {}, question: `Is ${bindings.email} shown?`, values: bindings });
  assertNoValues(JSON.stringify(checkReq), bindings);

  const select = mkEl({
    id: 'e2',
    tag: 'select',
    role: 'combobox',
    name: 'Choose',
    state: { disabled: false, selected: '' },
    options: [
      { value: 'v1', label: `Mail to ${bindings.email}` },
      { value: 'v2', label: 'Nothing here' },
    ],
  });
  for (const { request } of buildOptionRequests({ state: {}, select, bindings })) {
    assertNoValues(JSON.stringify(request), bindings);
  }
  const finalReq = buildOptionFinalRequest({
    state: {},
    winners: [{ value: 'v1', label: `Mail to ${bindings.email}` }],
    bindings,
  });
  assertNoValues(JSON.stringify(finalReq.request), bindings);
});

test('check request carries only the answer question', () => {
  const req = buildCheckRequest({ state: {}, question: 'Is there a Continue button?', values: {} });
  assert.deepEqual(Object.keys(req.questions), ['answer']);
  assert.equal(req.questions.answer.type, 'noul');
  assert.match(req.questions.answer.instructions, /Is there a Continue button\?/);
  assert.ok(req.questions.answer.instructions.endsWith(UNTRUSTED_SENTENCE));
});
