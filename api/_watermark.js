// Marca de agua DMD para páginas generadas con IA (servidor).
// Logo circular + "DMD" debajo, fijo abajo a la derecha, semitransparente
// y suave, sin bloquear clics. Snippet autocontenido (su propio <style>)
// para que valga igual en el preview, en la descarga y en la publicada.
const WATERMARK_SNIPPET = '<style>.dmd-watermark{position:fixed;right:18px;bottom:16px;z-index:9999;display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:none;opacity:.42;filter:blur(.5px)}.dmd-watermark svg{display:block;width:46px;height:46px}.dmd-watermark span{font:700 11px/1 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.22em;color:#1c1c1c}</style><div class="dmd-watermark" aria-hidden="true"><svg viewBox="0 0 512 512" width="46" height="46" aria-hidden="true"><defs><linearGradient id="dmdwmg1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/></linearGradient><linearGradient id="dmdwmg2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#2563eb"/></linearGradient><linearGradient id="dmdwmg3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#2563eb"/><stop offset="100%" stop-color="#1d4ed8"/></linearGradient><linearGradient id="dmdwmg4" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1e40af"/><stop offset="100%" stop-color="#0f172a"/></linearGradient><clipPath id="dmdwmclip"><circle cx="256" cy="256" r="256"/></clipPath></defs><g clip-path="url(#dmdwmclip)"><rect width="512" height="512" fill="#ffffff"/><g transform="translate(107,107)"><rect x="0" y="0" width="138" height="138" rx="36" fill="url(#dmdwmg1)"/><rect x="160" y="0" width="138" height="138" rx="36" fill="url(#dmdwmg2)"/><rect x="0" y="160" width="138" height="138" rx="36" fill="url(#dmdwmg3)"/><rect x="160" y="160" width="138" height="138" rx="36" fill="url(#dmdwmg4)"/></g></g></svg><span>DMD</span></div>';

function ensureWatermark(html) {
  if (typeof html !== 'string' || !html) return html;
  if (html.indexOf('dmd-watermark') !== -1) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, WATERMARK_SNIPPET + '\n</body>');
  return html + '\n' + WATERMARK_SNIPPET;
}

module.exports = { WATERMARK_SNIPPET, ensureWatermark };
