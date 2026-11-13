// api/_ratelimit.js — Límite de peticiones COMPARTIDO entre instancias
// serverless (guardado en Postgres). Si no hay DB o falla, cae a un Map
// en memoria (mejor que nada) y nunca bloquea el servicio por un error.
const crypto = require('crypto');
const { hasDb, query } = require('./_db');

const mem = new Map();

function memLimited(bucket, key, max, windowMs) {
  const now = Date.now();
  const k = bucket + ':' + key;
  if (mem.size > 1000) {
    for (const [mk, v] of mem) if (now - v.t > windowMs) mem.delete(mk);
  }
  const cur = mem.get(k);
  if (!cur || now - cur.t > windowMs) { mem.set(k, { n: 1, t: now }); return false; }
  cur.n++;
  return cur.n > max;
}

// true = bloqueado (superó `max` peticiones dentro de `windowMs`).
async function rateLimited(bucket, ip, max, windowMs) {
  const key = crypto.createHash('sha256').update(String(ip)).digest('hex');
  if (!hasDb()) return memLimited(bucket, key, max, windowMs);
  try {
    const r = await query(
      `INSERT INTO rate_limits (bucket, key, window_start, count)
       VALUES ($1, $2, NOW(), 1)
       ON CONFLICT (bucket, key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start < NOW() - ($3::int * INTERVAL '1 millisecond')
                      THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start < NOW() - ($3::int * INTERVAL '1 millisecond')
                      THEN NOW() ELSE rate_limits.window_start END
       RETURNING count`,
      [bucket, key, windowMs]
    );
    return r.rows[0].count > max;
  } catch (e) {
    console.error('ratelimit error:', e.message);
    return memLimited(bucket, key, max, windowMs);
  }
}

module.exports = { rateLimited };
