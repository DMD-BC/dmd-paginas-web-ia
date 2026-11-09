// Búsqueda web gratuita y sin clave para enriquecer la IA de DMD.
// Fuentes:
//  - Wikipedia en español (API pública, sin clave): datos reales del giro.
//  - DuckDuckGo Instant Answer (sin clave): resumen corto cuando existe.
//  - Openverse (API pública, sin clave): fotos reales con licencia CC.
// Todo con timeout corto y tolerancia a fallos: si la web falla, se
// devuelve vacío y la generación sigue solo con Groq (nunca se rompe).
// La llave de Groq NO se usa aquí.

const UA = { 'User-Agent': 'DMD-builder/1.0 (https://www.dmdmx.dev)' };
const FETCH_TIMEOUT_MS = 4000;

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Saca el tema de búsqueda del prompt del usuario:
// "crea una pagina de una taqueria en Ixtlahuaca" -> "taqueria"
// "quiero una página para mi papelería con precios y contacto" -> "papelería"
// M8 (2026-11-08): el viejo deriveQuery dejaba "mi papelería papelería
// el lápiz en" y Bing buscaba "mi" (Xiaomi, Michigan). Ahora se quitan
// el "mi", los rellenos ("con precios y contacto", "servicios"…) y el
// lugar, y quedan como máximo las 3 primeras palabras del giro.
function deriveQuery(prompt) {
  let q = String(prompt || '').toLowerCase();
  q = q
    .replace(/crea(r|me)?\s+(una?|la)?\s*p[aá]gina\s+(web\s+)?(de|para)\s+(una?|un|el|la)?\s*/g, '')
    .replace(/haz(me)?\s+(una?|la)?\s*p[aá]gina\s+(de|para)\s+(una?|un)?\s*/g, '')
    .replace(/p[aá]gina\s+(web\s+)?(de|para)\s+(una?|un)?\s*/g, '')
    .replace(/quiero\s+(una?|un)?\s*/g, '')
    .replace(/para\s+mi\s+(negocio|empresa|tienda)\s*/g, '')
    .trim();
  // Quita lugar al final ("en Ixtlahuaca", "en CDMX") para buscar el giro.
  q = q.replace(/\s+en\s+[a-záéíóúñ\s]+$/i, '').trim();
  // Quita rellenos que no son el giro: "con precios y contacto",
  // "con servicios", "con menú", "con catálogo y pedidos"…
  q = q.replace(/[^\wáéíóúñ\s]/gi, ' ');
  const STOP = new Set(['mi', 'mis', 'con', 'y', 'para', 'de', 'una', 'un', 'el', 'la',
    'los', 'las', 'precios', 'precio', 'contacto', 'servicios', 'servicio',
    'menu', 'menú', 'catalogo', 'catálogo', 'pedidos', 'negocio', 'empresa',
    'testimonios', 'testimonio', 'landing']);
  q = q.split(/\s+/).filter((w) => w && !STOP.has(w)).slice(0, 3).join(' ').trim();
  return q || 'negocio';
}

// Wikipedia ES: busca el tema y trae el resumen del primer artículo.
async function wikipediaFacts(query, signal) {
  const facts = [];
  try {
    const searchUrl =
      'https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
      encodeURIComponent(query) + '&format=json&srlimit=3&origin=*';
    const data = await fetchJson(searchUrl);
    const hits = (data && data.query && data.query.search) || [];
    for (const hit of hits.slice(0, 2)) {
      const snippet = cleanText(hit.snippet).slice(0, 300);
      if (snippet) facts.push({ source: 'Wikipedia: ' + hit.title, text: snippet });
      // Resumen completo del primer artículo.
      if (facts.length === 1) {
        const sumUrl =
          'https://es.wikipedia.org/api/rest_v1/page/summary/' +
          encodeURIComponent(hit.title);
        const sum = await fetchJson(sumUrl);
        if (sum && sum.extract) {
          facts[0] = { source: 'Wikipedia: ' + sum.title, text: cleanText(sum.extract).slice(0, 600) };
        }
      }
      if (facts.length >= 2) break;
    }
  } catch (e) { /* sin web, sin datos */ }
  return facts;
}

// DuckDuckGo Instant Answer: resumen corto (a veces viene vacío).
async function duckFacts(query) {
  try {
    const url =
      'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) +
      '&format=json&no_html=1&skip_disambig=1';
    const data = await fetchJson(url);
    if (data && data.AbstractText) {
      return [{ source: 'DuckDuckGo', text: cleanText(data.AbstractText).slice(0, 400) }];
    }
    const topics = (data && data.RelatedTopics) || [];
    const first = topics.find((t) => t && t.Text);
    if (first) return [{ source: 'DuckDuckGo', text: cleanText(first.Text).slice(0, 300) }];
  } catch (e) { /* sin web, sin datos */ }
  return [];
}

