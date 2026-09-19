import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfirmTokenStore, type PendingAction } from '../src/core/tokens.js';

function action(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    url: 'https://example.com/checkout',
    elementPath: '#submit',
    fingerprint: { tag: 'button', role: 'button', name: 'Place order', x: 1, y: 2 },
    verb: 'click',
    label: 'Place order',
    ...overrides,
  };
}

test('a minted token is consumed once', () => {
  const store = new ConfirmTokenStore();
  const a = action();
  const token = store.mint(a);
  const consumed = store.consume(token);
  assert.deepEqual(consumed, a);
});

test('a second consume returns null', () => {
  const store = new ConfirmTokenStore();
  const token = store.mint(action());
  store.consume(token);
  assert.equal(store.consume(token), null);
});

test('an expired token returns null', () => {
  let now = 1_000_000;
  const store = new ConfirmTokenStore(() => now, 1_000, 32);
  const token = store.mint(action());
  now += 2_000;
  assert.equal(store.consume(token), null);
});

test('the 33rd token evicts the oldest', () => {
  const store = new ConfirmTokenStore(Date.now, 600_000, 32);
  const tokens: string[] = [];
  for (let i = 0; i < 33; i++) {
    tokens.push(store.mint(action({ label: `action-${i}` })));
  }
  assert.equal(store.consume(tokens[0]), null);
  const last = store.consume(tokens[32]);
  assert.equal(last?.label, 'action-32');
});

test('url stored without fragment', () => {
  const store = new ConfirmTokenStore();
  const a = action({ url: 'https://example.com/checkout?x=1' });
  const token = store.mint(a);
  const consumed = store.consume(token);
  assert.equal(consumed?.url, 'https://example.com/checkout?x=1');
  assert.ok(!consumed?.url.includes('#'));
});
