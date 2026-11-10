/**
 * dmd-tab-titles.js — Títulos dinámicos de pestaña para Digital Mijma Dreams (DMD).
 *
 * Qué hace:
 *  1. Detecta automáticamente la sección actual (por subdominio y por ruta)
 *     y asigna el título profesional que le corresponde.
 *  2. Cuando la pestaña pierde el foco, el título parpadea cada segundo entre
 *     el título de la sección y "¡Regresa a diseñar! 🚀".
 *  3. Al recuperar el foco, restaura el título de la sección de inmediato.
 *
 * Solo modifica `document.title`. Nunca toca el favicon ni ningún otro
 * elemento de la página.
 *
 * Uso: incluir en cada página con
 *   <script src="/dmd-tab-titles.js" defer></script>
 * El script se autoejecuta al cargar. El <title> estático del HTML queda
 * como respaldo para navegadores sin JavaScript.
 */
(function () {
  'use strict';

  /** Texto de atención que se alterna con el título de la sección. */
  var TITULO_ATENCION = '¡Regresa a diseñar! 🚀';

  /** Intervalo del parpadeo, en milisegundos (1 segundo). */
  var INTERVALO_MS = 1000;

  /** Títulos profesionales por sección. */
  var TITULOS = {
    inicio: 'Digital Mijma Dreams | Constructor IA & Desarrollo Web Profesional',
    canva: 'Diseño Gráfico & Portadas Gratis | Estudio Canva DMD Pro',
    pos: 'Demos de Puntos de Venta (POS) Listos para Usar | TkPOS DMD',
    contenido: 'Creador de Contenido & Anuncios con IA | DMD Pro',
    portafolio: 'Proyectos Desarrollados y Casos de Impacto | Digital Mijma Dreams',
    servicios: 'Servicios de Ingeniería de Software & SaaS | Digital Mijma Dreams',
    planes: 'Suscripciones Mensuales y Planes Transparentes | Digital Mijma Dreams',
    dominios: '🔍 Comprobar y Registrar Disponibilidad de Dominio | DMD',
    checkout: '💳 Completar tu Suscripción Segura | Digital Mijma Dreams',
    legal: 'Legal: Aviso de Privacidad & Cumplimiento LFPDPPP | DMD',
    respaldo: 'Digital Mijma Dreams | Innovación & Desarrollo Web'
  };

  /**
   * Normaliza una ruta: minúsculas, sin barra final (salvo la raíz)
   * y sin "index.html" al final, para comparar de forma uniforme.
   */
  function normalizarRuta(pathname) {
    var ruta = String(pathname || '/').toLowerCase();
    ruta = ruta.replace(/index\.html?$/, '');
    if (ruta.length > 1) ruta = ruta.replace(/\/+$/, '');
    if (ruta === '') ruta = '/';
    return ruta;
  }

  /**
   * Detecta la sección actual a partir del subdominio y de la ruta,
   * y devuelve el título profesional que le corresponde.
   * El subdominio manda: cada herramienta vive en su propio subdominio.
   */
  function detectarTitulo() {
    var host = String(window.location.hostname || '').toLowerCase();
    var ruta = normalizarRuta(window.location.pathname);

    // --- Subdominios de cada herramienta DMD ---
    if (host.indexOf('canva') !== -1) return TITULOS.canva;
    if (host.indexOf('ventas') !== -1) return TITULOS.pos;
    if (host.indexOf('contenido') !== -1) return TITULOS.contenido;

    // --- Rutas del sitio oficial y del constructor ---
    if (/(^|\/)(privacidad|terminos|términos|aviso|legal)([\/\.\-]|$)/.test(ruta)) return TITULOS.legal;
    if (/(^|\/)dominio/.test(ruta)) return TITULOS.dominios;
    if (/(^|\/)(checkout|pago|pagar|suscripcion|suscripción|suscribirse)([\/\.\-]|$)/.test(ruta)) return TITULOS.checkout;
    if (/(^|\/)(precio|precios|planes|plan)([\/\.\-]|$)/.test(ruta)) return TITULOS.planes;
    if (/(^|\/)(portafolio|proyectos|casos)([\/\.\-]|$)/.test(ruta)) return TITULOS.portafolio;
    if (/(^|\/)(servicio|servicios|saas)([\/\.\-]|$)/.test(ruta)) return TITULOS.servicios;

    // Constructor y sus páginas (inicio, app, editor IA, panel).
    if (ruta === '/' || /(^|\/)(app|editor-ia|dashboard)([\/\.\-]|$)/.test(ruta)) return TITULOS.inicio;

    // Respaldo: cualquier otra ruta.
    return TITULOS.respaldo;
  }

  /**
   * Efecto de parpadeo del título de la pestaña.
   *
   * @param {string} tituloOriginal - Título de la sección, detectado por
   *   detectarTitulo(). Se restaura de golpe al recuperar el foco.
   */
  function iniciarEfectoTabDMD(tituloOriginal) {
    var intervalo = null;
    var mostrarAtencion = false;

    function detener() {
      if (intervalo !== null) {
        clearInterval(intervalo);
        intervalo = null;
      }
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (intervalo !== null) return; // Ya está parpadeando.
        mostrarAtencion = false;
        intervalo = setInterval(function () {
          mostrarAtencion = !mostrarAtencion;
          document.title = mostrarAtencion ? TITULO_ATENCION : tituloOriginal;
        }, INTERVALO_MS);
      } else {
        detener();
        document.title = tituloOriginal;
      }
    });
  }

  /**
   * Inicialización automática: fija el título de la sección al cargar
   * y deja activo el escuchador del efecto de parpadeo.
   * Protegido contra doble carga del script en la misma página.
   */
  function init() {
    if (window.__dmdTabTitlesInit) return;
    window.__dmdTabTitlesInit = true;

    var titulo = detectarTitulo();
    document.title = titulo;
    iniciarEfectoTabDMD(titulo);
  }

  // API pública mínima, por si otra parte del sitio quiere reutilizarlo.
  window.DMDTabTitles = {
    detectarTitulo: detectarTitulo,
    iniciarEfectoTabDMD: iniciarEfectoTabDMD
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
