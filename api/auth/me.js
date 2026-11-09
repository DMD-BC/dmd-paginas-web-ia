// GET /api/auth/me — ¿Quién está en sesión y cuánta cuota le queda?
// Con sesión: { db:true, user, quota:{used,limit,promo} }.
// Sin sesión (con DB): { db:true, user:null, quota:{used:<usos anónimos por IP>, limit:3} }.
// Sin DATABASE_URL: { db:false } y el builder usa el modo anónimo local.
const { hasDb, query } = require('../_db');
const { getSessionUser, quotaOf, ipHash } = require('../_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método no permitido, usa GET' });
  }
  if (!hasDb()) return res.status(200).json({ db: false, user: null, quota: { used: 0, limit: 3, promo: false } });
  try {
    const user = await getSessionUser(req);
    if (user) {
      return res.status(200).json({
        db: true,
        user: { id: user.id, name: user.name, email: user.email },
        quota: quotaOf(user)
      });
    }
    const anon = await query('SELECT count FROM anon_usage WHERE ip_hash = $1', [ipHash(req)]);
    const used = (anon.rows[0] && anon.rows[0].count) || 0;
    return res.status(200).json({ db: true, user: null, quota: { used, limit: 3, promo: false } });
  } catch (e) {
    if (e.code === 'NO_DB') return res.status(200).json({ db: false, user: null, quota: { used: 0, limit: 3, promo: false } });
    console.error('me error:', e.message);
    return res.status(500).json({ error: 'No se pudo leer la sesión.' });
  }
};
