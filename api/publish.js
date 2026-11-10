// POST /api/publish — Publica la página generada en el builder como
// https://www.dmdmx.dev/sitios/<slug> (repo oficial DMD-BC/DMD, carpeta
// sitios/, rama main; el proyecto digital_mija_dreams_dmd despliega
// desde main, así que la URL queda viva sola tras el commit).
//
// Autenticación: el token de GitHub vive SOLO en la variable de entorno
// GITHUB_TOKEN del proyecto dmd-paginas-web-ia en Vercel (fine-grained
// PAT, solo repo DMD-BC/DMD, permiso Contents: lectura y escritura).
// Jamás se devuelve, se registra ni se pone en el frontend o en el repo.
// Sin token, el endpoint responde 503 con el motivo real y el builder
// sigue ofreciendo descargar el .html (no se rompe nada).

const { ensureWatermark } = require('./_watermark');

const OWNER = 'DMD-BC';
const REPO = 'DMD';
const BRANCH = 'main';
const SITE = 'https://www.dmdmx.dev';

const MAX_HTML_BYTES = 500 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

// Scripts externos permitidos en la página publicada (las páginas
// generadas usan CSS/JS inline; si traen un <script src>, que sea de
// estos dominios o se rechaza).
const ALLOWED_SCRIPT_HOSTS = new Set([
  'cdn.tailwindcss.com',
  'unpkg.com',
  'www.dmdmx.dev',
  'dmdmx.dev',
  'dmd-bc.vercel.app'
]);

// Límite por IP (best-effort en memoria, igual que /api/generate).
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 1000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (e) {
      return {};
    }
  }
  return {};
}

function slugify(s) {
  return String(s || 'mi-pagina').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'mi-pagina';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Rechaza scripts externos a dominios no permitidos y javascript: URLs.
function unsafeHtml(html) {
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const src of srcs) {
    try {
      const u = new URL(src, SITE);
      if (!ALLOWED_SCRIPT_HOSTS.has(u.hostname)) return 'script externo no permitido: ' + u.hostname;
    } catch (e) {
      return 'URL de script inválida';
    }
  }
  if (/href\s*=\s*["']\s*javascript:/i.test(html)) return 'enlaces javascript: no permitidos';
  return null;
}

// Añade og:url + canonical de la URL pública y el pie "Hecho con DMD".
function finalizeHtml(html, slug, title) {
  const url = SITE + '/sitios/' + slug;
  let out = html;
  const meta = '<meta property="og:url" content="' + esc(url) + '">' +
    '<link rel="canonical" href="' + esc(url) + '">';
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, '  ' + meta + '\n</head>');
  else out = meta + '\n' + out;
  if (/<title>/i.test(out)) {
    // El título ya viene del generador; no se toca.
  }
  const footer = '<footer style="text-align:center;padding:24px 16px;font:14px system-ui,sans-serif;color:#6b7280;background:#f7f4ed">' +
    'Hecho con <a href="' + SITE + '" style="color:#111;font-weight:700;text-decoration:none">DMD</a> · ' +
    '<a href="' + SITE + '" style="color:#111">www.dmdmx.dev</a></footer>';
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, footer + '\n</body>');
  else out += '\n' + footer;
  // Marca de agua DMD en toda página publicada (si aún no la trae).
  out = ensureWatermark(out);
  return out;
}

async function gh(path, token, opts) {
  const res = await fetch('https://api.github.com' + path, {
    method: (opts && opts.method) || 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'dmd-paginas-web-ia-publish'
    },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
  return { status: res.status, data };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido, usa POST' });
  }

  if (rateLimited(clientIp(req))) {
    return res.status(429).json({
      error: 'Demasiadas publicaciones, espera unos minutos e inténtalo de nuevo'
    });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(503).json({
      error: 'Publicación no configurada: falta el token de GitHub (GITHUB_TOKEN) en el servidor. Descarga el archivo .html por ahora.'
    });
  }

  const body = readBody(req);
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
  const rawHtml = typeof body.html === 'string' ? body.html : '';
  if (!rawHtml) {
    return res.status(400).json({ error: 'html es requerido' });
  }
  if (Buffer.byteLength(rawHtml, 'utf8') > MAX_HTML_BYTES) {
    return res.status(400).json({ error: 'La página es demasiado grande (máximo 500 KB)' });
  }
  if (!/^<!doctype html/i.test(rawHtml.trim()) && !/<html/i.test(rawHtml)) {
    return res.status(400).json({ error: 'El html no parece una página completa' });
  }
  const unsafe = unsafeHtml(rawHtml);
  if (unsafe) {
    return res.status(400).json({ error: 'HTML no permitido: ' + unsafe });
  }

  const baseSlug = slugify(body.slug || title || 'mi-pagina');
  if (!SLUG_RE.test(baseSlug)) {
    return res.status(400).json({ error: 'Nombre de página inválido' });
  }

  try {
    // Encuentra un slug libre: base, base-2, base-3… nunca sobrescribir.
    let slug = baseSlug;
    for (let n = 0; n < 10; n++) {
      const candidate = n === 0 ? baseSlug : baseSlug + '-' + (n + 1);
      const check = await gh(
        '/repos/' + OWNER + '/' + REPO + '/contents/sitios/' + candidate + '.html?ref=' + BRANCH,
        token
      );
      if (check.status === 404) { slug = candidate; break; }
      if (check.status !== 200) {
        return res.status(502).json({ error: 'No se pudo revisar si el nombre ya existe (GitHub ' + check.status + ')' });
      }
      slug = candidate; // existe: probar el siguiente
      if (n === 9) {
        return res.status(409).json({ error: 'Ese nombre ya está muy usado, cambia el nombre del proyecto e inténtalo de nuevo' });
      }
    }

    // M3: el check-then-PUT no es atómico: si dos personas publican el
    // mismo slug a la vez, GitHub responde 422 (el archivo ya existe).
    // En vez de devolver 502 directo, se reintenta el PUT con el
    // siguiente slug libre (slug-2, slug-3…), hasta 5 intentos.
    const base = slug.replace(/-\d+$/, '');
    let put = null;
    let putSlug = slug;
    for (let attempt = 0; attempt < 5; attempt++) {
      const trySlug = attempt === 0 ? slug : base + '-' + (attempt + 1);
      putSlug = trySlug;
      put = await gh(
        '/repos/' + OWNER + '/' + REPO + '/contents/sitios/' + trySlug + '.html',
        token,
        {
          method: 'PUT',
          body: {
            message: 'Publica sitio: ' + trySlug + ' (DMD Builder)',
            content: Buffer.from(finalizeHtml(rawHtml, trySlug, title || trySlug), 'utf8').toString('base64'),
            branch: BRANCH
          }
        }
      );
      if (put.status === 201 || put.status === 200) { slug = trySlug; break; }
      if (put.status !== 422) break;
      // 422: el slug ya existe (carrera) -> probar el siguiente.
    }
    if (!put || (put.status !== 201 && put.status !== 200)) {
      const msg = (put && put.data && put.data.message) || ('GitHub ' + (put ? put.status : '?'));
      return res.status(502).json({ error: 'GitHub no aceptó la publicación: ' + msg });
    }
    slug = putSlug;

    return res.status(200).json({
      success: true,
      slug,
      url: SITE + '/sitios/' + slug,
      commit: put.data && put.data.commit && put.data.commit.sha
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error publicando la página' });
  }
};
