/* ============================================================
   image-catalog.js — Catálogo de fotos reales (Unsplash) para
   las páginas generadas, separado de generator.js para que
   generator.js no supere el límite de 128 KB por argumento al
   subirlo a Vercel con el CLI.
   TODOS los IDs de Unsplash de aquí fueron verificados con curl
   (HTTP 200) antes de entrar. Pollinations YA NO se usa como
   imagen principal: su tarjeta de límite llega como HTTP 200 y
   no se puede detectar con onerror. pollinationsUrl() se conserva
   solo por compatibilidad (Generator la exporta).
   Se carga ANTES de generator.js en app.html.
   ============================================================ */
(function () {
  "use strict";

  var normQuery = function (q) {
    return String(q || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  };

  var UNSPLASH = {
    pizza: "photo-1513104890138-7c749659a591",
    tacos: "photo-1551504734-5ee1c4a1479b",
    tacos2: "photo-1565299585323-38d6b0865b47",
    cafe: "photo-1495474472287-4d71bcdd2085",
    cafeteria: "photo-1501339847302-ac426a4a7cbb",
    burger: "photo-1568901346375-23c9450c58cd",
    sushi: "photo-1579871494447-9811cf80d66c",
    ensalada: "photo-1512621776951-a57141f2eefd",
    flores: "photo-1490750967868-88aa4486c946",
    restaurante: "photo-1517248135467-4c7edcad34c4",
    panaderia: "photo-1509440159596-0249088772ff",
    pan: "photo-1549931319-a545dcf3bc73",
    croissant: "photo-1555507036-ab1f4038808a",
    pastel: "photo-1578985545062-69928b1d9587",
    tarta: "photo-1565958011703-44f9829ba187",
    postre: "photo-1551024506-0bccd828d307",
    helado: "photo-1563805042-7684c019e1cb",
    donas: "photo-1517433670267-08bbd4be890f",
    carne: "photo-1558030006-450675393462",
    carniceria: "photo-1602470520998-f4a52199a3d6",
    asado: "photo-1529193591184-b1d58069ecdd",
    pollo: "photo-1562967914-608f82629710",
    mariscos: "photo-1559742811-822873691df8",
    barberia: "photo-1503951914875-452162b0f3f1",
    barberia2: "photo-1585747860715-2ba37e788b70",
    gym: "photo-1534438327276-14e5300c3a48",
    oficina: "photo-1556761175-b413da4baf72",
    equipo: "photo-1522071820081-009f0129c71c",
    casa: "photo-1560518883-ce09059eeffa",
    moda: "photo-1445205170230-053b83016050",
    viaje: "photo-1469854523086-cc02fe5d8800",
    tecnologia: "photo-1498050108023-c5249f4df085",
    comida: "photo-1504674900247-0877df9cc836",
    mascotas: "photo-1548199973-03cce0bbc87b",
    gato: "photo-1514888286974-6c03e2ca1dba",
    libreria: "photo-1481627834876-b7833e8f5570",
    joyeria: "photo-1515562141207-7a88fb7ce338",
    muebles: "photo-1555041469-a586c61ea9bc",
    auto: "photo-1492144534655-ae79c964c9d7",
    taller: "photo-1486262715619-67b85e0b08d3",
    belleza: "photo-1570172619644-dfd03ed5d881",
    spa: "photo-1560750588-73207b1ef5b8",
    // Papelería y útiles (verificados visualmente 2026-11-08):
    // papeleria = útiles de manualidades (cinta, tijeras, cúter, notas);
    // papeleria2 = organizador de escritorio con plumas y marcadores;
    // cuaderno = libreta abierta + lápiz; utiles = libros + manzana +
    // lápices de colores + cubos ABC; arte = pinceles con pintura.
    papeleria: "photo-1452860606245-08befc0ff44b",
    papeleria2: "photo-1456735190827-d1262f71b8a3",
    cuaderno: "photo-1452421822248-d4c2b47f0c81",
    utiles: "photo-1503676260728-1c00da094a0b",
    arte: "photo-1513364776144-60967b0f800f",
    // Otros giros (verificados visualmente 2026-11-08):
    // farmacia = cápsulas; ferreteria = taladro; dulceria = chocolate;
    // jugueteria = juguetes (robots y carritos); zapateria = tenis;
    // estetica = salón de peluquería; tienda = interior de tienda
    // de ropa, foto neutra usada como fallback genérico.
    farmacia: "photo-1587854692152-cbe660dbde88",
    ferreteria: "photo-1504148455328-c376907d081c",
    dulceria: "photo-1511381939415-e44015466834",
    jugueteria: "photo-1558060370-d644479cb6f7",
    zapateria: "photo-1549298916-b41d501d3772",
    estetica: "photo-1560066984-138dadb4c035",
    tienda: "photo-1441986300917-64674bd600d8"
  };
  // Palabras clave (sin acentos) -> foto curada. Lo específico va
  // antes que lo genérico.
  var UNSPLASH_KEYWORDS = [
    [/pizza|pizzeria/, UNSPLASH.pizza],
    [/taquer[ií]a|taco|pastor|birria/, UNSPLASH.tacos],
    // Papelería ANTES que las reglas de comida: "papelería" no tiene
    // nada que ver con pastel, y "colores pastel" (lápices) tampoco
    // es un pastel de comer (ver el guardado en unsplashUrl abajo).
    [/papeler[ií]a|stationery|cuaderno|lapiz|pluma|mochila|agenda|carpeta|borrador|\bregla\b|tijeras|pegamento|marcador|plumon|crayon|acuarela|\bpapel\b|utiles/, UNSPLASH.papeleria],
    [/pincel|pintura|\bdibujo\b|arte/, UNSPLASH.arte],
    [/ferreter[ií]a|herramienta|taladro|tornillo/, UNSPLASH.ferreteria],
    [/farmacia|medicina|medicamento|pastilla|farmaceutic/, UNSPLASH.farmacia],
    [/dulcer[ií]a|dulce|chocolate|caramelo|gomita/, UNSPLASH.dulceria],
    [/jugueter[ií]a|juguete|muneca|peluche|lego/, UNSPLASH.jugueteria],
    [/zapater[ií]a|zapato|tenis|calzado|\bbota\b/, UNSPLASH.zapateria],
    [/estetica|salon de belleza|estilista|manicura|pedicura/, UNSPLASH.estetica],
    [/croissant/, UNSPLASH.croissant],
    [/bolillo|baguette|\bpan\b|pan dulce|concha/, UNSPLASH.pan],
    [/panader[ií]a|bread|bakery/, UNSPLASH.panaderia],
    [/helado|ice cream/, UNSPLASH.helado],
    [/pastel|tarta|cake/, UNSPLASH.pastel],
    [/dona|donut/, UNSPLASH.donas],
    [/postre|dessert/, UNSPLASH.postre],
    [/carniceria|butcher/, UNSPLASH.carniceria],
    [/asado|parrilla|grill|barbacoa/, UNSPLASH.asado],
    [/carne|bistec|arrachera|ribeye|chorizo|costilla|filete|steak/, UNSPLASH.carne],
    [/pollo|chicken|alitas/, UNSPLASH.pollo],
    [/marisco|seafood|camaron|pescado/, UNSPLASH.mariscos],
    [/cafeteria|coffee shop/, UNSPLASH.cafeteria],
    [/caf[eé]|coffee|latte|barista/, UNSPLASH.cafe],
    [/burger|hamburguesa/, UNSPLASH.burger],
    [/sushi|ramen|japon/, UNSPLASH.sushi],
    [/ensalada|salad|healthy|vegan|vegetarian/, UNSPLASH.ensalada],
    [/flor|flower|ramo|bouquet/, UNSPLASH.flores],
    [/barberia|barber|peluqueria/, UNSPLASH.barberia],
    [/belleza|skincare|maquillaje|cosmetica/, UNSPLASH.belleza],
    [/spa|masaje/, UNSPLASH.spa],
    [/mascota|perro|dog|veterinaria/, UNSPLASH.mascotas],
    [/gato|cat/, UNSPLASH.gato],
    [/libreria|library|libro/, UNSPLASH.libreria],
    [/joyeria|joya|jewel/, UNSPLASH.joyeria],
    [/mueble|sofa|decoracion/, UNSPLASH.muebles],
    [/taller|mecanico/, UNSPLASH.taller],
    [/auto|carro|coche/, UNSPLASH.auto],
    [/gym|gimnasio|fitness|entrenamiento/, UNSPLASH.gym],
    [/oficina|office|consultor|reunion|meeting/, UNSPLASH.oficina],
    [/equipo|team|colaboraci/, UNSPLASH.equipo],
    [/casa|house|inmobiliaria|departamento/, UNSPLASH.casa],
    [/moda|fashion|ropa|vestido/, UNSPLASH.moda],
    [/viaje|travel|playa|monta/, UNSPLASH.viaje],
    [/tecnolog|software|laptop|programaci/, UNSPLASH.tecnologia],
    [/restaurante|restaurant|comida|food|menu|cocina/, UNSPLASH.comida],
    // Fallback neutro: interior de una tienda genérica. Antes era la
    // foto de restaurante (mesas), que salía en cualquier negocio sin
    // regla propia, como la papelería.
    [/.*/, UNSPLASH.tienda]
  ];

  // Devuelve la URL de una foto real verificada, o null si no hay query.
  var unsplashUrl = function (query, w) {
    if (!query || !String(query).trim()) return null;
    var q = normQuery(query);
    // "colores pastel" / "color pastel" / "tonos pastel" son colores
    // de lápices y útiles, NO un pastel de comer: se quita la frase
    // antes de matchear para que no caiga en la regla de pastel/cake.
    q = q.replace(/colores?\s+pastel|tonos?\s+pastel|pastel\s+colou?rs?/g, " ");
    for (var i = 0; i < UNSPLASH_KEYWORDS.length; i++) {
      if (UNSPLASH_KEYWORDS[i][0].test(q)) {
        return "https://images.unsplash.com/" + UNSPLASH_KEYWORDS[i][1] + "?q=80&w=" + (w || 1200) + "&auto=format&fit=crop";
      }
    }
    return null;
  };

  // Español -> inglés para prompts de imagen (solo compatibilidad:
  // Pollinations ya no es la fuente principal de imágenes).
  var IMG_EN = [
    [/panader[ií]a/g, "bakery"], [/pasteler[ií]a/g, "pastry shop"], [/tacos|taquer[ií]a/g, "tacos"],
    [/caf[eé]|cafeter[ií]a/g, "coffee shop"], [/pizzer[ií]a/g, "pizzeria"], [/restaurante/g, "restaurant"],
    [/florer[ií]a|flores/g, "flower shop"], [/barber[ií]a/g, "barbershop"], [/gimnasio/g, "gym"],
    [/ropa|boutique/g, "clothing boutique"], [/hotel/g, "hotel"], [/playa/g, "beach"],
    [/pan\b/g, "bread"], [/pastel/g, "cake"], [/croissant/g, "croissant"], [/concha/g, "sweet bread"],
    [/cerveza/g, "beer"], [/vino/g, "wine"], [/ensalada/g, "salad"],
    [/hamburguesa/g, "burger"], [/sushi/g, "sushi"], [/pizza/g, "pizza"]
  ];
  var IMG_STOP = /\b(de|la|el|los|las|un|una|unos|unas|con|y|en|su|sus|del|al|para|por|recien|galeria|gallery|menu|fotos|imagen|nuestro|nuestra)\b/g;
  var toImgEn = function (s) {
    var t = normQuery(s);
    for (var i = 0; i < IMG_EN.length; i++) t = t.replace(IMG_EN[i][0], IMG_EN[i][1]);
    t = t.replace(IMG_STOP, " ").replace(/[^a-z0-9 ,-]/g, "").replace(/\s+/g, " ").trim();
    var seen = {};
    return t.split(" ").filter(function (w) { return w && !seen[w] && (seen[w] = 1); }).join(" ");
  };
  var seedOf = function (s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 100000;
  };
  var pollinationsUrl = function (query, alt, w, h) {
    if (!query || !String(query).trim()) return null;
    var subject = toImgEn(query + " " + (alt || "")) || "modern business";
    var prompt = "photorealistic " + subject + ", professional photography, natural light, high detail";
    return "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
      "?width=" + (w || 1024) + "&height=" + (h || 768) + "&seed=" + seedOf(subject) + "&model=flux&nologo=true";
  };

  window.DMDImages = {
    UNSPLASH: UNSPLASH,
    UNSPLASH_KEYWORDS: UNSPLASH_KEYWORDS,
    unsplashUrl: unsplashUrl,
    pollinationsUrl: pollinationsUrl,
    toImgEn: toImgEn
  };
})();
