// Módulo compartido por las funciones serverless de /api.
// Misma lógica que src/groq-adapter.js del proyecto local (modelo, prompt,
// extracción de JSON y sanitización), pero con fetch en vez de groq-sdk
// (sin dependencias: las funciones de Vercel corren solo con Node).
// La llave NUNCA se escribe aquí: se lee de process.env.GROQ_API_KEY.

const PRIMARY_MODEL = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';
// C1 (2026-11-08): 4096 tokens bastan para un spec (antes 8192, el doble
// de cupo por generación). Se mantiene el 120b como modelo principal:
// NO se cambió a 20b sin probar que el spec salga completo y sin
// placeholders; el 20b queda solo como fallback si el 120b deja de
// existir (isModelNotFound). Si el cupo sigue sin alcanzar para un
// salón, la solución es una key con más cupo o turnos, no bajar de modelo.
const MAX_TOKENS = 4096;
const TEMPERATURE = 0.7;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Prompt del sistema estilo Lovable: exige contenido REAL y específico,
 * nunca plantillas genéricas. La IA debe inventar un negocio coherente
 * (nombre, eslogan, menú, precios, testimonios) a partir del prompt.
 */
const SYSTEM_PROMPT = `Eres un diseñador web senior y copywriter experto, al nivel de Lovable.
Tu tarea es tomar la descripción de una página web y generar una especificación
JSON estructurada y COMPLETA, lista para renderizar una página real y bonita.

Responde ÚNICAMENTE con un JSON válido (sin markdown, sin explicaciones,
sin texto antes ni después). Estructura exacta:

{
  "type": "landing|portfolio|ecommerce|blog|docs|admin|custom",
  "title": "Nombre real del negocio o proyecto",
  "tagline": "Eslogan específico y atractivo, en español",
  "accent": "#color_hex",
  "dark": false,
  "brand": "Nombre corto de la marca",
  "heroImageQuery": "wood fired pizza margherita",
  "sections": [
    {
      "type": "hero|features|menu|gallery|pricing|testimonials|faq|stats|contact|cta|footer|form",
      "title": "Título real de la sección",
      "content": "Texto real y específico de la sección",
      "imageQuery": "wood fired pizza oven",
      "items": [
        { "name": "Nombre real del ítem", "description": "Descripción real y concreta", "price": "$149", "imageQuery": "pizza margherita" }
      ]
    }
  ],
  "prompt": "Prompt original del usuario"
}

REGLAS DURAS (si las rompes, la página sale mal):
1. PROHIBIDO el contenido genérico o de relleno. NUNCA escribas: "Beneficio 1",
   "Beneficio 2", "Lorem", "Título", "Descripción", "Lo que te hace diferente",
   "Prueba social y confianza", "Llamado a la acción claro", ni nada parecido.
   Tampoco repitas el prompt del usuario como texto de la página: jamás pongas
   "Genera una página de..." ni "Generada a partir de tu idea:" en ningún campo.
2. INVENTA un negocio coherente y específico (nombre propio, eslogan,
   menú/servicios con descripciones reales). PERO NUNCA INVENTES DATOS
   DE CONTACTO NI PRECIOS: jamás inventes un número de teléfono,
   WhatsApp, dirección, correo ni precios. Si el usuario NO dio esos
   datos, usa el marcador visible "[TU TELÉFONO]", "[TU DIRECCIÓN]",
   "[TU CORREO]" o "[PRECIO]" en ese campo, u omite esa sección. Un
   teléfono o dirección inventados se publicarían como reales y el
   cliente llamaría a un desconocido. Ej.: si pide una pizzería,
   inventa el nombre ("Pizzería Forno Vivo"), el eslogan y platos
   reales con su descripción; los precios van como "[PRECIO]" salvo
   que el usuario los haya dado. Si el usuario SÍ dio su teléfono,
   dirección o precios en el prompt, úsalos tal cual.
3. CONTENIDO EN ESPAÑOL (México), concreto y creíble: testimonios con
   nombre y ciudad (son reseñas de ejemplo, no datos de contacto),
   horarios (ej. "Lun–Dom 12:00–23:00"), beneficios concretos
   (ej. "Masa fermentada 48 h, horno a 450°"), preguntas frecuentes
   con respuestas útiles. La ubicación solo si el usuario la dio; si
   no, "[TU DIRECCIÓN]".
4. SECCIONES: entre 6 y 8. Empieza siempre con "hero" y termina con "cta" o
   "footer". Para negocios de comida incluye "menu" con al menos 4 platos;
   para servicios incluye "pricing" o "features" con servicios reales;
   incluye "testimonials" con al menos 3 reseñas y "faq" con al menos 3 preguntas.
5. ITEMS: cada item es un OBJETO con "name" y "description" reales. "price"
   solo cuando aplica (platos, planes, productos) y siempre en MXN con formato
   "$149" — o "[PRECIO]" si el usuario no dio precios (nunca inventes
   precios). "period": "mes" SOLO si el plan es de suscripción mensual;
   nunca pongas "period" en productos o servicios de pago único.
   Nunca dejes "description" vacío ni con texto genérico.
6. IMÁGENES: "heroImageQuery" e "imageQuery" son palabras clave EN INGLÉS
   para buscar una foto real (ej. "wood fired pizza margherita",
   "tacos al pastor", "coffee shop interior"). NUNCA inventes URLs de imágenes.
   No pongas URLs en ningún campo: solo las palabras clave.
7. "type": elige el más apropiado. "accent": un hex válido acorde al tema
   (ej. rojo tomate #dc2626 para pizzería, verde #16a34a para florería).
   "dark": false salvo que el usuario pida tema oscuro.
8. JSON válido, sin markdown, sin comas finales, sin caracteres sin escapar.
   Si no sabes un dato, usa el marcador visible ([TU TELÉFONO],
   [TU DIRECCIÓN], [TU CORREO], [PRECIO]) o omite la sección; NUNCA
   inventes teléfono, WhatsApp, dirección, correo ni precios, y nunca
   uses placeholders genéricos ("Título", "Descripción") ni "Lorem".
9. Si el mensaje incluye "DATOS REALES ENCONTRADOS EN LA WEB", USA esos datos
   (platos, servicios, precios típicos, historia del giro) en el contenido
   en vez de inventarlos; no contradigas esos datos.
10. Si el mensaje incluye "PÁGINAS WEB REALES DE ESTE GIRO", toma su
    ESTRUCTURA como referencia (qué secciones tienen, en qué orden y qué
    ofrece cada una) para que tu página esté al nivel de una página real
    viable, con secciones y contenido al nivel de esas referencias; NUNCA
    copies sus textos, marcas, imágenes ni precios.

EJEMPLO de nivel esperado (para "una página de una pizzería"):
{
  "type": "landing",
  "title": "Pizzería Forno Vivo",
  "tagline": "Pizza al horno de leña, masa de 48 horas y ingredientes de mercado.",
  "accent": "#dc2626",
  "dark": false,
  "brand": "Forno Vivo",
  "heroImageQuery": "wood fired pizza oven",
  "sections": [
    { "type": "hero", "title": "Pizza como debe ser", "content": "Horno de leña a 450°, masa fermentada 48 horas y queso mozzarella fresco todos los días.", "imageQuery": "wood fired pizza margherita", "items": [] },
    { "type": "menu", "title": "El menú", "content": "Nuestras pizzas más pedidas, hechas al momento.", "items": [
      { "name": "Margarita", "description": "Jitomate San Marzano, mozzarella fresca y albahaca.", "price": "[PRECIO]", "imageQuery": "pizza margherita" },
      { "name": "Pepperoni", "description": "Pepperoni, mozzarella y orégano, borde crujiente.", "price": "[PRECIO]", "imageQuery": "pepperoni pizza" }
    ] },
    { "type": "testimonials", "title": "Lo que dicen", "content": "Clientes que vuelven cada semana.", "items": [
      { "name": "Mariana G., Ciudad de México", "description": "La mejor pizza al horno de leña que he probado en la Roma. La masa es otro nivel.", "price": "", "imageQuery": "" }
    ] }
  ]
}`;

