/* Consentimiento de cookies y carga de herramientas de medición (DMD).
 *
 * Las herramientas solo se cargan si el visitante acepta las cookies y
 * solo si su ID está puesto. Mientras un ID esté vacío, esa herramienta
 * no se carga: el banner funciona igual y el sitio sigue igual.
 *
 * IDs pendientes (pegar aquí cuando existan, uno por herramienta):
 * - GA_MEASUREMENT_ID: propiedad de Google Analytics 4 (G-XXXXXXXXXX).
 *   Se crea en Google Analytics.
 * - GTM_CONTAINER_ID: contenedor de Google Tag Manager (GTM-XXXXXXX).
 *   Se crea en Google Tag Manager.
 * - META_PIXEL_ID: píxel de Meta (solo dígitos). Se crea en el
 *   Administrador de eventos de Meta (business.facebook.com/
 *   events_manager). La cuenta de anuncios no permite crearlo desde
 *   aquí, así que hay que crearlo a mano.
 * - CLARITY_PROJECT_ID: proyecto de Microsoft Clarity (código corto).
 *   Se crea gratis en clarity.microsoft.com.
 * - SENTRY_DSN: DSN del proyecto de Sentry, con el formato
 *   https://XXXX.ingest.sentry.io/YYYY. Se crea gratis en sentry.io.
 *   Sin DSN no se carga nada de Sentry y los errores no se registran.
 */
(function () {
  'use strict';

  var GA_MEASUREMENT_ID = ''; /* PEGA AQUÍ TU ID G-XXXXXXXXXX */
  var GTM_CONTAINER_ID = ''; /* PEGA AQUÍ TU ID GTM-XXXXXXX */
  var META_PIXEL_ID = ''; /* PEGA AQUÍ TU ID DE PÍXEL (SOLO DÍGITOS) */
  var CLARITY_PROJECT_ID = ''; /* PEGA AQUÍ TU ID DE PROYECTO DE CLARITY */
  var SENTRY_DSN = ''; /* PEGA AQUÍ TU DSN DE SENTRY */

  var KEY = 'dmd-cookie-consent';

  function getConsent() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function setConsent(value) {
    try { window.localStorage.setItem(KEY, value); } catch (e) {}
  }

  function loadGA() {
    if (!GA_MEASUREMENT_ID) return; /* Sin ID no se carga nada. */
    if (window.__dmdGaLoaded) return;
    window.__dmdGaLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
  }

  function loadGTM() {
    if (!GTM_CONTAINER_ID) return; /* Sin ID no se carga nada. */
    if (window.__dmdGtmLoaded) return;
    window.__dmdGtmLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(GTM_CONTAINER_ID);
    document.head.appendChild(s);
  }

  function loadPixel() {
    if (!META_PIXEL_ID) return; /* Sin ID no se carga nada. */
    if (window.__dmdPixelLoaded) return;
    window.__dmdPixelLoaded = true;
    /* Fragmento oficial de Meta Pixel, cargado solo tras aceptar. */
    (function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  function loadClarity() {
    if (!CLARITY_PROJECT_ID) return; /* Sin ID no se carga nada. */
    if (window.__dmdClarityLoaded) return;
    window.__dmdClarityLoaded = true;
    /* Fragmento oficial de Microsoft Clarity, cargado solo tras aceptar. */
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
  }

  function loadSentry() {
    if (!SENTRY_DSN) return; /* Sin DSN no se carga nada. */
    if (window.__dmdSentryLoaded) return;
    window.__dmdSentryLoaded = true;
    /* SDK de Sentry para el navegador, cargado solo tras aceptar. */
    var s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = 'https://browser.sentry-cdn.com/7.119.0/bundle.min.js';
    s.onload = function () {
      if (window.Sentry) {
        window.Sentry.init({ dsn: SENTRY_DSN, tracesSampleRate: 0.1 });
      }
    };
    document.head.appendChild(s);
  }

  /* Carga todas las herramientas con ID puesto. Cada una se salta sola
   * si su ID sigue vacío. */
  function loadMarketing() {
    loadGA();
    loadGTM();
    loadPixel();
    loadClarity();
    loadSentry();
  }

  function hideBanner(banner) {
    if (banner) banner.hidden = true;
    document.documentElement.classList.remove('dmd-cookie-visible');
  }

  function init() {
    var banner = document.getElementById('dmdCookieBanner');
    if (!banner) return;

    var accept = document.getElementById('dmdCookieAccept');
    var reject = document.getElementById('dmdCookieReject');
    if (accept) accept.addEventListener('click', function () {
      setConsent('accepted');
      hideBanner(banner);
      loadMarketing();
    });
    if (reject) reject.addEventListener('click', function () {
      setConsent('rejected');
      hideBanner(banner);
    });

    var consent = getConsent();
    if (consent === 'accepted') { loadMarketing(); return; }
    if (consent === 'rejected') return;
    banner.hidden = false;
    document.documentElement.classList.add('dmd-cookie-visible');
  }

  /* Reabre el banner para cambiar la elección (lo usa la página de cookies). */
  window.DMDResetCookieConsent = function () {
    try { window.localStorage.removeItem(KEY); } catch (e) {}
    var banner = document.getElementById('dmdCookieBanner');
    if (banner) {
      banner.hidden = false;
      document.documentElement.classList.add('dmd-cookie-visible');
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
