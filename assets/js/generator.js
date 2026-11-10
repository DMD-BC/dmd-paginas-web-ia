/* ============================================================
   generator.js — "motor de generación" local del clon.
   Cumple el rol del LLM + Code Generation Engine de Lovable, pero de
   forma determinista: parsea el prompt, construye un "spec" y renderiza
   archivos reales (index.html / styles.css / script.js) que se montan
   en el iframe de preview.
   ============================================================ */
(function () {
  "use strict";

  /* ------------------------------------------------------------------
     1. Utilidades
     ------------------------------------------------------------------ */
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ------------------------------------------------------------------
     1b. Imágenes: FOTOS REALES de Unsplash como PRIMARIAS.
     Pollinations YA NO se usa en la ruta principal. Motivo (2026-11-08):
     cuando Pollinations llega a su límite gratis devuelve su tarjeta
     amarilla "Free limit reached" como imagen HTTP 200, así que el
     onerror del <img> nunca se dispara y la tarjeta se veía en la
     página generada (caso "Panadería La Espiga"). Una tarjeta de
     error con 200 no se puede detectar con onerror, así que la única
     forma segura de que nunca se vea es no poner Pollinations como
     imagen principal. Todas las fotos salen del catálogo UNSPLASH
     de abajo: cada ID fue verificado con curl (HTTP 200) antes de
     entrar aquí; source.unsplash.com está deprecado y NO se usa.
     Si una query no tiene foto curada, se usa un gradiente (nunca
     una URL inventada que dé 404 ni una imagen rota).
     ------------------------------------------------------------------ */
  /* Catálogo de fotos: vive en assets/js/image-catalog.js (se carga
     antes que este archivo en app.html). Se separó para que este
     archivo no supere el límite de 128 KB por argumento al subirlo
     a Vercel. Si el catálogo no cargó, las fotos caen a gradiente. */
  const UNSPLASH = (window.DMDImages && window.DMDImages.UNSPLASH) || {};
  const UNSPLASH_DEFAULT = UNSPLASH.tienda || UNSPLASH.restaurante || "";
  const UNSPLASH_KEYWORDS = (window.DMDImages && window.DMDImages.UNSPLASH_KEYWORDS) || [[/.*/, ""]];
  const unsplashUrl = (window.DMDImages && window.DMDImages.unsplashUrl) || (function () { return null; });
  const pollinationsUrl = (window.DMDImages && window.DMDImages.pollinationsUrl) || (function () { return null; });

  const normQuery = (q) => String(q || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  /* ------------------------------------------------------------------
     1c. Imágenes generadas por IA (Pollinations FLUX) — DESACTIVADO
     como imagen principal. Se conserva pollinationsUrl() solo por
     compatibilidad (otros scripts la exportan), pero NINGUNA imagen
     de una página generada sale de Pollinations: su tarjeta de
     límite gratis llega como HTTP 200 y no hay forma fiable de
     detectarla con onerror. Las fotos reales de Unsplash son la
     única fuente de imágenes de las páginas generadas.
     ------------------------------------------------------------------ */
  /* pollinationsUrl() vive en image-catalog.js (solo compatibilidad:
     Pollinations ya no es fuente de imágenes de las páginas). */

  // <img> con foto REAL de Unsplash (primaria y única fuente).
  // Se busca primero por la query de imagen y luego por el nombre
  // del item ("Bolillo tradicional" -> foto de pan), así cada
  // imagen corresponde a lo que muestra. Si no hay foto curada,
  // se usa un gradiente (nunca Pollinations, nunca una imagen rota).
  //
  // FOTOS SUBIDAS POR EL USUARIO (botón "+" del composer): si el
  // spec trae uploadedPhotos [{name, dataUrl}] y/o logo, esas
  // fotos tienen prioridad sobre Unsplash. Se asignan por nombre:
  // si el nombre del archivo comparte una palabra con el producto
  // ("bolillo.jpg" -> "Bolillo tradicional") va a ese producto;
  // si no hay coincidencia, se reparten en orden entre los
  // productos; con una sola foto, va al hero. Cada foto se usa
  // una sola vez por página (customUsed).
  var customPhotos = [];
  var customUsed = {};
  var wordsOf = function (s) {
    return normQuery(s || "").split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2; });
  };
  var customImageFor = function (query, alt, allowFallback) {
    if (!customPhotos.length) return null;
    var hay = wordsOf((query || "") + " " + (alt || ""));
    // 1) Coincidencia por nombre de archivo.
    for (var i = 0; i < customPhotos.length; i++) {
      if (customUsed[i]) continue;
      var fw = wordsOf(customPhotos[i].name || "");
      if (fw.some(function (w) { return hay.indexOf(w) !== -1; })) {
        customUsed[i] = true;
        return customPhotos[i].dataUrl;
      }
    }
    // 2) Sin coincidencia: repartir en orden (una foto por producto).
    // El hero NO roba fotos por orden: solo toma una si coincide por
    // nombre o si es la única foto subida; si no, queda la foto real
    // de Unsplash y la foto del producto va a su producto.
    if (!allowFallback) return null;
    for (var j = 0; j < customPhotos.length; j++) {
      if (!customUsed[j]) {
        customUsed[j] = true;
        return customPhotos[j].dataUrl;
      }
    }
    return null;
  };
  const imgHtml = (query, alt, cls, w, h) => {
    var isHero = (cls || "") === "hero__ph";
    var custom = customImageFor(query, alt, !isHero || customPhotos.length === 1);
    if (custom) return `<img class="${cls || "phimg"}" src="${custom}" alt="${esc(alt || "")}" loading="lazy" onerror="this.style.display='none';">`;
    const real = unsplashUrl(query, w) || unsplashUrl(alt, w);
    if (!real) return `<div class="${cls || "phimg"}" role="img" aria-label="${esc(alt || "")}"></div>`;
    return `<img class="${cls || "phimg"}" src="${real}" alt="${esc(alt || "")}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';">`;
  };

  const PLACEHOLDER_RE = /beneficio\s*\d|lorem|lo que te hace diferente|prueba social y confianza|llamado a la acci[oó]n claro|genera una p[aá]gina de|generada a partir de tu idea/i;
  const isPlaceholder = (s) => !s || PLACEHOLDER_RE.test(String(s));
  const formatPrice = (p) => {
    if (p === undefined || p === null || String(p).trim() === "") return "";
    const s = String(p).trim();
    // Precios siempre con 2 decimales ($1.50, no $1.5). Solo se
    // reformatea un precio simple ($149, 1.5, $2,500 MXN); textos
    // como "Gratis" o "desde $99" se dejan tal cual.
    const m = s.match(/^\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(MXN)?$/i);
    if (!m) return s;
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) return s;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (m[2] ? " MXN" : "");
  };
  // Normaliza un item: acepta objeto {name,title,description,price,
  // imageQuery} o string simple. Devuelve null si es relleno.
  const normalizeItem = (it) => {
    if (typeof it === "string") {
      return isPlaceholder(it) ? null : { name: it.trim(), description: "", price: "", imageQuery: "" };
    }
    if (!it || typeof it !== "object") return null;
    const name = String(it.name || it.title || "").trim();
    const description = String(it.description || it.desc || it.content || "").trim();
    if (!name || isPlaceholder(name) || isPlaceholder(description)) return null;
    // period: "mes" solo para planes de suscripción (lo usa pricingHtml
    // para decidir si muestra "/mes"); cualquier otro valor se ignora.
    const period = String(it.period || "").trim().toLowerCase() === "mes" ? "mes" : "";
    return { name, description, price: formatPrice(it.price), imageQuery: String(it.imageQuery || "").trim(), period };
  };
  // Normaliza un spec: las secciones pueden ser strings viejos
  // (["nav","hero","features"]) u objetos ricos del nuevo Groq.
  // Devuelve { ...spec, sections: [claves], rich: { clave: sección } }.
  const RICH_KEY = { hero: "hero", features: "features", menu: "menu", gallery: "gallery", pricing: "pricing", testimonials: "testimonials", faq: "faq", stats: "stats", contact: "contact", cta: "cta", footer: "footer", form: "contact", nav: "nav" };
  const normalizeSpec = (spec) => {
    const out = Object.assign({}, spec);
    out.sections = Array.isArray(spec.sections) ? spec.sections.slice() : [];
    // Conservar el mapa rico si el spec ya lo trae (p. ej. tras applyEdit).
    out.rich = Object.assign({}, spec.rich || {});
    const keys = [];
    out.sections.forEach((s) => {
      if (typeof s === "string") { if (!keys.includes(s)) keys.push(s); return; }
      if (!s || typeof s !== "object" || !s.type) return;
      const key = RICH_KEY[s.type] || s.type;
      if (!out.rich[key]) {
        out.rich[key] = {
          type: key,
          title: isPlaceholder(s.title) ? "" : String(s.title || "").trim(),
          content: isPlaceholder(s.content) ? "" : String(s.content || "").trim(),
          imageQuery: String(s.imageQuery || "").trim(),
          items: (Array.isArray(s.items) ? s.items : []).map(normalizeItem).filter(Boolean)
        };
      }
      if (!keys.includes(key)) keys.push(key);
    });
    out.sections = keys;
    return out;
  };
  // Tolerante a spec undefined/null (C2): si un renderer se llama sin
  // spec, devuelve null en vez de romper con "reading 'rich'".
  const richSec = (spec, key) => (spec && spec.rich && spec.rich[key]) || null;

  const COLORES = {
    verde: "#16a34a", green: "#16a34a",
    azul: "#2563eb", blue: "#2563eb",
    rojo: "#dc2626", red: "#dc2626",
    naranja: "#ea580c", orange: "#ea580c",
    rosa: "#db2777", pink: "#db2777",
    amarillo: "#eab308", yellow: "#eab308",
    violeta: "#7c3aed", morado: "#7c3aed", purple: "#7c3aed", lila: "#7c3aed",
    turquesa: "#0d9488", teal: "#0d9488", cian: "#0891b2",
    negro: "#111318", negro1: "#111318", gris: "#64748b", gray: "#64748b"
  };

  const TIPOS = [
    { key: "ecommerce", re: /(tienda|e-?commerce|ecommerce|carrito|shop|productos|productos?|catálogo|catalogo)/ },
    { key: "dashboard", re: /(dashboard|panel de control|anal[íi]tica|m[ée]tricas?|gr[áa]fic|reportes?|admin)/ },
    { key: "kanban", re: /(kanban|tablero|trello|columnas|scrum)/ },
    { key: "todo", re: /(tareas?|todo|to-?do|lista de pendientes|checklist|productividad)/ },
    { key: "chat", re: /(chat|mensajer[íi]a|conversaci[óo]n|mensajes)/ },
    { key: "portfolio", re: /(portafolio|portfolio|freelance|fot[óo]graf|dise[ñn]ador|artista)/ },
    { key: "blog", re: /(blog|art[íi]culos?|publicaciones|revista|noticias)/ },
    { key: "pricing", re: /(precios|pricing|planes de pago|tarifas)/ },
    { key: "auth", re: /(login|inicio de sesi[óo]n|registro|sign ?up|autenticaci[óo]n|formulario de acceso)/ },
    { key: "quiz", re: /(quiz|trivia|cuestionario|preguntas)/ },
    { key: "calculator", re: /(calculadora|calculator|calcula)/ },
    { key: "weather", re: /(clima|weather|tiempo meteorol[óo]gico|temperatura)/ },
    { key: "calendar", re: /(calendario|calendar|agenda|eventos)/ },
    { key: "notes", re: /(notas|notes|bloc de notas|cuaderno|memo)/ },
    { key: "crm", re: /(crm|contactos|pipeline|leads|clientes potenciales)/ },
    { key: "recipes", re: /(recetas?|recipes?|cocina|ingredientes)/ },
    { key: "fitness", re: /(fitness|gimnasio|gym|entrenamiento|rutina|ejercicio)/ },
    { key: "expenses", re: /(gastos|finanzas|presupuesto|balance|expensas)/ },
    { key: "forum", re: /(foro|forum|hilos|debate|comunidad)/ },
    { key: "bookings", re: /(reservas?|reservaciones|booking|turnos|restaurante)/ },
    { key: "landing", re: /(landing|p[áa]gina web|sitio web|p[áa]gina de inicio|web para|site)/ }
  ];

  const SECCIONES_LANDING = [
    { key: "nav", re: /(menu|men[úu]|navegaci[óo]n|navbar|header)/ },
    { key: "hero", re: /(hero|portada|encabezado principal)/ },
    { key: "features", re: /(caracter[íi]sticas|features|beneficios|servicios|funcionalidades)/ },
    { key: "gallery", re: /(galer[íi]a|gallery|im[áa]genes|showcase)/ },
    { key: "testimonials", re: /(testimonios?|reviews?|rese[ñn]as|opiniones)/ },
    { key: "pricing", re: /(precios?|pricing|planes|tarifas)/ },
    { key: "faq", re: /(faq|preguntas frecuentes)/ },
    { key: "contact", re: /(contacto|contact|formulario)/ },
    { key: "footer", re: /(footer|pie de p[áa]gina)/ }
  ];

  const ORDEN = SECCIONES_LANDING.map((s) => s.key);
  const ordenar = (secs) => uniq(secs).sort((a, b) => ORDEN.indexOf(a) - ORDEN.indexOf(b));

  /* ------------------------------------------------------------------
     2. analyze(prompt) -> spec
     ------------------------------------------------------------------ */
  function analyze(prompt, prev) {
    const p = (prompt || "").toLowerCase();

    // tipo de app
    // Señal fuerte: si el prompt pide explícitamente una landing/página web,
    // tiene prioridad sobre palabras sueltas como "precios" o "blog".
    const SITIO = /(landing page|landing|p[áa]gina web|sitio web|p[áa]gina de inicio)/;
    let type = "landing";
    // C2/M4: un prompt de NEGOCIO ("mi papelería con precios", "servicio
    // de meseros para eventos") es una landing de ese negocio, nunca una
    // app de precios/agenda: "precios" o "eventos" sueltos no cambian el
    // tipo cuando hay un giro detectado.
    if (detectBusiness(p)) {
      type = "landing";
    } else if (!SITIO.test(p)) for (const t of TIPOS) if (t.re.test(p)) { type = t.key; break; }

    // tema
    const dark = /(oscuro|dark|modo noche|tema negro|negro)/.test(p) ? true
      : /(claro|light|blanco|tema blanco)/.test(p) ? false
      : prev ? prev.dark : false;

    // acento
    let accent = prev ? prev.accent : "#7c3aed";
    const hex = p.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/);
    if (hex) accent = hex[0];
    else for (const [k, v] of Object.entries(COLORES)) if (p.includes(k)) { accent = v; break; }

    // título / nombre
    let title = prev ? prev.title : "";
    const quoted = prompt.match(/["“']([^"”']{2,40})["”']/);
    const named = p.match(/(?:llamad[ao]|se llama|nombre)\s+([a-z0-9áéíóúñ ]{2,24})/);
    if (quoted) title = quoted[1].trim();
    else if (named) title = cap(named[1].trim());
    if (!title) title = defaultTitle(type, p);

    // secciones (propio de landings)
    let sections = prev ? prev.sections.slice() : ["nav", "hero", "features", "footer"];
    if (type === "landing" || /(secci[óo]n|a[ñn]ade|agrega|incluye)/.test(p)) {
      const found = SECCIONES_LANDING.filter((s) => s.re.test(p)).map((s) => s.key);
      if (found.length) {
        if (!prev) sections = uniq(["nav", "hero", "features", ...found.filter((k) => k !== "nav" && k !== "hero" && k !== "features"), "footer"]);
        else sections = uniq([...sections, ...found.filter((k) => k !== "nav" && k !== "hero")]);
      }
    }
    // orden canónico
    sections = ordenar(sections);

    const spec = {
      type, title, accent, dark, sections,
      tagline: prev ? prev.tagline : defaultTagline(type, title, prompt),
      prompt: prompt || (prev && prev.prompt) || ""
    };
    return spec;
  }

  const cap = (s) => String(s).replace(/(^|[\s-])([a-záéíóúñ])/g, (_, sp, c) => sp + c.toUpperCase());
  const uniq = (a) => Array.from(new Set(a));
  const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mi-app";

  function defaultTitle(type, p) {
    const map = {
      ecommerce: "Nova Store", dashboard: "Pulseboard", kanban: "Flowboard",
      todo: "Taskly", chat: "Chitchat", portfolio: "Folio", blog: "Briefly",
      pricing: "Planos", auth: "Acceso", quiz: "Quizzy", calculator: "Calc",
      weather: "Skycast", calendar: "Tempo", notes: "Notely", crm: "Pipely",
      recipes: "Sazón", fitness: "Reps", expenses: "Bolsillo", forum: "Debate",
      bookings: "Mesa", landing: "Nova"
    };
    if (type === "landing") {
      const m = p.match(/(?:para|de)\s+(?:un[ao]?\s+)?([a-z0-9áéíóúñ ]{3,28})/);
      if (m) return cap(m[1].trim().split(" ").slice(0, 3).join(" "));
    }
    return map[type] || "Mi App";
  }
  /* ------------------------------------------------------------------
     2b. Textos por giro de negocio (respaldo local, P0-4).
     El generador local no es un LLM: antes ponía a cualquier negocio
     el texto genérico de SaaS ("ayuda a tu equipo a avanzar más
     rápido"). Ahora detecta el giro por palabras clave del prompt /
     título (sin acentos) y usa tagline y textos de sección acordes.
     Lo específico va antes que lo genérico. Sin coincidencia, el
     neutro NO habla de equipos ni de SaaS.
     ------------------------------------------------------------------ */
  const BUSINESS_TYPES = window.DMD_BUSINESS_TYPES || [];
  const detectBusiness = (text) => {
    const t = normQuery(text || "");
    for (const b of BUSINESS_TYPES) if (b.re.test(t)) return b;
    return null;
  };

  const defaultTagline = (type, title, prompt) => {
    if (type === "landing") {
      const biz = detectBusiness((prompt || "") + " " + (title || ""));
      if (biz) return biz.tagline(title);
      return `${title} — calidad y servicio cerca de ti.`;
    }
    const map = {
      ecommerce: "Productos seleccionados, entrega rápida.",
      dashboard: "Todas tus métricas en un solo lugar.",
      kanban: "Organiza el trabajo de tu equipo.",
      todo: "Organiza tu día, una tarea a la vez.",
      chat: "Conversaciones simples y rápidas.",
      portfolio: "Diseño y proyectos seleccionados.",
      blog: "Ideas, notas y artículos.",
      pricing: "Planes para cada etapa.",
      auth: "Bienvenido de vuelta.",
      quiz: "Pon a prueba tus conocimientos.",
      calculator: "Calcula en segundos.",
      weather: "El clima de tu ciudad.",
      calendar: "Agenda y organiza tus eventos.",
      notes: "Captura tus ideas al vuelo.",
      crm: "Gestiona contactos y oportunidades.",
      recipes: "Recetas fáciles para cada día.",
      fitness: "Sigue tu entrenamiento diario.",
      expenses: "Controla en qué se va tu dinero.",
      forum: "Comparte y debate con la comunidad.",
      bookings: "Reserva tu mesa en segundos."
    };
    return map[type] || "Construido con IA.";
  };

  /* ------------------------------------------------------------------
     3. applyEdit(spec, prompt) -> { spec, changes }
     ------------------------------------------------------------------ */
  function applyEdit(rawSpec, prompt) {
    // Normaliza primero: un spec de Groq trae secciones-objeto; aquí
    // trabajamos con claves y el mapa rico se conserva en next.rich.
    const spec = normalizeSpec(rawSpec);
    const p = (prompt || "").toLowerCase();
    const next = JSON.parse(JSON.stringify(spec));
    const changes = [];

    if (/(oscuro|dark|modo noche|tema negro)/.test(p) && !next.dark) { next.dark = true; changes.push("Activé el modo oscuro"); }
    if (/(claro|light|tema blanco|quita el modo oscuro)/.test(p) && next.dark) { next.dark = false; changes.push("Cambié a tema claro"); }

    const hex = p.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/);
    if (hex) { next.accent = hex[0]; changes.push(`Cambié el color de acento a ${hex[0]}`); }
    else for (const [k, v] of Object.entries(COLORES)) {
      if (p.includes(k) && /(color|acento|bot[óo]n|tema)/.test(p)) { next.accent = v; changes.push(`Cambié el acento a ${k}`); break; }
    }

    const t = prompt.match(/(?:t[íi]tulo|nombre|ll[áa]mal[ao]|cambia a)\s*[:"']?\s*([^"'.]{2,40})/i);
    if (t) {
      next.title = cap(t[1].trim().replace(/^(a|el|la|un|una)\s+/i, "").trim());
      changes.push(`Nuevo título: “${next.title}”`);
    }

    // añadir/quitar secciones: se procesa cláusula por cláusula para que
    // "añade faq y quita testimonios" no se pise a sí mismo.
    const clausulas = p.split(/\s+y\s+|,|;|\.|\btambi[ée]n\b/);
    const added = [], removed = [];
    clausulas.forEach((c) => {
      const secs = SECCIONES_LANDING.filter((s) => s.re.test(c)).map((s) => s.key);
      if (!secs.length) return;
      if (/(quita|elimina|borra|remueve|saca|\bsin\b)/.test(c)) removed.push(...secs);
      else if (/(a[ñn]ade|agrega|a[ñn]adir|incluye|suma|pon|con)/.test(c)) added.push(...secs);
    });
    if (removed.length) {
      next.sections = next.sections.filter((k) => !removed.includes(k));
      changes.push("Quité: " + uniq(removed).join(", "));
    }
    const add = added.filter((k) => !next.sections.includes(k) && !removed.includes(k) && k !== "nav" && k !== "hero");
    if (add.length) { next.sections = uniq([...next.sections, ...add]); changes.push("Añadí: " + uniq(add).join(", ")); }
    next.sections = ordenar(next.sections);

    // cambio de tipo
    for (const tp of TIPOS) if (tp.re.test(p) && /(c[aá]mbia|convierte|haz|transforma)/.test(p) && tp.key !== next.type) {
      next.type = tp.key; changes.push(`Convertí el proyecto a “${tp.key}”`); break;
    }

    if (!changes.length) changes.push("Actualicé el estilo y el contenido");
    return { spec: next, changes };
  }

  /* ------------------------------------------------------------------
     4. Render base (CSS común + helpers de layout)
     ------------------------------------------------------------------ */
  function baseCss(spec) {
    const dark = spec.dark;
    const bg = dark ? "#0e1014" : "#ffffff";
    const surface = dark ? "#161a21" : "#f7f7f8";
    const card = dark ? "#1a1f27" : "#ffffff";
    const fg = dark ? "#f4f5f7" : "#12141a";
    const muted = dark ? "rgba(244,245,247,.64)" : "rgba(18,20,26,.62)";
    const border = dark ? "rgba(255,255,255,.12)" : "rgba(18,20,26,.1)";
    
    // Variaciones por tema
    let themeStyles = "";
    if (spec.theme === "glass") {
      themeStyles = `
        .card { background: rgba(255,255,255,0.05); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.1); }
        .btn { backdrop-filter: blur(4px); }
      `;
    } else if (spec.theme === "brutal") {
      themeStyles = `
        .card, .btn, .inp { border: 3px solid var(--fg); border-radius: 0; box-shadow: 6px 6px 0 var(--fg); }
        .btn:hover { transform: translate(-2px, -2px); box-shadow: 8px 8px 0 var(--fg); }
      `;
    } else if (spec.theme === "soft") {
      themeStyles = `
        :root { --r: 24px; --r-sm: 16px; }
        .card { box-shadow: 0 10px 30px -10px rgba(0,0,0,0.05); border: none; }
      `;
    }

    return `:root{
  --accent:${spec.accent};
  --bg:${bg};--surface:${surface};--card:${card};
  --fg:${fg};--muted:${muted};--border:${border};
  --r:12px;--r-sm:8px;--r-pill:999px;
}
${themeStyles}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
h1,h2,h3{margin:0;line-height:1.15;letter-spacing:-.02em}
p{margin:0}
img{max-width:100%;display:block}
button{font:inherit;cursor:pointer}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:var(--r-sm);border:1px solid transparent;background:var(--accent);color:#fff;font-weight:600;font-size:15px;transition:.15s}
.btn:hover{filter:brightness(1.08)}
.btn--ghost{background:transparent;color:var(--fg);border-color:var(--border)}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r)}
.muted{color:var(--muted)}
.pill{display:inline-block;padding:6px 12px;border-radius:var(--r-pill);border:1px solid var(--border);font-size:13px;color:var(--muted)}
input,textarea,select{font:inherit}
::selection{background:var(--accent);color:#fff}`;
  }

  const navHtml = (spec) => `
<header class="nav">
  <div class="wrap nav__in">
    <a class="nav__brand" href="#">${spec.logo ? `<img class="nav__logo" src="${spec.logo}" alt="Logo de ${esc(spec.title)}">` : `<span class="dot"></span>`}${esc(spec.title)}</a>
    <nav class="nav__links">
      <a href="#features">Producto</a><a href="#pricing">Precios</a><a href="#faq">Docs</a>
    </nav>
    <div class="nav__cta"><a class="btn btn--ghost" href="#">Entrar</a><a class="btn" href="#">Empezar</a></div>
  </div>
</header>`;

  const navCss = `
.nav{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.nav__in{display:flex;align-items:center;justify-content:space-between;height:62px;gap:16px}
.nav__brand{display:flex;align-items:center;gap:8px;font-weight:700}
.nav__brand .nav__logo{height:30px;width:auto;max-width:150px;object-fit:contain}
.nav__brand .dot{width:12px;height:12px;border-radius:50%;background:var(--accent);display:inline-block}
.nav__links{display:flex;gap:20px;font-size:14px}
.nav__links a{color:var(--muted)}
.nav__links a:hover{color:var(--fg)}
.nav__cta{display:flex;gap:8px}`;

  // Hero: si el spec rico trae foto (heroImageQuery o sección hero),
  // se muestra la foto real; si no, el hero clásico con glow.
  // NUNCA se muestra spec.prompt: el prompt no es contenido.
  const heroHtml = (spec) => {
    const sec = richSec(spec, "hero");
    const imgQ = (sec && sec.imageQuery) || spec.heroImageQuery || "";
    const title = (sec && sec.title) || spec.title;
    const sub = (sec && sec.content) || spec.tagline;
    const photo = imgQ ? `<div class="hero__img">${imgHtml(imgQ, title, "hero__ph", 1024, 640)}</div>` : "";
    return `
<section class="hero">
  <div class="wrap">
    <span class="pill">✦ ${esc(spec.title)}</span>
    <h1 class="hero__t">${esc(title)}</h1>
    <p class="hero__s">${esc(sub)}</p>
    ${photo}
    <div class="hero__cta"><a class="btn" href="#">Empezar gratis</a><a class="btn btn--ghost" href="#">Ver demo</a></div>
  </div>
</section>`;
  };

  const heroCss = `
.hero{padding:88px 0 72px;text-align:center;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:-30% 20% auto 20%;height:60%;background:radial-gradient(closest-side,color-mix(in srgb,var(--accent) 32%,transparent),transparent);filter:blur(60px);pointer-events:none}
.hero__t{font-size:clamp(36px,6vw,58px);margin:16px 0 12px}
.hero__s{max-width:560px;margin:0 auto;color:var(--muted);font-size:18px}
.hero__cta{display:flex;gap:10px;justify-content:center;margin-top:26px;flex-wrap:wrap}`;

  const FEATURES = [
    ["⚡", "Rápido por defecto", "Rendimiento optimizado sin configuración extra."],
    ["🔒", "Seguro", "Buenas prácticas integradas desde el inicio."],
    ["🎨", "Diseño cuidado", "Una interfaz limpia lista para producción."],
    ["📱", "Responsive", "Se ve bien en móvil, tablet y escritorio."],
    ["🔌", "Integrable", "Conecta con tus herramientas favoritas."],
    ["📈", "Escalable", "Crece contigo cuando tu producto despega."]
  ];
  const featuresHtml = (spec) => {
    // Spec rico: los beneficios vienen del modelo, con títulos reales.
    // El fallback genérico (FEATURES) solo se usa con specs viejos.
    const sec = richSec(spec, "features");
    const rich = sec && sec.items.length ? sec.items : null;
    // Sin spec rico (generador local): textos por giro de negocio (P0-4),
    // en vez del genérico de SaaS.
    const biz = !rich ? detectBusiness((spec.prompt || "") + " " + (spec.title || "")) : null;
    const list = rich
      ? rich.map((it) => ({ icon: "✦", title: it.name, desc: it.description }))
      : ((spec.content && spec.content.features) || (biz
        ? biz.features.map(([i, t, d]) => ({ icon: i, title: t, desc: d }))
        : FEATURES.map(([i, t, d]) => ({ icon: i, title: t, desc: d }))));
    const title = (sec && sec.title) || (biz ? biz.featuresTitle : "Todo lo que necesitas");
    const sub = (sec && sec.content) || (biz ? biz.featuresSub : "Funciones pensadas para que lances rápido y bien.");
    return `
<section class="sec" id="features"><div class="wrap">
  <h2 class="sec__t">${esc(title)}</h2>
  <p class="sec__s muted">${esc(sub)}</p>
  <div class="grid grid--3">${list.map((f) => `
    <article class="card f"><div class="f__i">${esc(f.icon || "✦")}</div><h3>${esc(f.title)}</h3><p class="muted">${esc(f.desc || "")}</p></article>`).join("")}
  </div>
</div></section>`;
  };
  const featuresCss = `
.sec{padding:64px 0}.sec__t{font-size:32px}.sec__s{margin-top:8px;font-size:16px}
.grid{display:grid;gap:16px;margin-top:32px}
.grid--3{grid-template-columns:repeat(3,1fr)}
.f{padding:22px}.f__i{font-size:22px;margin-bottom:10px}.f h3{font-size:18px}.f p{margin-top:6px;font-size:14px}`;

  const pricingHtml = (spec) => {
    spec = spec || {};
    const defaultPricing = [
      ["Free", "$0", ["1 proyecto", "Preview público", "Soporte comunidad"], "mes"],
      ["Pro", "$25", ["Proyectos ilimitados", "Dominio propio", "Backend incluido"], "mes"],
      ["Team", "$60", ["Todo lo de Pro", "Colaboración", "SSO y roles"], "mes"]
    ].map(([n, pr, items, period]) => ({ name: n, price: pr, items, period }));
    // Spec rico: planes reales del modelo (name=plan, price, description).
    const sec = richSec(spec, "pricing");
    const rich = sec && sec.items.length ? sec.items.map((it) => ({
      name: it.name, price: it.price || "", items: it.description ? [it.description] : [],
      description: it.description || "", period: it.period || ""
    })) : null;
    const list = rich || (spec.content && spec.content.pricing) || defaultPricing;

    return `
<section class="sec" id="pricing"><div class="wrap">
  <h2 class="sec__t">Precios simples</h2>
  <p class="sec__s muted">Empieza gratis, escala cuando quieras.</p>
  <div class="grid grid--3">
    ${list.map((p, i) => {
      // A2: "/mes" SOLO si es suscripción explícita (period:"mes" en el
      // spec, o la descripción dice suscripción/mensual). Un precio de
      // producto o servicio ($2 la copia, $2,500 el arreglo) no lleva /mes.
      const descText = (p.description || "") + " " + (p.items || []).join(" ");
      const isSub = p.period === "mes" || /suscripci|mensual|al mes|por mes/i.test(descText);
      const price = formatPrice(p.price) || p.price || "";
      return `
      <article class="card plan ${i === 1 ? "plan--hl" : ""}">
        <h3>${p.name}</h3><div class="plan__p">${price}${isSub ? '<span class="muted">/mes</span>' : ""}</div>
        <ul>${p.items.map((x) => `<li>${x}</li>`).join("")}</ul>
        <a class="btn ${i === 1 ? "" : "btn--ghost"}" style="width:100%" href="#">Elegir ${p.name}</a>
      </article>`;}).join("")}
  </div>
</div></section>`;
  };
  const pricingCss = `
.plan{padding:24px;display:flex;flex-direction:column;gap:12px}
.plan--hl{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.plan__p{font-size:38px;font-weight:700;letter-spacing:-.02em}
.plan__p span{font-size:14px;font-weight:400}
.plan ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;font-size:14px;color:var(--muted)}
.plan ul li::before{content:"✓ ";color:var(--accent);font-weight:700}`;

  const testimonialsHtml = (spec) => {
    const defaultTestimonials = [["Lancé en una tarde.", "Ana R."], ["El preview en vivo lo cambia todo.", "Diego M."], ["Del prompt al deploy sin salir.", "Sofía L."]];
    // Spec rico: name=autor (con ciudad), description=cita real.
    const sec = richSec(spec, "testimonials");
    const rich = sec && sec.items.length ? sec.items.map((it) => ({ quote: it.description || it.name, author: it.name })) : null;
    const list = rich || (spec.content && spec.content.testimonials) || defaultTestimonials.map(([q, a]) => ({ quote: q, author: a }));
    const title = (sec && sec.title) || "Lo que dicen";
    return `
<section class="sec" style="background:var(--surface)"><div class="wrap">
  <h2 class="sec__t">${esc(title)}</h2>
  <div class="grid grid--3">
    ${list.map((t) => `<figure class="card q"><blockquote>“${t.quote}”</blockquote><figcaption class="muted">— ${t.author}</figcaption></figure>`).join("")}
  </div>
</div></section>`;
  };
  const testimonialsCss = `.q{padding:22px}.q blockquote{margin:0 0 10px;font-size:17px}.q figcaption{font-size:13px}`;

  const galleryHtml = (spec) => {
    // Spec rico: fotos reales por item (imageQuery) o de la sección.
    const sec = spec ? richSec(spec, "gallery") : null;
    const queries = sec && sec.items.length
      ? sec.items.map((it) => it.imageQuery || sec.imageQuery)
      : (sec && sec.imageQuery ? [sec.imageQuery] : []);
    const title = (sec && sec.title) || "Galería";
    if (!queries.length) return `
<section class="sec"><div class="wrap"><h2 class="sec__t">${esc(title)}</h2>
  <div class="grid grid--3">${Array.from({ length: 6 }).map((_, i) =>
    `<div class="card g" style="--h:${140 + (i % 3) * 30}px"></div>`).join("")}</div>
</div></section>`;
    return `
<section class="sec"><div class="wrap"><h2 class="sec__t">${esc(title)}</h2>
  <div class="grid grid--3">${queries.map((q, i) => `<div class="card gimg">${imgHtml(q, (sec.items[i] && sec.items[i].name) || title, "gimg__ph", 800, 600)}</div>`).join("")}</div>
</div></section>`;
  };
  const galleryCss = `.g{height:var(--h);background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 18%,var(--card)),var(--card))}`;

  const faqHtml = (spec) => {
    spec = spec || {};
    const defaultFaq = [["¿Es fácil empezar?", "Sí, en minutos tienes algo funcionando."], ["¿Puedo cancelar?", "Cuando quieras, sin compromiso."], ["¿Hay soporte?", "Sí, por chat y correo."]];
    // Spec rico: name=pregunta, description=respuesta.
    const sec = richSec(spec, "faq");
    const rich = sec && sec.items.length ? sec.items.map((it) => ({ q: it.name, a: it.description })) : null;
    const list = rich || (spec.content && spec.content.faq) || defaultFaq.map(([q, a]) => ({ q, a }));
    const title = (sec && sec.title) || "Preguntas frecuentes";
    return `
<section class="sec" style="background:var(--surface)" id="faq"><div class="wrap"><h2 class="sec__t">${esc(title)}</h2>
  <div class="faq">${list.map((item) => `<details class="card faq__i"><summary>${item.q}</summary><p class="muted">${item.a}</p></details>`).join("")}</div>
</div></section>`;
  };
  const faqCss = `.faq{display:flex;flex-direction:column;gap:10px;margin-top:28px}.faq__i{padding:16px 18px}.faq__i summary{cursor:pointer;font-weight:600}.faq__i p{margin-top:8px;font-size:14px}`;

  const contactHtml = (spec) => {
    // Spec rico: items con horarios, ubicación, teléfono, etc.
    const sec = spec ? richSec(spec, "contact") : null;
    const info = sec && sec.items.length ? sec.items : [];
    const title = (sec && sec.title) || "Contáctanos";
    const sub = (sec && sec.content) || "";
    const infoHtml = info.length ? `<div class="grid grid--3" style="margin-top:20px">${info.map((it) => `
      <article class="card f"><h3>${esc(it.name)}</h3><p class="muted">${esc(it.description || it.price || "")}</p></article>`).join("")}</div>` : "";
    return `
<section class="sec"><div class="wrap"><h2 class="sec__t">${esc(title)}</h2>
  ${sub ? `<p class="sec__s muted">${esc(sub)}</p>` : ""}
  ${infoHtml}
  <form class="card cform" onsubmit="event.preventDefault();this.querySelector('.msg').textContent='¡Gracias! Te escribiremos pronto.'">
    <input class="inp" placeholder="Tu nombre" required>
    <input class="inp" type="email" placeholder="Tu correo" required>
    <textarea class="inp" rows="4" placeholder="Tu mensaje"></textarea>
    <button class="btn" type="submit">Enviar</button><p class="msg muted"></p>
  </form>
</div></section>`;
  };

  const contactCss = `.cform{padding:24px;display:flex;flex-direction:column;gap:12px;max-width:520px;margin-top:24px}.inp{padding:11px 13px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--fg)}.inp:focus{outline:2px solid color-mix(in srgb,var(--accent) 60%,transparent);outline-offset:0}`;

  // Menú (restaurantes, cafés, etc.): tarjetas con foto real, nombre,
  // descripción y precio en MXN. Solo existe si el spec trae items.
  const menuHtml = (spec) => {
    const sec = richSec(spec, "menu");
    if (!sec || !sec.items.length) return "";
    return `
<section class="sec" id="menu"><div class="wrap">
  <h2 class="sec__t">${esc(sec.title || "El menú")}</h2>
  ${sec.content ? `<p class="sec__s muted">${esc(sec.content)}</p>` : ""}
  <div class="grid grid--3">${sec.items.map((it) => `
    <article class="card dish">
      <div class="dish__img">${imgHtml(it.imageQuery || sec.imageQuery, it.name, "dish__ph", 800, 600)}</div>
      <div class="dish__b"><h3>${esc(it.name)}</h3><p class="muted">${esc(it.description)}</p>
      ${it.price ? `<span class="dish__p">${esc(it.price)}</span>` : ""}</div>
    </article>`).join("")}
  </div>
</div></section>`;
  };
  const menuCss = `
.dish{overflow:hidden;padding:0}
.dish__img{height:170px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 30%,var(--card)),var(--card))}
.dish__img img,.dish__img .phimg{width:100%;height:100%;object-fit:cover}
.dish__b{padding:18px}.dish__b h3{font-size:18px}.dish__b p{margin-top:6px;font-size:14px}
.dish__p{display:inline-block;margin-top:12px;font-weight:700;font-size:18px;color:var(--accent)}`;

  const statsHtml = (spec) => {
    const sec = richSec(spec, "stats");
    if (!sec || !sec.items.length) return "";
    return `
<section class="sec" style="background:var(--surface)"><div class="wrap">
  <div class="grid grid--3">${sec.items.map((it) => `
    <div class="stat"><strong>${esc(it.description || it.price || "")}</strong><span class="muted">${esc(it.name)}</span></div>`).join("")}
  </div>
</div></section>`;
  };
  const statsCss = `.stat{text-align:center}.stat strong{display:block;font-size:36px;letter-spacing:-.02em}.stat span{font-size:14px}`;

  const ctaHtml = (spec) => {
    const sec = richSec(spec, "cta");
    const title = (sec && sec.title) || `¿Listo para empezar con ${spec.title}?`;
    const sub = (sec && sec.content) || spec.tagline;
    return `
<section class="sec cta"><div class="wrap">
  <h2 class="sec__t">${esc(title)}</h2>
  ${sub ? `<p class="sec__s muted">${esc(sub)}</p>` : ""}
  <div class="hero__cta"><a class="btn" href="#">Empezar ahora</a></div>
</div></section>`;
  };
  const ctaCss = `.cta{text-align:center;background:var(--surface)}.cta .sec__s{max-width:520px;margin:8px auto 0}`;

  const footerHtml = (spec) => `
<footer class="ft"><div class="wrap ft__in">
  <div><strong>${esc(spec.title)}</strong><p class="muted" style="margin-top:6px;font-size:14px">${esc(spec.tagline)}</p></div>
  <div class="ft__cols">
    <div><h4>Producto</h4><a href="#">Features</a><a href="#">Precios</a></div>
    <div><h4>Empresa</h4><a href="#">Nosotros</a><a href="#">Contacto</a></div>
    <div><h4>Legal</h4><a href="#">Privacidad</a><a href="#">Términos</a></div>
  </div>
</div><div class="wrap muted" style="padding-top:16px;font-size:13px">© 2026 ${esc(spec.title)}. Generado con IA.</div></footer>`;
  const footerCss = `.ft{border-top:1px solid var(--border);padding:40px 0 24px;margin-top:20px}.ft__in{display:grid;grid-template-columns:1.4fr 2fr;gap:32px}.ft__cols{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.ft__cols h4{margin:0 0 10px;font-size:14px}.ft__cols a{display:block;font-size:14px;color:var(--muted);padding:3px 0}`;

  /* ------------------------------------------------------------------
     5. Templates por tipo de app
     ------------------------------------------------------------------ */
  const T = {};

  T.landing = (rawSpec) => {
    // Normaliza: secciones viejas (strings) y nuevas (objetos ricos)
    // conviven; el render usa la sección rica cuando existe.
    const spec = normalizeSpec(rawSpec);
    const build = {
      nav: [navHtml, navCss], hero: [heroHtml, heroCss], features: [featuresHtml, featuresCss],
      menu: [menuHtml, menuCss], gallery: [galleryHtml, galleryCss],
      testimonials: [testimonialsHtml, testimonialsCss],
      pricing: [pricingHtml, pricingCss], faq: [faqHtml, faqCss], contact: [contactHtml, contactCss],
      stats: [statsHtml, statsCss], cta: [ctaHtml, ctaCss], footer: [footerHtml, footerCss]
    };
    let html = "", css = "";
    // El nav siempre va arriba en una landing (aunque el spec de
    // Groq no lo liste): ahí es donde se ve el logo subido.
    if (!spec.sections.includes("nav")) {
      html += navHtml(spec);
      css += navCss;
    }
    spec.sections.forEach((k) => {
      if (build[k]) {
        html += build[k][0](spec);
        css += build[k][1];
      }
    });
    // CSS extra para fotos del hero y la galería
    css += `
.hero__img{max-width:760px;margin:28px auto 0;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 30%,var(--card)),var(--card))}
.hero__img img,.hero__img .phimg{width:100%;height:340px;object-fit:cover}
.gimg{overflow:hidden;padding:0;height:190px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 22%,var(--card)),var(--card))}
.gimg img,.gimg .phimg{width:100%;height:100%;object-fit:cover}
.phimg{background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 35%,var(--card)),var(--card))}`;
    return { html, css, js: "" };
  };

  T.todo = (spec) => {
    const html = `
<section class="app">
  <div class="head"><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div>
  <form class="addline card" id="addform"><input id="newtask" class="inp" placeholder="Escribe una nueva tarea…" autocomplete="off"><button class="btn" type="submit">Añadir</button></form>
  <div class="filters"><button class="chip is-on" data-f="all">Todas</button><button class="chip" data-f="active">Pendientes</button><button class="chip" data-f="done">Completadas</button><span class="muted" id="count"></span></div>
  <ul class="tasks card" id="tasks"></ul>
</section>`;
    const css = `.app{max-width:720px;margin:0 auto;padding:48px 24px}.head h1{font-size:34px}.head p{margin-top:6px}
.addline{display:flex;gap:10px;padding:12px;margin:24px 0 14px}.inp{flex:1;padding:11px 13px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--fg)}
.filters{display:flex;gap:8px;align-items:center;margin-bottom:14px}.chip{padding:6px 12px;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--fg);font-size:13px}.chip.is-on{background:var(--accent);border-color:var(--accent);color:#fff}
.filters .muted{margin-left:auto;font-size:13px}
.tasks{list-style:none;padding:8px;margin:0;display:flex;flex-direction:column;gap:6px}
.task{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:var(--r-sm);transition:.15s}
.task:hover{background:var(--surface)}
.task input{width:18px;height:18px;accent-color:var(--accent)}
.task span{flex:1}.task.done span{text-decoration:line-through;color:var(--muted)}
.task .del{border:0;background:transparent;color:var(--muted);font-size:18px;opacity:0}.task:hover .del{opacity:1}`;
    const js = `
const list=document.getElementById('tasks');const form=document.getElementById('addform');const inp=document.getElementById('newtask');const count=document.getElementById('count');
let items=[{t:'Diseñar la pantalla principal',done:false},{t:'Conectar base de datos',done:false},{t:'Publicar la primera versión',done:true}];
let filter='all';
function render(){list.innerHTML='';items.filter(i=>filter==='all'||(filter==='active'&&!i.done)||(filter==='done'&&i.done)).forEach((it,idx)=>{
  const li=document.createElement('li');li.className='task'+(it.done?' done':'');
  li.innerHTML='<input type="checkbox" '+(it.done?'checked':'')+'><span>'+it.t.replace(/[<>&]/g,'')+'</span><button class="del" title="Eliminar">×</button>';
  li.querySelector('input').onchange=e=>{it.done=e.target.checked;render();};
  li.querySelector('.del').onclick=()=>{items=items.filter(x=>x!==it);render();};
  list.appendChild(li);});
  count.textContent=items.filter(i=>!i.done).length+' pendientes';}
form.onsubmit=e=>{e.preventDefault();const v=inp.value.trim();if(!v)return;items.unshift({t:v,done:false});inp.value='';render();};
document.querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{filter=b.dataset.f;document.querySelectorAll('[data-f]').forEach(x=>x.classList.toggle('is-on',x===b));render();});
render();`;
    return { html, css, js };
  };

  T.dashboard = (spec) => {
    const html = `
<section class="dash">
  <aside class="side card">
    <div class="brand"><span class="dot"></span>${esc(spec.title)}</div>
    <nav><a class="on" href="#">Resumen</a><a href="#">Analíticas</a><a href="#">Clientes</a><a href="#">Ajustes</a></nav>
  </aside>
  <main class="main">
    <h1>Resumen</h1>
    <div class="kpis">
      <div class="card kpi"><span class="muted">Ingresos</span><strong id="k1">$48,120</strong><em class="up">▲ 12.4%</em></div>
      <div class="card kpi"><span class="muted">Usuarios</span><strong id="k2">8,942</strong><em class="up">▲ 4.1%</em></div>
      <div class="card kpi"><span class="muted">Conversión</span><strong id="k3">3.8%</strong><em class="down">▼ 0.6%</em></div>
      <div class="card kpi"><span class="muted">Sesiones</span><strong id="k4">21,477</strong><em class="up">▲ 9.2%</em></div>
    </div>
    <div class="charts">
      <div class="card panel"><h3>Ingresos por mes</h3><div class="bars" id="bars"></div></div>
      <div class="card panel"><h3>Canales</h3><ul class="legend">${[["Orgánico", 46], ["Pago", 28], ["Referidos", 16], ["Directo", 10]].map(([n, v]) => `<li><span>${n}</span><b>${v}%</b><i style="width:${v}%"></i></li>`).join("")}</ul></div>
    </div>
  </main>
</section>`;
    const css = `.dash{display:grid;grid-template-columns:220px 1fr;gap:18px;padding:18px;min-height:100vh}
.side{padding:18px;display:flex;flex-direction:column;gap:18px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700}.dot{width:11px;height:11px;border-radius:50%;background:var(--accent)}
.side nav{display:flex;flex-direction:column;gap:4px}.side a{padding:9px 11px;border-radius:var(--r-sm);font-size:14px;color:var(--muted)}.side a.on{background:var(--surface);color:var(--fg);font-weight:600}
.main h1{font-size:26px;margin-bottom:18px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.kpi{padding:16px;display:flex;flex-direction:column;gap:6px}.kpi span{font-size:13px}.kpi strong{font-size:24px}.kpi em{font-style:normal;font-size:13px}.up{color:#16a34a}.down{color:#dc2626}
.charts{display:grid;grid-template-columns:1.6fr 1fr;gap:14px;margin-top:14px}
.panel{padding:18px}.panel h3{font-size:15px;margin-bottom:14px}
.bars{display:flex;align-items:flex-end;gap:10px;height:180px}
.bars i{flex:1;background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 35%,transparent));border-radius:6px 6px 0 0}
.legend{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:14px}
.legend li{position:relative;font-size:13px;display:flex;justify-content:space-between}
.legend i{position:absolute;left:0;bottom:-6px;height:3px;background:var(--accent);border-radius:3px}
@media(max-width:820px){.dash{grid-template-columns:1fr}.kpis{grid-template-columns:1fr 1fr}.charts{grid-template-columns:1fr}}`;
    const js = `
const bars=document.getElementById('bars');[42,58,36,74,52,88,64,96,70,82,60,90].forEach(v=>{const i=document.createElement('i');i.style.height=v+'%';bars.appendChild(i);});
let n=48120;setInterval(()=>{n+=Math.floor(Math.random()*400);document.getElementById('k1').textContent='$'+n.toLocaleString('en-US');},1800);`;
    return { html, css, js };
  };

  T.kanban = (spec) => {
    const cols = ["Por hacer", "En progreso", "Hecho"];
    const html = `
<section class="board"><h1>${esc(spec.title)}</h1>
  <div class="cols">${cols.map((c, ci) => `
    <div class="col card" data-col="${ci}"><h3>${c}</h3>
      <div class="drop" data-drop="${ci}"></div>
      <form class="add"><input class="inp" placeholder="+ Añadir tarjeta"><button class="btn btn--ghost" type="submit">+</button></form>
    </div>`).join("")}
  </div></section>`;
    const css = `.board{padding:32px 24px}.board h1{font-size:26px;margin-bottom:20px}
.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.col{padding:14px;display:flex;flex-direction:column;gap:10px;min-height:320px}
.col h3{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.drop{display:flex;flex-direction:column;gap:8px;flex:1;min-height:40px}
.carditem{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-sm);padding:11px 13px;font-size:14px;cursor:grab}
.carditem.drag{opacity:.5}
.add{display:flex;gap:6px}.add .inp{flex:1;padding:9px 11px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--fg)}
.col.over{outline:2px dashed var(--accent);outline-offset:-4px}
@media(max-width:760px){.cols{grid-template-columns:1fr}}`;
    const js = `
const seed=[[0,'Diseñar wireframes'],[0,'Definir paleta'],[1,'Maquetar home'],[1,'Escribir copy'],[2,'Configurar repo']];
const drops=[...document.querySelectorAll('[data-drop]')];
function mk(t){const d=document.createElement('div');d.className='carditem';d.draggable=true;d.textContent=t;d.ondragstart=()=>d.classList.add('drag');d.ondragend=()=>d.classList.remove('drag');return d;}
seed.forEach(([c,t])=>drops[c].appendChild(mk(t)));
drops.forEach(dp=>{dp.ondragover=e=>{e.preventDefault();dp.parentElement.classList.add('over');};dp.ondragleave=()=>dp.parentElement.classList.remove('over');dp.ondrop=e=>{e.preventDefault();dp.parentElement.classList.remove('over');const el=document.querySelector('.drag');if(el)dp.appendChild(el);};});
document.querySelectorAll('.add').forEach(f=>f.onsubmit=e=>{e.preventDefault();const i=f.querySelector('input');if(!i.value.trim())return;f.parentElement.querySelector('.drop').appendChild(mk(i.value.trim()));i.value='';});`;
    return { html, css, js };
  };

  T.portfolio = (spec) => {
    const html = `
<section class="pf">
  <header class="pf__h"><div class="avatar"></div><div><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div></header>
  <h2 class="pf__t">Proyectos</h2>
  <div class="grid grid--3">${["Marca personal", "App móvil", "Sitio corporativo", "Identidad visual", "Campaña", "Editorial"]
    .map((t) => `<article class="card work"><div class="thumb"></div><h3>${t}</h3><p class="muted">Diseño · 2026</p></article>`).join("")}</div>
  <h2 class="pf__t">Contacto</h2>
  <div class="card ct"><p class="muted">¿Trabajamos juntos?</p><a class="btn" href="#">Escríbeme</a></div>
</section>`;
    const css = `.pf{max-width:1000px;margin:0 auto;padding:56px 24px}
.pf__h{display:flex;align-items:center;gap:18px;margin-bottom:40px}
.avatar{width:74px;height:74px;border-radius:50%;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 30%,var(--card)))}
.pf__h h1{font-size:34px}.pf__t{font-size:22px;margin:34px 0 16px}
.work{padding:14px}.thumb{height:150px;border-radius:var(--r-sm);background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 22%,var(--card)),var(--card));margin-bottom:12px}
.work h3{font-size:17px}.work p{font-size:13px;margin-top:4px}
.ct{padding:28px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}`;
    return { html, css, js: "" };
  };

  T.blog = (spec) => {
    const posts = [["Diseño de producto en 2026", "Cómo cambian las interfaces con IA"], ["Del prototipo al lanzamiento", "Un flujo de trabajo práctico"], ["Escribir mejor código", "Hábitos para equipos pequeños"]];
    const html = `
<section class="blog"><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p>
  <div class="posts">${posts.map(([t, d]) => `<article class="card post"><span class="pill">Artículo</span><h2>${t}</h2><p class="muted">${d}</p><a class="link" href="#">Leer más →</a></article>`).join("")}</div>
</section>`;
    const css = `.blog{max-width:820px;margin:0 auto;padding:56px 24px}.blog h1{font-size:36px}.blog>p{margin-top:8px}
.posts{display:flex;flex-direction:column;gap:16px;margin-top:32px}
.post{padding:24px}.post h2{font-size:22px;margin:10px 0 8px}.post p{font-size:15px}
.link{display:inline-block;margin-top:12px;color:var(--accent);font-weight:600;font-size:14px}`;
    return { html, css, js: "" };
  };

  T.ecommerce = (spec) => {
    const prods = [["Café de altura", 12], ["Cold brew", 9], ["Taza cerámica", 15], ["Molino manual", 34], ["Suscripción mensual", 28], ["Kit de filtros", 18]];
    const html = `
<header class="sh"><div class="wrap sh__in"><strong>${esc(spec.title)}</strong><div class="sh__r"><span class="cart">🛒 <b id="cnt">0</b></span></div></div></header>
<section class="wrap shop"><h1>Tienda</h1><p class="muted">${esc(spec.tagline)}</p>
  <div class="grid grid--3">${prods.map(([n, p], i) => `
    <article class="card prod"><div class="pimg"></div><h3>${n}</h3><div class="prow"><span class="price">$${p}</span><button class="btn" data-add="${i}">Añadir</button></div></article>`).join("")}
  </div>
</section>
<div class="toast" id="toast"></div>`;
    const css = `.sh{border-bottom:1px solid var(--border);position:sticky;top:0;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(8px)}
.sh__in{display:flex;align-items:center;justify-content:space-between;height:60px}.cart{font-size:15px}
.shop{padding:40px 24px}.shop>p{margin-top:6px}
.prod{padding:14px}.pimg{height:150px;border-radius:var(--r-sm);background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 22%,var(--card)),var(--card));margin-bottom:12px}
.prod h3{font-size:16px}.prow{display:flex;align-items:center;justify-content:space-between;margin-top:10px}.price{font-weight:700}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);background:#111;color:#fff;padding:10px 18px;border-radius:999px;font-size:14px;opacity:0;transition:.25s;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}`;
    const js = `
let n=0;const cnt=document.getElementById('cnt');const toast=document.getElementById('toast');
document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{n++;cnt.textContent=n;toast.textContent='Añadido al carrito';toast.classList.add('show');clearTimeout(window._t);window._t=setTimeout(()=>toast.classList.remove('show'),1400);});`;
    return { html, css, js };
  };

  T.chat = (spec) => {
    const html = `
<section class="chat"><header class="chat__h"><div class="av"></div><div><strong>${esc(spec.title)}</strong><p class="muted">En línea</p></div></header>
  <div class="msgs" id="msgs"></div>
  <form class="cinput" id="cform"><input class="inp" id="cin" placeholder="Escribe un mensaje…" autocomplete="off"><button class="btn" type="submit">Enviar</button></form>
</section>`;
    const css = `.chat{max-width:640px;margin:0 auto;display:flex;flex-direction:column;height:100vh}
.chat__h{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border)}
.chat__h p{font-size:12px}.av{width:36px;height:36px;border-radius:50%;background:var(--accent)}
.msgs{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:10px}
.bub{max-width:75%;padding:11px 14px;border-radius:16px;font-size:14px}
.bub.me{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}
.bub.them{align-self:flex-start;background:var(--surface);border-bottom-left-radius:4px}
.cinput{display:flex;gap:8px;padding:14px 20px;border-top:1px solid var(--border)}
.cinput .inp{flex:1;padding:11px 14px;border:1px solid var(--border);border-radius:999px;background:var(--bg);color:var(--fg)}`;
    const js = `
const msgs=document.getElementById('msgs');const form=document.getElementById('cform');const inp=document.getElementById('cin');
function add(t,me){const d=document.createElement('div');d.className='bub '+(me?'me':'them');d.textContent=t;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;}
add('¡Hola! ¿En qué puedo ayudarte?',false);
form.onsubmit=e=>{e.preventDefault();const v=inp.value.trim();if(!v)return;add(v,true);inp.value='';setTimeout(()=>add(['¡Buen punto!','Cuéntame más.','Puedo ayudarte con eso.'][Math.floor(Math.random()*3)],false),600);};`;
    return { html, css, js };
  };

  T.calculator = (spec) => {
    const keys = ["C", "±", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "0", ".", "="];
    const html = `
<section class="calc"><h1>${esc(spec.title)}</h1>
  <div class="card body"><output id="screen">0</output>
    <div class="keys">${keys.map((k) => `<button class="key ${/[0-9]/.test(k) ? "" : "key--fn"} ${k === "=" ? "key--eq" : ""}" data-k="${esc(k)}">${k}</button>`).join("")}</div>
  </div>
</section>`;
    const css = `.calc{max-width:340px;margin:0 auto;padding:48px 20px;text-align:center}.calc h1{font-size:22px;margin-bottom:16px}
.body{padding:16px}output{display:block;text-align:right;font-size:40px;font-weight:600;padding:12px 8px;overflow:hidden}
.keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}
.key{aspect-ratio:1;border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:50%;font-size:18px;transition:.12s}
.key:hover{filter:brightness(.96)}.key--fn{background:var(--card)}.key--eq{background:var(--accent);color:#fff;border-color:var(--accent)}`;
    const js = `
let cur='0',prev=null,op=null,fresh=false;const s=document.getElementById('screen');
const show=()=>s.textContent=String(cur).slice(0,12);
function calc(){const a=parseFloat(prev),b=parseFloat(cur);if(isNaN(a)||isNaN(b))return b;return op==='+'?a+b:op==='−'?a-b:op==='×'?a*b:op==='÷'?(b?a/b:0):b;}
document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>{const k=b.dataset.k;
 if(/[0-9]/.test(k)){cur=fresh?k:(cur==='0'?k:cur+k);fresh=false;}
 else if(k==='.'){if(!cur.includes('.'))cur+='.';}
 else if(k==='C'){cur='0';prev=null;op=null;}
 else if(k==='±'){cur=String(parseFloat(cur)*-1);}
 else if(k==='%'){cur=String(parseFloat(cur)/100);}
 else if(k==='='){if(op){cur=String(calc());prev=null;op=null;}}
 else{if(op&&!fresh){cur=String(calc());}prev=cur;op=k;fresh=true;}
 show();});show();`;
    return { html, css, js };
  };

  T.pricing = (spec) => {
    // C2: pricingHtml/faqHtml RECIBEN el spec (antes se llamaban sin
    // argumentos y rompían con TypeError reading 'rich').
    return { html: navHtml(spec) + heroHtml(spec) + pricingHtml(spec) + faqHtml(spec) + footerHtml(spec), css: navCss + heroCss + pricingCss + faqCss + footerCss, js: "" };
  };

  T.auth = (spec) => {
    const html = `
<section class="auth">
  <form class="card aform" onsubmit="event.preventDefault();this.querySelector('.note').textContent='Sesión iniciada (demo)'">
    <div class="logo"><span class="dot"></span>${esc(spec.title)}</div>
    <h1>Inicia sesión</h1><p class="muted">${esc(spec.tagline)}</p>
    <label class="lbl">Correo<input class="inp" type="email" placeholder="tu@correo.com" required></label>
    <label class="lbl">Contraseña<input class="inp" type="password" placeholder="••••••••" required></label>
    <div class="row"><label class="chk"><input type="checkbox"> Recordarme</label><a href="#" style="font-size:13px">¿Olvidaste tu contraseña?</a></div>
    <button class="btn" type="submit" style="width:100%">Entrar</button>
    <p class="note muted"></p>
    <p class="muted" style="text-align:center;font-size:14px">¿No tienes cuenta? <a href="#" style="color:var(--accent)">Regístrate</a></p>
  </form>
</section>`;
    const css = `.auth{min-height:100vh;display:grid;place-items:center;background:var(--surface);padding:24px}
.aform{width:min(400px,100%);padding:32px;display:flex;flex-direction:column;gap:14px}
.logo{display:flex;align-items:center;gap:8px;font-weight:700}.dot{width:11px;height:11px;border-radius:50%;background:var(--accent)}
.aform h1{font-size:24px}.aform>p{margin-top:-6px;font-size:14px}
.lbl{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
.inp{padding:11px 13px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--fg);font-size:14px}
.row{display:flex;align-items:center;justify-content:space-between;font-size:13px}.chk{display:flex;align-items:center;gap:6px;color:var(--muted)}
.note{font-size:13px;text-align:center;min-height:18px}`;
    return { html, css, js: "" };
  };

  T.quiz = (spec) => {
    const html = `
<section class="quiz"><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p>
  <div class="card qbox"><div class="qmeta"><span id="prog">Pregunta 1 / 5</span><span id="score" class="muted">Puntos: 0</span></div>
    <h2 id="q">…</h2><div class="opts" id="opts"></div><p id="fb" class="muted"></p></div>
</section>`;
    const css = `.quiz{max-width:620px;margin:0 auto;padding:48px 24px;text-align:center}.quiz h1{font-size:30px}.quiz>p{margin-top:6px}
.qbox{padding:26px;margin-top:26px;text-align:left}
.qmeta{display:flex;justify-content:space-between;font-size:13px;margin-bottom:14px}
.qbox h2{font-size:20px;margin-bottom:16px}
.opts{display:flex;flex-direction:column;gap:9px}
.opt{padding:13px 15px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--fg);text-align:left;transition:.15s}
.opt:hover{border-color:var(--accent)}.opt.ok{background:color-mix(in srgb,var(--accent) 20%,transparent);border-color:var(--accent)}
.opt.bad{border-color:#dc2626;color:#dc2626}
#fb{margin-top:12px;font-size:14px;min-height:20px}`;
    const js = `
const Q=[{q:'¿Qué significa HTML?',o:['HyperText Markup Language','High Tech Modern Language','Home Tool Markup'],a:0},
{q:'¿Cuál es un lenguaje de programación?',o:['CSS','JavaScript','JSON'],a:1},
{q:'¿Qué hace CSS?',o:['Estructura','Estilos','Base de datos'],a:1},
{q:'¿Qué es un componente?',o:['Una pieza reutilizable de UI','Un servidor','Un archivo'],a:0},
{q:'¿Qué es Git?',o:['Un editor','Control de versiones','Un framework'],a:1}];
let i=0,s=0;const q=document.getElementById('q'),opts=document.getElementById('opts'),fb=document.getElementById('fb'),prog=document.getElementById('prog'),score=document.getElementById('score');
function load(){if(i>=Q.length){q.textContent='¡Terminaste!';opts.innerHTML='';fb.textContent='Puntaje final: '+s+' / '+Q.length;return;}
const it=Q[i];prog.textContent='Pregunta '+(i+1)+' / '+Q.length;score.textContent='Puntos: '+s;q.textContent=it.q;fb.textContent='';opts.innerHTML='';
it.o.forEach((t,k)=>{const b=document.createElement('button');b.className='opt';b.textContent=t;b.onclick=()=>{
 Array.from(opts.children).forEach((c,idx)=>{c.disabled=true;if(idx===it.a)c.classList.add('ok');});if(k===it.a){s++;score.textContent='Puntos: '+s;fb.textContent='¡Correcto!';}else{b.classList.add('bad');fb.textContent='Incorrecto. Respuesta: '+it.o[it.a];}
 setTimeout(()=>{i++;load();},900);};opts.appendChild(b);});}
load();`;
    return { html, css, js };
  };

  T.weather = (spec) => {
    const html = `
<section class="wx"><h1>${esc(spec.title)}</h1>
  <form class="wsearch" onsubmit="event.preventDefault();document.getElementById('city').textContent=this.q.value||'Tu ciudad'">
    <input class="inp" name="q" placeholder="Buscar ciudad…"><button class="btn" type="submit">Buscar</button></form>
  <div class="card wcard"><div class="wtop"><div><h2 id="city">Ciudad de México</h2><p class="muted" id="cond">Parcialmente nublado</p></div><div class="temp" id="temp">23°</div></div>
    <div class="days">${["Lun", "Mar", "Mié", "Jue", "Vie"].map((d, i) => `<div class="day"><span class="muted">${d}</span><b>${20 + i}°</b><span>${["☀️", "⛅", "🌧", "☀️", "⛅"][i]}</span></div>`).join("")}</div>
  </div></section>`;
    const css = `.wx{max-width:560px;margin:0 auto;padding:48px 24px}.wx h1{font-size:30px}
.wsearch{display:flex;gap:8px;margin:20px 0}.wsearch .inp{flex:1;padding:11px 13px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--fg)}
.wcard{padding:24px}.wtop{display:flex;justify-content:space-between;align-items:center}
.wcard h2{font-size:22px}.wcard p{font-size:14px;margin-top:4px}.temp{font-size:52px;font-weight:700}
.days{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:24px;text-align:center}
.day{display:flex;flex-direction:column;gap:6px;padding:12px 0;background:var(--surface);border-radius:var(--r-sm);font-size:14px}`;
    return { html, css, js: "" };
  };

  T.calendar = (spec) => {
    const html = `
<section class="cal"><header class="cal__h"><div><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div><button class="btn" id="today">Hoy</button></header>
  <div class="cal__grid">
    <div class="card month"><div class="month__top"><button class="nav-btn" id="prev">‹</button><strong id="label"></strong><button class="nav-btn" id="next">›</button></div>
      <div class="dow">${["L", "M", "M", "J", "V", "S", "D"].map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="days" id="days"></div>
    </div>
    <aside class="card side"><h3 id="sideTitle">Eventos</h3><ul id="events"></ul>
      <form id="evform"><input class="inp" id="evname" placeholder="Nuevo evento…" autocomplete="off"><button class="btn" type="submit">Añadir</button></form>
    </aside>
  </div>
</section>`;
    const css = `.cal{max-width:960px;margin:0 auto;padding:40px 24px}
.cal__h{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.cal__h h1{font-size:28px}.cal__h p{margin-top:4px;font-size:14px}
.cal__grid{display:grid;grid-template-columns:1.6fr 1fr;gap:18px}
.month{padding:18px}.month__top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.nav-btn{width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font-size:16px}
.dow{display:grid;grid-template-columns:repeat(7,1fr);text-align:center;font-size:12px;color:var(--muted);margin-bottom:6px}
.days{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.day2{aspect-ratio:1;display:grid;place-items:center;border-radius:8px;font-size:14px;cursor:pointer;border:1px solid transparent}
.day2:hover{background:var(--surface)}.day2.dim{color:var(--muted);opacity:.5}.day2.sel{background:var(--accent);color:#fff}
.day2.has{font-weight:700}.day2.has::after{content:"";position:absolute;width:5px;height:5px;border-radius:50%;background:var(--accent);margin-top:22px}
.side{padding:18px;display:flex;flex-direction:column;gap:12px}.side h3{font-size:16px}
.side ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;flex:1}
.side li{font-size:14px;padding:9px 11px;background:var(--surface);border-radius:8px;border-left:3px solid var(--accent)}
#evform{display:flex;gap:8px}#evform .inp{flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)}
@media(max-width:760px){.cal__grid{grid-template-columns:1fr}}`;
    const js = `
const MES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
let view=new Date(),sel=new Date(),events={'0_0':[]};
function key(d){return d.getFullYear()+'_'+(d.getMonth()+'_'+d.getDate());}
const days=document.getElementById('days'),label=document.getElementById('label'),evs=document.getElementById('events'),sideTitle=document.getElementById('sideTitle');
function render(){label.textContent=MES[view.getMonth()]+' '+view.getFullYear();
const first=new Date(view.getFullYear(),view.getMonth(),1);const start=(first.getDay()+6)%7;const total=new Date(view.getFullYear(),view.getMonth()+1,0).getDate();
days.innerHTML='';const today=new Date();
for(let i=0;i<start;i++){const d=document.createElement('div');d.className='day2 dim';days.appendChild(d);}
for(let i=1;i<=total;i++){const d=document.createElement('div');d.className='day2';d.textContent=i;const dt=new Date(view.getFullYear(),view.getMonth(),i);const k=key(dt);
 if(dt.toDateString()===today.toDateString())d.classList.add('sel'); if(events[k]&&events[k].length)d.classList.add('has');
 d.onclick=()=>{sel=dt;sideTitle.textContent='Eventos · '+i+' '+MES[view.getMonth()];renderEvents();document.querySelectorAll('.day2').forEach(x=>x.classList.remove('sel'));d.classList.add('sel');};
 days.appendChild(d);}renderEvents();}
function renderEvents(){const k=key(sel);evs.innerHTML='';const list=events[k]||[];if(!list.length){evs.innerHTML='<li class="muted" style="background:transparent;border:0;padding:0">Sin eventos. Añade uno abajo.</li>';return;}
 list.forEach(t=>{const li=document.createElement('li');li.textContent=t;evs.appendChild(li);});}
document.getElementById('prev').onclick=()=>{view=new Date(view.getFullYear(),view.getMonth()-1,1);render();};
document.getElementById('next').onclick=()=>{view=new Date(view.getFullYear(),view.getMonth()+1,1);render();};
document.getElementById('today').onclick=()=>{view=new Date();sel=new Date();sideTitle.textContent='Eventos de hoy';render();};
document.getElementById('evform').onsubmit=e=>{e.preventDefault();const i=document.getElementById('evname');if(!i.value.trim())return;const k=key(sel);(events[k]=events[k]||[]).push(i.value.trim());i.value='';render();};
render();`;
    return { html, css, js };
  };

  T.notes = (spec) => {
    const html = `
<section class="notes">
  <aside class="notes__side">
    <div class="notes__top"><strong>${esc(spec.title)}</strong><button class="btn btn--ghost" id="newnote">+ Nueva</button></div>
    <ul class="notelist" id="notelist"></ul>
  </aside>
  <main class="notes__main">
    <input class="notetitle" id="ntitle" placeholder="Título de la nota">
    <textarea class="notebody" id="nbody" placeholder="Escribe algo…"></textarea>
    <div class="notes__foot"><span class="muted" id="saved">Guardado</span><button class="btn btn--ghost" id="delnote">Eliminar</button></div>
  </main>
</section>`;
    const css = `.notes{display:grid;grid-template-columns:260px 1fr;height:100vh}
.notes__side{border-right:1px solid var(--border);padding:16px;display:flex;flex-direction:column;gap:12px;background:var(--surface);overflow:auto}
.notes__top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.notelist{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
.notelist li{padding:10px 12px;border-radius:8px;cursor:pointer;font-size:14px}
.notelist li:hover{background:var(--card)}.notelist li.on{background:var(--card);border:1px solid var(--border);font-weight:600}
.notes__main{display:flex;flex-direction:column;padding:28px 32px}
.notetitle{font-size:26px;font-weight:700;border:0;background:transparent;color:var(--fg);outline:none;padding:6px 0}
.notebody{flex:1;border:0;background:transparent;color:var(--fg);outline:none;resize:none;font:inherit;font-size:15px;line-height:1.7;padding:8px 0}
.notes__foot{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);padding-top:12px;font-size:13px}
@media(max-width:700px){.notes{grid-template-columns:1fr}.notes__side{display:none}}`;
    const js = `
let notes=[{t:'Ideas para el producto',b:'- Mejorar el onboarding\\n- Añadir modo oscuro\\n- Publicar la v1'},{t:'Reunión del lunes',b:'Revisar métricas y planear la semana.'}];
let cur=0;const list=document.getElementById('notelist'),nt=document.getElementById('ntitle'),nb=document.getElementById('nbody'),saved=document.getElementById('saved');
function render(){list.innerHTML='';notes.forEach((n,i)=>{const li=document.createElement('li');li.className=i===cur?'on':'';li.textContent=n.t||'Sin título';li.onclick=()=>{cur=i;render();load();};list.appendChild(li);});}
function load(){nt.value=notes[cur].t;nb.value=notes[cur].b;}
function save(){notes[cur]={t:nt.value,b:nb.value};saved.textContent='Guardado';render();}
nt.oninput=nb.oninput=()=>{saved.textContent='Editando…';clearTimeout(window._s);window._s=setTimeout(save,500);};
document.getElementById('newnote').onclick=()=>{notes.unshift({t:'',b:''});cur=0;render();load();nt.focus();};
document.getElementById('delnote').onclick=()=>{notes.splice(cur,1);if(!notes.length)notes=[{t:'',b:''}];cur=0;render();load();};
render();load();`;
    return { html, css, js };
  };

  T.crm = (spec) => {
    const html = `
<section class="crm"><header class="crm__h"><div><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div>
  <input class="inp search" id="search" placeholder="Buscar contacto…"></header>
  <div class="kpis3"><div class="card kpi"><span class="muted">Contactos</span><strong id="ktot">0</strong></div>
    <div class="card kpi"><span class="muted">En negociación</span><strong id="kneg">0</strong></div>
    <div class="card kpi"><span class="muted">Valor pipeline</span><strong id="kval">$0</strong></div></div>
  <div class="card table"><table id="tbl"><thead><tr><th>Nombre</th><th>Empresa</th><th>Etapa</th><th>Valor</th></tr></thead><tbody id="rows"></tbody></table></div>
</section>`;
    const css = `.crm{max-width:960px;margin:0 auto;padding:40px 24px}
.crm__h{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.crm__h h1{font-size:28px}.crm__h p{margin-top:4px;font-size:14px}
.search{max-width:260px}
.kpis3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}
.kpi{padding:16px;display:flex;flex-direction:column;gap:6px}.kpi span{font-size:13px}.kpi strong{font-size:24px}
.table{padding:6px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding:12px 14px}
td{padding:12px 14px;border-top:1px solid var(--border)}
.tag{padding:3px 10px;border-radius:999px;font-size:12px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);font-weight:600}`;
    const js = `
const DATA=[['Ana Ruiz','Nova Labs','Negociación',12000],['Diego Marín','Pixelo','Contactado',4500],['Sofía León','Trazo','Ganado',9000],['Marco Polo','Vertex','Contactado',2200],['Lucía Ferrer','Orbita','Negociación',15000]];
const rows=document.getElementById('rows'),search=document.getElementById('search');
function render(q){q=(q||'').toLowerCase();const f=DATA.filter(r=>r.join(' ').toLowerCase().includes(q));
rows.innerHTML=f.map(r=>'<tr><td><b>'+r[0]+'</b></td><td>'+r[1]+'</td><td><span class="tag">'+r[2]+'</span></td><td>$'+r[3].toLocaleString('en-US')+'</td></tr>').join('');
document.getElementById('ktot').textContent=DATA.length;
document.getElementById('kneg').textContent=DATA.filter(r=>r[2]==='Negociación').length;
document.getElementById('kval').textContent='$'+DATA.reduce((a,r)=>a+r[3],0).toLocaleString('en-US');}
search.oninput=e=>render(e.target.value);render('');`;
    return { html, css, js };
  };

  T.recipes = (spec) => {
    const html = `
<section class="rec"><header class="rec__h"><div><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div>
  <input class="inp search" id="rsearch" placeholder="Buscar receta…"></header>
  <div class="grid grid--3" id="rcards"></div>
  <div class="modal" id="rmodal"><div class="card modal__box" id="rbox"></div></div>
</section>`;
    const css = `.rec{max-width:1000px;margin:0 auto;padding:40px 24px}
.rec__h{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.rec__h h1{font-size:28px}.rec__h p{margin-top:4px;font-size:14px}
.search{max-width:260px}
.rcard{padding:0;overflow:hidden;cursor:pointer;transition:.15s}.rcard:hover{border-color:var(--accent)}
.rimg{height:130px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 24%,var(--card)),var(--card))}
.rinfo{padding:14px}.rinfo h3{font-size:16px}.rinfo p{font-size:13px;color:var(--muted);margin-top:4px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;place-items:center;padding:24px;z-index:50}
.modal.on{display:grid}.modal__box{max-width:440px;padding:24px;background:var(--card)}
.modal__box h2{font-size:20px;margin-bottom:10px}.modal__box ul{padding-left:18px;font-size:14px;color:var(--muted);line-height:1.8}`;
    const js = `
const R=[['Pasta al pesto',['200g pasta','Albahaca','Piñones','Parmesano'],'20 min'],['Tacos de pastor',['Tortillas','Cerdo adobado','Piña','Cebolla'],'35 min'],['Ensalada César',['Lechuga romana','Pollo','Crutones','Aderezo'],'15 min'],['Sopa de tomate',['Tomates','Cebolla','Ajo','Albahaca'],'30 min'],['Risotto de hongos',['Arroz arborio','Hongos','Caldo','Mantequilla'],'40 min'],['Brownies',['Chocolate','Mantequilla','Huevos','Harina'],'45 min']];
const cards=document.getElementById('rcards'),modal=document.getElementById('rmodal'),box=document.getElementById('rbox');
function render(q){q=(q||'').toLowerCase();cards.innerHTML='';R.filter(r=>r[0].toLowerCase().includes(q)).forEach(r=>{
 const a=document.createElement('article');a.className='card rcard';a.innerHTML='<div class="rimg"></div><div class="rinfo"><h3>'+r[0]+'</h3><p>'+r[2]+' · '+r[1].length+' ingredientes</p></div>';
 a.onclick=()=>{box.innerHTML='<h2>'+r[0]+'</h2><p class="muted" style="font-size:13px">'+r[2]+'</p><ul>'+r[1].map(i=>'<li>'+i+'</li>').join('')+'</ul><button class="btn" style="margin-top:16px" onclick="document.getElementById(\\'rmodal\\').classList.remove(\\'on\\')">Cerrar</button>';modal.classList.add('on');};
 cards.appendChild(a);});}
modal.onclick=e=>{if(e.target===modal)modal.classList.remove('on');};
document.getElementById('rsearch').oninput=e=>render(e.target.value);render('');`;
    return { html, css, js };
  };

  T.fitness = (spec) => {
    const html = `
<section class="fit"><header class="fit__h"><div><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div><button class="btn" id="reset">Reiniciar día</button></header>
  <div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="track"/><circle cx="60" cy="60" r="52" class="prog" id="prog"/></svg>
    <div class="ring__c"><strong id="pct">0%</strong><span class="muted">completado</span></div></div>
  <ul class="exs" id="exs"></ul>
</section>`;
    const css = `.fit{max-width:640px;margin:0 auto;padding:44px 24px}
.fit__h{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}.fit__h h1{font-size:28px}.fit__h p{margin-top:4px;font-size:14px}
.ring{position:relative;width:180px;height:180px;margin:0 auto 28px}
.ring svg{transform:rotate(-90deg)}.ring circle{fill:none;stroke-width:10;stroke-linecap:round}
.track{stroke:var(--surface)}.prog{stroke:var(--accent);stroke-dasharray:327;stroke-dashoffset:327;transition:stroke-dashoffset .4s}
.ring__c{position:absolute;inset:0;display:grid;place-items:center;text-align:center}
.ring__c strong{font-size:30px;display:block}.ring__c span{font-size:12px}
.exs{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
.ex{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--border);border-radius:var(--r);background:var(--card);cursor:pointer}
.ex.done{opacity:.6}.ex.done .ex__n{text-decoration:line-through}
.ex__n{flex:1;font-weight:600}.ex__d{font-size:13px;color:var(--muted)}
.ex__c{width:24px;height:24px;border-radius:50%;border:2px solid var(--border);display:grid;place-items:center;font-size:14px}
.ex.done .ex__c{background:var(--accent);border-color:var(--accent);color:#fff}`;
    const js = `
let EX=[['Press de banca','4×10'],['Sentadillas','4×8'],['Peso muerto','3×6'],['Remo con barra','3×12'],['Plancha','3×60s']].map(e=>({n:e[0],d:e[1],done:false}));
const list=document.getElementById('exs'),prog=document.getElementById('prog'),pct=document.getElementById('pct');
function render(){list.innerHTML='';EX.forEach((e,i)=>{const li=document.createElement('li');li.className='ex'+(e.done?' done':'');
 li.innerHTML='<div><div class="ex__n">'+e.n+'</div><div class="ex__d">'+e.d+'</div></div><div class="ex__c">'+(e.done?'✓':'')+'</div>';
 li.onclick=()=>{e.done=!e.done;render();};list.appendChild(li);});
 const p=Math.round(EX.filter(e=>e.done).length/EX.length*100);pct.textContent=p+'%';prog.style.strokeDashoffset=327-(327*p/100);}
document.getElementById('reset').onclick=()=>{EX.forEach(e=>e.done=false);render();};render();`;
    return { html, css, js };
  };

  T.expenses = (spec) => {
    const html = `
<section class="exp"><header class="exp__h"><div><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div></header>
  <div class="exp__grid">
    <div class="card total"><span class="muted">Gasto total</span><strong id="tot">$0</strong>
      <form id="eform"><input class="inp" id="ename" placeholder="Descripción" autocomplete="off"><input class="inp" id="eval" type="number" placeholder="Monto" style="max-width:120px"><button class="btn" type="submit">Añadir</button></form>
    </div>
    <div class="card cats"><h3>Por categoría</h3><div id="bars"></div></div>
  </div>
  <ul class="card elist" id="elist"></ul>
</section>`;
    const css = `.exp{max-width:800px;margin:0 auto;padding:40px 24px}
.exp__h h1{font-size:28px}.exp__h p{margin-top:4px;font-size:14px}
.exp__grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:22px 0}
.total{padding:20px;display:flex;flex-direction:column;gap:10px}.total strong{font-size:34px;letter-spacing:-.02em}
#eform{display:flex;gap:8px;flex-wrap:wrap}.inp{flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)}
.cats{padding:20px}.cats h3{font-size:15px;margin-bottom:14px}
#bars{display:flex;flex-direction:column;gap:10px;font-size:13px}
.catrow{display:flex;justify-content:space-between;gap:12px}
.catbar{height:6px;border-radius:6px;background:var(--surface);overflow:hidden;margin-top:4px}
.catbar i{display:block;height:100%;background:var(--accent)}
.elist{list-style:none;padding:8px;margin:0;display:flex;flex-direction:column;gap:4px}
.erow{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:8px}
.erow:hover{background:var(--surface)}.erow b{font-variant-numeric:tabular-nums}
@media(max-width:700px){.exp__grid{grid-template-columns:1fr}}`;
    const js = `
let E=[{n:'Supermercado',c:'Comida',v:820},{n:'Gasolina',c:'Transporte',v:600},{n:'Streaming',c:'Ocio',v:150},{n:'Café',c:'Comida',v:75}];
const list=document.getElementById('elist'),bars=document.getElementById('bars'),tot=document.getElementById('tot');
function render(){list.innerHTML='';E.forEach((e,i)=>{const li=document.createElement('li');li.className='erow';
 li.innerHTML='<span>'+e.n+' <span class="muted" style="font-size:12px">· '+e.c+'</span></span><span><b>$'+e.v.toLocaleString('en-US')+'</b> <button style="border:0;background:transparent;color:var(--muted);cursor:pointer">×</button></span>';
 li.querySelector('button').onclick=()=>{E.splice(i,1);render();};list.appendChild(li);});
 const t=E.reduce((a,e)=>a+e.v,0);tot.textContent='$'+t.toLocaleString('en-US');
 const by={};E.forEach(e=>by[e.c]=(by[e.c]||0)+e.v);const max=Math.max(1,...Object.values(by));
 bars.innerHTML=Object.entries(by).sort((a,b)=>b[1]-a[1]).map(([c,v])=>'<div><div class="catrow"><span>'+c+'</span><b>$'+v.toLocaleString('en-US')+'</b></div><div class="catbar"><i style="width:'+(v/max*100)+'%"></i></div></div>').join('');}
document.getElementById('eform').onsubmit=e=>{e.preventDefault();const n=document.getElementById('ename'),v=document.getElementById('eval');
 if(!n.value.trim()||!v.value)return;E.unshift({n:n.value.trim(),c:'General',v:Number(v.value)});n.value='';v.value='';render();};
render();`;
    return { html, css, js };
  };

  T.forum = (spec) => {
    const html = `
<section class="fo"><header class="fo__h"><div><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div><button class="btn" id="newthread">+ Nuevo tema</button></header>
  <div class="threads" id="threads"></div>
</section>`;
    const css = `.fo{max-width:760px;margin:0 auto;padding:40px 24px}
.fo__h{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.fo__h h1{font-size:28px}.fo__h p{margin-top:4px;font-size:14px}
.threads{display:flex;flex-direction:column;gap:10px}
.thread{padding:18px;display:flex;gap:14px;align-items:flex-start;cursor:pointer}
.thread:hover{border-color:var(--accent)}
.av2{width:38px;height:38px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;flex:none}
.thread h3{font-size:16px}.thread p{font-size:13px;color:var(--muted);margin-top:4px}
.meta2{font-size:12px;color:var(--muted);margin-top:8px;display:flex;gap:14px}
.reply{margin:12px 0 0 52px;padding:14px;border-left:2px solid var(--border);font-size:14px}
.reply .muted{font-size:12px;margin-bottom:4px;display:block}`;
    const js = `
let TH=[{t:'¿Cómo estructurar un proyecto grande?',a:'Ana',r:[{a:'Diego',t:'Divide por features y usa ramas cortas.'},{a:'Sofía',t:'Empieza por el modelo de datos.'}],v:128},
{t:'Mejores prácticas de accesibilidad',a:'Lucía',r:[],v:64},
{t:'Deploy sin downtime',a:'Marco',r:[{a:'Ana',t:'Usa despliegues azul/verde.'}],v:41}];
const box=document.getElementById('threads');
function render(){box.innerHTML='';TH.forEach((th,i)=>{const el=document.createElement('article');el.className='card thread';
 el.innerHTML='<div class="av2">'+th.a[0]+'</div><div style="flex:1"><h3>'+th.t+'</h3><p>por '+th.a+'</p><div class="meta2"><span>💬 '+th.r.length+' respuestas</span><span>▲ '+th.v+' votos</span></div>'+
 th.r.map(r=>'<div class="reply"><span class="muted">'+r.a+'</span>'+r.t+'</div>').join('')+
 '<form class="replyform" style="display:flex;gap:8px;margin-top:12px"><input class="inp" placeholder="Responder…" style="flex:1;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)"><button class="btn btn--ghost" type="submit">Enviar</button></form></div>';
 el.querySelector('.replyform').onsubmit=e=>{e.preventDefault();const inp=e.target.querySelector('input');if(!inp.value.trim())return;th.r.push({a:'Tú',t:inp.value.trim()});render();};
 box.appendChild(el);});}
document.getElementById('newthread').onclick=()=>{const t=prompt('Título del nuevo tema');if(t)TH.unshift({t,a:'Tú',r:[],v:0}),render();};
render();`;
    return { html, css, js };
  };

  T.bookings = (spec) => {
    const html = `
<section class="bk"><header class="bk__h"><div><h1>${esc(spec.title)}</h1><p class="muted">${esc(spec.tagline)}</p></div></header>
  <div class="bk__grid">
    <form class="card bkform" id="bkform">
      <label class="lbl">Fecha<input class="inp" type="date" id="bdate" required></label>
      <label class="lbl">Personas<input class="inp" type="number" id="bparty" min="1" value="2" required></label>
      <label class="lbl">Horario<div class="slots" id="slots"></div></label>
      <button class="btn" type="submit" style="width:100%">Reservar</button>
      <p class="muted" id="bmsg" style="font-size:13px;min-height:18px"></p>
    </form>
    <aside class="card bkside"><h3>Disponibilidad</h3><ul class="bklist" id="bklist"></ul></aside>
  </div>
</section>`;
    const css = `.bk{max-width:860px;margin:0 auto;padding:40px 24px}
.bk__h h1{font-size:28px}.bk__h p{margin-top:4px;font-size:14px}
.bk__grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px}
.bkform{padding:22px;display:flex;flex-direction:column;gap:14px}
.lbl{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
.inp{padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)}
.slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.slot{padding:9px 0;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px}
.slot.on{background:var(--accent);border-color:var(--accent);color:#fff}
.slot[disabled]{opacity:.35;cursor:not-allowed}
.bkside{padding:22px}.bkside h3{font-size:16px;margin-bottom:12px}
.bklist{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;font-size:14px}
.bklist li{padding:10px 12px;background:var(--surface);border-radius:8px;display:flex;justify-content:space-between;gap:10px}
@media(max-width:700px){.bk__grid{grid-template-columns:1fr}}`;
    const js = `
const TIMES=['12:00','13:30','15:00','18:00','19:30','21:00'];
let sel='12:00';let RES=[{d:'2026-11-06',t:'19:30',p:4},{d:'2026-11-07',t:'21:00',p:2}];
const slots=document.getElementById('slots'),list=document.getElementById('bklist'),msg=document.getElementById('bmsg'),date=document.getElementById('bdate');
date.value=new Date().toISOString().slice(0,10);
function renderSlots(){const taken=RES.filter(r=>r.d===date.value).map(r=>r.t);
 slots.innerHTML=TIMES.map(t=>'<button type="button" class="slot '+(t===sel?'on':'')+'" data-t="'+t+'" '+(taken.includes(t)?'disabled':'')+'>'+t+'</button>').join('');
 slots.querySelectorAll('.slot').forEach(b=>b.onclick=()=>{sel=b.dataset.t;renderSlots();});}
function renderList(){list.innerHTML=RES.map(r=>'<li><span>'+r.d+' · '+r.t+'</span><b>'+r.p+' pers.</b></li>').join('')||'<li class="muted">Sin reservas</li>';}
date.onchange=renderSlots;
document.getElementById('bkform').onsubmit=e=>{e.preventDefault();const p=document.getElementById('bparty').value;
 RES.push({d:date.value,t:sel,p:Number(p)});msg.textContent='Reserva confirmada: '+date.value+' a las '+sel;
 renderSlots();renderList();};
renderSlots();renderList();`;
    return { html, css, js };
  };

  /* ------------------------------------------------------------------
     6. build(spec) -> { files, preview, summary }
     ------------------------------------------------------------------ */
  /* Marca de agua DMD en toda página generada con IA: logo circular
     + "DMD" debajo, fija abajo a la derecha, semitransparente y suave,
     sin bloquear clics. Snippet autocontenido (su propio <style>) para
     que valga igual en el preview, en index.html solo, en el .zip y en
     la página publicada. */
  const WATERMARK_SNIPPET = "<style>.dmd-watermark{position:fixed;right:18px;bottom:16px;z-index:9999;display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:none;opacity:.42;filter:blur(.5px)}.dmd-watermark svg{display:block;width:46px;height:46px}.dmd-watermark span{font:700 11px/1 Inter,system-ui,-apple-system,\"Segoe UI\",sans-serif;letter-spacing:.22em;color:#1c1c1c}</style><div class=\"dmd-watermark\" aria-hidden=\"true\"><svg viewBox=\"0 0 512 512\" width=\"46\" height=\"46\" aria-hidden=\"true\"><defs><linearGradient id=\"dmdwmg1\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#38bdf8\"/><stop offset=\"100%\" stop-color=\"#0284c7\"/></linearGradient><linearGradient id=\"dmdwmg2\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#60a5fa\"/><stop offset=\"100%\" stop-color=\"#2563eb\"/></linearGradient><linearGradient id=\"dmdwmg3\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#2563eb\"/><stop offset=\"100%\" stop-color=\"#1d4ed8\"/></linearGradient><linearGradient id=\"dmdwmg4\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#1e40af\"/><stop offset=\"100%\" stop-color=\"#0f172a\"/></linearGradient><clipPath id=\"dmdwmclip\"><circle cx=\"256\" cy=\"256\" r=\"256\"/></clipPath></defs><g clip-path=\"url(#dmdwmclip)\"><rect width=\"512\" height=\"512\" fill=\"#ffffff\"/><g transform=\"translate(107,107)\"><rect x=\"0\" y=\"0\" width=\"138\" height=\"138\" rx=\"36\" fill=\"url(#dmdwmg1)\"/><rect x=\"160\" y=\"0\" width=\"138\" height=\"138\" rx=\"36\" fill=\"url(#dmdwmg2)\"/><rect x=\"0\" y=\"160\" width=\"138\" height=\"138\" rx=\"36\" fill=\"url(#dmdwmg3)\"/><rect x=\"160\" y=\"160\" width=\"138\" height=\"138\" rx=\"36\" fill=\"url(#dmdwmg4)\"/></g></g></svg><span>DMD</span></div>";
  function withWatermark(html) {
    return html.indexOf('dmd-watermark') === -1 ? html + '\n' + WATERMARK_SNIPPET : html;
  }

  function build(rawSpec) {
    // El spec de Groq (objetos) y el local (strings) se normalizan aquí,
    // así ningún renderer recibe secciones que no entiende.
    const spec = normalizeSpec(rawSpec);
    // Fotos/logo subidos por el usuario (botón "+"): se activan para
    // esta construcción y se resetean, para que cada build reparta
    // las fotos desde cero.
    customPhotos = Array.isArray(spec.uploadedPhotos) ? spec.uploadedPhotos : [];
    customUsed = {};
    const tpl = T[spec.type] || T.landing;
    const { html, css, js } = tpl(spec);
    // OG para la página generada: título/descripción del spec; og:image es
    // la foto del hero (Pollinations FLUX, o Unsplash curada) y, si no hay
    // foto, la tarjeta DMD 1200x630. Sin og:url: la página aún no tiene
    // URL pública (la pone quien la publica).
    const heroSec = richSec(spec, "hero");
    const heroQ = (heroSec && heroSec.imageQuery) || spec.heroImageQuery || "";
    const ogImg = (customPhotos.length ? customImageFor(heroQ, spec.title) : null) || unsplashUrl(heroQ, 1200) || unsplashUrl(spec.title, 1200) || "https://www.dmdmx.dev/assets/social/og-dmd.jpg";
    const head = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(spec.title)}</title><meta name="description" content="${esc(spec.tagline)}"><meta property="og:type" content="website"><meta property="og:site_name" content="DMD | Digital Mijma Dreams"><meta property="og:title" content="${esc(spec.title)}"><meta property="og:description" content="${esc(spec.tagline)}"><meta property="og:image" content="${ogImg}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(spec.title)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(spec.title)}"><meta name="twitter:description" content="${esc(spec.tagline)}"><meta name="twitter:image" content="${ogImg}">`;
    const bodyHtml = withWatermark(html);
    const indexHtml = `<!DOCTYPE html>\n<html lang="es">\n<head>\n  ${head}\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n${bodyHtml}\n  <script src="script.js"><\/script>\n</body>\n</html>`;
    const stylesCss = baseCss(spec) + "\n" + css + "\n\n@media(max-width:760px){.grid--3{grid-template-columns:1fr!important}.ft__in{grid-template-columns:1fr}}";
    const scriptJs = js || "// Sin lógica adicional";

    const preview = `<!DOCTYPE html><html lang="es"><head>${head}<style>${stylesCss}</style></head><body>${bodyHtml}<script>${scriptJs}<\/script></body></html>`;

    return {
      files: { "index.html": indexHtml, "styles.css": stylesCss, "script.js": scriptJs },
      preview,
      summary: resumen(spec)
    };
  }

  function resumen(spec) {
    const nombres = {
      landing: "landing page", dashboard: "dashboard", todo: "app de tareas", kanban: "tablero kanban",
      portfolio: "portafolio", blog: "blog", ecommerce: "tienda online", chat: "app de chat",
      calculator: "calculadora", pricing: "página de precios", auth: "pantalla de acceso",
      quiz: "quiz interactivo", weather: "app del clima", calendar: "calendario",
      notes: "app de notas", crm: "CRM", recipes: "app de recetas", fitness: "app de entrenamiento",
      expenses: "app de gastos", forum: "foro", bookings: "app de reservas"
    };
    const tema = spec.dark ? "tema oscuro" : "tema claro";
    const secs = spec.type === "landing" ? ` con secciones: ${spec.sections.join(", ")}` : "";
    return `Creé una ${nombres[spec.type] || "app"} llamada “${spec.title}” (${tema}, acento ${spec.accent})${secs}.`;
  }

  /* ------------------------------------------------------------------
     7. Catálogo de plantillas (para la galería de la landing)
     ------------------------------------------------------------------ */
  const CATALOGO = [
    { name: "Pulseboard",  tag: "Dashboard",     prompt: "Crea un dashboard de métricas con gráficos" },
    { name: "Taskly",      tag: "Productividad", prompt: "Crea una app de tareas pendientes" },
    { name: "Flowboard",   tag: "Proyectos",     prompt: "Crea un tablero kanban para organizar el trabajo" },
    { name: "Nova Store",  tag: "E-commerce",    prompt: "Crea una tienda online con carrito" },
    { name: "Folio",       tag: "Portafolio",    prompt: "Crea un portafolio para un diseñador" },
    { name: "Briefly",     tag: "Blog",          prompt: "Crea un blog de artículos" },
    { name: "Launchpad",   tag: "Landing SaaS",  prompt: "Crea una landing page para un SaaS" },
    { name: "Chitchat",    tag: "Mensajería",    prompt: "Crea una app de chat" },
    { name: "Tempo",       tag: "Calendario",    prompt: "Crea un calendario de eventos" },
    { name: "Notely",      tag: "Notas",         prompt: "Crea una app de notas" },
    { name: "Pipely",      tag: "CRM",           prompt: "Crea un crm de contactos y oportunidades" },
    { name: "Bolsillo",    tag: "Finanzas",      prompt: "Crea una app de gastos" },
    { name: "Reps",        tag: "Fitness",       prompt: "Crea una app de entrenamiento" },
    { name: "Sazón",       tag: "Recetas",       prompt: "Crea una app de recetas de cocina" },
    { name: "Debate",      tag: "Comunidad",     prompt: "Crea un foro de discusión" },
    { name: "Mesa",        tag: "Reservas",      prompt: "Crea un sistema de reservas para un restaurante" },
    { name: "Quizzy",      tag: "Interactivo",   prompt: "Crea un quiz de preguntas" },
    { name: "Skycast",     tag: "Clima",         prompt: "Crea una app del clima" },
    { name: "Acceso",      tag: "Autenticación", prompt: "Crea una pantalla de login" },
    { name: "Planos",      tag: "Precios",       prompt: "Crea una página de precios" },
    { name: "Calc",        tag: "Utilidades",    prompt: "Crea una calculadora" }
  ];

  window.Generator = { analyze, applyEdit, build, slug, esc, COLORES, CATALOGO, unsplashUrl, pollinationsUrl, normalizeSpec, normalizeItem, formatPrice, detectBusiness };
})();
