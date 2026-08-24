import crypto from 'node:crypto';

function validSignature(raw, header) {
  const entries = String(header || '').split(',').map((part) => part.split('='));
  const timestamp = entries.find(([key]) => key === 't');
  const signatures = entries.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length || !process.env.STRIPE_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp[1]}.${raw}`).digest('hex');
  return signatures.some((actual) => actual.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)));
}

async function stripe(path, options = {}) {
  const authorization = Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString('base64');
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...options,
    headers: { Authorization: `Basic ${authorization}`, ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Stripe request failed');
  return data;
}

const form = (data) => new URLSearchParams(data).toString();
const periodEnd = (subscription) => Number(subscription.current_period_end
  || subscription.items.data[0]?.current_period_end || 0);
const json = (data, status = 200) => Response.json(data, { status });

export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    // Stripe requires the exact bytes it sent. The Web Request API exposes them
    // before Vercel applies any JSON body helper or normalization.
    const raw = await request.text();
    if (!validSignature(raw, request.headers.get('stripe-signature'))) {
      return new Response('Invalid signature', { status: 400 });
    }

    const event = JSON.parse(raw);
    if (event.type !== 'checkout.session.completed') return json({ received: true });
    const checkout = event.data.object;
    if (checkout.metadata?.flow !== 'champvision_bundle_upgrade' || !checkout.subscription) {
      return json({ received: true });
    }

    try {
      const bundle = await stripe(`subscriptions/${checkout.subscription}`);
      if (bundle.metadata.upgrade_finalized === 'true') return json({ received: true });

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
      return json({ received: true });
    } catch (error) {
      console.error('stripe-webhook', error.message);
      return new Response('Webhook processing failed', { status: 500 });
    }
  }
};
