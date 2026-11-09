// api/_auth.js — Contraseñas y sesiones EN EL SERVIDOR.
// - Contraseña: scrypt (node:crypto) con sal aleatoria. Nunca se
//   guarda en claro, nunca viaja al cliente, nunca se registra.
// - Sesión: token aleatorio de 32 bytes; en la DB solo se guarda su
//   hash SHA-256. Al navegador va en cookie httpOnly (el JS no la
//   puede leer: no hay XSS que robe la sesión desde el frontend).
// - Cookie: httpOnly, SameSite=Lax, Path=/, 30 días, Secure en
//   producción (Vercel es https). SSO DMD: cuando el host es un
//   subdominio de dmdmx.dev (login.dmdmx.dev, crear.dmdmx.dev...),
//   la cookie lleva Domain=.dmdmx.dev y la comparten TODOS los
//   subdominios: iniciar sesión en login.dmdmx.dev vale también en
//   crear.dmdmx.dev y viceversa. En local/dev (localhost, *.vercel.app)
//   NO se pone Domain: la cookie queda host-only y sigue funcionando.

const crypto = require('crypto');

const SESSION_COOKIE = 'dmd_session';
const SESSION_DAYS = 30;
const SSO_DOMAIN = '.dmdmx.dev';

// Dominio de la cookie SSO, o '' fuera de *.dmdmx.dev (local/dev).
function cookieDomain(req) {
  const raw = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
  const host = String(raw).split(',')[0].trim().toLowerCase().split(':')[0];
  if (host === 'dmdmx.dev' || host.endsWith('.dmdmx.dev')) return SSO_DOMAIN;
  return '';
}

function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function scryptVerify(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const hash = crypto.scryptSync(String(password), parts[1], 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(parts[2], 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseCookies(req) {
  const out = {};
  const raw = (req.headers && req.headers.cookie) || '';
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function isSecureRequest(req) {
  if (process.env.VERCEL_ENV === 'production') return true;
  return (req.headers && req.headers['x-forwarded-proto']) === 'https';
}

function setSessionCookie(res, token, req) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = isSecureRequest(req) ? '; Secure' : '';
  const domain = cookieDomain(req);
  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=' + encodeURIComponent(token) +
    '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge +
    (domain ? '; Domain=' + domain : '') + secure);
}

function clearSessionCookie(res, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  const domain = cookieDomain(req);
  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' +
    (domain ? '; Domain=' + domain : '') + secure);
}

// Devuelve el usuario de la sesión (o null). Nunca lanza por falta de DB:
// si no hay DB, simplemente no hay sesión.
async function getSessionUser(req) {
  try {
    const { query } = require('./_db');
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    const rows = await query(
      'SELECT u.id, u.name, u.email, u.promo, u.used_count, u.created_at ' +
      'FROM sessions s JOIN users u ON u.id = s.user_id ' +
      'WHERE s.token_hash = $1 AND s.expires_at > NOW()',
      [hashToken(token)]
    );
    return rows.rows[0] || null;
  } catch (e) {
    return null;
  }
}

async function createSession(userId) {
  const { query } = require('./_db');
  const token = newSessionToken();
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [id, userId, hashToken(token), expires.toISOString()]
  );
  return token;
}

async function destroySession(req) {
  try {
    const { query } = require('./_db');
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    }
  } catch (e) { /* sin sesión que borrar */ }
}

function quotaOf(user) {
  if (!user) return { used: 0, limit: 3, promo: false };
  const limit = user.promo ? 50 : 25;
  return { used: user.used_count || 0, limit, promo: !!user.promo };
}

function clientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function ipHash(req) {
  return crypto.createHash('sha256').update(clientIp(req)).digest('hex');
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return {};
}

function noDb(res) {
  return res.status(503).json({
    db: false,
    error: 'Base de datos no configurada: falta DATABASE_URL en Vercel (Supabase o Neon gratis). El builder sigue en modo anónimo con límite local de 3.'
  });
}

module.exports = {
  SESSION_COOKIE,
  SSO_DOMAIN,
  cookieDomain,
  scryptHash,
  scryptVerify,
  newSessionToken,
  hashToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
  createSession,
  destroySession,
  quotaOf,
  clientIp,
  ipHash,
  readBody,
  noDb
};
