# DMD | paginas web — Todo estilo Lovable

Paquete completo en estilo Lovable original, sin el rediseño oscuro.

## Colores Lovable
- Fondo crema `#f7f4ed`, paneles `#fcfbf8`
- Texto `#1c1c1c`, secundario `#5f5f5d`
- Degradado: naranja `#ff8a4c` / rosa `#f0467f` / azul `#4f7dff`
- Botones negros en píldora, Inter

## Archivos
- `index.html` — landing Lovable original, CSS incrustado.
- `app.html` — builder Lovable original, con `app-lovable.css` incrustado para que se vea con color al abrirlo solo.
- `dashboard.html` — dashboard adaptado a Lovable (antes era azul oscuro). Mismos IDs y scripts.
- `editor-ia.html` — Editor IA de plantillas, fusionado desde la página oficial: carga la plantilla de `localStorage` (`dmd_editor_template`), la muestra en vivo y la edita con el Copilot (color, nombre, WhatsApp, modo oscuro/claro) con su motor local; permite copiar código, descargar el HTML y publicar (vía `dmd-publisher.js` de dmd-bc.vercel.app). Su interfaz está adaptada al estilo Lovable (crema, botones negros en píldora). Al cargar un ejemplo en el builder, ese ejemplo queda guardado como plantilla activa para el Editor.

## Qué no cambió
Ningún ID, ningún script, ningún texto. `server.js`, `src/groq-adapter.js`, `assets/js/*` y `.env` se quedan igual.

## Instalar
Sustituye `index.html`, `app.html` y `dashboard.html` en tu carpeta clon-web de Drive por estos tres archivos, y arranca con `npm start`.

## Plantillas con ejemplo

Cada plantilla de la landing enlaza a `app.html?example=<slug>` (consultora, reservas, ventas, portafolio, saas, cafe) y el builder carga ese ejemplo ya construido en Preview, Código y Timeline, con etiqueta «Ejemplo» — sin necesitar Groq ni `npm start`. Escribir un prompt y pulsar Construir sigue usando el generador con Groq.
