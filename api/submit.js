// Vercel serverless function: persist retreat interest submission to Blob storage.
// Writes one JSON file per submission at submissions/<id>.json.

import { put } from '@vercel/blob';

const MAX_FIELD_LEN = 4000;
const MAX_TOTAL_LEN = 32000;

function clean(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(clean).slice(0, 50);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 50)) {
      out[String(k).slice(0, 100)] = clean(value[k]);
    }
    return out;
  }
  const s = String(value);
  // strip script tags and control characters, cap length
  return s
    .replace(/<\s*\/?\s*script\b[^>]*>/gi, '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .slice(0, MAX_FIELD_LEN);
}

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
}

function makeId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const rand = Math.random().toString(16).slice(2, 8);
  return `${ts}_${rand}`;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return await new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_TOTAL_LEN * 2) {
        reject(new Error('payload_too_large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.status(413).json({ ok: false, error: 'payload_too_large' });
    return;
  }

  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'invalid_json' });
    return;
  }

  // Basic required-field validation.
  // The form treats email as optional, name as optional in the UI, but we
  // require at least one of them so we have something to identify the lead.
  const firstName = clean(body.firstName);
  const email = clean(body.email);
  if (!firstName && !email) {
    res.status(400).json({ ok: false, error: 'name_or_email_required' });
    return;
  }
  if (email && !isValidEmail(email)) {
    res.status(400).json({ ok: false, error: 'invalid_email' });
    return;
  }

  // Build sanitized record.
  const allowedKeys = [
    'firstName', 'email', 'interest', 'travel', 'location', 'length',
    'price', 'lodging', 'activities', 'activities_other', 'worth',
    'concerns', 'extras', 'likelihood',
  ];
  const record = {};
  for (const k of allowedKeys) {
    if (k in body) record[k] = clean(body[k]);
  }

  const id = makeId();
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);

  const payload = {
    id,
    submitted_at: new Date().toISOString(),
    user_agent: ua,
    ip: xff,
    ...record,
  };

  const json = JSON.stringify(payload, null, 2);
  if (json.length > MAX_TOTAL_LEN) {
    res.status(413).json({ ok: false, error: 'payload_too_large' });
    return;
  }

  try {
    await put(`submissions/${id}.json`, json, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
    });
  } catch (err) {
    console.error('blob_put_failed', err);
    res.status(500).json({ ok: false, error: 'storage_failed' });
    return;
  }

  res.status(200).json({ ok: true, id });
}
