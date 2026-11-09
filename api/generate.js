// POST /api/generate — Generación con IA real (Groq) para el builder público.
// Modos:
//   - spec (por defecto): { prompt, previousSpec? } -> { success, spec, model, plan }
//   - edición HTML (Copilot del Editor IA): { prompt, html } o un prompt que
//     incluya "Modifica el código HTML" + "Código actual:" -> { success, html, model }
// La llave de Groq vive solo en process.env.GROQ_API_KEY (variable de
// entorno de Vercel). Jamás se devuelve ni se registra.

const { generateSpec, editHtml, generateText } = require('./_groq');
const { searchWeb, webContextBlock } = require('./_websearch');

const MAX_PROMPT_CHARS = 2000;
const MAX_HTML_CHARS = 12000;
const GROQ_TIMEOUT_MS = 50000;

// Límite por IP (best-effort en memoria; las funciones serverless son
// efímeras, así que esto solo frena ráfagas cortas en una misma instancia).
// El límite real lo ponen el cupo y los rate limits del propio Groq.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;
const hits = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 1000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (e) {
      return {};
    }
  }
  return {};
}

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

  if (rateLimited(clientIp(req))) {
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
      const out = await editHtml(instruction, html, controller.signal);
      clearTimeout(timer);
      return res.status(200).json({ success: true, html: out.html, model: out.model });
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
    const result = await generateSpec(prompt, previousSpec, controller.signal, webCtx || undefined);
    clearTimeout(timer);
    return res.status(200).json({
      success: true,
      spec: result.spec,
      model: result.model,
      plan: result.plan,
      web: web ? { query: web.query, facts: web.facts, images: web.images, sites: web.sites || [] } : null
    });
  } catch (error) {
    clearTimeout(timer);
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
