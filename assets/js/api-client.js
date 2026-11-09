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

  return { generatePage: generatePage, healthCheck: healthCheck };
})();
