/**
 * Integración de IA con backend Groq seguro
 * El backend maneja la API key y la comunicación con Groq
 * El cliente solo envía prompts y recibe especificaciones JSON
 */
window.LLM = (function() {
  'use strict';

  let config = {
    enabled: false,
    mode: 'backend-groq'
  };

  /**
   * Verificar si la IA está configurada y disponible
   */
  function isConfigured() {
    // Simplemente retorna true si ApiClient está disponible
    return config.enabled && typeof window.ApiClient !== 'undefined';
  }

  /**
   * Generar especificación de página web usando backend Groq
   * @param {string} prompt - Descripción de página del usuario
   * @param {object} previousSpec - Especificación anterior para refinar
   * @param {function} onToken - Callback para recibir actualizaciones
   * @returns {Promise<{spec, model, plan}>}
   */
  async function planSpec(prompt, previousSpec, onToken) {
    if (!isConfigured()) {
      throw new Error('LLM no está configurado o ApiClient no disponible');
    }

    try {
      // Notificar inicio
      if (onToken) {
        onToken('🤖 Enviando a IA Groq a través del backend...');
      }

      // Llamar al backend
      const result = await window.ApiClient.generatePage(prompt, previousSpec);

      // Validar respuesta
      if (!result.spec || !result.spec.type) {
        throw new Error('Respuesta inválida del servidor: falta spec.type');
      }

      // Notificar éxito
      if (onToken) {
        const sections = result.spec.sections?.length || 0;
        onToken(`✅ Página generada: ${result.spec.type} con ${sections} secciones`);
      }

      return {
        spec: result.spec,
        plan: result.plan || `Generado por ${result.model || 'IA'}`,
        model: result.model || 'groq'
      };
    } catch (error) {
      console.error('❌ Error en LLM.planSpec:', error);

      // Notificar error
      if (onToken) {
        onToken(`❌ Error de IA: ${error.message}`);
      }

      // Reintento único (P0-1): re-verificar la salud del backend y
      // generar una vez más antes de rendirse. El llamador (app.js)
      // cae al generador local con aviso y botón de reintento.
      try {
        const healthyAgain = await retryInitialize();
        if (healthyAgain) {
          if (onToken) onToken('🔄 Reintentando con IA Groq…');
          const result = await window.ApiClient.generatePage(prompt, previousSpec);
          if (!result.spec || !result.spec.type) {
            throw new Error('Respuesta inválida del servidor: falta spec.type');
          }
          return {
            spec: result.spec,
            plan: result.plan || `Generado por ${result.model || 'IA'}`,
            model: result.model || 'groq'
          };
        }
      } catch (retryErr) {
        console.warn('⚠️ El reintento con IA también falló:', retryErr && retryErr.message);
      }

      // Relanzar para que app.js use fallback local
      throw error;
    }
  }

  /**
   * Habilitar/deshabilitar la IA
   */
  function setEnabled(enabled) {
    config.enabled = enabled;
    console.log(`[LLM] IA backend ${enabled ? '✅ habilitada' : '❌ deshabilitada'}`);
  }

  /**
   * Obtener configuración actual
   */
  function getConfig() {
    return { ...config };
  }

  /**
   * Health check al inicializar.
   * Una sola promesa compartida para toda la página (P0-1): así
   * initFromQuery (app.html) puede esperar a que el health check
   * resuelva antes de auto-enviar ?prompt=, en vez de caer al motor
   * local porque isConfigured() aún es false a los ~300 ms.
   */
  let initPromise = null;

  async function initialize() {
    if (initPromise) return initPromise;
    initPromise = (async function () {
      try {
        if (typeof window.ApiClient === 'undefined') {
          console.warn('⚠️ ApiClient no disponible, IA deshabilitada');
          config.enabled = false;
          return false;
        }

        const healthy = await window.ApiClient.healthCheck();
        config.enabled = healthy;

        if (healthy) {
          console.log('✅ Backend Groq disponible y activo');
        } else {
          console.warn('⚠️ Backend Groq no responde, usando generador local');
        }

        return healthy;
      } catch (error) {
        console.warn('⚠️ Error verificando backend:', error.message);
        config.enabled = false;
        return false;
      }
    })();
    return initPromise;
  }

  /**
   * Re-verifica la salud con un health check nuevo (no el cacheado)
   * y actualiza isConfigured(). Usado antes de caer al local y en
   * el reintento de planSpec.
   */
  async function retryInitialize() {
    try { await initPromise; } catch (e) { /* ignorar: se reintenta abajo */ }
    initPromise = null;
    return initialize();
  }

  /**
   * Espera al health check inicial y, si falló, lo reintenta una vez.
   * handlePrompt lo llama antes de decidir entre IA y motor local.
   */
  async function ensureReady() {
    let ok = false;
    try { ok = await initialize(); } catch (e) { ok = false; }
    if (!ok) {
      try { ok = await retryInitialize(); } catch (e) { ok = false; }
    }
    return ok;
  }

  // Auto-inicializar cuando el script carga
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    setTimeout(initialize, 100);
  }

  // Retornar API pública
  return {
    isConfigured,
    planSpec,
    setEnabled,
    getConfig,
    initialize,
    retryInitialize,
    ensureReady
  };
})();
