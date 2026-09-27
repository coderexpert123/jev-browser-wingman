// Unit test for tests/helpers/typesafe-stub.ts's fillDefaultAnswers (build
// spec 2026-09-26-wingman-forced-handoff, e2e stub fix). Real Jev answers
// every question a request asks; parseJevAnswers (src/core/jev-client.ts)
// rejects any response missing one. The e2e stubs used to answer only the
// questions each scenario cared about, so a `press`-offered `key` question
// (always asked — press is in DEFAULT_OFFERED_OPS) and sometimes `value`
// went unanswered and the whole round came back invalid-response. This test
// feeds a realistic chain request through the real parser to prove
// fillDefaultAnswers closes that gap without touching the test's own
// explicit answers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fillDefaultAnswers } from './helpers/typesafe-stub.js';
import { parseJevAnswers } from '../src/core/jev-client.js';
import type { JevRequest } from '../src/contract/types.js';

// A chain-mode, browse_step-shaped round: done/blocked/login/irreversible/
// action/target/value (bindings present) always ride; key (press is always
// offered) and step_done/right_page/ready (chain) ride too. `recover` stands
// in for a round-≥2 choice question with no `none` criterion.
function chainRequest(): JevRequest {
  return {
    state: { url: 'https://example.com', step: 'fill the field' },
    questions: {
      done: { type: 'noul', instructions: 'done?' },
      blocked: { type: 'noul', instructions: 'blocked?' },
      login: { type: 'noul', instructions: 'login?' },
      irreversible: { type: 'noul', instructions: 'irreversible?' },
      action: {
        type: 'choice',
        instructions: 'action?',
        criteria: { click: 'Click', fill: 'Fill', none: 'No action' },
      },
      target: {
        type: 'choice',
        instructions: 'target?',
        criteria: { e1: 'textbox "Email"', none: 'No element fits', ambiguous: 'Ambiguous' },
      },
      value: {
        type: 'choice',
        instructions: 'value?',
        criteria: { email: 'email (text)', none: 'None of the supplied values fits' },
      },
      key: {
        type: 'choice',
        instructions: 'key?',
        criteria: { Enter: 'Enter', Tab: 'Tab', none: 'No key fits' },
      },
      step_done: { type: 'noul', instructions: 'step done?' },
      right_page: { type: 'noul', instructions: 'right page?' },
      ready: { type: 'noul', instructions: 'ready?' },
      recover: {
        type: 'choice',
        instructions: 'recover?',
        criteria: { back: 'Go back', reload: 'Reload', wait: 'Wait', continue: 'Continue', 'give-up': 'Stop' },
      },
    },
  };
}

test('fillDefaultAnswers completes a partially-answered request so parseJevAnswers accepts it', () => {
  const request = chainRequest();
  const explicit: Record<string, unknown> = {
    action: { type: 'choice', choice: 'fill', probabilities: { fill: 0.9 }, confidence: 0.9 },
    target: { type: 'choice', choice: 'e1', probabilities: { e1: 0.9, none: 0.05, ambiguous: 0.05 }, confidence: 0.9 },
    value: { type: 'choice', choice: 'email', probabilities: { email: 0.9 }, confidence: 0.9 },
    right_page: { type: 'noul', noul: 0.95 },
    ready: { type: 'noul', noul: 0.95 },
  };
  const answers = fillDefaultAnswers(request.questions as never, explicit);

  // Explicit answers pass through unchanged.
  assert.deepEqual(answers.action, explicit.action);
  assert.deepEqual(answers.target, explicit.target);
  assert.deepEqual(answers.value, explicit.value);
  assert.deepEqual(answers.right_page, explicit.right_page);
  assert.deepEqual(answers.ready, explicit.ready);

  // Every unanswered question got a default.
  assert.deepEqual(answers.done, { type: 'noul', noul: 0.05 });
  assert.deepEqual(answers.blocked, { type: 'noul', noul: 0.05 });
  assert.deepEqual(answers.login, { type: 'noul', noul: 0.05 });
  assert.deepEqual(answers.irreversible, { type: 'noul', noul: 0.05 });
  assert.deepEqual(answers.step_done, { type: 'noul', noul: 0.05 });
  // key: choice with a `none` criterion -> none, at low confidence — never
  // fires a press on its own.
  assert.deepEqual(answers.key, { type: 'choice', choice: 'none', probabilities: { none: 0.05 }, confidence: 0.05 });
  // recover: choice with NO `none` criterion -> its first criterion key, at
  // low confidence — loop.ts only reads it once `error` has already crossed
  // its threshold, which no default here ever does, so this choice is inert.
  assert.deepEqual(answers.recover, { type: 'choice', choice: 'back', probabilities: { back: 0.05 }, confidence: 0.05 });

  // The real parser must accept the completed response: every asked
  // question has a structurally valid answer.
  const body = { answers };
  const parsed = parseJevAnswers(request, body);
  assert.notEqual(parsed, undefined, 'parseJevAnswers rejected the filled response');
  assert.equal(Object.keys(parsed ?? {}).length, Object.keys(request.questions).length);
});

test('fillDefaultAnswers can fail: proves the check discriminates', () => {
  const request = chainRequest();
  // No fill at all: only the questions a test answered explicitly are
  // present, exactly the old per-file stub behaviour this bug report
  // describes (missing key and value).
  const explicit: Record<string, unknown> = {
    action: { type: 'choice', choice: 'fill', probabilities: { fill: 0.9 }, confidence: 0.9 },
    target: { type: 'choice', choice: 'e1', probabilities: { e1: 0.9 }, confidence: 0.9 },
  };
  const parsed = parseJevAnswers(request, { answers: explicit });
  assert.equal(parsed, undefined, 'an unfilled response with missing questions must be rejected');
});
