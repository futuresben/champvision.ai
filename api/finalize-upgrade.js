const SITE_URL = 'https://futuresben.github.io/champvision.ai/';

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

function form(data) { return new URLSearchParams(data).toString(); }
function periodEnd(subscription) {
  return Number(subscription.current_period_end || (subscription.items.data[0] && subscription.items.data[0].current_period_end) || 0);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
  const sessionId = String(req.query && req.query.session_id || '');
  if (!sessionId.startsWith('cs_')) return res.redirect(`${SITE_URL}?bundle_upgrade=error`);

  try {
    const checkout = await stripe(`checkout/sessions/${encodeURIComponent(sessionId)}`);
    const paid = checkout.status === 'complete' && ['paid', 'no_payment_required'].includes(checkout.payment_status);
    if (!paid || checkout.mode !== 'subscription' || checkout.metadata?.flow !== 'champvision_bundle_upgrade'
      || !checkout.subscription || !checkout.customer) {
      return res.redirect(`${SITE_URL}?bundle_upgrade=error`);
    }

    const bundleId = typeof checkout.subscription === 'string' ? checkout.subscription : checkout.subscription.id;
    const bundle = await stripe(`subscriptions/${bundleId}`);
    if (bundle.metadata.upgrade_finalized === 'true') return res.redirect(`${SITE_URL}?bundle_upgrade=success`);

    const source = await stripe(`subscriptions/${checkout.metadata.source_subscription_id}`);
    const creditSeconds = Math.max(0, periodEnd(source) - Math.floor(Date.now() / 1000));
    await stripe(`customers/${checkout.customer}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        'metadata[champvision_mnq_credit_seconds]': String(creditSeconds),
        'metadata[champvision_mnq_credit_source]': source.id
      })
    });
    if (source.status !== 'canceled') await stripe(`subscriptions/${source.id}`, { method: 'DELETE' });
    await stripe(`subscriptions/${bundle.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        'metadata[upgrade_finalized]': 'true',
        'metadata[mnq_credit_seconds]': String(creditSeconds)
      })
    });
    return res.redirect(`${SITE_URL}?bundle_upgrade=success`);
  } catch (error) {
    console.error('finalize-upgrade', error.message);
    return res.redirect(`${SITE_URL}?bundle_upgrade=error`);
  }
};
