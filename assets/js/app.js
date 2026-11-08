/**
 * app.js — Controlador del builder (estética Lovable).
 * Flujo de generación:
 *   1. Intenta la IA real de DMD: POST /api/generate (Groq, en el servidor).
 *      Antes de decidir, re-verifica la salud del backend (LLM.ensureReady)
 *      y, si la generación falla, la reintenta una vez (P0-1).
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
    // En móvil, tras generar, cambiar automáticamente a la vista previa.
    if (isMobileView()) setMobileView('stage');
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

  // Prompt del último fallo de IA, para el botón "Reintentar con IA".
  var lastAiFailedPrompt = '';

  async function handlePrompt(promptText, opts) {
    if (state.busy) return;
    var prompt = (promptText || '').trim();
    if (!prompt) return;
    state.busy = true;

    // Al reintentar no se duplica el mensaje del usuario: ya está en el chat.
    var isRetry = !!(opts && opts.retry);
    if (!isRetry) addMsg('user', 'Tú', prompt);
    var agentEl = addMsg('agent', 'DMD', 'Creando tu página…');
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
        var attachNote = '';
        if (state.attachments.logo || state.attachments.photos.length) {
          attachNote = '<br><span class="muted">Usé tu logo' +
            (state.attachments.photos.length ? ' y ' + state.attachments.photos.length + ' foto(s) de tus productos' : '') +
            ' en la página.</span>';
        }
        agentEl.innerHTML = doneHtml + esc(summary || ('Listo: ' + (spec.title || 'tu página'))) +
          '<br><span class="muted">Generado con IA Groq 🤖</span>' + attachNote;
      } else {
        // Aviso visible (no silencioso): la versión es del motor local y
        // se ofrece reintentar el MISMO prompt contra la IA (P0-1).
        lastAiFailedPrompt = prompt;
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
        ['Portafolio', 'portafolio'], ['SaaS', 'saas'], ['Tienda de café', 'cafe']
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
            '🎉 Tu página ya está en vivo en <a href="' + esc(data.url) + '" target="_blank" rel="noopener">' + esc(data.url) + '</a>' +
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
    restoreLastProject();
    // El ejemplo (?example=) lo carga el script inline de app.html.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
