// POST /api/mp/webhook — Avisos de Mercado Pago sobre suscripciones.
// MP avisa con { type: "preapproval", data: { id } } (o con ?topic= & ?id=
// en la URL en el formato antiguo). Nunca se confía en el aviso tal cual:
// se consulta la suscripción a MP (GET /preapproval/{id}) y solo entonces
// se actualiza la fila local. Los avisos de pagos mensuales (type
// "payment") se confirman con 200 sin acción: el estado que manda es el
// de la suscripción, no el de cada cobro.
// Sin MP_ACCESS_TOKEN responde 503 para que MP reintente el aviso después.
const { readBody } = require('../_auth');
const { hasDb, query } = require('../_db');
const { mpConfigured, mpCall } = require('../_mp');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }
  let body = {};
  try { body = await readBody(req); } catch (e) { body = {}; }
  if (!body || typeof body !== 'object') body = {};
  const q = req.query || {};
  const type = body.type || body.topic || q.topic || '';
  const preId = (body.data && body.data.id) || body.id || q.id || '';
  if (type === 'payment') return res.status(200).json({ ok: true });
  if (!preId) return res.status(200).json({ ok: true });
  if (!mpConfigured()) return res.status(503).json({ error: 'MP no configurado' });
  if (!hasDb()) return res.status(503).json({ error: 'DB no configurada' });
  try {
    const pre = await mpCall('GET', '/preapproval/' + encodeURIComponent(String(preId)));
    const status = pre && pre.status;
    if (status === 'authorized' || status === 'cancelled' || status === 'paused') {
      await query(
        'UPDATE subscriptions SET status = $1, next_payment_date = $2, updated_at = NOW() WHERE id = $3',
        [status, (pre.auto_recurring && pre.auto_recurring.next_payment_date) || (pre.next_payment_date) || null, String(preId)]
      );
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('mp webhook error:', e.code || '', e.message);
    return res.status(503).json({ error: 'No se pudo verificar el aviso, MP lo reintentará' });
  }
};