// Prompt para textos cortos de marketing (Contenido IA, Canva IA, POS):
// devuelve SOLO el JSON pedido, sin markdown ni explicaciones.
const TEXT_SYSTEM_PROMPT = `Eres un copywriter experto en español de México para pequeños
negocios. Responde ÚNICAMENTE con un JSON válido, sin markdown, sin
explicaciones y sin texto antes ni después. El JSON tiene exactamente las
claves que pide el usuario en su mensaje (por ejemplo "captions",
"hashtags", "title", "slogan", "products", "promo"). Contenido real y
específico del giro, nunca genérico ("Beneficio 1", "Lorem", "Título").
Precios en pesos mexicanos con formato "$99" cuando apliquen. Si el
mensaje incluye "DATOS REALES ENCONTRADOS EN LA WEB", úsalos y no los
contradigas.`;

// Prompt para el Copilot del Editor IA: edita un HTML completo según la
// instrucción del usuario y devuelve SOLO el HTML modificado.
const EDIT_SYSTEM_PROMPT = `Eres un desarrollador front-end experto. Recibes un archivo HTML
completo y una instrucción del usuario en español. Devuelve ÚNICAMENTE el
archivo HTML completo modificado, sin markdown, sin cercas de código, sin
explicaciones y sin texto antes ni después.

REGLAS:
1. Conserva toda la estructura y todo el contenido que el usuario NO pidió
   cambiar. Aplica solo el cambio pedido (color de acento, nombre del
   negocio, número de WhatsApp, modo oscuro/claro, textos, secciones).
2. El HTML resultante debe ser válido y completo, con <html>, <head> y <body>.
3. Nunca uses placeholders, "Lorem" ni texto genérico. Si cambias el nombre
   del negocio, cámbialo en TODAS partes (título, encabezado, pie).
4. No inventes URLs de imágenes ni scripts externos nuevos.`;

