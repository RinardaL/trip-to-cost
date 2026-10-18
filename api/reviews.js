/* Shared reviews API (Vercel serverless function, no dependencies).
 *
 * Storage: an Upstash Redis database reached over its REST API. Add one from the Vercel dashboard
 * (Project > Storage > Create Database > Upstash for Redis) and connect it to this project; Vercel then
 * sets KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
 * Until a database is connected the endpoint answers { configured: false } and the site keeps working in
 * its old "reviews stay on this device" mode.
 *
 *   GET    /api/reviews                 -> { configured, reviews: [...] }  newest first, max 50
 *   POST   /api/reviews                 -> { id, createdAt, editKey }       create a review
 *   PUT    /api/reviews?id=ID           -> { ok: true }                      edit text/rating (needs the editKey)
 *   DELETE /api/reviews?id=ID           -> { ok: true }                      moderation (needs x-admin-token)
 *
 * Optional env var REVIEWS_ADMIN_TOKEN enables DELETE.
 */
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_TOKEN = process.env.REVIEWS_ADMIN_TOKEN;

const INDEX_KEY = 'tripToCost:reviews:index';
const MAX_LIST = 50;
const MAX_STORED = 500;
const POSTS_PER_HOUR = 5;
const LIMITS = { author: 60, trip: 80, text: 1000 };

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `redis ${r.status}`);
  return data.result;
}

const reviewKey = (id) => `tripToCost:review:${id}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

function publicView(r) {
  return { id: r.id, author: r.author, trip: r.trip || '', text: r.text, rating: r.rating, createdAt: r.createdAt, editedAt: r.editedAt || null };
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 20000) return {}; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return {}; }
}

function looksLikeSpam(text) {
  const links = (text.match(/https?:\/\/|www\./gi) || []).length;
  return links > 1 || /(.)\1{14,}/.test(text);
}

module.exports = async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) {
    if (req.method === 'GET') return send(res, 200, { configured: false, reviews: [] });
    return send(res, 503, { error: 'reviews_unconfigured' });
  }

  try {
    if (req.method === 'GET') {
      const ids = await redis(['ZREVRANGE', INDEX_KEY, '0', String(MAX_LIST - 1)]);
      let reviews = [];
      if (ids && ids.length) {
        const rows = await redis(['MGET', ...ids.map(reviewKey)]);
        reviews = rows.filter(Boolean).map((row) => { try { return publicView(JSON.parse(row)); } catch (e) { return null; } }).filter(Boolean);
      }
      return send(res, 200, { configured: true, reviews }, 'public, s-maxage=15, stale-while-revalidate=60');
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.website) return send(res, 201, { id: 'ok', createdAt: Date.now(), editKey: 'x' }); // honeypot: pretend success
      const author = clean(body.author, LIMITS.author);
      const trip = clean(body.trip, LIMITS.trip);
      const text = cleanText(body.text, LIMITS.text);
      const rating = Math.round(Number(body.rating));
      if (!author || text.length < 3 || !(rating >= 1 && rating <= 5)) return send(res, 400, { error: 'invalid_review' });
      if (looksLikeSpam(text) || looksLikeSpam(author) || looksLikeSpam(trip)) return send(res, 400, { error: 'rejected' });

      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      const bucket = `tripToCost:rl:${sha256(ip).slice(0, 16)}:${Math.floor(Date.now() / 3600000)}`;
      const count = await redis(['INCR', bucket]);
      if (count === 1) await redis(['EXPIRE', bucket, '3700']);
      if (count > POSTS_PER_HOUR) return send(res, 429, { error: 'rate_limited' });

      const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
      const editKey = crypto.randomBytes(16).toString('hex');
      const createdAt = Date.now();
      const record = { id, author, trip, text, rating, createdAt, keyHash: sha256(editKey) };
      await redis(['SET', reviewKey(id), JSON.stringify(record)]);
      await redis(['ZADD', INDEX_KEY, String(createdAt), id]);
      const total = await redis(['ZCARD', INDEX_KEY]);
      if (total > MAX_STORED) {
        const old = await redis(['ZRANGE', INDEX_KEY, '0', String(total - MAX_STORED - 1)]);
        if (old && old.length) {
          await redis(['ZREM', INDEX_KEY, ...old]);
          await redis(['DEL', ...old.map(reviewKey)]);
        }
      }
      return send(res, 201, { id, createdAt, editKey });
    }

    const id = String((req.query && req.query.id) || new URL(req.url, 'http://x').searchParams.get('id') || '');
    if (!/^[a-z0-9]{6,40}$/.test(id)) return send(res, 400, { error: 'invalid_id' });

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const raw = await redis(['GET', reviewKey(id)]);
      if (!raw) return send(res, 404, { error: 'not_found' });
      const record = JSON.parse(raw);
      const given = Buffer.from(sha256(String(body.editKey || '')), 'hex');
      const want = Buffer.from(record.keyHash, 'hex');
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 403, { error: 'forbidden' });
      const text = cleanText(body.text, LIMITS.text);
      const rating = Math.round(Number(body.rating));
      if (text.length < 3 || !(rating >= 1 && rating <= 5) || looksLikeSpam(text)) return send(res, 400, { error: 'invalid_review' });
      record.text = text;
      record.rating = rating;
      record.editedAt = Date.now();
      await redis(['SET', reviewKey(id), JSON.stringify(record)]);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) return send(res, 401, { error: 'unauthorized' });
      await redis(['DEL', reviewKey(id)]);
      await redis(['ZREM', INDEX_KEY, id]);
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return send(res, 405, { error: 'method_not_allowed' });
  } catch (e) {
    return send(res, 500, { error: 'server_error' });
  }
};
