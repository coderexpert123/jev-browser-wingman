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
  const v = classifyUrl('https://mail.google.com/mail/u/0/');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-webmail');
});

test('a subdomain of a listed bank matches', () => {
  const v = classifyUrl('https://secure.chase.com/login');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-banking');
});

test('a host that merely contains a listed name does not match', () => {
  const v = classifyUrl('https://notchase.com.example/');
  assert.equal(v.sensitive, false);
});

test('the bank.in suffix matches any Indian bank domain', () => {
  const v = classifyUrl('https://somebank.bank.in/');
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-banking');
});

test('gov suffix matches irs.gov and www.gov.uk', () => {
  const a = classifyUrl('https://irs.gov/');
  assert.equal(a.sensitive, true);
  assert.equal(a.reason, 'sensitive-government');
  const b = classifyUrl('https://www.gov.uk/');
  assert.equal(b.sensitive, true);
  assert.equal(b.reason, 'sensitive-government');
});

test('config extras extend a category', () => {
  const v = classifyUrl('https://mybank.example.com/', { banking: ['mybank.example.com'] });
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-banking');
});

test('/login and /oauth2/authorize paths are sensitive-auth-path', () => {
  const a = classifyUrl('https://example.com/login');
  assert.equal(a.sensitive, true);
  assert.equal(a.reason, 'sensitive-auth-path');
  const b = classifyUrl('https://example.com/oauth2/authorize');
  assert.equal(b.sensitive, true);
  assert.equal(b.reason, 'sensitive-auth-path');
});

test('/blog/logins-are-hard is not an auth path', () => {
  const v = classifyUrl('https://example.com/blog/logins-are-hard');
  assert.equal(v.sensitive, false);
});

test('chrome:// and about: pages are unsupported-page', () => {
  const a = classifyUrl('chrome://settings/');
  assert.equal(a.sensitive, true);
  assert.equal(a.reason, 'unsupported-page');
  const b = classifyUrl('about:blank');
  assert.equal(b.sensitive, true);
  assert.equal(b.reason, 'unsupported-page');
});

test('localhost fixtures are never sensitive', () => {
  const a = classifyUrl('http://localhost:3000/login');
  assert.equal(a.sensitive, false);
  const b = classifyUrl('http://127.0.0.1:3000/oauth2');
  assert.equal(b.sensitive, false);
  const c = classifyUrl('http://[::1]:3000/');
  assert.equal(c.sensitive, false);
});

test('password signal wins over a clean URL', () => {
  const v = evaluatePolicy('https://example.com/', signals({ password: true }));
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-password');
});

test('otp text signal is sensitive-otp', () => {
  const v = classifySignals(signals({ otpText: true }));
  assert.equal(v.sensitive, true);
  assert.equal(v.reason, 'sensitive-otp');
});

test('cc autocomplete is sensitive-payment-field', () => {
  const v = classifySignals(signals({ ccAutocomplete: true }));
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
