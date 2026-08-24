const crypto = require('crypto');

const SITE_ORIGIN = 'https://futuresben.github.io';
const RETURN_URL = 'https://futuresben.github.io/champvision.ai/';

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

  try {
    const subscription = await stripe(`subscriptions/${verified.subscriptionId}`);
    const priceIds = subscription.items.data.map((item) => item.price.id);
    const configuration = priceIds.includes(process.env.STRIPE_LEGACY_MNQ_PRICE_ID)
      ? process.env.STRIPE_LEGACY_PORTAL_CONFIGURATION
      : priceIds.includes(process.env.STRIPE_CURRENT_MNQ_PRICE_ID)
        ? process.env.STRIPE_CURRENT_PORTAL_CONFIGURATION
        : null;
    if (!configuration) return res.status(400).json({ error: 'Für dieses Abo ist kein Bundle-Upgrade verfügbar.' });

    const form = new URLSearchParams({ customer: verified.customerId, configuration, return_url: RETURN_URL });
    const session = await stripe('billing_portal/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('verify-upgrade-code', error.message);
    return res.status(500).json({ error: 'Stripe konnte das Upgrade gerade nicht vorbereiten. Bitte versuche es erneut.' });
  }
};
