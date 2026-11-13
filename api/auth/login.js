// POST /api/auth/login — Inicia sesión contra la DB del servidor.
// Body: { email, password }. Verifica scrypt, crea sesión httpOnly y
// devuelve la cuota real del servidor. Al iniciar sesión, el builder
// carga DESDE LA DB los proyectos de esa cuenta (api/projects).
// Sin DATABASE_URL -> 503 db:false.
const { hasDb, query } = require('../_db');
const { rateLimited } = require('../_ratelimit');
const { scryptVerify, createSession, setSessionCookie, readBody, quotaOf, noDb, clientIp } = require('../_auth');


module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }
  if (!hasDb()) return noDb(res);
  const body = readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Escribe tu correo y tu contraseña.' });
  }
  const ip = clientIp(req);
  if (await rateLimited('login', ip, 20, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  }
  try {
    const found = await query(
      'SELECT id, name, email, pass_hash, promo, used_count FROM users WHERE LOWER(email) = $1',
      [email]
    );
    const user = found.rows[0];
    if (!user || !scryptVerify(password, user.pass_hash)) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }
    const token = await createSession(user.id);
    setSessionCookie(res, token, req);
    return res.status(200).json({
      ok: true, db: true,
      user: { id: user.id, name: user.name, email: user.email },
      quota: quotaOf(user)
    });
  } catch (e) {
    if (e.code === 'NO_DB') return noDb(res);
    console.error('login error:', e.message);
    return res.status(500).json({ error: 'No se pudo iniciar sesión, inténtalo de nuevo.' });
  }
};
