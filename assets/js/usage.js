/**
 * usage.js — Límites de uso y cuentas del builder de DMD, EN EL SERVIDOR.
 *
 * LA CUENTA ES REAL (servidor + Postgres), no solo localStorage:
 *   - Registro/login: POST /api/auth/register y /api/auth/login.
 *     La contraseña se hashea con scrypt EN EL SERVIDOR; el cliente
 *     nunca la guarda. La sesión es una cookie httpOnly (el JS no la
 *     puede leer) con el token hasheado en la DB.
 *   - Cuota en servidor: anónimo 3 cambios en total (por IP),
 *     registrado 25, con código promocional 50. Cada generación cobra 1
 *     cambio con POST /api/usage { action:'consume' }.
 *   - Proyectos: GET/POST /api/projects (por usuario, en la DB).
 *     Cuenta nueva -> lista VACÍA. Al iniciar sesión aparecen SUS
 *     proyectos, cargados desde la DB (app.js: syncServerProjects).
 *
 * SIN BASE DE DATOS (hoy: no hay DATABASE_URL en Vercel): los
 * endpoints responden 503 { db:false } y el builder cae al MODO
 * ANÓNIMO LOCAL: contador en localStorage (dmd_usage_anon, 3 usos)
 * y cuentas NO disponibles (el modal lo dice). En cuanto se conecte
 * Supabase/Neon gratis y se ponga DATABASE_URL en Vercel, todo lo
 * de arriba funciona sin tocar el frontend.
 *
 * Claves locales (solo respaldo sin DB / espejo de la cuota):
 *   dmd_usage_anon -> usos del visitante sin registrar (sin DB)
 */
