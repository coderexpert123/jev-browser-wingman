import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyUrl, classifySignals, evaluatePolicy, policySelfTest } from '../src/core/policy.js';
import { registrableDomain } from '../src/core/etld.js';
import { BUILTIN_HOSTS } from '../src/core/policy-data.js';
import type { PageSignals } from '../src/contract/types.js';

function signals(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    password: false,
    currentPassword: false,
    newPassword: false,
    otpAutocomplete: false,
    ccAutocomplete: false,
    otpText: false,
    captcha: false,
    ...overrides,
  };
}

test('mail.google.com is sensitive-webmail', () => {
  const v = classifyUrl('https://mail.google.com/mail/u/0/', undefined, 'enforce');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-webmail');
});

test('a subdomain of a listed bank matches', () => {
  const v = classifyUrl('https://secure.chase.com/login', undefined, 'enforce');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-banking');
});

test('a host that merely contains a listed name does not match', () => {
  const v = classifyUrl('https://notchase.com.example/', undefined, 'enforce');
  assert.equal(v.sensitive, false);
});

test('the bank.in suffix matches any Indian bank domain', () => {
  const v = classifyUrl('https://somebank.bank.in/', undefined, 'enforce');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-banking');
});

test('gov suffix matches irs.gov and www.gov.uk', () => {
  const a = classifyUrl('https://irs.gov/', undefined, 'enforce');
  assert.equal(a.sensitive, true);
  assert.equal(a.reason, 'sensitive-government');
  const b = classifyUrl('https://www.gov.uk/', undefined, 'enforce');
  assert.equal(b.sensitive, true);
  assert.equal(b.reason, 'sensitive-government');
});

test('config extras extend a category', () => {
  const v = classifyUrl('https://mybank.example.com/', { banking: ['mybank.example.com'] }, 'enforce');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-banking');
});

test('/login and /oauth2/authorize paths are sensitive-auth-path', () => {
  const a = classifyUrl('https://example.com/login', undefined, 'enforce');
  assert.equal(a.sensitive, true);
  assert.equal(a.reason, 'sensitive-auth-path');
  const b = classifyUrl('https://example.com/oauth2/authorize', undefined, 'enforce');
  assert.equal(b.sensitive, true);
  assert.equal(b.reason, 'sensitive-auth-path');
});

test('/blog/logins-are-hard is not an auth path', () => {
  const v = classifyUrl('https://example.com/blog/logins-are-hard', undefined, 'enforce');
  assert.equal(v.sensitive, false);
});

test('chrome:// and about: pages are unsupported-page', () => {
  const a = classifyUrl('chrome://settings/', undefined, 'enforce');
  assert.equal(a.sensitive, true);
  assert.equal(a.reason, 'unsupported-page');
  const b = classifyUrl('about:blank', undefined, 'enforce');
  assert.equal(b.sensitive, true);
  assert.equal(b.reason, 'unsupported-page');
});

test('localhost fixtures are never sensitive', () => {
  const a = classifyUrl('http://localhost:3000/login', undefined, 'enforce');
  assert.equal(a.sensitive, false);
  const b = classifyUrl('http://127.0.0.1:3000/oauth2', undefined, 'enforce');
  assert.equal(b.sensitive, false);
  const c = classifyUrl('http://[::1]:3000/', undefined, 'enforce');
  assert.equal(c.sensitive, false);
});

test('password signal wins over a clean URL', () => {
  const v = evaluatePolicy('https://example.com/', signals({ password: true }), undefined, 'enforce');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-password');
});

test('otp text signal is sensitive-otp', () => {
  const v = classifySignals(signals({ otpText: true }), 'enforce');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-otp');
});

test('cc autocomplete is sensitive-payment-field', () => {
  const v = classifySignals(signals({ ccAutocomplete: true }), 'enforce');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-payment-field');
});

test('policySelfTest passes on built-ins', () => {
  const r = policySelfTest();
  assert.equal(r.ok, true);
});

test('policySelfTest fails on an emptied identity list', () => {
  const badLists = { ...BUILTIN_HOSTS, identity: [] };
  const r = policySelfTest(badLists);
  assert.equal(r.ok, false);
});

test('registrableDomain reduces a.b.example.co.uk to example.co.uk', () => {
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
});

test('trailing dots, ports and case never hide a listed host', () => {
  const a = classifyUrl('https://chase.com./', undefined, 'enforce');
  assert.equal(a.sensitive, true);
  assert.equal(a.reason, 'sensitive-banking');

  const b = classifyUrl('https://CHASE.COM:8443/login', undefined, 'enforce');
  assert.equal(b.sensitive, true);
  assert.equal(b.reason, 'sensitive-banking');

  const c = classifyUrl('https://secure.Chase.COM/Login', undefined, 'enforce');
  assert.equal(c.sensitive, true);
  assert.equal(c.reason, 'sensitive-banking');
});

test('userinfo in the URL never changes the classified host', () => {
  const v = classifyUrl('https://example.com@chase.com/', undefined, 'enforce');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-banking');

  const notBank = classifyUrl('https://chase.com@example.com/', undefined, 'enforce');
  assert.equal(notBank.sensitive, false);
});

test('policy.mode off classifies a listed banking host as non-sensitive', () => {
  // Explicit 'enforce' first: the host IS sensitive under enforce.
  const enforce = evaluatePolicy('https://secure.chase.com/login', signals(), undefined, 'enforce');
  assert.equal(enforce.sensitive, true);
  assert.equal(enforce.reason, 'sensitive-banking');

  const off = evaluatePolicy('https://secure.chase.com/login', signals(), undefined, 'off');
  assert.equal(off.sensitive, false);
  assert.equal(off.reason, undefined);

  // classifyUrl directly, including a non-http URL that enforce always blocks.
  const offUrl = classifyUrl('https://secure.chase.com/login', undefined, 'off');
  assert.equal(offUrl.sensitive, false);
  const offChrome = classifyUrl('chrome://settings/', undefined, 'off');
  assert.equal(offChrome.sensitive, false);
});

test('policy.mode off proceeds past a password-field page signal', () => {
  const enforce = evaluatePolicy('https://example.com/', signals({ password: true }), undefined, 'enforce');
  assert.equal(enforce.sensitive, true);
  assert.equal(enforce.reason, 'sensitive-password');

  const off = evaluatePolicy('https://example.com/', signals({ password: true }), undefined, 'off');
  assert.equal(off.sensitive, false);
  assert.equal(classifySignals(signals({ password: true, otpText: true, ccAutocomplete: true }), 'off').sensitive, false);
});

test('default/absent policy mode is off; only explicit enforce falls back', () => {
  // No mode argument at all: the shipped default is off, so nothing is sensitive.
  const host = evaluatePolicy('https://secure.chase.com/login', signals());
  assert.equal(host.sensitive, false);
  const sigOff = evaluatePolicy('https://example.com/', signals({ password: true }));
  assert.equal(sigOff.sensitive, false);
  // Explicit 'enforce' opts back in, including signals.
  const sig = evaluatePolicy('https://example.com/', signals({ password: true }), undefined, 'enforce');
  assert.equal(sig.sensitive, true);
  assert.equal(sig.reason, 'sensitive-password');
});
