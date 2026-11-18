// POST /api/auth/delete-account — Borra la cuenta del usuario y todos
// sus datos: sesiones, proyectos y suscripciones locales (ON DELETE
// CASCADE en schema.sql). Requiere sesión + la contraseña actual, y
// tiene límite de 5 intentos por hora por IP: borrar la cuenta es
// irreversible y no debe poder probarse a lo loco.
// Si el usuario tiene una suscripción de Mercado Pago activa, se
// rechaza con 409: primero debe cancelarla (botón "Cancelar
// suscripción" en Mi cuenta), para no dejar un cobro recurrente
// huérfano en Mercado Pago sin cuenta local que lo vea.
const { hasDb, query } = require('../_db');
const {
  getSessionUser, scryptVerify, clearSessionCookie,
  readBody, noDb, clientIp
} = require('../_auth');
const { rateLimited } = require('../_ratelimit');

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
    return res.status(401).json({ error: 'Inicia sesión para eliminar tu cuenta.' });
  }
  if (await rateLimited('delete-account', clientIp(req), 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera una hora e inténtalo de nuevo.' });
  }
  const body = readBody(req);
  const password = String(body.password || '');
  if (!password) {
    return res.status(400).json({ error: 'Escribe tu contraseña para confirmar.' });
  }
  try {
    const found = await query(
      'SELECT pass_hash FROM users WHERE id = $1',
      [user.id]
    );
    const row = found.rows[0];
    if (!row || !scryptVerify(password, row.pass_hash)) {
      return res.status(401).json({ error: 'La contraseña no coincide.' });
    }
    const sub = await query(
      "SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'authorized' LIMIT 1",
      [user.id]
    );
    if (sub.rows.length) {
      return res.status(409).json({
        error: 'Primero cancela tu suscripción activa en "Mi cuenta". Así no se te sigue cobrando después de borrar la cuenta.'
      });
    }
    await query('DELETE FROM users WHERE id = $1', [user.id]);
    clearSessionCookie(res, req);
    return res.status(200).json({ ok: true });
  } catch (e) {
    if (e.code === 'NO_DB') return noDb(res);
    console.error('delete-account error:', e.message);
    return res.status(500).json({ error: 'No se pudo eliminar la cuenta, inténtalo de nuevo.' });
  }
};
