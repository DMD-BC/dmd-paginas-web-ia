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
  // Máximo 6 palabras, sin puntuación.
  q = q.replace(/[^\wáéíóúñ\s]/gi, '').split(/\s+/).slice(0, 6).join(' ').trim();
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

// Búsqueda completa para un prompt de usuario. Nunca lanza.
// NOTA: Openverse se probó pero es demasiado lento (>8 s por consulta
// desde el servidor) y no fiable; las imágenes siguen con el catálogo
// curado de Unsplash (fotos reales verificadas), no con Openverse.
async function searchWeb(prompt) {
  const query = deriveQuery(prompt);
  const [wiki, duck] = await Promise.all([
    wikipediaFacts(query),
    duckFacts(query)
  ]);
  const facts = [...wiki, ...duck].slice(0, 3);
  return { query, facts, images: [] };
}

// Bloque de texto para meter en el prompt de Groq.
function webContextBlock(web) {
  if (!web || (!web.facts.length && !web.images.length)) return '';
  const lines = ['DATOS REALES ENCONTRADOS EN LA WEB (úsalos, no los contradigas; si un dato no aplica al negocio, ignóralo):'];
  web.facts.forEach((f) => lines.push('- [' + f.source + '] ' + f.text));
  if (web.images.length) {
    lines.push('FOTOS REALES ENCONTRADAS EN LA WEB (Openverse, licencia CC) para inspirar las palabras clave de imagen:');
    web.images.slice(0, 4).forEach((im) => lines.push('- "' + im.title + '" (' + im.license + ')'));
  }
  return lines.join('\n');
}

module.exports = { searchWeb, webContextBlock, deriveQuery, wikipediaFacts, duckFacts, webImages };
