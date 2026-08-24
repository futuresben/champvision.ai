const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Readable } = require('stream');

function response(status = 200) {
  return {
    statusCode: status,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; }
  };
}

function challenge(intent, subscriptionId = 'sub_mnq', customerId = 'cus_1') {
  const payload = Buffer.from(JSON.stringify({ intent, subscriptionId, customerId, code: '123456', exp: Date.now() + 60000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.UPGRADE_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function stripeReply(data) {
  return { ok: true, json: async () => data };
}

test('upgrade checkout charges the 400 euro bundle immediately', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_CURRENT_MNQ_PRICE_ID = 'price_mnq';
  process.env.STRIPE_LEGACY_MNQ_PRICE_ID = 'price_legacy';
  process.env.STRIPE_BUNDLE_PRICE_ID = 'price_bundle';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/subscriptions/sub_mnq')) return stripeReply({ status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_mnq' } }] } });
    return stripeReply({ url: 'https://checkout.stripe.test/session' });
  };
  const handler = require('../api/verify-upgrade-code');
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { challenge: challenge('upgrade'), code: '123456' } }, res);
  const checkoutBody = new URLSearchParams(calls[1].options.body);
  assert.equal(checkoutBody.get('mode'), 'subscription');
  assert.equal(checkoutBody.get('line_items[0][price]'), 'price_bundle');
  assert.equal(checkoutBody.get('metadata[source_subscription_id]'), 'sub_mnq');
  assert.equal(res.body.url, 'https://checkout.stripe.test/session');
});

test('paid upgrade stores remaining MNQ seconds and cancels the old subscription', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  const created = 1800000000;
  const event = {
    id: 'evt_1', type: 'checkout.session.completed', created,
    data: { object: { id: 'cs_1', customer: 'cus_1', subscription: 'sub_bundle', metadata: { flow: 'champvision_bundle_upgrade', source_subscription_id: 'sub_mnq' } } }
  };
  const raw = Buffer.from(JSON.stringify(event));
  const timestamp = String(created);
  const signature = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/subscriptions/sub_bundle')) return stripeReply({ id: 'sub_bundle', metadata: {}, items: { data: [{ current_period_end: created + 2592000 }] } });
    if (url.endsWith('/subscriptions/sub_mnq')) return stripeReply({ id: 'sub_mnq', status: 'active', items: { data: [{ current_period_end: created + 864000 }] } });
    return stripeReply({});
  };
  const handler = require('../api/stripe-webhook');
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` };
  const res = response();
  await handler(req, res);
  const customerUpdate = calls.find((call) => call.url.endsWith('/customers/cus_1'));
  const customerBody = new URLSearchParams(customerUpdate.options.body);
  assert.equal(customerBody.get('metadata[champvision_mnq_credit_seconds]'), '864000');
  assert.ok(calls.some((call) => call.url.endsWith('/subscriptions/sub_mnq') && call.options.method === 'DELETE'));
  assert.equal(res.statusCode, 200);
});