// Frases de relleno que jamás deben llegar al render.
const FORBIDDEN = [
  /beneficio\s*\d/i,
  /lorem/i,
  /lo que te hace diferente/i,
  /prueba social y confianza/i,
  /llamado a la acci[oó]n claro/i,
  /genera una p[aá]gina de/i,
  /generada a partir de tu idea/i,
  /t[ií]tulo de (la )?secci[oó]n/i,
  /^t[ií]tulo$/i,
  /^descripci[oó]n$/i
];

function isForbidden(text) {
  if (!text) return false;
  return FORBIDDEN.some((re) => re.test(String(text)));
}

function cleanText(text) {
  return String(text || '').trim();
}

// A1 — red de seguridad: si el modelo igual inventa un teléfono o
// dirección con los patrones típicos de relleno (1234/5678…), se
// sustituye por el marcador visible en vez de publicarlo como real.
// Solo toca secuencias telefónicas que contienen 1234 o 9876, y las
// direcciones inventadas observadas en la auditoría; un número real
// dado por el usuario (sin esos patrones) pasa intacto.
function scrubInventedContact(text) {
  let s = String(text || '');
  s = s.replace(/\+?[\d][\d\s\-()]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return (/1234|9876/.test(digits) && digits.length >= 10) ? '[TU TELÉFONO]' : m;
  });
  s = s.replace(/Calle Hidalgo\s*#?\s*123[^\n,]*/gi, '[TU DIRECCIÓN]');
  s = s.replace(/Av\.?\s*Insurgentes Sur\s*1234[^\n,]*/gi, '[TU DIRECCIÓN]');
  return s;
}

function sanitizeSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Spec inválido: Groq no retornó un objeto JSON');
  }
  if (!spec.type || !spec.title || isForbidden(spec.title)) {
    throw new Error('Spec inválido: falta type o title (o el título es genérico)');
  }
  if (isForbidden(spec.tagline)) spec.tagline = '';
  spec.tagline = scrubInventedContact(spec.tagline);
  spec.title = scrubInventedContact(spec.title);
  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    throw new Error('Spec inválido: faltan sections');
  }

  spec.sections = spec.sections
    .filter((s) => s && typeof s === 'object' && s.type && !isForbidden(s.title))
    .map((s) => {
      const section = {
        type: String(s.type),
        title: scrubInventedContact(cleanText(s.title)),
        content: isForbidden(s.content) ? '' : scrubInventedContact(cleanText(s.content)),
        imageQuery: cleanText(s.imageQuery || '')
      };
      if (Array.isArray(s.items)) {
        section.items = s.items
          .filter((it) => it && typeof it === 'object')
          .map((it) => ({
            name: scrubInventedContact(cleanText(it.name || it.title || '')),
            description: scrubInventedContact(cleanText(it.description || it.desc || it.content || '')),
            price: cleanText(it.price || ''),
            imageQuery: cleanText(it.imageQuery || '')
          }))
          .filter((it) => it.name && !isForbidden(it.name) && !isForbidden(it.description));
        if (section.items.length === 0) {
          section.items = s.items
            .filter((it) => typeof it === 'string' && it.trim() && !isForbidden(it))
            .map((it) => ({ name: it.trim(), description: '', price: '', imageQuery: '' }));
        }
      } else {
        section.items = [];
      }
      return section;
    })
    .filter((s) => s.title || (s.items && s.items.length) || s.content);

  if (spec.sections.length === 0) {
    throw new Error('Spec inválido: todas las secciones eran genéricas o vacías');
  }
  return spec;
}

