import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showsRefundControls } from './organizer-refund';

const order = (status: string, reviewRequired = false) => ({ reviewRequired, payment: { status, amount: 1000, currency: 'KZT', depositAmount: null, depositStatus: null } }) as Parameters<typeof showsRefundControls>[0];

test('a failed order with a quarantined capture shows refund controls', () => {
  assert.equal(showsRefundControls(order('failed', true)), true);
  assert.equal(showsRefundControls(order('cancelled', true)), true);
});

test('orders without a capture keep the previous visibility', () => {
  assert.equal(showsRefundControls(order('failed')), false);
  assert.equal(showsRefundControls(order('pending')), false);
  for (const status of ['paid', 'cancelled', 'refunded']) assert.equal(showsRefundControls(order(status)), true);
});
