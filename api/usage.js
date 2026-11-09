// /api/usage — Cuota del builder, contada EN EL SERVIDOR.
//   GET  -> { db, user, quota:{used,limit,promo,remaining} }
//   POST { action:'consume' } -> cobra 1 cambio si queda cupo.
//     Con sesión: users.used_count, límite 25 (50 con promo DMDMX).
//     Sin sesión: anon_usage por hash de IP, límite 3 en total.
//     Si no queda cupo -> 429 { ok:false, error, used, limit }.
//     Sin DATABASE_URL -> 503 { db:false } y el cliente usa su
//     contador local anónimo (3) hasta que se conecte la DB.
const { hasDb, query } = require('./_db');
const { getSessionUser, quotaOf, ipHash, readBody, noDb } = require('./_auth');

function remainingOf(q) {
  return { used: q.used, limit: q.limit, promo: q.promo, remaining: Math.max(0, q.limit - q.used) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!hasDb()) {
    if (req.method === 'GET') {
      return res.status(200).json({ db: false, user: null, quota: { used: 0, limit: 3, promo: false, remaining: 3 } });
    }
    return noDb(res);
  }
  try {
    const user = await getSessionUser(req);
    if (req.method === 'GET') {
      if (user) {
        return res.status(200).json({
          db: true, user: { id: user.id, name: user.name, email: user.email },
          quota: remainingOf(quotaOf(user))
        });
      }
      const anon = await query('SELECT count FROM anon_usage WHERE ip_hash = $1', [ipHash(req)]);
      const used = (anon.rows[0] && anon.rows[0].count) || 0;
      return res.status(200).json({ db: true, user: null, quota: { used, limit: 3, promo: false, remaining: Math.max(0, 3 - used) } });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Método no permitido' });
    }
    const body = readBody(req);
    if (body.action !== 'consume') {
      return res.status(400).json({ error: 'action debe ser "consume"' });
    }
    if (user) {
      const q = quotaOf(user);
      if (q.used >= q.limit) {
        return res.status(429).json({ ok: false, db: true, error: 'Ya usaste tus ' + q.limit + ' cambios.', quota: remainingOf(q) });
      }
      const updated = await query(
        'UPDATE users SET used_count = used_count + 1 WHERE id = $1 RETURNING promo, used_count',
        [user.id]
      );
      const u = updated.rows[0];
      const quota = remainingOf(quotaOf({ promo: u.promo, used_count: u.used_count }));
      return res.status(200).json({ ok: true, db: true, quota });
    }
    // Anónimo por IP (hash, nunca la IP en claro en la tabla).
    const hash = ipHash(req);
    const anon = await query('SELECT count FROM anon_usage WHERE ip_hash = $1', [hash]);
    const used = (anon.rows[0] && anon.rows[0].count) || 0;
    if (used >= 3) {
      return res.status(429).json({ ok: false, db: true, error: 'Ya usaste tus 3 cambios gratis. Regístrate para tener 25.', quota: { used, limit: 3, promo: false, remaining: 0 } });
    }
    const up = await query(
      'INSERT INTO anon_usage (ip_hash, count) VALUES ($1, 1) ' +
      'ON CONFLICT (ip_hash) DO UPDATE SET count = anon_usage.count + 1, updated_at = NOW() RETURNING count',
      [hash]
    );
    const n = up.rows[0].count;
    return res.status(200).json({ ok: true, db: true, quota: { used: n, limit: 3, promo: false, remaining: Math.max(0, 3 - n) } });
  } catch (e) {
    if (e.code === 'NO_DB') return noDb(res);
    console.error('usage error:', e.message);
    return res.status(500).json({ error: 'No se pudo leer la cuota.' });
  }
};
