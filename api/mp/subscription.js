// GET /api/mp/subscription — Suscripción actual del usuario con sesión.
// Devuelve { plan: null } si no tiene ninguna, o { plan, plan_name, amount,
// status, next_payment_date } con su suscripción más reciente.
const { getSessionUser, noDb } = require('../_auth');
const { hasDb, query } = require('../_db');
const { PLANS } = require('../_mp');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método no permitido, usa GET' });
  }
  if (!hasDb()) return noDb(res);
  const user = await getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Inicia sesión o regístrate para ver tu suscripción.' });
  }
  try {
    const r = await query(
      'SELECT plan, status, next_payment_date, created_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [user.id]
    );
    const row = r.rows[0];
    if (!row) return res.status(200).json({ plan: null });
    const cfg = PLANS[row.plan] || { amount: 0, name: row.plan };
    return res.status(200).json({
      plan: row.plan,
      plan_name: cfg.name,
      amount: cfg.amount,
      status: row.status,
      next_payment_date: row.next_payment_date,
      created_at: row.created_at,
    });
  } catch (e) {
    console.error('mp subscription error:', e.message);
    return res.status(502).json({ error: 'No se pudo consultar tu suscripción. Inténtalo de nuevo.' });
  }
};