function parseSpec(responseText) {
  if (!responseText || !responseText.trim()) {
    throw new Error('Groq retornó una respuesta vacía');
  }
  const unfenced = responseText
    .replace(/^\s*```(?:json|html)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch (e) {
    const jsonMatch = unfenced.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Groq no retornó un JSON válido');
    }
    return JSON.parse(jsonMatch[0]);
  }
}

function isModelNotFound(error) {
  const msg = String((error && error.message) || '').toLowerCase();
  const status = error && (error.status || error.statusCode);
  return (
    status === 404 ||
    msg.includes('model_not_found') ||
    msg.includes('model_deactivated') ||
    msg.includes('does not exist') ||
    msg.includes('no longer exists')
  );
}

function groqError(status, text) {
  const err = new Error(`Groq error ${status}: ${String(text || '').slice(0, 200)}`);
  err.status = status;
  return err;
}

async function callGroq(model, messages, signal, maxTokens) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error('GROQ_API_KEY no configurada en el servidor');
    err.status = 503;
    throw err;
  }
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      'User-Agent': 'groq-sdk/0.4.0'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || MAX_TOKENS,
      temperature: TEMPERATURE,
      messages
    }),
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 429 = cupo/límite de Groq: se propaga tal cual para que el frontend
    // caiga al generador local en vez de reintentar en bucle.
    throw groqError(res.status, text);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content || ''
    : '';
  return { content, model: data.model || model };
}

/**
 * Genera un spec de página con Groq. Intenta con gpt-oss-120b y, solo si
 * ese modelo ya no existe, reintenta una vez con gpt-oss-20b.
 * webContext (opcional): bloque de datos reales de la web (Wikipedia /
 * DuckDuckGo / Openverse) que se añade al mensaje del usuario para que el
 * contenido deje de ser genérico.
 */
async function generateSpec(prompt, previousSpec, signal, webContext) {
  let userMessage = prompt;
  if (previousSpec) {
    userMessage =
      'Contexto previo de la página:\n' + JSON.stringify(previousSpec) +
      '\n\nNueva solicitud del usuario:\n' + prompt;
  }
  if (webContext) {
    userMessage += '\n\n' + webContext;
  }
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ];
  let result;
  let modelUsed = PRIMARY_MODEL;
  try {
    result = await callGroq(PRIMARY_MODEL, messages, signal);
  } catch (error) {
    if (isModelNotFound(error)) {
      modelUsed = FALLBACK_MODEL;
      result = await callGroq(FALLBACK_MODEL, messages, signal);
    } else {
      throw error;
    }
  }
  // El modelo a veces devuelve JSON con un detalle inválido o truncado
  // (temperatura 0.7): un reintento con una muestra nueva suele bastar.
  let spec;
  try {
    spec = sanitizeSpec(parseSpec(result.content));
  } catch (e) {
    const retry = await callGroq(modelUsed, messages, signal);
    spec = sanitizeSpec(parseSpec(retry.content));
    result = retry;
  }
  return {
    spec,
    model: result.model || modelUsed,
    plan: 'Creando ' + spec.type + ': ' + spec.title + ' con ' + spec.sections.length + ' secciones'
  };
}

/**
 * Edita un HTML completo según la instrucción (Copilot del Editor IA).
 * Devuelve el HTML modificado, o lanza si la respuesta no es HTML válido.
 */
async function editHtml(instruction, html, signal) {
  const messages = [
    { role: 'system', content: EDIT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: 'Instrucción del usuario: "' + instruction + '"\n\nCódigo HTML actual:\n\n' + html
    }
  ];
  let result;
  let modelUsed = PRIMARY_MODEL;
  try {
    result = await callGroq(PRIMARY_MODEL, messages, signal, 8192);
  } catch (error) {
    if (isModelNotFound(error)) {
      modelUsed = FALLBACK_MODEL;
      result = await callGroq(FALLBACK_MODEL, messages, signal, 8192);
    } else {
      throw error;
    }
  }
  let out = cleanHtml(result.content);
  if (!isValidHtml(out)) {
    // Un reintento con una muestra nueva suele bastar.
    const retry = await callGroq(modelUsed, messages, signal, 8192);
    out = cleanHtml(retry.content);
    result = retry;
  }
  if (!isValidHtml(out)) {
    throw new Error('Groq no retornó un HTML válido');
  }
  return { html: out, model: result.model || modelUsed };
}

/**
 * Texto corto de marketing con Groq (Contenido IA, Canva IA, POS).
 * prompt: instrucción en español que pide un JSON con claves concretas.
 * webContext: datos reales de la web (opcional). Devuelve el objeto JSON.
 */
async function generateText(prompt, signal, webContext) {
  let userMessage = String(prompt || '').trim();
  if (webContext) userMessage += '\n\n' + webContext;
  const messages = [
    { role: 'system', content: TEXT_SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ];
  let result;
  let modelUsed = PRIMARY_MODEL;
  try {
    result = await callGroq(PRIMARY_MODEL, messages, signal, 2048);
  } catch (error) {
    if (isModelNotFound(error)) {
      modelUsed = FALLBACK_MODEL;
      result = await callGroq(FALLBACK_MODEL, messages, signal, 2048);
    } else {
      throw error;
    }
  }
  let out;
  try {
    out = parseSpec(result.content);
  } catch (e) {
    const retry = await callGroq(modelUsed, messages, signal, 2048);
    out = parseSpec(retry.content);
    result = retry;
  }
  if (!out || typeof out !== 'object') throw new Error('Groq no retornó un JSON válido');
  return { data: out, model: result.model || modelUsed };
}

function cleanHtml(text) {
  return String(text || '').trim()
    .replace(/^\s*```(?:html)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function isValidHtml(out) {
  return out.length >= 100 && /<body[\s>]/i.test(out) && /<\/body>/i.test(out);
}

module.exports = {
  generateSpec,
  editHtml,
  generateText,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  MAX_TOKENS,
  TEMPERATURE,
  SYSTEM_PROMPT,
  sanitizeSpec,
  parseSpec
};
