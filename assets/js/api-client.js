/**
 * ApiClient — cliente del backend de IA de DMD.
 * Llama a /api/generate y /api/health en el MISMO origen (URL relativa):
 * en local apunta al Express de `npm start` y en producción a las
 * funciones serverless de Vercel. La llave de Groq vive solo en el
 * servidor, nunca en este archivo ni en el navegador.
 */
window.ApiClient = (function () {
  'use strict';

  // M6: 65 s (antes 55 s). El servidor puede tardar hasta 50 s de Groq
  // + 6 s de búsqueda web = 56 s; con 55 s el cliente abortaba a 1 s
  // del éxito. 65 s cubre el peor caso sin tocar el timeout del servidor.
  var GENERATE_TIMEOUT_MS = 65000;
  var HEALTH_TIMEOUT_MS = 8000;

  function withTimeout(ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return { signal: controller.signal, done: function () { clearTimeout(timer); } };
  }

  async function postJson(url, body, timeoutMs) {
    var t = withTimeout(timeoutMs);
    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: t.signal
      });
      var data = null;
      try { data = await res.json(); } catch (e) { /* cuerpo no-JSON */ }
      if (!res.ok) {
        var msg = (data && data.error) || ('Error del servidor (' + res.status + ')');
        var err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('La IA tardó demasiado, inténtalo de nuevo');
      throw e;
    } finally {
      t.done();
    }
  }

  /**
   * Generar spec con Groq a través del backend.
   * @returns {Promise<{spec, model, plan}>}
   */
  async function generatePage(prompt, previousSpec) {
    var data = await postJson('/api/generate', { prompt: prompt, previousSpec: previousSpec || null }, GENERATE_TIMEOUT_MS);
    if (!data || !data.spec) throw new Error('Respuesta inválida del servidor: falta spec');
    return { spec: data.spec, model: data.model || 'groq', plan: data.plan || '' };
  }

  /**
   * Editar HTML con Groq a través del backend (Copilot del Editor IA).
   * Mismo cliente, mismo timeout (65 s) y mismo manejo de errores que
   * generatePage: el editor y el builder comparten la IA.
   * @returns {Promise<{html, model}>}
   */
  async function editPage(instruction, html, color, style) {
    var data = await postJson('/api/generate', {
      prompt: 'Modifica el código HTML de este sitio web según la instrucción del usuario: "' + instruction + '". Código actual:\n\n' + html,
      color: color || '#2563eb',
      style: style || 'claro'
    }, GENERATE_TIMEOUT_MS);
    if (!data || !data.html || data.html.indexOf('<body') === -1) throw new Error('Respuesta inválida del servidor: falta html');
    return { html: data.html, model: data.model || 'groq' };
  }

  /**
   * Health check del backend. true si responde con status ok.
   */
  async function healthCheck() {
    var t = withTimeout(HEALTH_TIMEOUT_MS);
    try {
      var res = await fetch('/api/health', { signal: t.signal });
      if (!res.ok) return false;
      var data = await res.json();
      return data && data.status === 'ok';
    } catch (e) {
      return false;
    } finally {
      t.done();
    }
  }

  return { generatePage: generatePage, editPage: editPage, healthCheck: healthCheck };
})();

/* Marca de agua DMD (la usa el Editor IA): logo circular + "DMD",
   fija abajo a la derecha, semitransparente y suave, sin bloquear clics. */
window.DMDWatermark = {
  SNIPPET: "<style>.dmd-watermark{position:fixed;right:18px;bottom:16px;z-index:9999;display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:none;opacity:.42;filter:blur(.5px)}.dmd-watermark svg{display:block;width:46px;height:46px}.dmd-watermark span{font:700 11px/1 Inter,system-ui,-apple-system,\"Segoe UI\",sans-serif;letter-spacing:.22em;color:#1c1c1c}</style><div class=\"dmd-watermark\" aria-hidden=\"true\"><svg viewBox=\"0 0 512 512\" width=\"46\" height=\"46\" aria-hidden=\"true\"><defs><linearGradient id=\"dmdwmg1\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#38bdf8\"/><stop offset=\"100%\" stop-color=\"#0284c7\"/></linearGradient><linearGradient id=\"dmdwmg2\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#60a5fa\"/><stop offset=\"100%\" stop-color=\"#2563eb\"/></linearGradient><linearGradient id=\"dmdwmg3\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#2563eb\"/><stop offset=\"100%\" stop-color=\"#1d4ed8\"/></linearGradient><linearGradient id=\"dmdwmg4\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#1e40af\"/><stop offset=\"100%\" stop-color=\"#0f172a\"/></linearGradient><clipPath id=\"dmdwmclip\"><circle cx=\"256\" cy=\"256\" r=\"256\"/></clipPath></defs><g clip-path=\"url(#dmdwmclip)\"><rect width=\"512\" height=\"512\" fill=\"#ffffff\"/><g transform=\"translate(107,107)\"><rect x=\"0\" y=\"0\" width=\"138\" height=\"138\" rx=\"36\" fill=\"url(#dmdwmg1)\"/><rect x=\"160\" y=\"0\" width=\"138\" height=\"138\" rx=\"36\" fill=\"url(#dmdwmg2)\"/><rect x=\"0\" y=\"160\" width=\"138\" height=\"138\" rx=\"36\" fill=\"url(#dmdwmg3)\"/><rect x=\"160\" y=\"160\" width=\"138\" height=\"138\" rx=\"36\" fill=\"url(#dmdwmg4)\"/></g></g></svg><span>DMD</span></div>",
  ensure: function (html) {
    if (typeof html !== 'string' || !html) return html;
    if (html.indexOf('dmd-watermark') !== -1) return html;
    if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, this.SNIPPET + '\n</body>');
    return html + '\n' + this.SNIPPET;
  }
};
