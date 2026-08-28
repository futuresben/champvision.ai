const crypto = require('crypto');

const SITE_ORIGIN = 'https://futuresben.github.io';
const MIGRATED_MNQ_PRICE_IDS = ['price_1U5kacLh2L59TOeGwOkBeUVn'];

function eligibleMnqPriceIds() {
  return new Set([
    process.env.STRIPE_LEGACY_MNQ_PRICE_ID,
    process.env.STRIPE_CURRENT_MNQ_PRICE_ID,
    ...MIGRATED_MNQ_PRICE_IDS,
    ...String(process.env.STRIPE_ADDITIONAL_MNQ_PRICE_IDS || '').split(',').map((id) => id.trim())
  ].filter(Boolean));
}

function setCors(req, res) {
  if (req.headers.origin === SITE_ORIGIN) res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.UPGRADE_TOKEN_SECRET).update(value).digest('base64url');
}

async function stripe(path) {
  const authorization = Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString('base64');
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Basic ${authorization}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error && data.error.message ? data.error.message : 'Stripe request failed');
  return data;
}

async function findCustomersByEmail(email) {
  const exact = await stripe(`customers?email=${encodeURIComponent(email)}&limit=100`);
  if (exact.data.length) return exact.data;

  let startingAfter = '';
  for (let page = 0; page < 10; page += 1) {
    const suffix = startingAfter ? `&starting_after=${encodeURIComponent(startingAfter)}` : '';
    const customers = await stripe(`customers?limit=100${suffix}`);
    const matches = customers.data.filter((customer) => String(customer.email || '').trim().toLowerCase() === email);
    if (matches.length || !customers.has_more || !customers.data.length) return matches;
    startingAfter = customers.data[customers.data.length - 1].id;
  }
  return [];
}

async function isEligibleMnqItem(item, eligiblePrices) {
  const price = item.price || {};
  if (eligiblePrices.has(price.id)) return true;
  if (price.id === process.env.STRIPE_BUNDLE_PRICE_ID || price.id === process.env.STRIPE_MGC_PRICE_ID) return false;

  const productId = typeof price.product === 'string' ? price.product : price.product && price.product.id;
  if (!productId) return false;
  if (productId === process.env.STRIPE_MNQ_PRODUCT_ID) return true;
  const product = typeof price.product === 'object' ? price.product : await stripe(`products/${encodeURIComponent(productId)}`);
  const label = `${product.name || ''} ${product.description || ''}`;
  return /\bMNQ\b/i.test(label) && !/\bbundle\b/i.test(label);
}

async function findEligibleSubscription(email) {
  const eligiblePrices = eligibleMnqPriceIds();
  const customers = await findCustomersByEmail(email);
  for (const customer of customers) {
    const subscriptions = await stripe(`subscriptions?customer=${customer.id}&status=all&limit=100`);
    for (const subscription of subscriptions.data) {
      if (!['active', 'trialing'].includes(subscription.status)) continue;
      const matches = await Promise.all(subscription.items.data.map((item) => isEligibleMnqItem(item, eligiblePrices)));
      if (matches.some(Boolean)) {
        return { customerId: customer.id, subscriptionId: subscription.id };
      }
    }
  }
  return null;
}

async function findManageableSubscription(email) {
  const customers = await stripe(`customers?email=${encodeURIComponent(email)}&limit=10`);
  for (const customer of customers.data) {
    const subscriptions = await stripe(`subscriptions?customer=${customer.id}&status=all&limit=100`);
    const active = subscriptions.data.filter((item) => item.status === 'active');
    const hasMnqCredit = Number(customer.metadata.champvision_mnq_credit_seconds || 0) > 0;
    const hasPrice = (item, price) => item.items.data.some((line) => line.price.id === price);
    const subscription = active.find((item) => hasPrice(item, process.env.STRIPE_BUNDLE_PRICE_ID)) ||
      (hasMnqCredit && active.find((item) => (
        hasPrice(item, process.env.STRIPE_CURRENT_MNQ_PRICE_ID) || hasPrice(item, process.env.STRIPE_MGC_PRICE_ID)
      )));
    if (subscription) return { customerId: customer.id, subscriptionId: subscription.id };
  }
  return null;
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const intent = req.body && req.body.intent === 'manage' ? 'manage' : 'upgrade';
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });

  try {
    const membership = intent === 'manage'
      ? await findManageableSubscription(email)
      : await findEligibleSubscription(email);
    if (!membership) {
      return res.status(400).json({
        error: intent === 'manage'
          ? 'Zu dieser E-Mail-Adresse wurde kein verwaltbares Bundle-Abo gefunden.'
          : 'Zu dieser E-Mail-Adresse wurde kein aktives MNQ-Abo gefunden.'
      });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const payload = Buffer.from(JSON.stringify({ ...membership, intent, code, exp: Date.now() + 10 * 60 * 1000 })).toString('base64url');
    const challenge = `${payload}.${sign(payload)}`;
    const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: process.env.BREVO_SENDER_NAME || 'Champvision Support', email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email }],
        subject: intent === 'manage' ? 'Dein Code für die Abo-Verwaltung' : 'Dein Code für das Bundle-Upgrade',
        htmlContent: `<p>Dein Bestätigungscode für ${intent === 'manage' ? 'die ChampVision Abo-Verwaltung' : 'das ChampVision Bundle-Upgrade'} lautet:</p><p style="font-size:28px;font-weight:bold;letter-spacing:5px">${code}</p><p>Der Code ist 10 Minuten gültig.</p>`
      })
    });
    if (!emailResponse.ok) throw new Error('Email request failed');
    return res.status(200).json({ ok: true, challenge });
  } catch (error) {
    console.error('request-upgrade-code', error.message);
    return res.status(500).json({ error: 'Der Code konnte gerade nicht gesendet werden. Bitte versuche es erneut.' });
  }
};
