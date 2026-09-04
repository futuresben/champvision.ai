const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

function response(status = 200) {
  return {
    statusCode: status,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; },
    redirect(value) { this.statusCode = 307; this.redirectedTo = value; return this; }
  };
}

function challenge(intent, subscriptionId = 'sub_mnq', customerId = 'cus_1', extra = {}) {
  const payload = Buffer.from(JSON.stringify({ intent, subscriptionId, customerId, code: '123456', exp: Date.now() + 60000, ...extra })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.UPGRADE_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

test('management lookup finds a case-insensitive MNQ email and returns the MNQ plan', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_CURRENT_MNQ_PRICE_ID = 'price_current';
  process.env.BREVO_API_KEY = 'brevo_test';
  process.env.BREVO_SENDER_EMAIL = 'support@example.test';
  global.fetch = async (url) => {
    if (url.includes('/customers?email=')) return stripeReply({ data: [] });
    if (url.endsWith('/customers?limit=100')) return stripeReply({ data: [{ id: 'cus_mike', email: 'Mike2015@Hotmail.de' }], has_more: false });
    if (url.includes('/subscriptions?customer=cus_mike')) return stripeReply({ data: [{ id: 'sub_mnq', status: 'active', items: { data: [{ price: { id: 'price_current' } }] } }] });
    if (url === 'https://api.brevo.com/v3/smtp/email') return stripeReply({ messageId: 'mail_manage' });
    throw new Error(`Unexpected request: ${url}`);
  };
  const handler = require('../api/request-upgrade-code');
  const res = response();
  await handler({ method: 'POST', headers: { origin: 'https://futuresben.github.io' }, body: { email: 'mike2015@hotmail.de', intent: 'manage' } }, res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(Buffer.from(res.body.challenge.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(payload.plan, 'mnq');
});

test('management verification returns the subscription plan for the interface', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  const handler = require('../api/verify-upgrade-code');
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { challenge: challenge('manage', 'sub_mnq', 'cus_1', { plan: 'mnq' }), code: '123456' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, mode: 'manage', plan: 'mnq' });
});

test('cancellation confirmation can be resent only for a pending cancellation', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_CURRENT_MNQ_PRICE_ID = 'price_current';
  process.env.BREVO_API_KEY = 'brevo_test';
  process.env.BREVO_SENDER_EMAIL = 'support@example.test';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/customers?email=')) return stripeReply({ data: [{ id: 'cus_massimo', email: 'massimovezzi@googlemail.com' }] });
    if (url.includes('/subscriptions?customer=cus_massimo')) return stripeReply({ data: [{ id: 'sub_massimo', status: 'canceled', cancel_at_period_end: true, current_period_end: 1788540000, items: { data: [{ price: { id: 'price_current' } }] } }] });
    if (url === 'https://api.brevo.com/v3/smtp/email') return stripeReply({ messageId: 'mail_resend' });
    throw new Error(`Unexpected request: ${url}`);
  };
  const handler = require('../api/request-upgrade-code');
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { email: 'massimovezzi@googlemail.com', intent: 'resend-cancellation-confirmation' } }, res);
  assert.equal(res.statusCode, 200);
  const mail = calls.find((call) => call.url === 'https://api.brevo.com/v3/smtp/email');
  assert.equal(JSON.parse(mail.options.body).to[0].email, 'massimovezzi@googlemail.com');
  assert.match(JSON.parse(mail.options.body).subject, /MNQ-Kündigung/);
});

test('an active MNQ subscription can be cancelled through management', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_BUNDLE_PRICE_ID = 'price_bundle';
  process.env.BREVO_API_KEY = 'brevo_test';
  process.env.BREVO_SENDER_EMAIL = 'support@example.test';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/subscriptions/sub_mnq')) return stripeReply({ id: 'sub_mnq', status: 'active', items: { data: [{ price: { id: 'price_mnq' }, current_period_end: 1790000000 }] } });
    if (url === 'https://api.brevo.com/v3/smtp/email') return stripeReply({ messageId: 'cancellation_mail' });
    throw new Error(`Unexpected request: ${url}`);
  };
  const handler = require('../api/manage-subscription');
  const res = response();
  await handler({ method: 'POST', headers: { origin: 'https://futuresben.github.io' }, body: { challenge: challenge('manage', 'sub_mnq', 'cus_1', { plan: 'mnq', email: 'member@example.test' }), code: '123456', choice: 'cancel' } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /endet zum Ende/);
  const cancellation = calls.find((call) => call.url.endsWith('/subscriptions/sub_mnq') && call.options.method === 'POST');
  assert.equal(new URLSearchParams(cancellation.options.body).get('cancel_at_period_end'), 'true');
  assert.equal(calls.some((call) => call.url.endsWith('/customers/cus_1')), false);
  const mail = calls.find((call) => call.url === 'https://api.brevo.com/v3/smtp/email');
  assert.equal(JSON.parse(mail.options.body).to[0].email, 'member@example.test');
  assert.match(JSON.parse(mail.options.body).subject, /MNQ-Kündigung/);
});

