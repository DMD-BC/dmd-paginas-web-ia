// POST /api/generate — Generación con IA real (Groq) para el builder público.
// Modos:
//   - spec (por defecto): { prompt, previousSpec? } -> { success, spec, model, plan }
//   - edición HTML (Copilot del Editor IA): { prompt, html } o un prompt que
//     incluya "Modifica el código HTML" + "Código actual:" -> { success, html, model }
// La llave de Groq vive solo en process.env.GROQ_API_KEY (variable de
// entorno de Vercel). Jamás se devuelve ni se registra.
//
// CUOTA EN EL SERVIDOR: los modos spec y edición cobran 1 cambio aquí
// mismo, antes de llamar a Groq (25 por cuenta, 50 con código promocional,
// 3 anónimos por IP). Antes la cobraba el cliente con POST /api/usage
// { action:'consume' } y quien llamaba directo a /api/generate se saltaba
// el contador. El modo texto (Contenido IA, Canva IA, POS) no se cobra,
// igual que antes. Si Groq falla después de cobrar, el cambio se devuelve
// para que el reintento manual no cueste otro.

const { generateSpec, editHtml, generateText } = require('./_groq');
const { getSessionUser, quotaOf, ipHash, clientIp, readBody } = require('./_auth');
const { hasDb, query } = require('./_db');
const { rateLimited } = require('./_ratelimit');
const { searchWeb, webContextBlock } = require('./_websearch');
const { ensureWatermark } = require('./_watermark');

const ANON_LIMIT = 3;

function quotaPayload(used, limit, promo) {
  return { used, limit, promo: !!promo, remaining: Math.max(0, limit - used) };
}

// Cobra 1 cambio, atómico: solo si queda cupo. Devuelve
// { ok:true, kind:'user'|'anon', userId?, ipHash?, quota } o
// { ok:false, quota, error }. Sin DB no hay dónde cobrar: se permite
// (igual que hoy, que sin DB la cuota es solo un espejo local en el cliente).
async function chargeQuota(req) {
  if (!hasDb()) return { ok: true, db: false, quota: null };
  const user = await getSessionUser(req);
  if (user) {
    const q = quotaOf(user);
    const r = await query(
      'UPDATE users SET used_count = used_count + 1 ' +
      'WHERE id = $1 AND used_count < (CASE WHEN promo THEN 50 ELSE 25 END) ' +
      'RETURNING used_count, promo',
      [user.id]
    );
    if (!r.rows[0]) {
      return {
        ok: false,
        quota: quotaPayload(q.used, q.limit, q.promo),
        error: 'Ya usaste tus ' + q.limit + ' cambios.' +
          (q.promo ? '' : ' Con un código promocional llegas a 50 cambios.')
      };
    }
    const u = r.rows[0];
    const limit = u.promo ? 50 : 25;
    return { ok: true, kind: 'user', userId: user.id, quota: quotaPayload(u.used_count, limit, u.promo) };
  }
  const hash = ipHash(req);
  const anon = await query('SELECT count FROM anon_usage WHERE ip_hash = $1', [hash]);
  const used = (anon.rows[0] && anon.rows[0].count) || 0;
  if (used >= ANON_LIMIT) {
    return {
      ok: false,
      quota: quotaPayload(used, ANON_LIMIT, false),
      error: 'Ya usaste tus 3 cambios gratis. Regístrate para tener 25.'
    };
  }
  const up = await query(
    'INSERT INTO anon_usage (ip_hash, count) VALUES ($1, 1) ' +
    'ON CONFLICT (ip_hash) DO UPDATE SET count = anon_usage.count + 1, updated_at = NOW() ' +
    'WHERE anon_usage.count < $2 RETURNING count',
    [hash, ANON_LIMIT]
  );
  if (!up.rows[0]) {
    return {
      ok: false,
      quota: quotaPayload(ANON_LIMIT, ANON_LIMIT, false),
      error: 'Ya usaste tus 3 cambios gratis. Regístrate para tener 25.'
    };
  }
  const n = up.rows[0].count;
  return { ok: true, kind: 'anon', ipHash: hash, quota: quotaPayload(n, ANON_LIMIT, false) };
}

// Devuelve 1 cambio cuando la IA falló después de cobrar: el intento
// fallido no se cuenta y el reintento manual no cobra otro.
async function refundQuota(charged) {
  if (!charged || !charged.ok || charged.db === false) return;
  try {
    if (charged.kind === 'user' && charged.userId) {
      await query('UPDATE users SET used_count = used_count - 1 WHERE id = $1 AND used_count > 0', [charged.userId]);
    } else if (charged.kind === 'anon' && charged.ipHash) {
      await query('UPDATE anon_usage SET count = count - 1 WHERE ip_hash = $1 AND count > 0', [charged.ipHash]);
    }
  } catch (e) {
    console.error('generate refund error:', e.message);
  }
}

const MAX_PROMPT_CHARS = 2000;
const MAX_HTML_CHARS = 12000;
const GROQ_TIMEOUT_MS = 50000;

// Límite por IP (best-effort en memoria; las funciones serverless son
// efímeras, así que esto solo frena ráfagas cortas en una misma instancia).
// El límite real lo ponen el cupo y los rate limits del propio Groq.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;

// Extrae el HTML embebido en el prompt del Copilot del Editor IA
// ("Modifica el código HTML ... Código actual:\n\n<html...>").
function extractHtmlFromPrompt(prompt) {
  const marker = 'Código actual:';
  const idx = prompt.indexOf(marker);
  if (idx === -1) return '';
  return prompt.slice(idx + marker.length).trim();
}