// Openverse: fotos reales con licencia Creative Commons, sin clave.
async function webImages(query) {
  try {
    const url =
      'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(query) +
      '&page_size=6&license_type=commercial';
    const data = await fetchJson(url, 5000);
    const results = (data && data.results) || [];
    return results
      .filter((r) => r && r.url)
      .map((r) => ({
        url: r.url,
        title: cleanText(r.title).slice(0, 80),
        license: r.license || 'cc',
        creator: cleanText(r.creator || '')
      }));
  } catch (e) {
    return [];
  }
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// DuckDuckGo HTML (sin clave): "<giro> página web" y "<giro> website".
// Devuelve los primeros resultados (título, snippet, URL). En la práctica
// el HTML de DDG a veces viene vacío o bloqueado desde serverless, así
// que esto es un intento honesto, no la única fuente.
async function duckReferenceSites(query) {
  const out = [];
  const queries = [query + ' página web', query + ' website'];
  for (const q of queries) {
    try {
      const html = await fetchText(
        'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), 4000);
      if (!html) continue;
      // <a class="result__a" href="URL">Título</a> + result__snippet
      const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]{1,200}?)<\/a>/gi;
      let m;
      while ((m = linkRe.exec(html)) && out.length < 4) {
        let url = cleanText(m[1]);
        try { url = decodeURIComponent(url); } catch (e) {}
        if (!/^https?:\/\//.test(url)) continue;
        const title = cleanText(m[2].replace(/<[^>]+>/g, '')).slice(0, 90);
        if (title && !out.some((s) => s.url === url)) {
          out.push({ title, url, snippet: '', source: 'DuckDuckGo' });
        }
      }
      if (out.length >= 3) break;
    } catch (e) { /* siguiente fuente */ }
  }
  // DDG Instant Answer: RelatedTopics trae FirstURL + Text.
  try {
    const data = await fetchJson(
      'https://api.duckduckgo.com/?q=' + encodeURIComponent(query + ' página web') +
      '&format=json&no_html=1&skip_disambig=1');
    const topics = (data && data.RelatedTopics) || [];
    for (const t of topics) {
      const sub = t && t.Topics ? t.Topics : [t];
      for (const s of sub) {
        if (s && s.FirstURL && s.Text && !out.some((x) => x.url === s.FirstURL)) {
          out.push({ title: cleanText(s.Text).slice(0, 90), url: s.FirstURL,
            snippet: cleanText(s.Text).slice(0, 200), source: 'DuckDuckGo' });
        }
        if (out.length >= 4) break;
      }
      if (out.length >= 4) break;
    }
  } catch (e) { /* sin DDG, sin sitios de DDG */ }
  return out;
}

// Bing RSS (sin clave): el respaldo fiable cuando DDG no devuelve nada
// parseable desde el servidor. Mismo tipo de resultado: título, URL,
// descripción del sitio real.
async function bingReferenceSites(query) {
  try {
    const xml = await fetchText(
      'https://www.bing.com/search?q=' + encodeURIComponent(query + ' pagina web') +
      '&format=rss', 4000);
    if (!xml) return [];
    const out = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml)) && out.length < 4) {
      const body = m[1];
      const title = cleanText(((body.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '')
        .replace(/<!\[CDATA\[|\]\]>/g, '')).slice(0, 90);
      const url = cleanText(((body.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '')
        .replace(/<!\[CDATA\[|\]\]>/g, ''));
      const desc = cleanText(((body.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '')
        .replace(/<!\[CDATA\[|\]\]>/g, '')).slice(0, 200);
      if (/^https?:\/\//.test(url) && title && !out.some((s) => s.url === url)) {
        out.push({ title, url, snippet: desc, source: 'Bing' });
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

// Sitios reales de referencia del giro: DDG primero (lo pedido), Bing
// como respaldo fiable. Nunca lanza; si todo falla, devuelve [] y la
// generación sigue solo con Groq.
async function referenceSites(query) {
  const [ddg, bing] = await Promise.all([
    duckReferenceSites(query),
    bingReferenceSites(query)
  ]);
  const merged = [];
  [...ddg, ...bing].forEach((s) => {
    if (s && s.url && !merged.some((x) => x.url === s.url)) merged.push(s);
  });
  return merged.slice(0, 4);
}

// Búsqueda completa para un prompt de usuario. Nunca lanza.
// NOTA: Openverse se probó pero es demasiado lento (>8 s por consulta
// desde el servidor) y no fiable; las imágenes siguen con el catálogo
// curado de Unsplash (fotos reales verificadas), no con Openverse.
// "sites": páginas web reales del giro (referencia estructural para
// que la página generada esté al nivel de una página real viable).
async function searchWeb(prompt) {
  const query = deriveQuery(prompt);
  const [wiki, duck, sites] = await Promise.all([
    wikipediaFacts(query),
    duckFacts(query),
    referenceSites(query)
  ]);
  const facts = [...wiki, ...duck].slice(0, 3);
  return { query, facts, images: [], sites };
}

// Bloque de texto para meter en el prompt de Groq.
function webContextBlock(web) {
  if (!web || (!web.facts.length && !web.images.length && !(web.sites && web.sites.length))) return '';
  const lines = ['DATOS REALES ENCONTRADOS EN LA WEB (úsalos, no los contradigas; si un dato no aplica al negocio, ignóralo):'];
  web.facts.forEach((f) => lines.push('- [' + f.source + '] ' + f.text));
  if (web.images.length) {
    lines.push('FOTOS REALES ENCONTRADAS EN LA WEB (Openverse, licencia CC) para inspirar las palabras clave de imagen:');
    web.images.slice(0, 4).forEach((im) => lines.push('- "' + im.title + '" (' + im.license + ')'));
  }
  if (web.sites && web.sites.length) {
    lines.push('PÁGINAS WEB REALES DE ESTE GIRO (referencia estructural: toma su ESTRUCTURA — qué secciones tienen, en qué orden y qué ofrece cada una — como guía para que tu página esté al nivel de una página real viable; NO copies sus textos, imágenes, marcas ni precios):');
    web.sites.forEach((s) => lines.push('- "' + s.title + '" — ' + s.url + (s.snippet ? ' — ' + s.snippet : '')));
  }
  return lines.join('\n');
}

module.exports = { searchWeb, webContextBlock, deriveQuery, wikipediaFacts, duckFacts, webImages, referenceSites, duckReferenceSites, bingReferenceSites };
