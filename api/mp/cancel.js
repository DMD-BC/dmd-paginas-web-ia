// POST /api/mp/cancel — Cancela la suscripción activa del usuario en
// Mercado Pago (PUT /preapproval/{id} { status: "cancelled" }) y la marca
// cancelada en la DB. El acceso se conserva hasta el final del período
// pagado. En PyME y Élite, cancelar antes de los 12 meses tiene una cuota
// única de liquidación de $350 MXN según los términos aceptados: v1 NO la
// cobra automáticamente, solo la informa y remite a contacto@dmd.mx para
// liquidarla (cobro aparte pendiente de definir).
const { getSessionUser, noDb } = require('../_auth');
const { hasDb, query } = require('../_db');
const { PLANS, mpConfigured, mpCall } = require('../_mp');

const EARLY_FEE_MXN = 350;
const MIN_MONTHS = 12;

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }
  if (!hasDb()) return noDb(res);
  const user = await getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Inicia sesión o regístrate para cancelar tu suscripción.' });
  }
  if (!mpConfigured()) {
    return res.status(503).json({ error: 'Los pagos aún no están configurados. Inténtalo más tarde.' });
  }
  try {
    const r = await query(
      "SELECT id, plan, status, created_at FROM subscriptions WHERE user_id = $1 AND status = 'authorized' ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    const row = r.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'No tienes una suscripción activa para cancelar.' });
    }
    await mpCall('PUT', '/preapproval/' + encodeURIComponent(row.id), { status: 'cancelled' });
    await query(
      "UPDATE subscriptions SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [row.id]
    );
    const months = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    const early = (row.plan === 'pyme' || row.plan === 'elite') && months < MIN_MONTHS;
    return res.status(200).json({
      ok: true,
      plan: row.plan,
      early_fee_mxn: early ? EARLY_FEE_MXN : 0,
      message: early
        ? 'Tu suscripción quedó cancelada y ya no se te cobrará. Como cancelaste antes de los 12 meses, aplica la cuota única de liquidación de $350 MXN según los términos: escríbenos a contacto@dmd.mx para liquidarla.'
        : 'Tu suscripción quedó cancelada y ya no se te cobrará. Conservas el acceso hasta el final de tu período pagado.',
    });
  } catch (e) {
    console.error('mp cancel error:', e.code || '', e.message);
    return res.status(502).json({ error: 'No se pudo cancelar la suscripción en Mercado Pago. Inténtalo de nuevo.' });
  }
};
