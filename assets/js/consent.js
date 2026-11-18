/* Consentimiento de cookies y carga de Google Analytics (DMD).
 *
 * GA_MEASUREMENT_ID: aquí va el ID de la propiedad de Google Analytics 4
 * (formato G-XXXXXXXXXX). Mientras esté vacío, este archivo no carga nada
 * de Google: el banner funciona igual y Analytics queda inactivo.
 * Para activarlo, crea la propiedad en Google Analytics y pega su ID aquí.
 */
(function () {
  'use strict';

  var GA_MEASUREMENT_ID = ''; /* PEGA AQUÍ TU ID G-XXXXXXXXXX */

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
      loadGA();
    });
    if (reject) reject.addEventListener('click', function () {
      setConsent('rejected');
      hideBanner(banner);
    });

    var consent = getConsent();
    if (consent === 'accepted') { loadGA(); return; }
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
