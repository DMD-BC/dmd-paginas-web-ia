// POST /api/mp/subscribe — Crea la suscripción mensual en Mercado Pago.
// Requiere sesión (la suscripción se liga a la cuenta del usuario).
// Body: { plan: "pro" | "pyme" | "elite" }.
// Devuelve { init_point, preapproval_id }: el frontend redirige al cliente
// a init_point para autorizar el cobro recurrente en Mercado Pago.
// Si el usuario ya tiene una suscripción autorizada, responde 409.
// Si ya hay una pendiente del mismo plan, devuelve su mismo init_point.
const { getSessionUser, readBody, clientIp, noDb } = require('../_auth');
const { rateLimited } = require('../_ratelimit');
const { hasDb, query } = require('../_db');
const { PLANS, SITE, mpConfigured, mpCall } = require('../_mp');

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
    return res.status(401).json({ error: 'Inicia sesión o regístrate para suscribirte a un plan.' });
  }
  let body = {};
  try { body = await readBody(req); } catch (e) { body = {}; }
  const plan = body && body.plan;
  if (!PLANS[plan]) {
    return res.status(400).json({ error: 'Plan no válido. Elige Pro, PyME o Élite.' });
  }
  if (await rateLimited('mp-subscribe', clientIp(req), 10, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  }
  if (!mpConfigured()) {
    return res.status(503).json({ error: 'Los pagos aún no están configurados. Inténtalo más tarde.' });
  }
  try {
    const existing = await query(
      "SELECT id, plan, status, init_point FROM subscriptions WHERE user_id = $1 AND status IN ('pending','authorized') ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    const row = existing.rows[0];
    if (row && row.status === 'authorized') {
      return res.status(409).json({ error: 'Ya tienes una suscripción activa (' + (PLANS[row.plan] ? PLANS[row.plan].name : row.plan) + '). Cancélala primero si quieres cambiar de plan.' });
    }
    if (row && row.status === 'pending' && row.plan === plan && row.init_point) {
      return res.status(200).json({ init_point: row.init_point, preapproval_id: row.id, plan });
    }
    const cfg = PLANS[plan];
    const pre = await mpCall('POST', '/preapproval', {
      payer_email: user.email,
      reason: cfg.name,
      external_reference: user.id + ':' + plan,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: cfg.amount,
        currency_id: 'MXN',
      },
      back_url: SITE + '/app.html?sub=ok',
      notification_url: SITE + '/api/mp/webhook',
      status: 'pending',
    });
    if (!pre || !pre.id || !pre.init_point) {
      console.error('mp subscribe: respuesta inesperada de MP');
      return res.status(502).json({ error: 'Mercado Pago no pudo crear la suscripción. Inténtalo de nuevo.' });
    }
    await query(
      'INSERT INTO subscriptions (id, user_id, plan, status, payer_email, init_point) VALUES ($1,$2,$3,$4,$5,$6) ' +
      'ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, init_point = EXCLUDED.init_point, updated_at = NOW()',
      [pre.id, user.id, plan, 'pending', user.email, pre.init_point]
    );
    return res.status(200).json({ init_point: pre.init_point, preapproval_id: pre.id, plan });
  } catch (e) {
    console.error('mp subscribe error:', e.code || '', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 300) : '');
    return res.status(502).json({ error: 'Mercado Pago no pudo crear la suscripción. Inténtalo de nuevo.' });
  }
};
