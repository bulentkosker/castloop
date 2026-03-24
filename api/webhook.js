const crypto = require('crypto');

const SUPABASE_URL = 'https://pdttjblnvxoitskhdtro.supabase.co';

const PRICE_TO_PLAN = {
  pri_01kkq2qhxdmqreg93wfa90cqqr: 'lite',
  pri_01kkq68n48m06g366npzg7fk01: 'lite',
  pri_01kkq6k6kr5xmza70p6n574378: 'basic',
  pri_01kkq6n0p98rx63q3dj6qd4c83: 'basic',
  pri_01kkq6tjh7rmq5s19ns35n52d7: 'pro',
  pri_01kkq6vvphytz0xjk2y2vqswv2: 'pro',
  pri_01kkq6y9a729e82r153t4ckakr: 'business',
  pri_01kkq70cs983hs30fqxq5s2sga: 'business',
  pri_01kkq72xsn1hvest90mdw6ag4e: 'enterprise',
  pri_01kkq748ydd7tcdbky4zfsdkda: 'enterprise',
  pri_01kmcxn7vvjz06vhpbjg6zyxyq: '4k_starter',
  pri_01kmcxqe1n6sk6st551z4gjpbw: '4k_starter',
  pri_01kmcxszdwcdk30bpwga1qnyq7: '4k_plus',
  pri_01kmcxvg3t6krm3twh9tp35pjj: '4k_plus',
  pri_01kmcxx4491c5m32tr70ah258x: '4k_pro',
  pri_01kmcxy7vwxqez6jzyqjdfy438: '4k_pro'
};

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload, null, 2));
}

async function getRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;

  if (req.body && typeof req.body === 'object') {
    // Fallback for environments that auto-parse JSON body.
    return JSON.stringify(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsePaddleSignature(signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return null;
  const parts = signatureHeader.split(/[;,]\s*/);
  const map = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  if (!map.ts || !map.h1) return null;
  return { ts: map.ts, h1: map.h1 };
}

function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  const parsed = parsePaddleSignature(signatureHeader);
  if (!parsed) return false;

  const signedPayload = `${parsed.ts}:${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(parsed.h1, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

function extractEventType(payload) {
  return payload?.event_type || payload?.eventType || payload?.type || null;
}

function extractCustomerId(payload) {
  const data = payload?.data || {};
  return data.customer_id || data.customerId || data.customer?.id || null;
}

function extractCustomerEmail(payload) {
  const data = payload?.data || {};
  return (
    data.customer_email ||
    data.customerEmail ||
    data.customer?.email ||
    data.email ||
    null
  );
}

function extractPriceId(payload) {
  const data = payload?.data || {};

  const fromItems = Array.isArray(data.items) ? data.items : [];
  for (const item of fromItems) {
    if (item?.price?.id) return item.price.id;
    if (item?.price_id) return item.price_id;
    if (item?.priceId) return item.priceId;
  }

  const fromLineItems = Array.isArray(data.details?.line_items) ? data.details.line_items : [];
  for (const item of fromLineItems) {
    if (item?.price?.id) return item.price.id;
    if (item?.price_id) return item.price_id;
    if (item?.priceId) return item.priceId;
  }

  return data.price_id || data.priceId || null;
}

function buildSupabaseUrl(table, query) {
  return `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`;
}

async function supabaseRequest(table, { method = 'GET', query = '', body } = {}) {
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseKey) throw new Error('SUPABASE_KEY is not configured');

  const response = await fetch(buildSupabaseUrl(table, query), {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const msg = data?.message || response.statusText || 'Supabase request failed';
    const error = new Error(msg);
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }

  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return json(res, 500, { error: 'PADDLE_WEBHOOK_SECRET is not configured' });
  }

  const rawBody = await getRawBody(req);
  const signatureHeader = req.headers['paddle-signature'];
  const isValid = verifyPaddleSignature(rawBody, signatureHeader, webhookSecret);
  if (!isValid) {
    return json(res, 401, { error: 'Invalid Paddle signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    return json(res, 400, { error: 'Invalid JSON payload' });
  }

  const eventType = extractEventType(payload);
  if (eventType !== 'transaction.completed') {
    return json(res, 200, { ok: true, ignored: true, eventType });
  }

  const customerId = extractCustomerId(payload);
  const customerEmailRaw = extractCustomerEmail(payload);
  const customerEmail = typeof customerEmailRaw === 'string' ? customerEmailRaw.trim().toLowerCase() : null;
  const priceId = extractPriceId(payload);
  const plan = PRICE_TO_PLAN[priceId];

  if (!customerId || !priceId || !plan || !customerEmail) {
    return json(res, 400, {
      error: 'Missing webhook fields or unknown price id',
      customerId: customerId || null,
      customerEmail: customerEmail || null,
      priceId: priceId || null,
      mappedPlan: plan || null
    });
  }

  try {
    const emailFilter = encodeURIComponent(`eq.${customerEmail}`);
    const rows = await supabaseRequest('profiles', {
      method: 'GET',
      query: `select=id,email,plan&email=${emailFilter}&limit=1`
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      return json(res, 404, {
        error: 'Profile not found for customer email',
        customerId,
        customerEmail
      });
    }

    const profileId = rows[0].id;
    const idFilter = encodeURIComponent(`eq.${profileId}`);
    const updated = await supabaseRequest('profiles', {
      method: 'PATCH',
      query: `id=${idFilter}`,
      body: { plan }
    });

    return json(res, 200, {
      ok: true,
      eventType,
      customerId,
      customerEmail,
      priceId,
      plan,
      profileId,
      updatedCount: Array.isArray(updated) ? updated.length : 0
    });
  } catch (error) {
    return json(res, error.status || 500, {
      error: error.message || 'Failed to update profile plan',
      details: error.details || null
    });
  }
};
