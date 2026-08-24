const crypto = require('crypto');

const SITE_ORIGIN = 'https://futuresben.github.io';
const SITE_URL = 'https://futuresben.github.io/champvision.ai/';

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
    if (Date.now() > decoded.exp || String(code).trim() !== decoded.code) return null;
    return decoded;
  } catch { return null; }
}

async function stripe(path, options = {}) {
  const authorization = Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString('base64');
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { ...options, headers: { Authorization: `Basic ${authorization}`, ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error && data.error.message ? data.error.message : 'Stripe request failed');
  return data;
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const verified = validChallenge(req.body && req.body.challenge, req.body && req.body.code);
  if (!verified) return res.status(400).json({ error: 'Der Code ist ungültig oder abgelaufen.' });
  if (verified.intent === 'manage') return res.status(200).json({ ok: true, mode: 'manage' });
  if (!process.env.STRIPE_BUNDLE_PRICE_ID) return res.status(500).json({ error: 'Das Bundle-Upgrade ist noch nicht eingerichtet.' });

  try {
    const subscription = await stripe(`subscriptions/${verified.subscriptionId}`);
    const validPrice = subscription.status === 'active' && subscription.items.data.some((item) => (
      item.price.id === process.env.STRIPE_LEGACY_MNQ_PRICE_ID || item.price.id === process.env.STRIPE_CURRENT_MNQ_PRICE_ID
    ));
    if (!validPrice || subscription.cancel_at_period_end) return res.status(400).json({ error: 'Dieses MNQ-Abo kann nicht mehr auf das Bundle umgestellt werden.' });

    const form = new URLSearchParams({
      mode: 'subscription',
      customer: verified.customerId,
      'line_items[0][price]': process.env.STRIPE_BUNDLE_PRICE_ID,
      'line_items[0][quantity]': '1',
      'metadata[source_subscription_id]': verified.subscriptionId,
      'metadata[flow]': 'champvision_bundle_upgrade',
      'subscription_data[metadata][champvision_bundle]': 'true',
      'subscription_data[metadata][source_subscription_id]': verified.subscriptionId,
      success_url: `${SITE_URL}?bundle_upgrade=success`,
      cancel_url: `${SITE_URL}?bundle_upgrade=cancelled`
    });
    const session = await stripe('checkout/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('verify-upgrade-code', error.message);
    return res.status(500).json({ error: 'Stripe konnte das Upgrade gerade nicht vorbereiten. Bitte versuche es erneut.' });
  }
};
