// /api/mp — Único endpoint de suscripciones con Mercado Pago (Vercel Hobby
// permite 12 funciones serverless por despliegue; las 4 rutas de MP viven
// aquí en una sola función). Las rutas limpias llegan por el rewrite de
// vercel.json: /api/mp/subscribe, /api/mp/webhook, /api/mp/subscription y
// /api/mp/cancel se reescriben a /api/mp?action=<ruta>.
// Flujo: subscribe crea una suscripción "pending" y devuelve init_point; el
// cliente autoriza el cobro recurrente en Mercado Pago; el webhook la marca
// autorizada. DMD no toca ni ve datos de tarjetas.
const { getSessionUser, readBody, clientIp, noDb } = require('./_auth');
const { rateLimited } = require('./_ratelimit');
const { hasDb, query } = require('./_db');
const { PLANS, SITE, mpConfigured, mpCall } = require('./_mp');

const EARLY_FEE_MXN = 350;
const MIN_MONTHS = 12;

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

// CORS: www.dmdmx.dev llama a /api/mp/subscribe cross-origin con la cookie
// de sesión (Domain=.dmdmx.dev). Sin estos headers el navegador bloquea la
// respuesta y el checkout no arranca. Mismo patrón que api/auth/otp.js
// (login) y api/projects.js (crear): se refleja el origen solo si es
// dmdmx.dev y se permiten credenciales. Los headers van en TODAS las
// respuestas (también 401/409/429) para que el cliente pueda leerlas.
function cors(req, res) {
  const origin = (req.headers && req.headers.origin) || '';
  if (/^https:\/\/([a-z0-9-]+\.)*dmdmx\.dev$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// POST /api/mp/subscribe — Crea la suscripción mensual en Mercado Pago.
// Requiere sesión. Body: { plan: "pro" | "pyme" | "elite" }.
// Devuelve { init_point, preapproval_id }.
async function subscribe(req, res) {
  if (!hasDb()) return noDb(res);
  const user = await getSessionUser(req);
  if (!user) {
    return json(res, 401, { error: 'Inicia sesión o regístrate para suscribirte a un plan.' });
  }
  let body = {};
  try { body = await readBody(req); } catch (e) { body = {}; }
  const plan = body && body.plan;
  if (!PLANS[plan]) {
    return json(res, 400, { error: 'Plan no válido. Elige Pro, PyME o Élite.' });
  }
  if (await rateLimited('mp-subscribe', clientIp(req), 10, 10 * 60 * 1000)) {
    return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  }
  if (!mpConfigured()) {
    return json(res, 503, { error: 'Los pagos aún no están configurados. Inténtalo más tarde.' });
  }
  try {
    const existing = await query(
      "SELECT id, plan, status, init_point FROM subscriptions WHERE user_id = $1 AND status IN ('pending','authorized') ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    const row = existing.rows[0];
    if (row && row.status === 'authorized') {
      return json(res, 409, { error: 'Ya tienes una suscripción activa (' + (PLANS[row.plan] ? PLANS[row.plan].name : row.plan) + '). Cancélala primero si quieres cambiar de plan.' });
    }
    if (row && row.status === 'pending' && row.plan === plan && row.init_point) {
      return json(res, 200, { init_point: row.init_point, preapproval_id: row.id, plan });
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
      return json(res, 502, { error: 'Mercado Pago no pudo crear la suscripción. Inténtalo de nuevo.' });
    }
    await query(
      'INSERT INTO subscriptions (id, user_id, plan, status, payer_email, init_point) VALUES ($1,$2,$3,$4,$5,$6) ' +
      'ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, init_point = EXCLUDED.init_point, updated_at = NOW()',
      [pre.id, user.id, plan, 'pending', user.email, pre.init_point]
    );
    return json(res, 200, { init_point: pre.init_point, preapproval_id: pre.id, plan });
  } catch (e) {
    console.error('mp subscribe error:', e.code || '', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 300) : '');
    return json(res, 502, { error: 'Mercado Pago no pudo crear la suscripción. Inténtalo de nuevo.' });
  }
}

// POST /api/mp/webhook — Avisos de Mercado Pago sobre suscripciones.
// MP avisa con { type: "preapproval", data: { id } } (o con ?topic= e ?id=
// en la URL en el formato antiguo). Nunca se confía en el aviso tal cual:
// se consulta la suscripción a MP (GET /preapproval/{id}) y solo entonces
// se actualiza la fila local. Los avisos de pagos mensuales (type
// "payment") se confirman con 200 sin acción.
async function webhook(req, res) {
  if (req.method === 'GET') return json(res, 200, { ok: true });
  let body = {};
  try { body = await readBody(req); } catch (e) { body = {}; }
  if (!body || typeof body !== 'object') body = {};
  const q = req.query || {};
  const type = body.type || body.topic || q.topic || '';
  const preId = (body.data && body.data.id) || body.id || q.id || '';
  if (type === 'payment') return json(res, 200, { ok: true });
  if (!preId) return json(res, 200, { ok: true });
  if (!mpConfigured()) return json(res, 503, { error: 'MP no configurado' });
  if (!hasDb()) return json(res, 503, { error: 'DB no configurada' });
  try {
    const pre = await mpCall('GET', '/preapproval/' + encodeURIComponent(String(preId)));
    const status = pre && pre.status;
    if (status === 'authorized' || status === 'cancelled' || status === 'paused') {
      await query(
        'UPDATE subscriptions SET status = $1, next_payment_date = $2, updated_at = NOW() WHERE id = $3',
        [status, (pre.auto_recurring && pre.auto_recurring.next_payment_date) || (pre.next_payment_date) || null, String(preId)]
      );
    }
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('mp webhook error:', e.code || '', e.message);
    return json(res, 503, { error: 'No se pudo verificar el aviso, MP lo reintentará' });
  }
}

// GET /api/mp/subscription — Suscripción actual del usuario con sesión.
// Devuelve { plan: null } si no tiene ninguna.
async function subscription(req, res) {
  if (!hasDb()) return noDb(res);
  const user = await getSessionUser(req);
  if (!user) {
    return json(res, 401, { error: 'Inicia sesión o regístrate para ver tu suscripción.' });
  }
  try {
    const r = await query(
      'SELECT plan, status, next_payment_date, created_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [user.id]
    );
    const row = r.rows[0];
    if (!row) return json(res, 200, { plan: null });
    const cfg = PLANS[row.plan] || { amount: 0, name: row.plan };
    return json(res, 200, {
      plan: row.plan,
      plan_name: cfg.name,
      amount: cfg.amount,
      status: row.status,
      next_payment_date: row.next_payment_date,
      created_at: row.created_at,
    });
  } catch (e) {
    console.error('mp subscription error:', e.message);
    return json(res, 502, { error: 'No se pudo consultar tu suscripción. Inténtalo de nuevo.' });
  }
}

// POST /api/mp/cancel — Cancela la suscripción activa del usuario en
// Mercado Pago y la marca cancelada en la DB. El acceso se conserva hasta
// el final del período pagado. En PyME y Élite, cancelar antes de los 12
// meses tiene una cuota única de liquidación de $350 MXN según los
// términos: v1 NO la cobra automáticamente, solo la informa y remite a
// contacto@dmd.mx para liquidarla.
async function cancel(req, res) {
  if (!hasDb()) return noDb(res);
  const user = await getSessionUser(req);
  if (!user) {
    return json(res, 401, { error: 'Inicia sesión o regístrate para cancelar tu suscripción.' });
  }
  if (!mpConfigured()) {
    return json(res, 503, { error: 'Los pagos aún no están configurados. Inténtalo más tarde.' });
  }
  try {
    const r = await query(
      "SELECT id, plan, status, created_at FROM subscriptions WHERE user_id = $1 AND status = 'authorized' ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    const row = r.rows[0];
    if (!row) {
      return json(res, 404, { error: 'No tienes una suscripción activa para cancelar.' });
    }
    await mpCall('PUT', '/preapproval/' + encodeURIComponent(row.id), { status: 'cancelled' });
    await query(
      "UPDATE subscriptions SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [row.id]
    );
    const months = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    const early = (row.plan === 'pyme' || row.plan === 'elite') && months < MIN_MONTHS;
    return json(res, 200, {
      ok: true,
      plan: row.plan,
      early_fee_mxn: early ? EARLY_FEE_MXN : 0,
      message: early
        ? 'Tu suscripción quedó cancelada y ya no se te cobrará. Como cancelaste antes de los 12 meses, aplica la cuota única de liquidación de $350 MXN según los términos: escríbenos a contacto@dmd.mx para liquidarla.'
        : 'Tu suscripción quedó cancelada y ya no se te cobrará. Conservas el acceso hasta el final de tu período pagado.',
    });
  } catch (e) {
    console.error('mp cancel error:', e.code || '', e.message);
    return json(res, 502, { error: 'No se pudo cancelar la suscripción en Mercado Pago. Inténtalo de nuevo.' });
  }
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = (req.query && req.query.action) || '';
  if (req.method === 'POST' && action === 'subscribe') return subscribe(req, res);
  if (action === 'webhook' && (req.method === 'POST' || req.method === 'GET')) return webhook(req, res);
  if (req.method === 'GET' && action === 'subscription') return subscription(req, res);
  if (req.method === 'POST' && action === 'cancel') return cancel(req, res);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ error: 'Ruta de suscripción no válida' });
};
