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

function productLabel(product) {
  const text = `${product?.name || ''} ${product?.description || ''}`;
  if (/bundle/i.test(text)) return 'ChampVision Bot Bundle';
  if (/\b(?:MGC|Gold)\b/i.test(text)) return 'CV.AI MGC Bot';
  if (/\bMNQ\b/i.test(text)) return 'CV.AI MNQ Bot';
  return product?.name || 'deinem ChampVision Produkt';
}

async function sendPurchaseConfirmation(checkout, event) {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return;
  const subscriptionId = typeof checkout.subscription === 'string' ? checkout.subscription : checkout.subscription?.id;
  if (!subscriptionId) return;

  const subscription = await stripe(`subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (subscription.metadata?.purchase_confirmation_sent === 'true') return;

  const item = subscription.items?.data?.[0];
  const productId = typeof item?.price?.product === 'string'
    ? item.price.product
    : item?.price?.product?.id;
  const product = productId ? await stripe(`products/${encodeURIComponent(productId)}`) : null;
  const productName = productLabel(product);
  const email = checkout.customer_details?.email || checkout.customer_email;
  // Stripe Checkout normally always supplies this. Do not block the actual
  // subscription finalization if an old or manually replayed event lacks it.
  if (!email) return;

  const isUpgrade = checkout.metadata?.flow === 'champvision_bundle_upgrade';
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_SENDER_NAME || 'Champvision Support', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email }],
      subject: 'Dein Kauf bei ChampVision.ai ist bestätigt',
      htmlContent: `<p>Hallo,</p><p>dein Kauf von <strong>${productName}</strong> wurde erfolgreich bestätigt.</p>${isUpgrade ? '<p>Deine verbleibende MNQ-Restlaufzeit wird als persönliches Zeitguthaben gesichert.</p>' : ''}<p><strong>Bitte füge mich auf Discord hinzu: futuresben</strong></p><p>Dort erhältst du die weiteren Informationen zu deinem Bot.</p><p>Viele Grüße<br>Ben von ChampVision.ai</p>`
    })
  });
  if (!response.ok) throw new Error('Purchase confirmation email request failed');

  await stripe(`subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      'metadata[purchase_confirmation_sent]': 'true',
      'metadata[purchase_confirmation_event_id]': event.id || ''
    })
  });
}

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
    const paid = (checkout.status || 'complete') === 'complete'
      && ['paid', 'no_payment_required'].includes(checkout.payment_status || 'paid');
    if (!paid || (checkout.mode && checkout.mode !== 'subscription') || !checkout.subscription) return json({ received: true });

    try {
      // A mail-provider outage must never stop a paid bundle upgrade from
      // preserving the member's remaining MNQ time or cancelling the old plan.
      try {
        await sendPurchaseConfirmation(checkout, event);
      } catch (error) {
        console.error('purchase-confirmation', error.message);
      }
      if (checkout.metadata?.flow !== 'champvision_bundle_upgrade') return json({ received: true });

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
