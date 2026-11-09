// POST /api/auth/promo — Código promocional (Axel lo comparte en privado).
// Requiere sesión. Pone users.promo = TRUE: el límite sube a 50.
// Sin DATABASE_URL -> 503 db:false.
const { hasDb, query } = require('../_db');
const { getSessionUser, readBody, quotaOf, noDb } = require('../_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }
  if (!hasDb()) return noDb(res);
  const body = readBody(req);
  const code = String(body.code || '').replace(/\s+/g, '').toUpperCase();
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Primero regístrate o inicia sesión para usar el código.' });
    if (code !== 'DMDMX') {
      return res.status(400).json({ error: 'Ese código no es válido. Revisa el código e inténtalo de nuevo.' });
    }
    const updated = await query(
      'UPDATE users SET promo = TRUE WHERE id = $1 RETURNING id, name, email, promo, used_count',
      [user.id]
    );
    const u = updated.rows[0];
    return res.status(200).json({ ok: true, db: true, quota: quotaOf(u), already: !!user.promo });
  } catch (e) {
    if (e.code === 'NO_DB') return noDb(res);
    console.error('promo error:', e.message);
    return res.status(500).json({ error: 'No se pudo aplicar el código.' });
  }
};
