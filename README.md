# DMD | Páginas web con IA (crear.dmdmx.dev)

Builder de páginas con IA. Frontend estático + funciones serverless de Vercel (sin framework).

## Estructura
- `index.html` — landing del producto.
- `app.html` — builder (chat + vista previa). Antes de la primera página de un negocio hace una entrevista corta al usuario.
- `editor-ia.html` — Editor IA con Copilot para editar el HTML de una plantilla.
- `dashboard.html` — panel de información.
- `assets/js/` — `generator.js` (render de páginas), `image-catalog.js` (fotos), `app.js` (UI del builder), `api-client.js`/`llm.js` (cliente de la IA), `usage.js` (cuenta y cupo).
- `api/` — `generate` (IA con Groq), `publish` (publica en GitHub), `auth/*` (registro, login, promo), `projects`, `usage`, `health`; módulos `_auth`, `_db`, `_groq`, `_ratelimit`, `_websearch`, `_watermark`.
- `schema.sql` — tablas de Postgres (también se crean solas al primer uso).

## Variables de entorno (Vercel → Settings → Environment Variables)
| Variable | Uso |
|---|---|
| `GROQ_API_KEY` | IA (Groq). Obligatoria para generar con IA. |
| `DATABASE_URL` | Postgres (Supabase/Neon): cuentas, cuota, proyectos, límites de uso. |
| `GITHUB_TOKEN` | Publicar páginas en `dmdmx.dev/sitios/<slug>`. |
| `PROMO_CODE` | Código promocional (sube el límite a 50 cambios). |
| `DB_SSL_STRICT` | Opcional: `1` valida el certificado SSL de la base de datos. |

## Límites
Anónimo 3 cambios, registrado 25, con código promo 50. Rate limit por IP guardado en Postgres (`rate_limits`).

## Desarrollo
No hay build. Abre los `.html` con un servidor estático (`npx serve`) o despliega en Vercel; las APIs solo corren en Vercel (`vercel dev`).
