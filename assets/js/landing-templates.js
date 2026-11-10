/* Vistas previas REALES de las plantillas de la landing (crear.dmdmx.dev).
   Cada tarjeta de #templates muestra la página real de la plantilla en
   miniatura (iframe con srcdoc, escalado) en vez del degradado de antes.
   Sin JS o sin datos, la tarjeta conserva su degradado original.
   El clic abre el Editor IA con esa plantilla (?template=<slug>). */
(function () {
  var W = 900, H = 560;
  function fit(frame) {
    var box = frame.parentNode;
    if (!box) return;
    var w = box.clientWidth || 320;
    var s = w / W;
    frame.style.transform = 'scale(' + s + ')';
    box.style.height = Math.round(H * s) + 'px';
  }
  function init() {
    if (!window.DMD_EXAMPLES) return;
    var thumbs = document.querySelectorAll('.thumb[data-example]');
    var any = false;
    thumbs.forEach(function (box) {
      var slug = box.getAttribute('data-example');
      var ex = window.DMD_EXAMPLES[slug];
      if (!ex || !ex.html) return;
      box.classList.add('thumb-live');
      var f = document.createElement('iframe');
      f.style.pointerEvents = 'none';
      f.setAttribute('title', 'Vista previa real de ' + (ex.title || slug));
      f.setAttribute('loading', 'lazy');
      f.srcdoc = ex.html;
      box.appendChild(f);
      fit(f);
      any = true;
    });
    if (!any) return;
    window.addEventListener('resize', function () {
      document.querySelectorAll('.thumb-live iframe').forEach(fit);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