window.DMDUsage = (function () {
  'use strict';

  var ANON_LIMIT = 3;
  var FREE_LIMIT = 25;
  var PROMO_LIMIT = 50;
  var ANON_KEY = 'dmd_usage_anon';

  // Espejo local de la cuota del servidor (para que canUse() sea
  // síncrono en el chat). Se actualiza con sync() y con cada consume().
  var state = {
    db: false,        // ¿hay DB conectada? (false hasta que /api/auth/me lo confirme)
    checked: false,   // ¿ya se preguntó al servidor?
    user: null,       // { id, name, email } o null
    used: 0,
    limit: ANON_LIMIT,
    promo: false
  };

  function readAnon() {
    try {
      var n = parseInt(localStorage.getItem(ANON_KEY) || '0', 10);
      return isNaN(n) ? 0 : Math.max(0, n);
    } catch (e) { return 0; }
  }
  function writeAnon(n) {
    try { localStorage.setItem(ANON_KEY, String(n)); } catch (e) {}
  }
  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }
  function normalizePromo(code) {
    return String(code || '').replace(/\s+/g, '').toUpperCase();
  }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({ credentials: 'include' }, opts || {}));
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { res: res, data: data };
  }

  function applyQuota(q) {
    if (!q) return;
    state.used = typeof q.used === 'number' ? q.used : state.used;
    state.limit = typeof q.limit === 'number' ? q.limit : state.limit;
    state.promo = !!q.promo;
  }

  // Pregunta al servidor quién está en sesión y cuánta cuota queda.
  // Sin DB o sin red: db=false y el espejo queda en modo anónimo local.
  async function sync() {
    try {
      var r = await api('/api/auth/me');
      if (r.data && r.data.db === false) {
        state.db = false; state.checked = true; state.user = null;
        state.used = readAnon(); state.limit = ANON_LIMIT; state.promo = false;
        return state;
      }
      if (r.data && r.data.db === true) {
        state.db = true; state.checked = true;
        state.user = r.data.user || null;
        applyQuota(r.data.quota);
        return state;
      }
    } catch (e) { /* sin red: modo local */ }
    state.db = false; state.checked = true; state.user = null;
    state.used = readAnon(); state.limit = ANON_LIMIT; state.promo = false;
    return state;
  }

  function currentUser() { return state.user; }
  function used() { return state.db ? state.used : readAnon(); }
  function limit() { return state.db ? state.limit : ANON_LIMIT; }
  function remaining() { return Math.max(0, limit() - used()); }
  function canUse() { return remaining() > 0; }

  // Cobra 1 cambio. Con DB: POST /api/usage (el servidor decide).
  // Sin DB: contador local anónimo. Devuelve Promise<boolean>.
  async function consume() {
    if (!canUse()) return false;
    if (!state.db) {
      writeAnon(readAnon() + 1);
      return true;
    }
    try {
      var r = await api('/api/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'consume' })
      });
      if (r.data && r.data.quota) applyQuota(r.data.quota);
      if (r.res.status === 429) return false;
      return !!(r.data && r.data.ok);
    } catch (e) {
      return false;
    }
  }

  function dbError(data) {
    if (data && data.db === false) {
      return 'Las cuentas aún no están conectadas: falta la base de datos del servidor (DATABASE_URL en Vercel). Mientras tanto puedes usar tus 3 cambios gratis sin registrarte.';
    }
    return (data && data.error) || 'Error del servidor, inténtalo de nuevo.';
  }

  async function register(name, email, password) {
    name = String(name || '').trim();
    email = normalizeEmail(email);
    if (name.length < 2) return { ok: false, error: 'Escribe tu nombre.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'Ese correo no se ve válido.' };
    }
    if (String(password || '').length < 4) {
      return { ok: false, error: 'La contraseña necesita al menos 4 caracteres.' };
    }
    try {
      var r = await api('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, password: password })
      });
      if (!r.data || !r.data.ok) return { ok: false, error: dbError(r.data) };
      state.db = true; state.user = r.data.user || null;
      applyQuota(r.data.quota);
      return { ok: true, account: state.user, quota: r.data.quota };
    } catch (e) {
      return { ok: false, error: 'No hay conexión con el servidor.' };
    }
  }

  async function login(email, password) {
    email = normalizeEmail(email);
    try {
      var r = await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      if (!r.data || !r.data.ok) return { ok: false, error: dbError(r.data) };
      state.db = true; state.user = r.data.user || null;
      applyQuota(r.data.quota);
      return { ok: true, account: state.user, quota: r.data.quota };
    } catch (e) {
      return { ok: false, error: 'No hay conexión con el servidor.' };
    }
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    state.user = null;
    await sync();
  }

  async function applyPromo(code) {
    if (!state.user) {
      return { ok: false, error: 'Primero regístrate o inicia sesión para usar el código.' };
    }
    try {
      var r = await api('/api/auth/promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code })
      });
      if (!r.data || !r.data.ok) return { ok: false, error: dbError(r.data) };
      applyQuota(r.data.quota);
      return { ok: true, already: !!r.data.already };
    } catch (e) {
      return { ok: false, error: 'No hay conexión con el servidor.' };
    }
  }

  function statusText() {
    if (state.user) {
      return 'Te quedan ' + remaining() + ' cambios de ' + limit() +
        ' · ' + used() + ' / ' + limit() + ' usados';
    }
    if (!state.db) {
      return 'Te quedan ' + remaining() + ' cambios gratis · ' +
        'las cuentas del servidor aún no están conectadas';
    }
    return 'Te quedan ' + remaining() + ' cambios gratis · ' +
      'regístrate para tener ' + FREE_LIMIT;
  }

  return {
    ANON_LIMIT: ANON_LIMIT,
    FREE_LIMIT: FREE_LIMIT,
    PROMO_LIMIT: PROMO_LIMIT,
    state: state,
    sync: sync,
    currentUser: currentUser,
    used: used,
    limit: limit,
    remaining: remaining,
    canUse: canUse,
    consume: consume,
    register: register,
    login: login,
    logout: logout,
    applyPromo: applyPromo,
    normalizePromo: normalizePromo,
    statusText: statusText
  };
})();
