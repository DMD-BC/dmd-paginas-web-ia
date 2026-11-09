// POST /api/auth/logout — Borra la sesión en la DB y limpia la cookie.
const { destroySession, clearSessionCookie, readBody } = require('../_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }
  await destroySession(req);
  clearSessionCookie(res, req);
  return res.status(200).json({ ok: true });
};
