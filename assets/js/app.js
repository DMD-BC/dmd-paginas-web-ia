/**
 * app.js — Controlador del builder (estética Lovable).
 * Flujo de generación:
 *   1. Intenta la IA real de DMD: POST /api/generate (Groq, en el servidor).
 *      Antes de decidir, re-verifica la salud del backend (LLM.ensureReady).
 *      Si la generación falla NO se reintenta sola (C1): cae al generador
 *      local con aviso y botón "Reintentar con IA" manual.
 *   2. Si el backend falla, tarda o no responde, cae al generador local
 *      determinista (window.Generator.analyze) para que la experiencia
 *      nunca se rompa, pero AVISA en el chat y ofrece "Reintentar con IA"
 *      en vez de caer en silencio al local (P0-1).
 * Los proyectos se guardan en localStorage (dmd_projects).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- vista móvil (Chat / Vista previa) ---------------- */

  function isMobileView() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 1100px)').matches);
  }

  // Una sola vista a la vez en móvil: 'chat' o 'stage' (vista previa).
  function setMobileView(view) {
    var show = view === 'stage';
    document.body.classList.toggle('show-stage', show);
    document.querySelectorAll('#viewSwitch .vsw').forEach(function (b) {
      var on = b.getAttribute('data-mview') === view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  window.DMDShowStage = function () { setMobileView('stage'); };
  window.DMDSetMobileView = setMobileView;

  function closeMobileMenu() {
    var m = $('mobileMenu');
    if (m) m.hidden = true;
  }

  function openSidebarMobile() {
    var ws = $('workspace');
    if (!ws) return;
    ws.classList.add('show-side');
    ws.classList.remove('no-side');
    var bd = $('sideBackdrop');
    if (bd) bd.hidden = false;
  }

  function closeSidebarMobile() {
    var ws = $('workspace');
    if (ws) ws.classList.remove('show-side');
    var bd = $('sideBackdrop');
    if (bd) bd.hidden = true;
  }
  window.DMDCloseMobileSidebar = closeSidebarMobile;

  var state = {
    spec: null,       // spec actual (rico de Groq o local)
    html: '',         // preview standalone generado
    files: null,      // { 'index.html', 'styles.css', 'script.js' }
    name: 'mi-app',
    busy: false
  };

  /* ---------------- utilidades ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function slugify(s) {
    return String(s || 'mi-app').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mi-app';
  }

  function tlAdd(text, cls) {
    var tl = $('timeline');
    if (!tl) return;
    var d = document.createElement('div');
    d.className = 'tl ' + (cls || '');
    d.innerHTML = '<div class="tl__t">' + esc(text) + '</div>' +
      '<div class="tl__time">' + new Date().toLocaleTimeString('es-MX') + '</div>';
    tl.appendChild(d);
    tl.scrollTop = tl.scrollHeight;
  }

  function addMsg(role, name, text, isHtml) {
    // Defensa: nunca renderizar una burbuja vacía (avatar sin texto).
    if (!isHtml && !String(text || '').trim()) return null;
    var th = $('thread');
    if (!th) return null;
    var empty = $('empty');
    if (empty) empty.style.display = 'none';
    var wrap = document.createElement('div');
    wrap.className = 'msg msg--' + role;
    var avatar = role === 'user' ? 'Tú' : '✦';
    wrap.innerHTML = '<div class="msg__avatar">' + avatar + '</div>' +
      '<div class="msg__body"><div class="msg__name">' + esc(name) + '</div>' +
      '<div class="msg__text">' + (isHtml ? text : esc(text)) + '</div></div>';
    th.appendChild(wrap);
    th.scrollTop = th.scrollHeight;
    saveChat();
    return wrap.querySelector('.msg__text');
  }

  /* ---------------- lista de pasos en vivo (generación) ----------------
     Pasos reales del flujo, en español, con checkmarks. La lista vive
     en dos sitios a la vez: en el mensaje del asistente en el chat y
     en un overlay sobre la vista previa (la zona superior), para que
     en móvil se vea qué está pasando sin que el chat tape la página.
     Cada paso se marca hecho solo cuando su fase termina de verdad:
     0 Entendiendo tu idea (al recibir el prompt), 1 Conectando con
     la IA (health check), 2 Escribiendo el contenido (/api/generate
     o motor local), 3 Buscando las imágenes (Generator.build elige
     las fotos), 4 Armando y revisando tu página (render del preview).
     Al terminar, la lista queda como resumen con todos en ✓. */
  var GEN_STEPS = [
    'Entendiendo tu idea',
    'Conectando con la IA',
    'Escribiendo el contenido',
    'Buscando las imágenes',
    'Armando y revisando tu página'
  ];
  function stepsHtml(states) {
    return '<ul class="gen-steps">' + GEN_STEPS.map(function (label, i) {
      var st = states[i] || 'pending';
      var mark = st === 'done' ? '✓'
        : (st === 'active' ? '<span class="spinner spinner--sm"></span>' : '○');
      return '<li class="gen-step gen-step--' + st + '">' +
        '<span class="gen-step__mark">' + mark + '</span>' +
        '<span>' + esc(label) + '</span></li>';
    }).join('') + '</ul>';
  }
  function renderSteps(agentEl, states) {
    var html = stepsHtml(states);
    if (agentEl) agentEl.innerHTML = html;
    var ov = $('genOverlay'), ol = $('genStepsOverlay');
    if (ov && ol) {
      ov.hidden = false;
      ol.innerHTML = html;
    }
  }
  function hideStepsOverlay() {
    var ov = $('genOverlay');
    if (ov) ov.hidden = true;
  }
  function stepsStates(activeIdx, doneThrough) {
    return GEN_STEPS.map(function (_, i) {
      if (i <= doneThrough) return 'done';
      if (i === activeIdx) return 'active';
      return 'pending';
    });
  }

  var state = {
    spec: null,       // spec actual (rico de Groq o local)
    html: '',         // preview standalone generado
    files: null,      // { 'index.html', 'styles.css', 'script.js' }
    name: 'mi-app',
    busy: false,
    // Adjuntos del botón "+": fotos de producto y logo subidos por el
    // usuario (data URLs comprimidas en el navegador).
    attachments: { photos: [], logo: null }
  };

  /* ---------------- adjuntos (botón "+") ----------------
     - Foto de producto / logo: se leen con FileReader y se
       comprimen en el navegador con canvas (máx. 800px la foto,
       400px el logo; JPEG ~80%, PNG se conserva para el logo con
       transparencia). Así no revientan localStorage ni el límite
       de 500 KB de /api/publish. Al generar, el spec lleva
       uploadedPhotos/logo y Generator los usa en vez de Unsplash.
     - Archivo / ZIP: un .html se carga directo como vista previa;
       un .zip se extrae en el navegador (JSZip por CDN) y su
       index.html se vuelve autocontenido (imágenes en data URL,
       CSS/JS en línea) para que se pueda publicar tal cual. Lo que
       no se puede resolver se avisa en el chat, nunca en silencio.
  ---------------------------------------------------------------- */
  function kbOf(dataUrl) { return Math.round((dataUrl || '').length * 3 / 4 / 1024); }

  function compressImage(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          var isPng = file.type === 'image/png';
          resolve(cv.toDataURL(isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : quality));
        };
        img.onerror = function () { reject(new Error('No se pudo leer la imagen')); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error('No se pudo leer el archivo')); };
      reader.readAsDataURL(file);
    });
  }

  function renderAttachChips() {
    var box = $('attachChips');
    if (!box) return;
    var html = '';
    state.attachments.photos.forEach(function (p, i) {
      html += '<span class="attach-chip"><img src="' + p.dataUrl + '" alt=""><span class="attach-chip__n">📷 ' +
        esc(p.name) + ' · ' + kbOf(p.dataUrl) + ' KB</span>' +
        '<button type="button" class="attach-chip__x" data-remove-photo="' + i + '" title="Quitar foto">×</button></span>';
    });
    var lg = state.attachments.logo;
    if (lg) {
      html += '<span class="attach-chip"><img src="' + lg.dataUrl + '" alt=""><span class="attach-chip__n">🖼️ Logo · ' +
        kbOf(lg.dataUrl) + ' KB</span>' +
        '<button type="button" class="attach-chip__x" data-remove-logo="1" title="Quitar logo">×</button></span>';
    }
    box.innerHTML = html;
  }

  function totalAttachKb() {
    var kb = 0;
    state.attachments.photos.forEach(function (p) { kb += kbOf(p.dataUrl); });
    if (state.attachments.logo) kb += kbOf(state.attachments.logo.dataUrl);
    return kb;
  }

  async function handleAttachFile(file, kind) {
    if (!file) return;
    try {
      if (kind === 'file') { await handleUploadedPageFile(file); return; }
      var isLogo = kind === 'logo';
      var dataUrl = await compressImage(file, isLogo ? 400 : 800, isLogo ? 0.9 : 0.8);
      if (isLogo) {
        state.attachments.logo = { name: file.name, dataUrl: dataUrl };
        addMsg('agent', 'DMD', '🖼️ Logo guardado (' + esc(file.name) + ', ' + kbOf(dataUrl) + ' KB). Se usará en el nav de la próxima página que generes.');
      } else {
        state.attachments.photos.push({ name: file.name, dataUrl: dataUrl });
        addMsg('agent', 'DMD', '📷 Foto guardada (' + esc(file.name) + ', ' + kbOf(dataUrl) + ' KB). Se usará para el producto que coincida por nombre al generar; si no coincide con ninguno, se reparte entre los productos.');
      }
      if (totalAttachKb() > 350) {
        addMsg('agent', 'DMD', '⚠️ Tus fotos/logo ya suman ~' + totalAttachKb() + ' KB. El límite para publicar es 500 KB en total, así que si agregas más, Publicar puede rechazar la página (ahí te lo diré y podrás descargar el .html).');
      }
      renderAttachChips();
    } catch (e) {
      addMsg('agent', 'DMD', '⚠️ No pude leer ese archivo: ' + esc(e && e.message ? e.message : 'error desconocido'));
    }
  }

  function loadJSZip() {
    return new Promise(function (resolve, reject) {
      if (window.JSZip) return resolve(window.JSZip);
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = function () { resolve(window.JSZip); };
      s.onerror = function () { reject(new Error('No se pudo cargar JSZip desde el CDN (revisa tu conexión)')); };
      document.head.appendChild(s);
    });
  }

  // Carga una página subida por el usuario como vista previa y la
  // deja lista para publicar con Publicar.
  function loadUploadedPage(html, title, name, notes) {
    state.spec = { title: title || name, type: 'landing', sections: [], tagline: '' };
    state.html = html;
    state.files = { 'index.html': html };
    state.name = slugify(name || title || 'mi-pagina');
    var pv = $('preview');
    if (pv) pv.srcdoc = html;
    var code = $('code');
    if (code) code.textContent = html;
    var cf = $('codeFile');
    if (cf) cf.textContent = 'index.html';
    var ft = $('filetree');
    if (ft) ft.innerHTML = '<button class="file" data-f="index.html">▤ index.html</button>';
    var pn = $('projectName');
    if (pn) pn.value = state.name;
    var url = $('url');
    if (url) url.textContent = window.location.href;
    try { saveProject(); } catch (e) { /* página grande: no se guarda, pero se ve */ }
    tlAdd('Página subida cargada — ' + state.name, 'tl--tool');
    var msg = '📄 Tu página <b>' + esc(title || name) + '</b> ya está en la vista previa. Puedes publicarla con el botón <b>Publicar</b> (queda en dmdmx.dev/sitios/' + esc(state.name) + ').';
    if (notes && notes.length) msg += '<br><span class="muted">⚠️ ' + notes.map(esc).join('<br>⚠️ ') + '</span>';
    if (html.length > 500 * 1024) msg += '<br><span class="muted">⚠️ Esta página pesa ~' + Math.round(html.length / 1024) + ' KB (límite para publicar: 500 KB), así que Publicar la rechazará; quita imágenes grandes o usa Descargar .html.</span>';
    addMsg('agent', 'DMD', msg, true);
    if (isMobileView()) setMobileView('stage');
  }

  // C3: loadExample() (app.html) carga plantillas con esto, para que la
  // plantilla quede como proyecto real (state.spec/html/files/name) y
  // Publicar publique LA plantilla que se ve, no el proyecto anterior.
  window.DMDLoadUploadedPage = loadUploadedPage;

  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  async function handleUploadedPageFile(file) {
    var name = file.name || 'mi-pagina';
    if (/\.zip$/i.test(name)) {
      var JSZip;
      try { JSZip = await loadJSZip(); }
      catch (e) { addMsg('agent', 'DMD', '⚠️ No pude abrir el ZIP: ' + esc(e.message)); return; }
      var zip;
      try { zip = await JSZip.loadAsync(file); }
      catch (e) { addMsg('agent', 'DMD', '⚠️ Ese ZIP no se pudo leer (puede estar dañado o protegido con contraseña, que no soporto).'); return; }
      var entries = Object.keys(zip.files).filter(function (k) { return !zip.files[k].dir; });
      if (!entries.length) { addMsg('agent', 'DMD', '⚠️ El ZIP está vacío.'); return; }
      var main = entries.find(function (k) { return /(^|\/)index\.html?$/i.test(k); }) ||
        entries.find(function (k) { return /\.html?$/i.test(k); });
      if (!main) { addMsg('agent', 'DMD', '⚠️ El ZIP no trae ningún archivo .html. Trae: ' + esc(entries.slice(0, 8).join(', '))); return; }
      var notes = [];
      var assets = {}; // ruta normalizada -> { kind, data }
      for (var i = 0; i < entries.length; i++) {
        var p = entries[i];
        if (p === main) continue;
        var low = p.toLowerCase();
        try {
          if (/\.(png|jpe?g|gif|webp|svg|ico)$/.test(low)) {
            var b64 = await zip.files[p].async('base64');
            var mime = /\.svg$/.test(low) ? 'image/svg+xml' : /\.png$/.test(low) ? 'image/png' : /\.gif$/.test(low) ? 'image/gif' : /\.webp$/.test(low) ? 'image/webp' : 'image/jpeg';
            assets[p.replace(/^\.\//, '')] = { kind: 'img', data: 'data:' + mime + ';base64,' + b64 };
          } else if (/\.css$/.test(low)) {
            assets[p.replace(/^\.\//, '')] = { kind: 'css', data: await zip.files[p].async('string') };
          } else if (/\.js$/.test(low)) {
            assets[p.replace(/^\.\//, '')] = { kind: 'js', data: await zip.files[p].async('string') };
          } else {
            notes.push('No se aplicó el archivo ' + p + ' (tipo no soportado en la vista previa).');
          }
        } catch (e) { notes.push('No se pudo leer ' + p + '.'); }
      }
      var html = await zip.files[main].async('string');
      var title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || name.replace(/\.zip$/i, '');
      // Incrustar assets: imágenes como data URL, CSS/JS en línea.
      // Así la página queda autocontenida y se puede publicar tal cual.
      Object.keys(assets).forEach(function (path) {
        var a = assets[path];
        var base = path.split('/').pop();
        [path, base, './' + path].forEach(function (ref) {
          if (a.kind === 'img') {
            html = html.split('src="' + ref + '"').join('src="' + a.data + '"');
            html = html.split("src='" + ref + "'").join("src='" + a.data + "'");
          } else if (a.kind === 'css') {
            var linkRe = new RegExp('<link[^>]+href=["' + "'" + ']' + escRe(ref) + '["' + "'" + '][^>]*>', 'gi');
            html = html.replace(linkRe, '<style>' + a.data + '</style>');
          } else if (a.kind === 'js') {
            var jsRe = new RegExp('<script[^>]+src=["' + "'" + ']' + escRe(ref) + '["' + "'" + '][^>]*>\\s*</script>', 'gi');
            html = html.replace(jsRe, '<script>' + a.data.replace(/<\/script>/gi, '<\\/script>') + '</script>');
          }
        });
      });
      // Avisos honestos: referencias que quedaron sin resolver y
      // cosas externas que se dejaron como estaban.
      var unresolved = [];
      var refRe = /(?:src|href)=["']([^"']+)["']/gi, m;
      while ((m = refRe.exec(html))) {
        var ref = m[1];
        if (!ref || /^(data:|https?:|\/\/|#|mailto:|tel:)/i.test(ref)) continue;
        unresolved.push(ref);
      }
      if (unresolved.length) notes.push('No se pudieron resolver estos archivos del ZIP y pueden verse rotos: ' + Array.from(new Set(unresolved)).slice(0, 6).join(', ') + '.');
      if (/src=["']https?:|href=["']https?:|src=["']\/\//i.test(html)) notes.push('La página usa scripts/estilos externos (http) o rutas absolutas: se dejaron como estaban.');
      loadUploadedPage(html, title.trim(), slugify(title.trim() || name.replace(/\.zip$/i, '')), notes);
      return;
    }
    if (/\.html?$/i.test(name)) {
      var text = await file.text();
      var t2 = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || name.replace(/\.html?$/i, '');
      var notes2 = [];
      if (/src=["']https?:|href=["']https?:/i.test(text)) notes2.push('La página usa scripts/estilos externos (http): se dejaron como estaban.');
      loadUploadedPage(text, t2.trim(), slugify(t2.trim() || name.replace(/\.html?$/i, '')), notes2);
      return;
    }
    addMsg('agent', 'DMD', '⚠️ Solo acepto un archivo .html o un .zip con tu página. Ese archivo (' + esc(name) + ') no es ninguno de los dos.');
  }

  function initAttach() {
    var btn = $('attachBtn'), menu = $('attachMenu');
    if (!btn || !menu) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !e.target.closest('#attachMenu') && !e.target.closest('#attachBtn')) menu.hidden = true;
    });
    menu.addEventListener('click', function (e) {
      var b = e.target.closest('[data-attach]');
      if (!b) return;
      menu.hidden = true;
      var kind = b.getAttribute('data-attach');
      var input = $(kind === 'photo' ? 'attachPhoto' : kind === 'logo' ? 'attachLogo' : 'attachFile');
      if (input) input.click();
    });
    var ph = $('attachPhoto'), lg = $('attachLogo'), fl = $('attachFile');
    if (ph) ph.addEventListener('change', function () { handleAttachFile(ph.files[0], 'photo'); ph.value = ''; });
    if (lg) lg.addEventListener('change', function () { handleAttachFile(lg.files[0], 'logo'); lg.value = ''; });
    if (fl) fl.addEventListener('change', function () { handleAttachFile(fl.files[0], 'file'); fl.value = ''; });
    var chips = $('attachChips');
    if (chips) chips.addEventListener('click', function (e) {
      var rp = e.target.closest('[data-remove-photo]');
      if (rp) { state.attachments.photos.splice(Number(rp.getAttribute('data-remove-photo')), 1); renderAttachChips(); return; }
      var rl = e.target.closest('[data-remove-logo]');
      if (rl) { state.attachments.logo = null; renderAttachChips(); }
    });
  }

  function render(spec, source) {
    var built;
    try {
      built = window.Generator.build(spec);
    } catch (e) {
      console.error('Generator.build falló:', e);
      throw new Error('No se pudo renderizar la página');
    }
    state.spec = spec;
    state.html = built.preview;
    state.files = built.files;
    state.name = slugify(spec.title || spec.brand || 'mi-app');

    var pv = $('preview');
    if (pv) pv.srcdoc = built.preview;
    var code = $('code');
    if (code) code.textContent = built.files['index.html'];
    var cf = $('codeFile');
    if (cf) cf.textContent = 'index.html';
    var ft = $('filetree');
    if (ft) ft.innerHTML = Object.keys(built.files).map(function (f) {
      return '<button class="file" data-f="' + esc(f) + '">▤ ' + esc(f) + '</button>';
    }).join('');
    var pn = $('projectName');
    if (pn) pn.value = state.name;
    var url = $('url');
    // La vista previa es srcdoc (sin URL pública): se muestra la URL real
    // de esta página, nunca una inventada (P1-3).
    if (url) url.textContent = window.location.href;

    saveProject();
    tlAdd('Preview actualizado — ' + (source || 'generador'), 'tl--tool');
    if (window.Trajectory) window.Trajectory.log('render', spec.title || state.name, source || '');
    // En móvil NO se cambia solo a la vista previa: el resultado se
    // muestra como tarjeta en el chat (handlePrompt abre el historial)
    // y la miniatura se amplía con el modal de vista previa.
  }

  /* ---------------- proyectos (localStorage) ---------------- */

  var LS_KEY = 'dmd_projects';

  function loadProjects() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; }
  }

  function saveProject() {
    if (!state.spec) return;
    try {
      var list = loadProjects().filter(function (p) { return p.name !== state.name; });
      list.unshift({
        name: state.name,
        title: state.spec.title || state.name,
        spec: state.spec,
        html: state.html,
        updatedAt: Date.now()
      });
      localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 20)));
      renderProjects();
      // Con sesión, el proyecto también se guarda EN LA DB (por usuario).
      var U2 = window.DMDUsage;
      if (U2 && U2.state && U2.state.db && U2.currentUser()) {
        fetch('/api/projects', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: state.name, title: state.spec.title || state.name, spec: state.spec, html: state.html, files: state.files || {} })
        }).catch(function () {});
      }
    } catch (e) { /* almacenamiento lleno o bloqueado: no es fatal */ }
  }

  function renderProjects() {
    var ul = $('projects');
    if (!ul) return;
    var list = loadProjects();
    ul.innerHTML = list.map(function (p, i) {
      return '<li><button class="proj" data-i="' + i + '">' +
        '<span class="proj__t">' + esc(p.title || p.name) + '</span>' +
        '<span class="proj__x" data-del="' + i + '" title="Eliminar">×</span></button></li>';
    }).join('') || '<li class="muted" style="font-size:13px;padding:6px 10px">Sin proyectos todavía</li>';
  }

  /* ---------------- historial del chat (localStorage) ---------------- */
  // Cada mensaje se guarda con su proyecto; al reabrir el builder el
  // chat vuelve con el historial completo (prompt + respuesta de DMD).
  var CHAT_KEY = 'dmd_chat';

  function serializeThread() {
    var th = $('thread');
    if (!th) return [];
    return Array.prototype.map.call(th.querySelectorAll('.msg'), function (m) {
      var t = m.querySelector('.msg__text');
      var html = t ? t.innerHTML : '';
      // Sin el "Generando…" transitorio: no se restaura un spinner.
      if (html.indexOf('spinner') !== -1) return null;
      // Sin el botón "Reintentar con IA": su prompt ya no vive tras recargar.
      html = html.replace(/<button[^>]*data-retry-ai[^>]*>.*?<\/button>/g, '');
      return {
        role: m.classList.contains('msg--user') ? 'user' : 'agent',
        name: (m.querySelector('.msg__name') || {}).textContent || (m.classList.contains('msg--user') ? 'Tú' : 'DMD'),
        html: html
      };
    }).filter(function (m) {
      return m && (m.html || '').replace(/<[^>]*>/g, '').trim() !== '';
    });
  }

  function saveChat() {
    try {
      localStorage.setItem(CHAT_KEY + ':' + state.name, JSON.stringify(serializeThread()));
    } catch (e) { /* almacenamiento lleno o bloqueado: no es fatal */ }
  }

  function loadChat(name) {
    try {
      var raw = localStorage.getItem(CHAT_KEY + ':' + name);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function restoreChat(messages) {
    var th = $('thread');
    if (!th) return;
    th.innerHTML = '';
    (messages || []).forEach(function (m) {
      addMsg(m.role === 'user' ? 'user' : 'agent', m.name || (m.role === 'user' ? 'Tú' : 'DMD'), m.html || '', true);
    });
  }

  // Al abrir el builder, restaura el proyecto más reciente con su
  // preview y su historial de chat. Se queda en la vista Chat para
  // que el historial se vea al instante (sin auto-cambiar a preview).
  // El historial vive en su propia clave (dmd_chat:<nombre>), que
  // saveChat() actualiza en cada mensaje, así nunca queda desfasado
  // respecto a la respuesta final de DMD.
  function restoreLastProject() {
    var list = loadProjects();
    var p = list[0];
    if (!p || !p.spec) return;
    try {
      render(p.spec, 'proyecto guardado');
      restoreChat(loadChat(p.name));
      if (isMobileView()) setMobileView('chat');
    } catch (e) { console.warn('No se pudo restaurar el proyecto:', e); }
  }

  /* ---------------- generación ---------------- */

  /* ---------------- banner de fallback local (A4) ----------------
     En móvil el thread está oculto (display:none) hasta tocar
     "Historial del chat", así que el aviso "la IA no respondió" y el
     botón "Reintentar con IA" no se veían. Este banner vive FUERA del
     thread, sobre la vista previa, y se muestra/oculta desde
     handlePrompt. El botón reintenta el mismo prompt (ver init()). */
  function showLocalBanner(errMsg) {
    var b = $('localBanner');
    if (!b) return;
    var t = b.querySelector('.local-banner__text');
    if (t) t.textContent = '⚠️ La IA no respondió' + (errMsg ? ' (' + errMsg + ')' : '') + '. Esta versión se generó con el motor local.';
    b.hidden = false;
  }
  function hideLocalBanner() {
    var b = $('localBanner');
    if (b) b.hidden = true;
  }

  // Prompt del último fallo de IA, para el botón "Reintentar con IA".
  var lastAiFailedPrompt = '';

  /* ---------------- contador, tarjeta de resultado, preview grande,
     descarga ZIP, cuenta y proyectos del servidor ---------------- */

  function updateUsageUI() {
    var U = window.DMDUsage;
    if (!U) return;
    var pill = $('usagePill');
    if (pill) pill.textContent = 'Te quedan ' + U.remaining() + ' cambios';
    var ut = $('usageText');
    if (ut) ut.textContent = U.statusText();
    var label = $('accountLabel');
    if (label) {
      var u = U.currentUser();
      label.textContent = u ? (u.name || u.email || 'Cuenta') : 'Cuenta';
    }
    var au = $('accUsage');
    if (au) au.textContent = U.statusText();
  }

  function summaryText() {
    try { return window.Generator.build(state.spec).summary; }
    catch (e) { return 'Tu página "' + ((state.spec && state.spec.title) || state.name) + '" está lista.'; }
  }

  // Tarjeta de resultado (móvil tipo chat con IA): miniatura + resumen.
  // Va como hermana de .msg__text (no dentro), para que saveChat() no
  // serialice el srcdoc completo de la página en localStorage.
  function appendResultCard(agentEl) {
    if (!agentEl || !state.html) return;
    var body = agentEl.parentElement;
    if (!body || body.querySelector('.result-card')) return;
    var card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = '<div class="result-thumb" data-open-preview="1"><iframe class="result-thumb-frame" title="Miniatura de tu página" sandbox="allow-scripts"></iframe><span class="result-thumb__tap">🔍 Tocar para ver grande</span></div>' +
      '<div class="result-summary">' + esc(summaryText()) + '</div>' +
      '<div class="result-actions"><button type="button" class="btn btn--primary" data-open-preview="1">Ver página completa</button>' +
      '<button type="button" class="btn btn--outline" data-download-zip="1">⬇ Descargar .zip</button></div>';
    body.appendChild(card);
    var fr = card.querySelector('.result-thumb-frame');
    if (fr) fr.setAttribute('srcdoc', state.html);
  }

  function openPreviewModal() {
    var m = $('previewModal');
    if (!m || !state.html) return;
    var t = $('previewModalTitle');
    if (t) t.textContent = (state.spec && state.spec.title) || state.name;
    var fr = $('bigPreview');
    if (fr) fr.srcdoc = state.html;
    var code = $('bigCodeText');
    if (code) code.textContent = (state.files && state.files['index.html']) || state.html;
    m.hidden = false;
  }
  function closePreviewModal() {
    var m = $('previewModal');
    if (m) m.hidden = true;
  }
  function initPreviewModal() {
    var c = $('previewModalClose');
    if (c) c.addEventListener('click', closePreviewModal);
    var m = $('previewModal');
    if (m) m.addEventListener('click', function (e) { if (e.target === m) closePreviewModal(); });
    document.querySelectorAll('#previewModal [data-bview]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#previewModal [data-bview]').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        var showCode = b.getAttribute('data-bview') === 'code';
        var fr = $('bigPreview'), pre = $('bigCode');
        if (fr) fr.hidden = showCode;
        if (pre) pre.hidden = !showCode;
      });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePreviewModal(); });
  }

  // Descarga el proyecto actual como .zip (JSZip por CDN): index.html,
  // styles.css, script.js, fotos/logo subidos y un LEEME. Si aún no hay
  // página, el ZIP trae solo el LEEME explicándolo.
  async function downloadProjectZip() {
    var JSZip;
    try { JSZip = await loadJSZip(); }
    catch (e) { addMsg('agent', 'DMD', '⚠️ No pude cargar la herramienta de ZIP (revisa tu conexión).'); return; }
    try {
      var zip = new JSZip();
      if (state.html) {
        zip.file('index.html', state.html);
        if (state.files) Object.keys(state.files).forEach(function (f) { if (f !== 'index.html') zip.file(f, state.files[f]); });
        state.attachments.photos.forEach(function (p, i) {
          var m = /^data:([^;]+);base64,(.*)$/.exec(p.dataUrl || '');
          if (m) zip.file('assets/foto-' + (i + 1) + '.jpg', m[2], { base64: true });
        });
        if (state.attachments.logo) {
          var lm = /^data:([^;]+);base64,(.*)$/.exec(state.attachments.logo.dataUrl || '');
          if (lm) zip.file('assets/logo.png', lm[2], { base64: true });
        }
        zip.file('LEEME.txt', 'Página "' + ((state.spec && state.spec.title) || state.name) + '" creada con DMD | paginas web (crear.dmdmx.dev).\nAbre index.html en el navegador. Las fotos de tus productos están en assets/ si las subiste.\n');
      } else {
        zip.file('LEEME.txt', 'Aún no hay página generada en este proyecto.\nGenera una página con el builder y vuelve a descargar: el ZIP traerá index.html, styles.css y script.js.\n');
      }
      var blob = await zip.generateAsync({ type: 'blob' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.name || 'mi-pagina') + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      addMsg('agent', 'DMD', '⬇ Descargué tus archivos en .zip (' + esc(a.download) + '). Ábrelo y ahí va index.html con todo lo necesario.');
    } catch (e) {
      addMsg('agent', 'DMD', '⚠️ No pude armar el ZIP: ' + esc(e && e.message ? e.message : 'error desconocido'));
    }
  }

  // Proyectos del servidor: con sesión, la lista viene de /api/projects.
  // Cuenta nueva -> vacía. Login -> SUS proyectos de la DB. La lista
  // anónima/local se guarda aparte y vuelve al cerrar sesión.
  var ANON_PROJECTS_KEY = 'dmd_projects_anon';
  function syncServerProjects() {
    var U = window.DMDUsage;
    if (!U || !U.state || !U.state.db || !U.currentUser()) return Promise.resolve(false);
    return fetch('/api/projects', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.projects)) return false;
        try {
          var current = loadProjects();
          if (current.length) localStorage.setItem(ANON_PROJECTS_KEY, JSON.stringify(current));
        } catch (e) {}
        try { localStorage.setItem(LS_KEY, JSON.stringify(data.projects.slice(0, 20))); } catch (e) {}
        renderProjects();
        return true;
      })
      .catch(function () { return false; });
  }
  function restoreAnonProjects() {
    try {
      var raw = localStorage.getItem(ANON_PROJECTS_KEY);
      if (raw) { localStorage.setItem(LS_KEY, raw); localStorage.removeItem(ANON_PROJECTS_KEY); }
    } catch (e) {}
    renderProjects();
  }

  // Modal Mi cuenta (registro/login en el servidor + código promocional).
  var accMode = 'register';
  function openAccountModal() {
    var m = $('accountModal');
    if (!m) return;
    refreshAccountModal();
    m.hidden = false;
  }
  function refreshAccountModal() {
    var U = window.DMDUsage;
    if (!U) return;
    var au = $('accUsage');
    if (au) au.textContent = U.statusText();
    var dbNote = $('accDbNote');
    if (dbNote) {
      var hasDb = !!(U.state && U.state.db);
      dbNote.textContent = hasDb
        ? 'Cuentas en el servidor: activas. Tu sesión y tus proyectos se guardan en la base de datos.'
        : 'Cuentas del servidor aún no conectadas: falta DATABASE_URL en Vercel (base de datos gratis de Supabase o Neon). El registro está desactivado hasta conectarla; mientras tanto usa tus 3 cambios gratis sin registrarte.';
    }
    var u = U.currentUser();
    var logged = $('accLogged');
    if (logged) {
      logged.hidden = !u;
      if (u) logged.textContent = 'Sesión: ' + u.name + ' (' + u.email + ') · cuenta del servidor';
    }
    var form = $('accForm');
    if (form) form.style.display = u ? 'none' : '';
    var lo = $('accLogout');
    if (lo) lo.hidden = !u;
    var promoBox = $('accPromoBox');
    if (promoBox) promoBox.style.display = '';
    if (!u) {
      var ps0 = $('accPromoStatus');
      if (ps0) ps0.textContent = 'Primero regístrate o inicia sesión para usar tu código.';
    }
    var submit = $('accSubmit');
    if (submit) {
      submit.textContent = accMode === 'register' ? 'Registrarme' : 'Iniciar sesión';
      submit.disabled = !(U.state && U.state.db);
    }
    var nameField = $('accNameField');
    if (nameField) nameField.style.display = accMode === 'register' ? '' : 'none';
    var toggle = $('accToggle');
    if (toggle) toggle.textContent = accMode === 'register' ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate';
  }
  function initAccountModal() {
    var ab = $('accountBtn');
    if (ab) ab.addEventListener('click', openAccountModal);
    var m = $('accountModal');
    if (!m) return;
    var close = function () { m.hidden = true; };
    var cb = $('accClose');
    if (cb) cb.addEventListener('click', close);
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    var toggle = $('accToggle');
    if (toggle) toggle.addEventListener('click', function () {
      accMode = accMode === 'register' ? 'login' : 'register';
      var st = $('accStatus');
      if (st) st.textContent = '';
      refreshAccountModal();
    });
    var submit = $('accSubmit');
    if (submit) submit.addEventListener('click', async function () {
      var U = window.DMDUsage;
      if (!U) return;
      var st = $('accStatus');
      if (st) st.textContent = accMode === 'register' ? 'Creando tu cuenta en el servidor…' : 'Iniciando sesión…';
      var r = accMode === 'register'
        ? await U.register($('accName').value, $('accEmail').value, $('accPass').value)
        : await U.login($('accEmail').value, $('accPass').value);
      if (st) st.textContent = r.ok ? 'Listo ✓' : ('⚠️ ' + (r.error || 'Error'));
      if (r.ok) {
        updateUsageUI();
        await syncServerProjects();
        var list = loadProjects();
        if (list[0]) {
          try { render(list[0].spec, 'proyecto guardado'); restoreChat(loadChat(list[0].name)); } catch (e) {}
        }
        setTimeout(close, 700);
      }
      refreshAccountModal();
    });
    var promoBtn = $('accPromoBtn');
    if (promoBtn) promoBtn.addEventListener('click', async function () {
      var U = window.DMDUsage;
      if (!U) return;
      var ps = $('accPromoStatus');
      var r = await U.applyPromo($('accPromo').value);
      if (ps) ps.textContent = r.ok ? '✓ Código aplicado: tu límite es 50 cambios.' : ('⚠️ ' + (r.error || 'Error'));
      updateUsageUI();
      refreshAccountModal();
    });
    var lo = $('accLogout');
    if (lo) lo.addEventListener('click', async function () {
      var U = window.DMDUsage;
      if (!U) return;
      await U.logout();
      restoreAnonProjects();
      updateUsageUI();
      refreshAccountModal();
      var st = $('accStatus');
      if (st) st.textContent = 'Sesión cerrada. Vuelves al modo anónimo.';
    });
  }

  async function handlePrompt(promptText, opts) {
    if (state.busy) return;
    var prompt = (promptText || '').trim();
    // M10: prompt vacío con feedback (antes retornaba en silencio).
    if (!prompt) {
      addMsg('agent', 'DMD', '✏️ Escribe tu idea arriba: por ejemplo, "una página para mi papelería con precios y contacto".');
      return;
    }
    state.busy = true;

    // Al reintentar no se duplica el mensaje del usuario: ya está en el chat.
    var isRetry = !!(opts && opts.retry);
    if (!isRetry) addMsg('user', 'Tú', prompt);

    // Fuera de alcance: NO se gasta cupo ni cambios. Mensaje exacto
    // pedido por Axel + botón para descargar los archivos (.zip).
    var oos = window.DMDOutOfScope;
    if (oos && oos.isOutOfScope(prompt)) {
      addMsg('agent', 'DMD',
        esc(oos.message) +
        '<br><span class="muted">Tu proyecto actual no se tocó.</span>' +
        '<br><button type="button" class="btn btn--outline" data-download-zip="1" style="margin-top:8px">⬇ Descargar mis archivos (.zip)</button>',
        true);
      state.busy = false;
      return;
    }

    // Límites de uso (local, por navegador): anónimo 3, registrado 25,
    // con código promocional 50. Se cobra 1 cambio cuando la generación
    // arranca; el reintento manual tras un fallo de IA no cobra otro
    // (ese intento ya se cobró).
    var U = window.DMDUsage;
    if (U && !isRetry) {
      if (!U.canUse()) {
        addMsg('agent', 'DMD',
          '⛔ Ya usaste tus ' + U.limit() + ' cambios' +
          (U.currentUser() ? '' : ' gratis') +
          '. Regístrate para tener ' + U.FREE_LIMIT + ' cambios por cuenta (50 con un código promocional).' +
          '<br><button type="button" class="btn btn--primary" data-open-account="1" style="margin-top:8px">Registrarme</button>',
          true);
        state.busy = false;
        return;
      }
      var consumed = await U.consume();
      if (!consumed) {
        addMsg('agent', 'DMD',
          '⛔ Se acabaron tus cambios (límite ' + U.limit() + '). ' +
          (U.currentUser() ? 'Con un código promocional llegas a 50 cambios.' : 'Regístrate para tener ' + U.FREE_LIMIT + ' cambios por cuenta (50 con un código promocional).') +
          '<br><button type="button" class="btn btn--primary" data-open-account="1" style="margin-top:8px">Mi cuenta</button>',
          true);
        state.busy = false;
        return;
      }
      updateUsageUI();
    }

    var agentEl = addMsg('agent', 'DMD', 'Estoy generando tu página…');
    // Paso 0 hecho (idea recibida), paso 1 activo (health check).
    renderSteps(agentEl, stepsStates(1, 0));
    tlAdd('Prompt: ' + prompt.slice(0, 120), 'tl--user');

    var usedAI = false;
    var spec = null;
    var errMsg = '';

    // 1) IA real de DMD (Groq en el servidor). Antes de decidir, se
    // re-verifica la salud del backend: el health check inicial es
    // asíncrono y podía no haber terminado cuando llegó el prompt
    // (P0-1: la carrera que hacía caer al local con ?prompt=).
    if (window.LLM && window.LLM.ensureReady) {
      try { await window.LLM.ensureReady(); } catch (e) { /* sigue al local con aviso */ }
    }
    // Paso 1 hecho, paso 2 activo (escribiendo el contenido).
    renderSteps(agentEl, stepsStates(2, 1));
    if (window.LLM && window.LLM.isConfigured()) {
      try {
        var res = await window.LLM.planSpec(prompt, state.spec, function () {});
        spec = res.spec;
        usedAI = true;
      } catch (e) {
        errMsg = e && e.message ? e.message : String(e);
        console.warn('IA DMD no disponible, fallback local:', errMsg);
      }
    } else {
      errMsg = 'Backend de IA no disponible';
    }

    // 2) Fallback local (nunca se rompe la experiencia)
    if (!spec) {
      try {
        spec = window.Generator.analyze(prompt, state.spec);
      } catch (e) {
        hideStepsOverlay();
        if (agentEl) agentEl.textContent = 'No pude generar la página: ' + (e.message || e);
        saveChat();
        state.busy = false;
        return;
      }
    }

    // 3) Render. Paso 2 hecho, paso 3 activo (buscando las imágenes:
    // Generator.build elige las fotos reales para cada sección/item).
    // Fotos/logo subidos con "+": van en el spec para que el
    // generador los use en vez de Unsplash.
    if (state.attachments.photos.length) {
      spec.uploadedPhotos = state.attachments.photos.map(function (p) { return { name: p.name, dataUrl: p.dataUrl }; });
    }
    if (state.attachments.logo) spec.logo = state.attachments.logo.dataUrl;
    renderSteps(agentEl, stepsStates(3, 2));
    try {
      render(spec, usedAI ? 'IA Groq' : 'generador local');
    } catch (e) {
      hideStepsOverlay();
      if (agentEl) agentEl.textContent = 'No pude mostrar la página: ' + (e.message || e);
      saveChat();
      state.busy = false;
      return;
    }
    // Paso 3 hecho, paso 4 activo (armando y revisando el preview).
    renderSteps(agentEl, stepsStates(4, 3));

    var summary = '';
    try { summary = window.Generator.build(spec).summary; } catch (e) { summary = ''; }
    if (agentEl) {
      // Resumen final: la lista queda con todos los pasos en ✓.
      var doneHtml = stepsHtml(['done', 'done', 'done', 'done', 'done']);
      if (usedAI) {
        lastAiFailedPrompt = '';
        hideLocalBanner();
        var attachNote = '';
        if (state.attachments.logo || state.attachments.photos.length) {
          attachNote = '<br><span class="muted">Usé tu logo' +
            (state.attachments.photos.length ? ' y ' + state.attachments.photos.length + ' foto(s) de tus productos' : '') +
            ' en la página.</span>';
        }
        agentEl.innerHTML = doneHtml + esc(summary || ('Listo: ' + (spec.title || 'tu página'))) +
          '<br><span class="muted">Generado con IA Groq 🤖</span>' + attachNote +
          // A1: avisar siempre tras una generación con IA: los datos de
          // contacto/precios que el usuario no dio salen como marcadores
          // [TU TELÉFONO] / [TU DIRECCIÓN] / [PRECIO] y hay que
          // revisarlos antes de publicar.
          '<br><span class="muted">⚠️ Revisa tu teléfono, dirección y precios antes de publicar: si no me los diste, aparecen como [TU TELÉFONO], [TU DIRECCIÓN] o [PRECIO].</span>';
      } else {
        // Aviso visible (no silencioso): la versión es del motor local y
        // se ofrece reintentar el MISMO prompt contra la IA (P0-1).
        lastAiFailedPrompt = prompt;
        // A4: el aviso también fuera del thread (banner sobre el preview),
        // porque en móvil el thread está oculto y nadie lo vería.
        showLocalBanner(errMsg);
        var attachNoteLocal = '';
        if (state.attachments.logo || state.attachments.photos.length) {
          attachNoteLocal = '<br><span class="muted">Usé tu logo' +
            (state.attachments.photos.length ? ' y ' + state.attachments.photos.length + ' foto(s) de tus productos' : '') +
            ' en la página.</span>';
        }
        agentEl.innerHTML = doneHtml + esc(summary || ('Listo: ' + (spec.title || 'tu página'))) +
          '<br><span class="muted">⚠️ La IA no respondió (' + esc(errMsg) + '). Esta versión se generó con el motor local.</span>' + attachNoteLocal +
          '<br><button type="button" class="btn btn--outline" data-retry-ai="1" style="margin-top:8px">↻ Reintentar con IA</button>';
      }
      saveChat();
    }
    // Tarjeta de resultado (móvil tipo chat con IA): miniatura + resumen.
    if (agentEl) appendResultCard(agentEl);
    // En móvil, tras generar se abre el historial para que la tarjeta
    // se vea arriba del composer; la miniatura se abre a pantalla casi
    // completa al tocarla (modal con X y pestañas Vista previa/Código).
    if (isMobileView()) {
      setMobileView('chat');
      var th2 = $('thread');
      if (th2) {
        th2.classList.add('open');
        var ht2 = $('historyToggle');
        if (ht2) { ht2.textContent = '✕ Cerrar historial'; ht2.setAttribute('aria-expanded', 'true'); }
      }
    }
    hideStepsOverlay();
    tlAdd(usedAI ? 'Generado con IA Groq' : 'Generado con motor local', 'tl--agent');
    if (window.Trajectory) window.Trajectory.log('generate', prompt.slice(0, 80), usedAI ? 'groq' : 'local');
    state.busy = false;
  }

  /* ---------------- init ---------------- */

  function initTabs() {
    document.querySelectorAll('.tab[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tab[data-view]').forEach(function (b) { b.classList.remove('is-on'); });
        btn.classList.add('is-on');
        document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('is-on'); });
        var v = $('view-' + btn.getAttribute('data-view'));
        if (v) v.classList.add('is-on');
      });
    });
    document.querySelectorAll('#devices .dev').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('#devices .dev').forEach(function (b) { b.classList.remove('is-on'); });
        btn.classList.add('is-on');
        var pv = $('preview');
        if (pv) pv.style.maxWidth = btn.getAttribute('data-w');
      });
    });
    var ft = $('filetree');
    if (ft) ft.addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]');
      if (!b || !state.files) return;
      var f = b.getAttribute('data-f');
      var code = $('code');
      if (code) code.textContent = state.files[f] || '';
      var cf = $('codeFile');
      if (cf) cf.textContent = f;
      ft.querySelectorAll('.file').forEach(function (x) { x.classList.remove('is-on'); });
      b.classList.add('is-on');
    });
    var rb = $('refreshBtn');
    if (rb) rb.addEventListener('click', function () {
      var pv = $('preview');
      if (pv && state.html) pv.srcdoc = state.html;
    });
    var ob = $('openBtn');
    if (ob) ob.addEventListener('click', function () {
      if (!state.html) return;
      var blob = new Blob([state.html], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank');
    });
    var cp = $('copyCode');
    if (cp) cp.addEventListener('click', function () {
      var code = $('code');
      if (!code) return;
      var done = function () { cp.textContent = 'Copiado ✓'; setTimeout(function () { cp.textContent = 'Copiar'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code.textContent).then(done, done);
      } else { done(); }
    });
  }

  function initComposer() {
    var form = $('composer');
    var input = $('prompt');
    if (!form || !input) return;
    // M10: contador visible del límite de 2000 caracteres.
    var count = $('promptCount');
    var updateCount = function () {
      if (count) count.textContent = (input.value.length) + ' / 2000 caracteres';
    };
    input.addEventListener('input', updateCount);
    updateCount();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value;
      input.value = '';
      handlePrompt(v);
    });
    var chips = $('chipsBtn');
    if (chips) chips.addEventListener('click', function () {
      var ideas = [
        'Landing para mi taquería con menú y precios',
        'Portafolio para mostrar mi trabajo',
        'Tienda de café con catálogo y pedidos',
        'Landing SaaS con producto y precios'
      ];
      input.value = ideas[Math.floor(Math.random() * ideas.length)];
      input.focus();
    });

    fillEmptyIdeas();
  }

  // Llena las ideas y plantillas del estado vacío (se vuelve a llamar
  // tras "Nuevo proyecto", que recrea el #empty; no re-engancha el form).
  function fillEmptyIdeas() {
    var input = $('prompt');
    var ei = $('emptyIdeas');
    if (ei && !ei.children.length) {
      ['🍕 Pizzería', '💇 Barbería', '☕ Cafetería', '🏋️ Gimnasio'].forEach(function (label) {
        var b = document.createElement('button');
        b.className = 'chip';
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', function () {
          if (input) {
            input.value = 'Crea una página para ' + label.slice(2).toLowerCase() + ' con servicios, precios y contacto';
            input.focus();
          }
        });
        ei.appendChild(b);
      });
    }
    var et = $('emptyTpl');
    if (et && !et.children.length) {
      [
        ['Consultora', 'consultora'], ['Reservas', 'reservas'], ['Panel de ventas', 'ventas'],
        ['Portafolio', 'portafolio'], ['SaaS', 'saas'], ['Tienda de café', 'cafe'],
        ['Buen Fin', 'buenfin']
      ].forEach(function (pair) {
        var a = document.createElement('a');
        a.className = 'chip';
        a.href = 'app.html?example=' + pair[1];
        a.textContent = pair[0];
        et.appendChild(a);
      });
    }
  }

  function initSidebar() {
    var tb = $('toggleSidebar');
    var ws = $('workspace');
    if (tb && ws) tb.addEventListener('click', function () {
      if (isMobileView()) {
        // móvil: el ☰ abre el menú móvil (Proyectos / Editor IA / Compartir)
        var m = $('mobileMenu');
        if (m) m.hidden = !m.hidden;
        return;
      }
      ws.classList.toggle('show-side');
      ws.classList.toggle('no-side');
    });
    var np = $('newProject');
    if (np) np.addEventListener('click', function () {
      hideStepsOverlay();
      hideLocalBanner();
      state.spec = null; state.html = ''; state.files = null; state.name = 'mi-app';
      var pv = $('preview'); if (pv) pv.removeAttribute('srcdoc');
      var code = $('code'); if (code) code.textContent = '';
      var tl = $('timeline'); if (tl) tl.innerHTML = '';
      var th = $('thread'); if (th) th.innerHTML = '';
      var empty = $('empty'); if (empty) empty.style.display = '';
      var pn = $('projectName'); if (pn) pn.value = 'mi-app';
      var url = $('url'); if (url) url.textContent = window.location.href;
      var input = $('prompt'); if (input) input.value = '';
      if (window.Trajectory) window.Trajectory.clear();
      initComposerEmpty();
    });
    var ul = $('projects');
    if (ul) ul.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        var list = loadProjects();
        list.splice(Number(del.getAttribute('data-del')), 1);
        try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (err) {}
        renderProjects();
        return;
      }
      var btn = e.target.closest('[data-i]');
      if (!btn) return;
      var p = loadProjects()[Number(btn.getAttribute('data-i'))];
      if (!p || !p.spec) return;
      try { render(p.spec, 'proyecto guardado'); } catch (err) { console.warn(err); }
      restoreChat(loadChat(p.name));
      if (isMobileView()) closeSidebarMobile();
    });
    renderProjects();
  }

  // Repone el estado vacío tras "Nuevo proyecto" (el #empty se vació al chatear)
  function initComposerEmpty() {
    var th = $('thread');
    if (!th) return;
    th.innerHTML = '<div class="empty" id="empty">' +
      '<h2>¿Qué quieres construir hoy?</h2>' +
      '<p class="muted">Describe tu idea y la IA generará el código y el preview en vivo.</p>' +
      '<div class="empty__ideas" id="emptyIdeas"></div>' +
      '<div class="empty__label muted">o empieza con una plantilla</div>' +
      '<div class="empty__ideas" id="emptyTpl"></div></div>';
    fillEmptyIdeas();
  }

  function initTopbar() {
    var dzb = $('downloadZipBtn');
    if (dzb) dzb.addEventListener('click', function () { downloadProjectZip(); });
    var sb = $('shareBtn');
    if (sb) sb.addEventListener('click', function () {
      var done = function () { sb.textContent = 'Enlace copiado ✓'; setTimeout(function () { sb.textContent = 'Compartir'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(window.location.href).then(done, done);
      } else { done(); }
    });
    var pb = $('publishBtn');
    if (pb) pb.addEventListener('click', async function () {
      if (!state.html || !state.files) {
        addMsg('agent', 'DMD', 'Primero genera una página con el prompt de abajo y luego podrás publicarla.');
        return;
      }
      if (pb.disabled) return;
      pb.disabled = true;
      var oldLabel = pb.textContent;
      pb.textContent = 'Publicando…';
      // Límite honesto: /api/publish acepta hasta 500 KB. Si la página
      // (p. ej. con fotos subidas embebidas) ya lo supera, se avisa
      // claro en vez de intentar y fallar en silencio.
      if (state.html && state.html.length > 500 * 1024) {
        addMsg('agent', 'DMD',
          '⚠️ Esta página pesa ~' + Math.round(state.html.length / 1024) + ' KB y el límite para publicar es 500 KB. Las fotos subidas son lo que más pesa: quita alguna con la × de su miniatura y vuelve a generar, o descárgala como archivo .html.' +
          '<br><button type="button" class="btn btn--outline" data-download-html="1" style="margin-top:8px">⬇ Descargar .html</button>',
          true);
        pb.disabled = false;
        pb.textContent = oldLabel;
        return;
      }
      try {
        var res = await fetch('/api/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: state.name,
            title: state.spec && state.spec.title ? state.spec.title : state.name,
            html: state.html
          })
        });
        var data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (res.ok && data && data.url) {
          var url = $('url');
          if (url) url.textContent = data.url;
          addMsg('agent', 'DMD',
            // M2: el deploy del sitio oficial tarda ~1 min tras el commit;
            // decir "ya está en vivo" al instante llevaba a un 404.
            '🎉 Tu página se está publicando y estará lista en ~1 minuto en <a href="' + esc(data.url) + '" target="_blank" rel="noopener">' + esc(data.url) + '</a> (si al abrirla ves un error, espera un minuto y recarga).' +
            '<br><button type="button" class="btn btn--outline" data-publish-copy="' + esc(data.url) + '" style="margin:6px 6px 0 0">📋 Copiar enlace</button>' +
            '<button type="button" class="btn btn--outline" data-publish-open="' + esc(data.url) + '" style="margin-top:6px">↗ Abrir página</button>',
            true);
          tlAdd('Publicado en ' + data.url, 'tl--tool');
        } else {
          var reason = (data && data.error) || ('Error ' + res.status);
          addMsg('agent', 'DMD',
            '⚠️ No se pudo publicar: ' + esc(reason) +
            '<br>Tu página no se perdió: puedes descargarla como archivo .html.' +
            '<br><button type="button" class="btn btn--outline" data-download-html="1" style="margin-top:8px">⬇ Descargar .html</button>',
            true);
        }
      } catch (e) {
        addMsg('agent', 'DMD',
          '⚠️ No se pudo publicar: ' + esc(e && e.message ? e.message : 'error de red') +
          '<br>Tu página no se perdió: puedes descargarla como archivo .html.' +
          '<br><button type="button" class="btn btn--outline" data-download-html="1" style="margin-top:8px">⬇ Descargar .html</button>',
          true);
      } finally {
        pb.disabled = false;
        pb.textContent = oldLabel;
      }
    });
    var pn = $('projectName');
    if (pn) pn.addEventListener('change', function () {
      state.name = slugify(pn.value);
      var url = $('url');
      if (url) url.textContent = window.location.href;
    });
  }

  function initMobileView() {
    var sw = $('viewSwitch');
    if (sw) sw.addEventListener('click', function (e) {
      var b = e.target.closest('[data-mview]');
      if (!b) return;
      setMobileView(b.getAttribute('data-mview'));
      closeMobileMenu();
    });
    var mp = $('mMenuProjects');
    if (mp) mp.addEventListener('click', function () {
      closeMobileMenu();
      openSidebarMobile();
    });
    var ms = $('mMenuShare');
    if (ms) ms.addEventListener('click', function () {
      closeMobileMenu();
      var sb = $('shareBtn');
      if (sb) sb.click();
    });
    var bd = $('sideBackdrop');
    if (bd) bd.addEventListener('click', function () { closeSidebarMobile(); });
    document.addEventListener('click', function (e) {
      var m = $('mobileMenu');
      if (!m || m.hidden) return;
      if (e.target.closest('#mobileMenu') || e.target.closest('#toggleSidebar')) return;
      m.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      closeMobileMenu();
      closeSidebarMobile();
    });
  }

  function initAiModal() {
    var modal = $('aiModal');
    if (!modal) return;
    var open = function () { modal.hidden = false; refreshAiStatus(); };
    var close = function () { modal.hidden = true; };
    var ab = $('aiBtn'); if (ab) ab.addEventListener('click', open);
    var cb = $('aiClose'); if (cb) cb.addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    // Cargar ajustes guardados. La generación usa el backend de DMD en
    // /api/generate; la clave Groq vive solo en el .env del servidor,
    // nunca en el navegador. Si existía una clave guardada aquí de antes,
    // se borra.
    try {
      var cfg = JSON.parse(localStorage.getItem('dmd_ai_config') || '{}');
      if (cfg.preset) $('aiPreset').value = cfg.preset;
      if (cfg.base) $('aiBase').value = cfg.base;
      if (cfg.key) { delete cfg.key; try { localStorage.setItem('dmd_ai_config', JSON.stringify(cfg)); } catch (e2) {} }
      if (cfg.model) $('aiModel').value = cfg.model;
      if (cfg.timeout) $('aiTimeout').value = cfg.timeout;
      if (cfg.enabled) $('aiEnabled').checked = true;
    } catch (e) {}

    var save = $('aiSave');
    if (save) save.addEventListener('click', function () {
      try {
        localStorage.setItem('dmd_ai_config', JSON.stringify({
          preset: $('aiPreset').value,
          base: $('aiBase').value,
          model: $('aiModel').value,
          timeout: $('aiTimeout').value,
          enabled: $('aiEnabled').checked
        }));
      } catch (e) {}
      var st = $('aiStatus');
      if (st) st.textContent = 'Ajustes guardados. La generación usa el backend de DMD (Groq).';
      setTimeout(close, 700);
    });
    var test = $('aiTest');
    if (test) test.addEventListener('click', async function () {
      var st = $('aiStatus');
      if (st) st.textContent = 'Probando backend de DMD…';
      var ok = false;
      try { ok = await window.ApiClient.healthCheck(); } catch (e) { ok = false; }
      if (st) st.textContent = ok
        ? 'Backend de DMD disponible (Groq). La IA está lista.'
        : 'Backend de DMD no responde. Se usará el generador local.';
    });
  }

  function refreshAiStatus() {
    var st = $('aiStatus');
    if (!st) return;
    var on = window.LLM && window.LLM.isConfigured();
    st.textContent = on
      ? 'IA de DMD activa (Groq). Escribe tu idea y se generará con IA real.'
      : 'IA de DMD no disponible ahora. Se usará el generador local.';
  }

  function watchAiDot() {
    var dot = $('aiDot');
    if (!dot) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (window.LLM && window.LLM.isConfigured()) {
        dot.classList.add('is-on');
        dot.title = 'IA de DMD activa (Groq)';
        clearInterval(iv);
      } else if (tries > 15) {
        clearInterval(iv);
      }
    }, 1000);
  }

  function init() {
    initTabs();
    initComposer();
    initAttach();
    // Historial del chat (móvil): el historial vive colapsado arriba
    // del composer y NO tapa la vista previa; se abre solo si se toca.
    var ht = $('historyToggle');
    if (ht) ht.addEventListener('click', function () {
      var th = $('thread');
      if (!th) return;
      var open = th.classList.toggle('open');
      ht.textContent = open ? '✕ Cerrar historial' : '💬 Historial del chat';
      ht.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) th.scrollTop = th.scrollHeight;
    });
    initSidebar();
    initTopbar();
    initAiModal();
    initAccountModal();
    initPreviewModal();
    updateUsageUI();
    initMobileView();
    watchAiDot();
    // La barra de URL muestra la URL real de esta página (P1-3).
    var url = $('url');
    if (url) url.textContent = window.location.href;
    // Botón "Reintentar con IA" del aviso de fallback local (P0-1):
    // re-ejecuta el mismo prompt contra el backend, sin duplicar el
    // mensaje del usuario en el chat.
    var th = $('thread');
    if (th) th.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-retry-ai]') : null;
      if (b && !state.busy && lastAiFailedPrompt) { handlePrompt(lastAiFailedPrompt, { retry: true }); return; }
      var opv = e.target && e.target.closest ? e.target.closest('[data-open-preview]') : null;
      if (opv) { openPreviewModal(); return; }
      var dz2 = e.target && e.target.closest ? e.target.closest('[data-download-zip]') : null;
      if (dz2) { downloadProjectZip(); return; }
      var oa = e.target && e.target.closest ? e.target.closest('[data-open-account]') : null;
      if (oa) { openAccountModal(); return; }
      // Botones del mensaje de publicación (Copiar / Abrir / Descargar).
      var cp = e.target && e.target.closest ? e.target.closest('[data-publish-copy]') : null;
      if (cp) {
        var u = cp.getAttribute('data-publish-copy');
        var done = function () { cp.textContent = 'Copiado ✓'; setTimeout(function () { cp.textContent = '📋 Copiar enlace'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(done, done);
        else done();
        return;
      }
      var op = e.target && e.target.closest ? e.target.closest('[data-publish-open]') : null;
      if (op) { window.open(op.getAttribute('data-publish-open'), '_blank'); return; }
      var dl = e.target && e.target.closest ? e.target.closest('[data-download-html]') : null;
      if (dl && state.html) {
        var blob = new Blob([state.html], { type: 'text/html' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = state.name + '.html';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });
    // Sesión del servidor: si hay cookie, el contador y los proyectos
    // vienen de la DB (cuenta nueva -> lista vacía; login -> sus
    // proyectos). Sin DB, queda el modo anónimo local (3 cambios).
    if (window.DMDUsage && window.DMDUsage.sync) {
      window.DMDUsage.sync().then(function () {
        updateUsageUI();
        return syncServerProjects();
      }).then(function () { restoreLastProject(); });
    } else {
      restoreLastProject();
    }
    // Banner de fallback local (A4): su botón "Reintentar con IA" vive
    // fuera del thread, así que necesita su propio listener.
    var lb = $('localBanner');
    if (lb) lb.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-retry-ai]') : null;
      if (b && !state.busy && lastAiFailedPrompt) { hideLocalBanner(); handlePrompt(lastAiFailedPrompt, { retry: true }); }
    });
    // El ejemplo (?example=) lo carga el script inline de app.html.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