// Dominios DMD autorizados a llamar a esta API (builder + herramientas).
// Sin llave en el frontend: la llave de Groq solo vive en env de Vercel.
const ALLOWED_ORIGINS = [
  'https://www.dmdmx.dev',
  'https://dmdmx.dev',
  'https://crear.dmdmx.dev',
  'https://login.dmdmx.dev',
  'https://canva.dmdmx.dev',
  'https://ventas.dmdmx.dev',
  'https://contenido.dmdmx.dev',
  'https://dmd-paginas-web-ia.vercel.app',
  'https://dmd-login.vercel.app',
  'https://dmd-canva.vercel.app',
  'https://dmd-pos.vercel.app',
  'https://dmd-contenido.vercel.app'
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }

  if (await rateLimited('generate', clientIp(req), RATE_MAX, RATE_WINDOW_MS)) {
    return res.status(429).json({
      error: 'Demasiadas solicitudes, espera unos minutos e inténtalo de nuevo'
    });
  }

  const body = readBody(req);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'prompt es requerido y debe ser string' });
  }
  if (prompt.length > MAX_PROMPT_CHARS + MAX_HTML_CHARS) {
    return res.status(400).json({ error: 'prompt demasiado largo' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  let charged = null;

  try {
    // ---- Modo edición HTML (Copilot del Editor IA) ----
    const htmlField = typeof body.html === 'string' ? body.html : '';
    const embeddedHtml = extractHtmlFromPrompt(prompt);
    const html = htmlField || embeddedHtml;
    const isEdit =
      html.length > 0 &&
      (htmlField.length > 0 || /modifica el c[oó]digo html/i.test(prompt));

    if (isEdit) {
      const instruction = htmlField
        ? prompt.slice(0, MAX_PROMPT_CHARS)
        : prompt.slice(0, prompt.indexOf('Código actual:')).trim().slice(0, MAX_PROMPT_CHARS);
      if (!instruction) {
        return res.status(400).json({ error: 'Falta la instrucción de edición' });
      }
      if (html.length > MAX_HTML_CHARS) {
        return res.status(400).json({ error: 'HTML demasiado largo' });
      }
      charged = await chargeQuota(req);
      if (!charged.ok) {
        clearTimeout(timer);
        return res.status(429).json({ error: charged.error, quotaExceeded: true, quota: charged.quota });
      }
      const out = await editHtml(instruction, html, controller.signal);
      clearTimeout(timer);
      return res.status(200).json({ success: true, html: ensureWatermark(out.html), model: out.model, quota: charged.quota });
    }

    // ---- Modo texto (Contenido IA, Canva IA, POS) ----
    // { mode: 'text', prompt } -> { success, data, model, web }
    // Textos cortos de marketing con Groq real; la búsqueda web alimenta
    // el prompt cuando aplica. El frontend usa esto y cae a su texto
    // local si la llamada falla (nunca se rompe la herramienta).
    if (body.mode === 'text') {
      if (prompt.length > 1000) {
        return res.status(400).json({ error: 'prompt demasiado largo (máximo 1000 caracteres)' });
      }
      let web = null;
      let webCtx = '';
      try {
        web = await Promise.race([
          searchWeb(prompt),
          new Promise((resolve) => setTimeout(() => resolve(null), 6000))
        ]);
        if (web) webCtx = webContextBlock(web);
      } catch (e) { web = null; webCtx = ''; }
      const out = await generateText(prompt, controller.signal, webCtx || undefined);
      clearTimeout(timer);
      return res.status(200).json({
        success: true,
        data: out.data,
        model: out.model,
        web: web ? { query: web.query, facts: web.facts, images: web.images, sites: web.sites || [] } : null
      });
    }

    // ---- Modo spec (builder) ----
    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: 'prompt demasiado largo (máximo 2000 caracteres)' });
    }
    const previousSpec = body.previousSpec && typeof body.previousSpec === 'object'
      ? body.previousSpec
      : undefined;
    // Búsqueda web (Wikipedia / DuckDuckGo / Openverse) con presupuesto
    // de 6 s: si falla o tarda, se genera solo con Groq como antes.
    let web = null;
    let webCtx = '';
    try {
      web = await Promise.race([
        searchWeb(prompt),
        new Promise((resolve) => setTimeout(() => resolve(null), 6000))
      ]);
      if (web) webCtx = webContextBlock(web);
    } catch (e) { web = null; webCtx = ''; }
    charged = await chargeQuota(req);
    if (!charged.ok) {
      clearTimeout(timer);
      return res.status(429).json({ error: charged.error, quotaExceeded: true, quota: charged.quota });
    }
    const result = await generateSpec(prompt, previousSpec, controller.signal, webCtx || undefined);
    clearTimeout(timer);
    return res.status(200).json({
      success: true,
      spec: result.spec,
      model: result.model,
      plan: result.plan,
      web: web ? { query: web.query, facts: web.facts, images: web.images, sites: web.sites || [] } : null,
      quota: charged.quota
    });
  } catch (error) {
    clearTimeout(timer);
    if (charged) await refundQuota(charged);
    const status = error.status || 500;
    if (error.name === 'AbortError') {
      return res.status(504).json({
        error: 'La IA tardó demasiado, inténtalo de nuevo o usa el generador local'
      });
    }
    if (status === 429) {
      return res.status(429).json({
        error: 'El cupo de IA se agotó por ahora, inténtalo en unos minutos o usa el generador local'
      });
    }
    if (status === 503) {
      return res.status(503).json({ error: 'IA no configurada en el servidor' });
    }
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'Error de autenticación con el proveedor de IA' });
    }
    return res.status(500).json({
      error: error.message || 'Error generando con IA'
    });
  }
};
