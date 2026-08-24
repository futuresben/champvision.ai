const crypto = require('crypto');

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function validSignature(raw, header) {
  const entries = String(header || '').split(',').map((part) => part.split('='));
  const timestamp = entries.find(([key]) => key === 't');
  const signatures = entries.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length || !process.env.STRIPE_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp[1]}.${raw.toString('utf8')}`).digest('hex');
  return signatures.some((actual) => actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)));
}

async function stripe(path, options = {}) {
  const authorization = Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString('base64');
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...options,
    headers: { Authorization: `Basic ${authorization}`, ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error && data.error.message ? data.error.message : 'Stripe request failed');
  return data;
}

function form(data) {
  return new URLSearchParams(data).toString();
}

function periodEnd(subscription) {
  return Number(subscription.current_period_end || (subscription.items.data[0] && subscription.items.data[0].current_period_end) || 0);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const raw = await rawBody(req);
  if (!validSignature(raw, req.headers['stripe-signature'])) return res.status(400).send('Invalid signature');

  const event = JSON.parse(raw.toString('utf8'));
  if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true });
  const checkout = event.data.object;
  if (!checkout.metadata || checkout.metadata.flow !== 'champvision_bundle_upgrade' || !checkout.subscription) {
    return res.status(200).json({ received: true });
  }

  try {
    const bundle = await stripe(`subscriptions/${checkout.subscription}`);
    if (bundle.metadata.upgrade_finalized === 'true') return res.status(200).json({ received: true });

    const source = await stripe(`subscriptions/${checkout.metadata.source_subscription_id}`);
    const creditSeconds = Math.max(0, periodEnd(source) - Number(event.created || 0));
    await stripe(`customers/${checkout.customer}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        'metadata[champvision_mnq_credit_seconds]': String(creditSeconds),
        'metadata[champvision_mnq_credit_source]': source.id
      })
    });

    if (source.status !== 'canceled') await stripe(`subscriptions/${source.id}`, { method: 'DELETE' });
    await stripe(`subscriptions/${bundle.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        'metadata[upgrade_finalized]': 'true',
        'metadata[mnq_credit_seconds]': String(creditSeconds)
      })
    });
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('stripe-webhook', error.message);
    return res.status(500).send('Webhook processing failed');
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
