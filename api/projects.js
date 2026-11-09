// /api/projects — Proyectos guardados EN LA DB, por usuario.
//   GET  /api/projects            -> lista MIS proyectos (orden: recientes)
//   GET  /api/projects?slug=xxx   -> un proyecto mío
//   POST /api/projects            -> guarda/actualiza { slug, title, spec, html, files }
//   DELETE /api/projects?slug=xxx -> borra un proyecto mío
// Requiere sesión (cookie httpOnly de /api/auth/*). Sin sesión -> 401.
// Cuenta nueva: la lista viene VACÍA (nada hecho antes). Al iniciar
// sesión aparecen solo SUS proyectos, cargados desde la DB.
// Sin DATABASE_URL -> 503 { db:false }.
const { hasDb, query } = require('./_db');
const { getSessionUser, readBody, noDb } = require('./_auth');
const crypto = require('crypto');

function slugify(s) {
  return String(s || 'mi-app').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mi-app';
}

function publicProject(row) {
  return {
    name: row.slug,
    slug: row.slug,
    title: row.title || row.slug,
    spec: row.spec || {},
    html: row.html || '',
    files: row.files || {},
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  // CORS: el portal (login.dmdmx.dev) lee esta API cross-origin con la
  // cookie de sesión. Sin estos headers el navegador bloquea la
  // respuesta y "Mis Páginas" muestra "No se pudo contactar al builder".
  res.setHeader('Access-Control-Allow-Origin', 'https://login.dmdmx.dev');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!hasDb()) return noDb(res);
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Inicia sesión para ver tus proyectos.' });

    if (req.method === 'GET') {
      const slug = req.query && req.query.slug ? slugify(req.query.slug) : '';
      if (slug) {
        const found = await query(
          'SELECT slug, title, spec, html, files, updated_at FROM projects WHERE user_id = $1 AND slug = $2',
          [user.id, slug]
        );
        if (!found.rows.length) return res.status(404).json({ error: 'Proyecto no encontrado.' });
        return res.status(200).json({ ok: true, db: true, project: publicProject(found.rows[0]) });
      }
      const list = await query(
        'SELECT slug, title, spec, html, files, updated_at FROM projects WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20',
        [user.id]
      );
      return res.status(200).json({ ok: true, db: true, projects: list.rows.map(publicProject) });
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      const slug = slugify(body.slug || body.name || (body.title || 'mi-app'));
      const title = String(body.title || slug).slice(0, 200);
      const spec = body.spec && typeof body.spec === 'object' ? body.spec : {};
      const html = typeof body.html === 'string' ? body.html.slice(0, 500 * 1024) : '';
      const files = body.files && typeof body.files === 'object' ? body.files : {};
      await query(
        'INSERT INTO projects (id, user_id, slug, title, spec, html, files, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) ' +
        'ON CONFLICT (user_id, slug) DO UPDATE SET title = EXCLUDED.title, spec = EXCLUDED.spec, ' +
        'html = EXCLUDED.html, files = EXCLUDED.files, updated_at = NOW()',
        [crypto.randomUUID(), user.id, slug, title, JSON.stringify(spec), html, JSON.stringify(files)]
      );
      return res.status(200).json({ ok: true, db: true, slug });
    }

    if (req.method === 'DELETE') {
      const slug = req.query && req.query.slug ? slugify(req.query.slug) : '';
      if (!slug) return res.status(400).json({ error: 'Falta slug.' });
      await query('DELETE FROM projects WHERE user_id = $1 AND slug = $2', [user.id, slug]);
      return res.status(200).json({ ok: true, db: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    if (e.code === 'NO_DB') return noDb(res);
    console.error('projects error:', e.message);
    return res.status(500).json({ error: 'No se pudieron leer tus proyectos.' });
  }
};
