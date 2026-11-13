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

      // C1 (2026-11-08): SIN reintento automático de la llamada completa.
      // Reintentar de inmediato duplicaba el consumo de cupo de Groq por
      // intento (y con 429, el reintento también cae en 429). El usuario
      // reintenta a mano con el botón "Reintentar con IA" cuando quiera,
      // con espera entre intentos. Se relanza para que app.js use el
      // fallback local con aviso.
      // Relanzar para que app.js use fallback local
      throw error;
    }
  }

  /**
   * Habilitar/deshabilitar la IA
   */
  function setEnabled(enabled) {
    config.enabled = enabled;
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

  // ---- Fuera de alcance del builder ----
  // El builder genera páginas estáticas (landing, catálogo, portafolio).
  // NO puede hacer tiendas con pagos, sistemas con usuarios, bases de
  // datos ni apps nativas. Detectarlo ANTES de generar evita gastar
  // cupo de IA y cambios del usuario en algo que no se puede entregar.
  // La lista vive aquí para poder probarla en Node; app.js la usa.
  var OUT_OF_SCOPE_PATTERNS = [
    /carrito\s*(de\s*compras?)?|checkout|pasarela\s+de\s+pagos?/i,
    /pagos?\s+en\s+l[ií]nea|pagar\s+en\s+l[ií]nea|cobro\s+en\s+l[ií]nea|pago\s+con\s+tarjeta/i,
    /stripe|paypal|mercado\s*pago|openpay|conekta/i,
    /tienda\s+.*\bcon\s+pagos?\b|e-?commerce\s+con\s+pagos?/i,
    /base\s+de\s+datos|database|sql|mongodb|firebase/i,
    /panel\s+de\s+administra|administraci[oó]n\s+de\s+usuarios|admin\s+panel/i,
    /login\s+de\s+usuarios|registro\s+de\s+usuarios|inicio\s+de\s+sesion\s+de\s+usuarios|cuentas\s+de\s+usuario|autenticaci[oó]n\s+de\s+usuarios/i,
    /app\s+m[oó]vil\s+nativa|aplicaci[oó]n\s+nativa|\bapk\b|app\s+para\s+(android|ios|iphone)/i,
    /reservas?\s+con\s+cobro|reservar\s+y\s+pagar/i,
    /suscripci[oó]n\s+con\s+cobro|cobrar\s+suscripc/i
  ];
  var OUT_OF_SCOPE_MESSAGE =
    'La IA de DMD no puede hacer tal cosa. Te recomiendo que descargues ' +
    'tus archivos y lo hagas con ayuda de otra IA.';
  function isOutOfScope(prompt) {
    var p = String(prompt || '');
    return OUT_OF_SCOPE_PATTERNS.some(function (re) { return re.test(p); });
  }
  window.DMDOutOfScope = {
    patterns: OUT_OF_SCOPE_PATTERNS,
    message: OUT_OF_SCOPE_MESSAGE,
    isOutOfScope: isOutOfScope
  };

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
