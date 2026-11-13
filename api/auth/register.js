// POST /api/auth/register — Crea la cuenta EN EL SERVIDOR (Postgres).
// Body: { name, email, password }. La contraseña se hashea con scrypt
// en el servidor y jamás se guarda en claro ni se devuelve.
// Cuenta nueva: used_count = 0 y SIN proyectos (la lista empieza vacía;
// al iniciar sesión solo aparecen los proyectos guardados en la DB).
// Responde 201 + cookie de sesión httpOnly. Sin DATABASE_URL -> 503 db:false.
const crypto = require('crypto');
const { hasDb, query } = require('../_db');
const { scryptHash, createSession, setSessionCookie, readBody, quotaOf, noDb } = require('../_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }
  if (!hasDb()) return noDb(res);
  const body = readBody(req);
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Ese correo no se ve válido.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña necesita al menos 8 caracteres.' });
  }
  try {
    const existing = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Ese correo ya tiene cuenta. Inicia sesión.' });
    }
    const id = crypto.randomUUID();
    await query(
      'INSERT INTO users (id, name, email, pass_hash, promo, used_count) VALUES ($1, $2, $3, $4, FALSE, 0)',
      [id, name, email, scryptHash(password)]
    );
    const token = await createSession(id);
    setSessionCookie(res, token, req);
    const user = { id, name, email, promo: false, used_count: 0 };
    return res.status(201).json({
      ok: true, db: true, user: { id, name, email },
      quota: quotaOf(user), projects: []
    });
  } catch (e) {
    if (e.code === 'NO_DB') return noDb(res);
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Ese correo ya tiene cuenta. Inicia sesión.' });
    }
    console.error('register error:', e.message);
    return res.status(500).json({ error: 'No se pudo crear la cuenta, inténtalo de nuevo.' });
  }
};
