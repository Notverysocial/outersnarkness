// Vercel serverless function: list all retreat submissions.
// Requires header: Authorization: Bearer <ADMIN_TOKEN>
// Optional ?download=1 returns CSV with all fields flattened.

import { list } from '@vercel/blob';

function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

function csvCell(v) {
  if (v == null) return '';
  if (Array.isArray(v)) v = v.join('; ');
  if (typeof v === 'object') v = JSON.stringify(v);
  v = String(v);
  if (/[",\n\r]/.test(v)) {
    v = '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

export default async function handler(req, res) {
  const expected = process.env.ADMIN_TOKEN || '';
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : '';

  if (!expected || !constantTimeEq(token, expected)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  let blobs = [];
  try {
    let cursor;
    do {
      const page = await list({ prefix: 'submissions/', cursor, limit: 1000 });
      blobs = blobs.concat(page.blobs || []);
      cursor = page.cursor;
    } while (cursor);
  } catch (err) {
    console.error('blob_list_failed', err);
    res.status(500).json({ ok: false, error: 'list_failed' });
    return;
  }

  // Sort newest first by uploadedAt.
  blobs.sort((a, b) => {
    const at = new Date(a.uploadedAt || 0).getTime();
    const bt = new Date(b.uploadedAt || 0).getTime();
    return bt - at;
  });

  const wantDownload = String(req.query?.download || '') === '1';

  if (!wantDownload) {
    const submissions = blobs.map((b) => {
      const pathname = b.pathname || '';
      const idMatch = pathname.match(/submissions\/(.+)\.json$/);
      return {
        id: idMatch ? idMatch[1] : pathname,
        submitted_at: b.uploadedAt,
        size: b.size,
        downloadUrl: b.url,
      };
    });
    res.status(200).json({ ok: true, count: submissions.length, submissions });
    return;
  }

  // CSV download: fetch every blob and flatten.
  const columns = [
    'id', 'submitted_at', 'firstName', 'email', 'interest', 'travel',
    'location', 'length', 'price', 'lodging', 'activities',
    'activities_other', 'worth', 'concerns', 'extras', 'likelihood',
    'user_agent', 'ip',
  ];

  const rows = [];
  for (const b of blobs) {
    try {
      const r = await fetch(b.url);
      if (!r.ok) continue;
      const data = await r.json();
      rows.push(columns.map((c) => csvCell(data[c])).join(','));
    } catch (err) {
      // skip unreadable blob
    }
  }

  const csv = [columns.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="outersnarkness-submissions.csv"'
  );
  res.status(200).send(csv);
}
