const crypto = require('crypto');

const SITE_ORIGIN = 'https://futuresben.github.io';

function setCors(req, res) {
  if (req.headers.origin === SITE_ORIGIN) res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function signature(value) {
  return crypto.createHmac('sha256', process.env.UPGRADE_TOKEN_SECRET).update(value).digest('base64url');
}

function validChallenge(challenge, code) {
  const [payload, actualSignature] = String(challenge || '').split('.');
  if (!payload || !actualSignature || !process.env.UPGRADE_TOKEN_SECRET) return null;
  const expectedSignature = signature(payload);
  if (actualSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(actualSignature), Buffer.from(expectedSignature))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.intent !== 'manage' || Date.now() > decoded.exp || String(code).trim() !== decoded.code) return null;
    return decoded;
  } catch { return null; }
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

async function scheduleMnqCredit(customerId, startsAt, creditSeconds) {
  if (creditSeconds <= 0) return 0;
  const schedules = await stripe(`subscription_schedules?customer=${customerId}&limit=100`);
  const existing = schedules.data.find((schedule) => (
    schedule.metadata.champvision_mnq_credit === 'true' && schedule.status !== 'canceled' && schedule.status !== 'completed'
  ));
  if (!existing) {
    await stripe('subscription_schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        customer: customerId,
        start_date: String(startsAt),
        end_behavior: 'cancel',
        'phases[0][items][0][price]': process.env.STRIPE_CURRENT_MNQ_PRICE_ID,
        'phases[0][items][0][quantity]': '1',
        'phases[0][end_date]': String(startsAt + creditSeconds),
        'phases[0][trial]': 'true',
        'metadata[champvision_mnq_credit]': 'true',
        'metadata[credit_seconds]': String(creditSeconds)
      })
    });
  }
  await stripe(`customers/${customerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ 'metadata[champvision_mnq_credit_seconds]': '0' })
  });
  return creditSeconds;
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const verified = validChallenge(req.body && req.body.challenge, req.body && req.body.code);
  const choice = String(req.body && req.body.choice || '');
  if (!verified || !['mnq', 'mgc', 'cancel'].includes(choice)) return res.status(400).json({ error: 'Die Anfrage ist ungültig oder abgelaufen.' });

  try {
    const subscription = await stripe(`subscriptions/${verified.subscriptionId}`);
    const isBundle = ['active', 'trialing'].includes(subscription.status) && subscription.items.data.some((item) => item.price.id === process.env.STRIPE_BUNDLE_PRICE_ID);

    if (choice === 'cancel') {
      if (!['active', 'trialing'].includes(subscription.status)) return res.status(400).json({ error: 'Dieses Abo ist nicht mehr aktiv.' });
      await stripe(`subscriptions/${subscription.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ cancel_at_period_end: 'true' })
      });
      // A standalone MNQ subscription has no bundle credit to restore. Avoid
      // a separate customer lookup so a normal cancellation only needs Stripe's
      // subscription update.
      let scheduled = 0;
      if (verified.plan !== 'mnq') {
        const customer = await stripe(`customers/${verified.customerId}`);
        const credit = Number(customer.metadata.champvision_mnq_credit_seconds || 0);
        scheduled = await scheduleMnqCredit(verified.customerId, periodEnd(subscription), credit);
      }
      const days = Math.ceil(scheduled / 86400);
      return res.status(200).json({
        message: days > 0
          ? `Gespeichert: Nach dem bezahlten Zeitraum endet MGC. MNQ bleibt anschließend noch ${days} Tag${days === 1 ? '' : 'e'} aktiv.`
          : 'Gespeichert: Dein Abo endet zum Ende des bereits bezahlten Zeitraums.'
      });
    }

    if (!isBundle) return res.status(400).json({ error: 'Ein Wechsel zwischen Einzelbots ist hier derzeit nicht erforderlich.' });
    const price = choice === 'mnq' ? process.env.STRIPE_CURRENT_MNQ_PRICE_ID : process.env.STRIPE_MGC_PRICE_ID;
    if (!price) throw new Error('Missing single-bot price');
    const subscriptions = await stripe(`subscriptions?customer=${verified.customerId}&status=all&limit=100`);
    const pending = subscriptions.data.find((item) => item.status === 'trialing' && item.metadata.champvision_pending_change_source === subscription.id);
    if (pending) {
      await stripe(`subscriptions/${pending.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ 'items[0][id]': pending.items.data[0].id, 'items[0][price]': price, proration_behavior: 'none' })
      });
    } else {
      await stripe('subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({
          customer: verified.customerId,
          'items[0][price]': price,
          trial_end: String(periodEnd(subscription)),
          'trial_settings[end_behavior][missing_payment_method]': 'cancel',
          'metadata[champvision_pending_change_source]': subscription.id
        })
      });
    }
    await stripe(`subscriptions/${subscription.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ cancel_at_period_end: 'true' })
    });
    return res.status(200).json({ message: `Gespeichert: Zum Ende des bezahlten Bundle-Monats läuft nur ${choice === 'mnq' ? 'MNQ' : 'MGC'} für 250 € monatlich weiter.` });
  } catch (error) {
    console.error('manage-subscription', error.message);
    return res.status(500).json({ error: 'Die Änderung konnte gerade nicht gespeichert werden. Bitte versuche es erneut.' });
  }
};