test('a schedule-managed MNQ subscription is released before cancellation', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_BUNDLE_PRICE_ID = 'price_bundle';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/subscriptions/sub_scheduled') && !options.method) return stripeReply({ id: 'sub_scheduled', status: 'active', schedule: 'sub_sched_1', items: { data: [{ price: { id: 'price_mnq' } }] } });
    if (url.endsWith('/subscription_schedules/sub_sched_1/release')) return stripeReply({ id: 'sub_sched_1', status: 'released', released_subscription: 'sub_scheduled' });
    if (url.endsWith('/subscriptions/sub_scheduled')) return stripeReply({ id: 'sub_scheduled' });
    throw new Error(`Unexpected request: ${url}`);
  };
  const handler = require('../api/manage-subscription');
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { challenge: challenge('manage', 'sub_scheduled', 'cus_1', { plan: 'mnq' }), code: '123456', choice: 'cancel' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((call) => call.url.replace('https://api.stripe.com/v1/', '')), [
    'subscriptions/sub_scheduled',
    'subscription_schedules/sub_sched_1/release',
    'subscriptions/sub_scheduled'
  ]);
});

function stripeReply(data) {
  return { ok: true, json: async () => data };
}

test('upgrade lookup recognizes an active MNQ subscription with a new price', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_CURRENT_MNQ_PRICE_ID = 'price_current';
  process.env.STRIPE_BUNDLE_PRICE_ID = 'price_bundle';
  process.env.STRIPE_MGC_PRICE_ID = 'price_mgc';
  process.env.BREVO_API_KEY = 'brevo_test';
  process.env.BREVO_SENDER_EMAIL = 'support@example.test';
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (url.includes('/customers?email=')) return stripeReply({ data: [{ id: 'cus_new', email: 'member@example.test' }] });
    if (url.includes('/subscriptions?customer=cus_new')) return stripeReply({ data: [{ id: 'sub_new', status: 'active', items: { data: [{ price: { id: 'price_new', product: 'prod_mnq' } }] } }] });
    if (url.endsWith('/products/prod_mnq')) return stripeReply({ id: 'prod_mnq', name: 'ChampVision MNQ Member' });
    if (url === 'https://api.brevo.com/v3/smtp/email') return stripeReply({ messageId: 'mail_1' });
    throw new Error(`Unexpected request: ${url}`);
  };
  const handler = require('../api/request-upgrade-code');
  const res = response();
  await handler({ method: 'POST', headers: { origin: 'https://futuresben.github.io' }, body: { email: 'member@example.test', intent: 'upgrade' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(calls.some((url) => url.endsWith('/products/prod_mnq')));
});

test('upgrade lookup matches Stripe customer email case-insensitively and accepts trialing', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_CURRENT_MNQ_PRICE_ID = 'price_current';
  process.env.BREVO_API_KEY = 'brevo_test';
  process.env.BREVO_SENDER_EMAIL = 'support@example.test';
  global.fetch = async (url) => {
    if (url.includes('/customers?email=')) return stripeReply({ data: [] });
    if (url.endsWith('/customers?limit=100')) return stripeReply({ data: [{ id: 'cus_case', email: 'Member@Example.Test' }], has_more: false });
    if (url.includes('/subscriptions?customer=cus_case')) return stripeReply({ data: [{ id: 'sub_case', status: 'trialing', items: { data: [{ price: { id: 'price_current' } }] } }] });
    if (url === 'https://api.brevo.com/v3/smtp/email') return stripeReply({ messageId: 'mail_2' });
    throw new Error(`Unexpected request: ${url}`);
  };
  const handler = require('../api/request-upgrade-code');
  const res = response();
  await handler({ method: 'POST', headers: { origin: 'https://futuresben.github.io' }, body: { email: 'member@example.test', intent: 'upgrade' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

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
  await handler({ method: 'POST', headers: { host: 'preview.test' }, body: { challenge: challenge('upgrade'), code: '123456' } }, res);
  const checkoutBody = new URLSearchParams(calls[1].options.body);
  assert.equal(checkoutBody.get('mode'), 'subscription');
  assert.equal(checkoutBody.get('line_items[0][price]'), 'price_bundle');
  assert.equal(checkoutBody.get('metadata[source_subscription_id]'), 'sub_mnq');
  assert.equal(checkoutBody.get('success_url'), 'https://preview.test/api/finalize-upgrade?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(res.body.url, 'https://checkout.stripe.test/session');
});

test('upgrade checkout accepts a trialing subscription with a new MNQ price', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_BUNDLE_PRICE_ID = 'price_bundle';
  process.env.STRIPE_CURRENT_MNQ_PRICE_ID = 'price_current';
  process.env.STRIPE_MGC_PRICE_ID = 'price_mgc';
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/subscriptions/sub_new')) return stripeReply({ status: 'trialing', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_new', product: 'prod_mnq' } }] } });
    if (url.endsWith('/products/prod_mnq')) return stripeReply({ id: 'prod_mnq', name: 'ChampVision MNQ Member' });
    return stripeReply({ url: 'https://checkout.stripe.test/session' });
  };
  const handler = require('../api/verify-upgrade-code');
  const res = response();
  await handler({ method: 'POST', headers: { host: 'preview.test' }, body: { challenge: challenge('upgrade', 'sub_new'), code: '123456' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://checkout.stripe.test/session');
  assert.ok(calls.some((url) => url.endsWith('/products/prod_mnq')));
});

test('migrated 250 euro MNQ subscription can start the bundle upgrade', async () => {
  process.env.UPGRADE_TOKEN_SECRET = 'test-secret';
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  process.env.STRIPE_CURRENT_MNQ_PRICE_ID = 'price_mnq';
  process.env.STRIPE_LEGACY_MNQ_PRICE_ID = 'price_legacy';
  process.env.STRIPE_BUNDLE_PRICE_ID = 'price_bundle';
  const migratedPrice = 'price_1U5kacLh2L59TOeGwOkBeUVn';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/subscriptions/sub_migrated')) return stripeReply({ status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: migratedPrice } }] } });
    return stripeReply({ url: 'https://checkout.stripe.test/session' });
  };
  const handler = require('../api/verify-upgrade-code');
  const res = response();
  await handler({ method: 'POST', headers: { host: 'preview.test' }, body: { challenge: challenge('upgrade', 'sub_migrated'), code: '123456' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://checkout.stripe.test/session');
  assert.ok(calls.some((call) => call.url.endsWith('/checkout/sessions')));
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
  const handler = (await import('../api/stripe-webhook.mjs')).default;
  const req = new Request('https://example.test/api/stripe-webhook', {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` }
  });
  const res = await handler.fetch(req);
  const customerUpdate = calls.find((call) => call.url.endsWith('/customers/cus_1'));
  const customerBody = new URLSearchParams(customerUpdate.options.body);
  assert.equal(customerBody.get('metadata[champvision_mnq_credit_seconds]'), '864000');
  assert.ok(calls.some((call) => call.url.endsWith('/subscriptions/sub_mnq') && call.options.method === 'DELETE'));
  assert.equal(res.status, 200);
});

test('paid checkout return finalizes the upgrade without a webhook', async () => {
  process.env.STRIPE_SECRET_KEY = 'rk_test';
  const now = Math.floor(Date.now() / 1000);
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/checkout/sessions/cs_paid')) return stripeReply({
      id: 'cs_paid', status: 'complete', payment_status: 'paid', mode: 'subscription',
      customer: 'cus_1', subscription: 'sub_bundle',
      metadata: { flow: 'champvision_bundle_upgrade', source_subscription_id: 'sub_mnq' }
    });
    if (url.endsWith('/subscriptions/sub_bundle')) return stripeReply({ id: 'sub_bundle', metadata: {} });
    if (url.endsWith('/subscriptions/sub_mnq')) return stripeReply({
      id: 'sub_mnq', status: 'active', items: { data: [{ current_period_end: now + 864000 }] }
    });
    return stripeReply({});
  };
  const handler = require('../api/finalize-upgrade');
  const res = response();
  await handler({ method: 'GET', query: { session_id: 'cs_paid' } }, res);
  assert.ok(calls.some((call) => call.url.endsWith('/subscriptions/sub_mnq') && call.options.method === 'DELETE'));
  assert.match(res.redirectedTo, /bundle_upgrade=success/);
});
