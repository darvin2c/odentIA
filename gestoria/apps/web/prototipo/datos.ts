/**
 * Los datos del prototipo, en memoria: cinco tiendas de ejemplo, una por rubro, con sus productos,
 * la plantilla de datos de su rubro y tres conversaciones de Sofi. Las fotos son de Wikimedia
 * Commons (créditos en `CREDITOS`), recortadas; los videos están armados con esas fotos.
 */

export type RubroId = "calzado" | "ropa" | "cosmetica" | "tecnologia" | "hogar"
export type Rol = "dueno" | "ventas"

export interface Dato {
  id: string
  label: string
  type: "chips" | "text" | "percol" | "table" | "date"
  opts?: string[]
  cols?: string[]
  /** Sofi lo necesita para vender sola; sin esto, suma. */
  need?: boolean
  /** Lo que pregunta la IA cuando no lo ve en las fotos. */
  ask?: string
  /** Una pregunta de sí o no que arma el texto. */
  ai?: { q: string; a: Record<string, string> }
  /** Palabras con que lo pregunta una clienta (para la prueba de Sofi). */
  keys: string[]
}

export interface Color {
  id: string
  name: string
  hex: string
  hex2?: string
  /** Lo que propone la IA desde la foto: se ve con ✦ hasta aceptarlo. */
  aiHex?: string
  aiName?: string
}

export interface Media {
  id: string
  src: string
  kind: "foto" | "video"
  /** El color al que pertenece. */
  color?: string
  /** Lo asignó la IA y nadie lo confirmó todavía. */
  aiColor?: boolean
  poster?: string
  dur?: number
  label?: string
}

export interface Promo {
  id: string
  nombre: string
  pct: number
  alcance: string
  desde: string
  hasta: string
}

export interface Tramo {
  desde: number
  precio: number
}

export type EstadoId =
  | "disponible"
  | "agotado"
  | "encargo"
  | "cupo"
  | "preventa"
  | "liquidacion"
  | "no"

export interface Producto {
  id: string
  name: string
  cat: string
  estado: EstadoId
  estadoInfo: { dias?: string; cupo?: string; fecha?: string }
  media: Media[]
  colors: Color[]
  sizes: string[]
  /** `${colorId}|${talla}` → unidades. */
  stock: Record<string, number>
  /** Precio propio de una variante; sin él, el del producto. */
  prices: Record<string, number>
  list: number
  min: number | null
  costos: { fecha: string; cant: number; costo: number }[]
  tiers: Tramo[]
  mayor: Tramo | null
  promos: Promo[]
  ofertas: { envio: boolean; soles: boolean; regalo: string; dosx: boolean }
  datos: Record<string, unknown>
  texto: string
  preguntas: { q: string; a: string; who: string }[]
  keywords: string[]
  web: { visible: boolean; slug: string }
  paquete: { peso: string; l: string; a: string; h: string }
  combo: { con: string[]; pct: number }
  parecido: string[]
  sku: string
  /** Lo que propone la IA y todavía no se aceptó. */
  ai: {
    datos?: Record<string, unknown>
    keywords?: string[]
    /** `null`: descartada; sin nada, la IA propone una según el margen. */
    tier?: Tramo | null
    promo?: Promo & { porque: string }
    paquete?: { peso: string; l: string; a: string; h: string }
    texto?: string
    name?: string
    cat?: string
  }
}

export interface Mensaje {
  k: "in" | "out" | "sys"
  t: string
  h?: string
  img?: string
  video?: string
  used?: string[]
  nota?: boolean
}
export interface Chat {
  name: string
  pid: string
  msgs?: Mensaje[]
  nego?: boolean
  q?: string
  short?: string
  ans?: string
}

export interface Rubro {
  label: string
  store: { name: string; color: string; owner: string; mail: string; ventas: string; slug: string }
  unit: string
  unitOne: string
  row: string
  col: string | null
  datos: Dato[]
  /** Las fotos «recientes» que ofrece Agregar desde fotos. */
  gallery: string[]
  /** Lo que la IA «ve» en cada foto: producto, color, hex (y el segundo, si es bicolor). */
  ph: Record<string, [string, string, string, string?]>
  kinds: Record<string, { name: string; cat: string; cols: string; texto: string; kw: string[] }>
  /** Las fotos de ejemplo de «Cargar muchos». */
  pool: string[]
  /** Lo que «ve» la cámara del prototipo, toma a toma. */
  camara: string[]
  /** Lo que se le pregunta a Sofi para probarla. */
  sugeridas: string[]
  products: () => Producto[]
  chats: Chat[]
}

export const HOY = "2026-11-27"
export const DISTRITOS: [string, number][] = [
  ["Surco", 10],
  ["Miraflores", 10],
  ["San Juan de Lurigancho", 12],
  ["Callao", 12],
  ["Provincia, por agencia", 18],
  ["Recojo en tienda", 0],
]
export const GRATIS_DESDE = 250

export const ESTADOS: { id: EstadoId; label: string; sofi: string }[] = [
  { id: "disponible", label: "Disponible", sofi: "Ofrece y vende con el stock de cada variante." },
  { id: "agotado", label: "Agotado", sofi: "«Se acabó. ¿Te aviso cuando vuelva?»" },
  {
    id: "encargo",
    label: "Por encargo",
    sofi: "«No la tengo ahora: te la consigo en {dias} días.»",
  },
  {
    id: "cupo",
    label: "Con cupo por día",
    sofi: "«Hago {cupo} por día. ¿Para qué fecha la quieres?»",
  },
  {
    id: "preventa",
    label: "Preventa",
    sofi: "«Llega el {fecha}. Si la pides hoy, sale apenas llegue.»",
  },
  {
    id: "liquidacion",
    label: "Liquidación",
    sofi: "«Está en liquidación: es su precio final.» No negocia.",
  },
  { id: "no", label: "Ya no se vende", sofi: "No la ofrece; recomienda lo más parecido." },
]

export const range = (a: number, b: number) => {
  const r: string[] = []
  for (let i = a; i <= b; i++) r.push(String(i))
  return r
}

let uid = 0
export const nid = (p = "x") => `${p}${++uid}${Math.random().toString(36).slice(2, 6)}`

const media = (src: string, color?: string, extra: Partial<Media> = {}): Media => ({
  id: nid("m"),
  src,
  kind: "foto",
  color,
  ...extra,
})
const video = (src: string, poster: string, color: string | undefined, label: string): Media => ({
  id: nid("v"),
  src,
  kind: "video",
  poster,
  color,
  dur: 6,
  label,
})

function base(o: Partial<Producto> & Pick<Producto, "id" | "name" | "cat">): Producto {
  return {
    estado: "disponible",
    estadoInfo: {},
    media: [],
    colors: [],
    sizes: ["Única"],
    stock: {},
    prices: {},
    list: 0,
    min: null,
    costos: [],
    tiers: [],
    mayor: null,
    promos: [],
    ofertas: { envio: true, soles: true, regalo: "", dosx: false },
    datos: {},
    texto: "",
    preguntas: [],
    keywords: [],
    web: { visible: true, slug: "" },
    paquete: { peso: "", l: "", a: "", h: "" },
    combo: { con: [], pct: 0 },
    parecido: [],
    sku: "",
    ai: {},
    ...o,
  }
}

const stockOf = (
  colors: { id: string }[],
  sizes: string[],
  fn: (c: string, s: string) => number,
) => {
  const s: Record<string, number> = {}
  for (const c of colors) for (const z of sizes) s[`${c.id}|${z}`] = fn(c.id, z)
  return s
}

export const RUBROS: Record<RubroId, Rubro> = {
  calzado: {
    label: "Calzado",
    store: {
      name: "Calzados Rosa",
      color: "#be185d",
      owner: "Rosa Quispe",
      mail: "rosa@calzadosrosa.pe",
      ventas: "Lucía Torres",
      slug: "calzadosrosa",
    },
    unit: "pares",
    unitOne: "par",
    row: "Color",
    col: "Talla",
    datos: [
      {
        id: "horma",
        label: "Cómo calza",
        type: "chips",
        opts: ["Normal", "Chico", "Grande"],
        need: true,
        ask: "¿Cómo calza? No se ve en las fotos.",
        keys: ["calza", "horma", "talla", "me sirve", "me queda", "pie"],
      },
      {
        id: "ancho",
        label: "Si tienes el pie ancho",
        type: "chips",
        opts: ["Tu talla de siempre", "Una talla más"],
        keys: ["ancho", "pie ancho", "empeine"],
      },
      {
        id: "material",
        label: "Material",
        type: "chips",
        opts: ["Cuero", "Sintético", "Lona", "Gamuza"],
        need: true,
        ask: "¿De qué material es?",
        keys: ["material", "cuero", "lona", "sintético", "de qué es", "tela"],
      },
      {
        id: "plantilla",
        label: "Largo de la plantilla, en cm",
        type: "percol",
        keys: ["plantilla", "cm", "centímetros", "mide", "medida", "largo"],
      },
      {
        id: "limpia",
        label: "Cómo se limpia",
        type: "text",
        ai: {
          q: "¿Se puede lavar en lavadora?",
          a: {
            Sí: "Se puede lavar en lavadora, en ciclo suave.",
            "No, a mano": "Lávala a mano con agua fría. No va a la lavadora.",
          },
        },
        keys: ["lava", "limpia", "lavadora", "mancha", "destiñe"],
      },
    ],
    gallery: [
      "botin1",
      "bailarina1",
      "lluvia1",
      "plataforma1",
      "mocasin2",
      "plataforma2",
      "bailarina2",
      "negra2",
    ],
    ph: {
      negra1: ["lona", "negra", "#1f1f1f"],
      negra2: ["lona", "negra", "#1f1f1f"],
      negra3: ["lona", "negra", "#1f1f1f"],
      blanca1: ["lona", "blanca", "#f2f0ea"],
      blanca2: ["lona", "blanca", "#f2f0ea"],
      botin1: ["hebilla", "negro", "#1c1c1c"],
      botin2: ["pasador", "negro", "#1c1c1c"],
      botin2b: ["pasador", "negro", "#1c1c1c"],
      dorada1: ["dorada", "dorado", "#b08d57"],
      dorada2: ["dorada", "dorado", "#b08d57"],
      plataforma1: ["plat", "blanca", "#f4f1ec"],
      plataforma2: ["plat", "blanca", "#f4f1ec"],
      bailarina1: ["bailarina", "blanca y azul", "#f5f5f4", "#5b7fd1"],
      bailarina2: ["bailarina", "blanca", "#ececea"],
      mocasin1: ["mocasin", "marrón", "#5b3a24"],
      mocasin2: ["mocasin", "negro", "#18181b"],
      lluvia1: ["lluvia", "fucsia con lunares", "#db2777", "#ffffff"],
    },
    kinds: {
      lona: {
        name: "Zapatilla de lona",
        cat: "Zapatillas",
        cols: "35 a 42",
        texto: "Zapatilla de lona de caña baja, con suela gruesa y pasadores del mismo color.",
        kw: ["zapa", "tenis", "zapatilla de tela"],
      },
      hebilla: {
        name: "Botín de tacón con hebilla",
        cat: "Botines",
        cols: "35 a 39",
        texto: "Botín de caña media con tacón ancho y una hebilla al costado.",
        kw: ["botín", "botita", "bota corta"],
      },
      pasador: {
        name: "Botín de tacón con pasador",
        cat: "Botines",
        cols: "35 a 39",
        texto: "Botín con pasadores y tacón ancho.",
        kw: ["botín", "botín con pasador"],
      },
      dorada: {
        name: "Sandalia de tiras",
        cat: "Sandalias",
        cols: "35 a 39",
        texto: "Sandalia de tiras cruzadas, color dorado.",
        kw: ["sandalia dorada", "sandalia de fiesta"],
      },
      plat: {
        name: "Sandalia de plataforma",
        cat: "Sandalias",
        cols: "35 a 39",
        texto: "Sandalia de plataforma con tiras delgadas.",
        kw: ["plataforma", "sandalia alta"],
      },
      bailarina: {
        name: "Bailarina",
        cat: "Bailarinas",
        cols: "35 a 39",
        texto: "Bailarina de punta redonda, sin taco.",
        kw: ["balerina", "flats"],
      },
      mocasin: {
        name: "Mocasín",
        cat: "Mocasines",
        cols: "38 a 43",
        texto: "Mocasín sin pasadores, de suela delgada.",
        kw: ["mocasín", "zapato sin pasador"],
      },
      lluvia: {
        name: "Botas de lluvia",
        cat: "Botas",
        cols: "35 a 39",
        texto: "Bota de caña alta con lunares.",
        kw: ["bota de lluvia", "botas de jebe"],
      },
    },
    pool: [
      "plataforma1",
      "bailarina1",
      "mocasin2",
      "negra2",
      "lluvia1",
      "plataforma2",
      "bailarina2",
      "botin1",
      "dorada2",
      "negra3",
      "botin2b",
    ],
    camara: ["plataforma1", "plataforma2", "plataforma1"],
    sugeridas: [
      "¿Me sirve si calzo 38 y tengo el pie ancho?",
      "¿Cuánto mide la plantilla de la 38?",
      "¿Se puede lavar en lavadora?",
      "¿Tienes la negra en 35?",
      "¿Me la dejas más barata?",
    ],
    products() {
      const s1 = range(35, 42)
      const s2 = range(35, 39)
      const lc: Color[] = [
        { id: "blanca", name: "blanca", hex: "#ffffff", aiHex: "#f2f0ea" },
        { id: "negra", name: "negra", hex: "#1f1f1f" },
      ]
      return [
        base({
          id: "p1",
          name: "Zapatilla de lona",
          cat: "Zapatillas",
          media: [
            media("blanca1", "blanca"),
            media("negra1", "negra"),
            media("blanca2", "blanca", { aiColor: true }),
            video("v_calzado", "negra1", "negra", "Puesta, caminando"),
          ],
          colors: lc,
          sizes: s1,
          stock: stockOf(lc, s1, (c, z) =>
            c === "blanca" ? (z === "42" ? 0 : z === "38" ? 2 : 3) : z === "35" ? 0 : 2,
          ),
          prices: Object.fromEntries(s1.map((z) => [`negra|${z}`, 119])),
          list: 129,
          min: 99,
          tiers: [{ desde: 2, precio: 115 }],
          mayor: { desde: 6, precio: 85 },
          promos: [
            {
              id: "pr1",
              nombre: "Liquidación talla 35",
              pct: 30,
              alcance: "col:35",
              desde: "2026-11-27",
              hasta: "2026-12-07",
            },
          ],
          ofertas: { envio: true, soles: true, regalo: "Medias tobilleras", dosx: false },
          combo: { con: ["p4"], pct: 10 },
          costos: [
            { fecha: "20 nov", cant: 24, costo: 68 },
            { fecha: "2 oct", cant: 30, costo: 64 },
            { fecha: "15 ago", cant: 20, costo: 62 },
          ],
          datos: {
            horma: "Normal",
            ancho: "Una talla más",
            material: "Lona",
            plantilla: {},
            limpia: "",
          },
          texto: "Zapatilla de lona para el día a día. Suela gruesa.",
          preguntas: [
            {
              q: "¿Es impermeable?",
              a: "No. Es de lona: con lluvia fuerte se moja.",
              who: "Rosa · 20 nov",
            },
          ],
          sku: "ZAP-LONA",
          paquete: { peso: "0,9", l: "32", a: "20", h: "12" },
          parecido: ["p3"],
          keywords: ["zapa blanca", "tenis", "zapatilla de tela"],
          web: { visible: true, slug: "zapatilla-de-lona" },
          ai: {
            keywords: ["zapatilla urbana", "zapatilla blanca"],
            tier: { desde: 3, precio: 109 },
            promo: {
              id: "pr-ai",
              nombre: "Blanca 41 y 42",
              pct: 15,
              alcance: "row:blanca",
              desde: "2026-11-27",
              hasta: "2026-12-15",
              porque:
                "La blanca grande no se vende hace 30 días; con 15 % aún ganas S/ 42 por par.",
            },
          },
        }),
        base({
          id: "p2",
          name: "Botín de tacón con pasador",
          cat: "Botines",
          media: [media("botin2", "negro"), media("botin2b", "negro")],
          colors: [{ id: "negro", name: "negro", hex: "#1c1c1c" }],
          sizes: s2,
          stock: stockOf([{ id: "negro" }], s2, () => 2),
          list: 219,
          min: 190,
          costos: [{ fecha: "12 nov", cant: 10, costo: 135 }],
          datos: {
            horma: "Chico",
            ancho: "Una talla más",
            material: "Sintético",
            plantilla: { "35": "22,5", "36": "23", "37": "23,5", "38": "24", "39": "24,5" },
            limpia: "Con un paño húmedo.",
          },
          texto: "Botín con pasadores y tacón ancho de 7 cm.",
          sku: "BOT-PAS",
          paquete: { peso: "1,2", l: "34", a: "24", h: "14" },
          keywords: ["botín negro", "botita"],
          web: { visible: true, slug: "botin-pasador" },
        }),
        base({
          id: "p3",
          name: "Mocasín con borla",
          cat: "Mocasines",
          media: [media("mocasin1", "marron")],
          colors: [{ id: "marron", name: "marrón", hex: "#5b3a24" }],
          sizes: range(38, 43),
          stock: stockOf([{ id: "marron" }], range(38, 43), (_c, z) => (z === "43" ? 0 : 2)),
          list: 159,
          min: null,
          costos: [{ fecha: "5 nov", cant: 12, costo: 88 }],
          datos: { horma: "", material: "Cuero" },
          sku: "MOC-BOR",
          web: { visible: false, slug: "mocasin-con-borla" },
          ai: { datos: { horma: "Normal" } },
        }),
        base({
          id: "p4",
          name: "Sandalia de tiras",
          cat: "Sandalias",
          media: [media("dorada1", "dorado"), media("dorada2", "dorado")],
          colors: [{ id: "dorado", name: "dorado", hex: "#b08d57" }],
          sizes: s2,
          stock: stockOf([{ id: "dorado" }], s2, (_c, z) => (z === "39" ? 0 : 3)),
          list: 89,
          min: 79,
          costos: [{ fecha: "1 nov", cant: 15, costo: 42 }],
          datos: { horma: "Normal", material: "Sintético" },
          texto: "Sandalia de tiras cruzadas, color dorado.",
          keywords: ["sandalia dorada"],
          web: { visible: true, slug: "sandalia-de-tiras" },
        }),
      ]
    },
    chats: [
      {
        name: "Valeria Soto",
        pid: "p1",
        msgs: [
          { k: "in", t: "Hola, ¿me sirve si calzo 38 y tengo el pie ancho?", h: "10:41" },
          {
            k: "out",
            t: "Hola, Valeria. Esta zapatilla calza normal, pero con pie ancho te recomiendo una talla más: la 39.",
            h: "10:41",
          },
          {
            k: "out",
            img: "negra1",
            t: "La negra está a S/ 119 y de la 39 me quedan 2. ¿Te la envío o la recoges?",
            h: "10:41",
            used: [
              "Cómo calza: normal",
              "Pie ancho: una talla más",
              "Foto de «negra»",
              "Stock 39 negra: 2",
            ],
          },
          { k: "in", t: "¿Cómo se ve puesta?", h: "10:43" },
          {
            k: "out",
            video: "v_calzado",
            img: "negra1",
            t: "Así se ve puesta. Pesa poco: va bien para todo el día.",
            h: "10:43",
            used: ["Video de «negra» · listo para WhatsApp"],
          },
        ],
      },
      { name: "Ana Torres", pid: "p1", nego: true },
      {
        name: "Carla Mendoza",
        pid: "p1",
        q: "¿La zapatilla de lona destiñe al lavarla?",
        short: "¿Destiñe al lavarla?",
        ans: "No destiñe. Lávala a mano con agua fría.",
      },
    ],
  },
  ropa: {
    label: "Ropa",
    store: {
      name: "Moda Lucía",
      color: "#4338ca",
      owner: "Lucía Ramos",
      mail: "lucia@modalucia.pe",
      ventas: "Kiara Ruiz",
      slug: "modalucia",
    },
    unit: "prendas",
    unitOne: "prenda",
    row: "Color",
    col: "Talla",
    datos: [
      {
        id: "tela",
        label: "Tela",
        type: "chips",
        opts: ["Algodón", "Piqué de algodón", "Poliéster", "Lino", "Jean"],
        need: true,
        ask: "¿De qué tela es?",
        keys: ["tela", "algodón", "material", "de qué es"],
      },
      {
        id: "medidas",
        label: "Medidas de la prenda por talla, en cm",
        type: "table",
        cols: ["Pecho", "Largo"],
        need: true,
        keys: ["medida", "mide", "pecho", "largo", "cm", "me queda", "talla"],
      },
      {
        id: "largo",
        label: "Largo",
        type: "chips",
        opts: ["Corto", "A la cadera", "Largo"],
        keys: ["largo", "corto"],
      },
      {
        id: "calce",
        label: "Calce",
        type: "chips",
        opts: ["Ajustado", "Regular", "Holgado"],
        ask: "¿Cómo queda: ajustado, regular u holgado?",
        keys: ["calce", "queda", "ajustado", "holgado", "me sirve"],
      },
      {
        id: "cuidado",
        label: "Cuidado",
        type: "text",
        ai: {
          q: "¿Se lava en lavadora?",
          a: {
            Sí: "Lavar en lavadora con agua fría. No usar secadora.",
            "No, a mano": "Lavar a mano con agua fría. Secar a la sombra.",
          },
        },
        keys: ["lava", "encoge", "lavadora", "plancha", "destiñe"],
      },
    ],
    gallery: ["polo_negro", "jean2", "vestido1", "polo_coral"],
    ph: {
      polo_azul: ["polo", "azul", "#1d4ed8"],
      polo_coral: ["polo", "coral", "#e07a5f"],
      polo_negro: ["polo", "negro", "#2b2b2b"],
      vestido1: ["vestido", "estampado", "#c2410c", "#0f766e"],
      jean1: ["jean", "celeste", "#5b7a9d"],
      jean2: ["short", "celeste", "#93a9c2"],
    },
    kinds: {
      polo: {
        name: "Polo piqué",
        cat: "Polos",
        cols: "S, M, L, XL",
        texto: "Polo de cuello camisero con dos botones.",
        kw: ["polo con cuello", "polera"],
      },
      vestido: {
        name: "Vestido estampado",
        cat: "Vestidos",
        cols: "S, M, L",
        texto: "Vestido de tiras con falda amplia y estampado de colores.",
        kw: ["vestido de verano", "vestido floreado"],
      },
      jean: {
        name: "Jean recto",
        cat: "Jeans",
        cols: "26, 28, 30, 32",
        texto: "Jean de corte recto, tiro medio.",
        kw: ["pantalón jean", "jean celeste"],
      },
      short: {
        name: "Short de jean",
        cat: "Jeans",
        cols: "26, 28, 30",
        texto: "Short de jean con basta doblada.",
        kw: ["short", "short jean"],
      },
    },
    pool: ["polo_negro", "jean2", "vestido1", "jean1", "polo_coral"],
    camara: ["jean2", "jean2"],
    sugeridas: [
      "Uso M y mido 1,60, ¿me queda?",
      "¿El polo encoge al lavarlo?",
      "¿Tienes el coral en XL?",
      "¿Me lo dejas más barato?",
    ],
    products() {
      const sz = ["S", "M", "L", "XL"]
      const pc: Color[] = [
        { id: "azul", name: "azul", hex: "#1d4ed8" },
        { id: "coral", name: "coral", hex: "#ff7f50", aiHex: "#e07a5f" },
      ]
      return [
        base({
          id: "p1",
          name: "Polo piqué",
          cat: "Polos",
          media: [
            media("polo_azul", "azul"),
            media("polo_coral", "coral"),
            video("v_ropa", "polo_azul", "azul", "Puesto, de frente"),
          ],
          colors: pc,
          sizes: sz,
          stock: stockOf(pc, sz, (c, z) => (z === "XL" && c === "coral" ? 0 : 4)),
          prices: Object.fromEntries(pc.map((c) => [`${c.id}|XL`, 55])),
          list: 49,
          min: 39,
          tiers: [{ desde: 3, precio: 44 }],
          mayor: { desde: 12, precio: 32 },
          ofertas: { envio: true, soles: true, regalo: "", dosx: true },
          combo: { con: ["p3"], pct: 10 },
          costos: [{ fecha: "18 nov", cant: 40, costo: 22 }],
          datos: {
            tela: "Piqué de algodón",
            medidas: { S: ["48", "66"], M: ["50", "68"], L: ["53", "70"], XL: ["56", "72"] },
            largo: "A la cadera",
            calce: "Regular",
            cuidado: "",
          },
          texto: "Polo piqué de algodón. Cuello camisero.",
          sku: "POL-PIQ",
          paquete: { peso: "0,3", l: "30", a: "22", h: "3" },
          keywords: ["polo con cuello", "polera"],
          web: { visible: true, slug: "polo-pique" },
          ai: { keywords: ["polo de algodón"], tier: { desde: 4, precio: 42 } },
        }),
        base({
          id: "p2",
          name: "Vestido estampado",
          cat: "Vestidos",
          media: [media("vestido1", "estampado")],
          colors: [{ id: "estampado", name: "estampado", hex: "#c2410c", hex2: "#0f766e" }],
          sizes: ["S", "M", "L"],
          stock: stockOf([{ id: "estampado" }], ["S", "M", "L"], () => 2),
          list: 89,
          min: 75,
          costos: [{ fecha: "10 nov", cant: 6, costo: 45 }],
          datos: { tela: "Algodón", largo: "Corto" },
          texto: "Vestido de tiras con falda amplia.",
          web: { visible: true, slug: "vestido-estampado" },
        }),
        base({
          id: "p3",
          name: "Jean recto",
          cat: "Jeans",
          media: [media("jean1", "celeste")],
          colors: [{ id: "celeste", name: "celeste", hex: "#5b7a9d" }],
          sizes: ["26", "28", "30", "32"],
          stock: stockOf([{ id: "celeste" }], ["26", "28", "30", "32"], () => 3),
          list: 99,
          min: 85,
          costos: [{ fecha: "3 nov", cant: 12, costo: 52 }],
          datos: { tela: "Jean", calce: "Regular" },
          texto: "Jean de corte recto.",
          web: { visible: true, slug: "jean-recto" },
        }),
      ]
    },
    chats: [
      {
        name: "Daniela Paz",
        pid: "p1",
        msgs: [
          { k: "in", t: "Hola, uso M, ¿el polo me queda bien? Mido 1,60", h: "9:20" },
          {
            k: "out",
            t: "Hola, Daniela. La M tiene 50 cm de pecho y 68 de largo, y el calce es regular: si usas M, te queda bien.",
            h: "9:20",
          },
          {
            k: "out",
            img: "polo_azul",
            t: "El azul está a S/ 49 y en M me quedan 4.",
            h: "9:20",
            used: ["Medidas de la M", "Calce: regular", "Foto de «azul»", "Stock M azul: 4"],
          },
          { k: "in", t: "¿Tienes video?", h: "9:22" },
          {
            k: "out",
            video: "v_ropa",
            img: "polo_azul",
            t: "Aquí lo ves puesto.",
            h: "9:22",
            used: ["Video de «azul» · listo para WhatsApp"],
          },
        ],
      },
      { name: "Rocío Vega", pid: "p1", nego: true },
      {
        name: "Patty León",
        pid: "p1",
        q: "¿El polo encoge al lavarlo?",
        short: "¿Encoge al lavarlo?",
        ans: "Casi nada si lo lavas con agua fría y lo secas a la sombra.",
      },
    ],
  },
  cosmetica: {
    label: "Cosmética",
    store: {
      name: "Belleza Mía",
      color: "#a21caf",
      owner: "Mía Salas",
      mail: "mia@bellezamia.pe",
      ventas: "Flor Díaz",
      slug: "bellezamia",
    },
    unit: "unidades",
    unitOne: "unidad",
    row: "Tono",
    col: null,
    datos: [
      {
        id: "contenido",
        label: "Contenido",
        type: "chips",
        opts: ["3,5 g", "4 g", "15 ml", "30 ml"],
        need: true,
        ask: "¿Cuánto contiene? Si se lee en la etiqueta, lo propongo.",
        keys: ["contiene", "gramos", "ml", "cuánto trae", "tamaño"],
      },
      {
        id: "piel",
        label: "Para qué tipo de piel",
        type: "chips",
        opts: ["Todo tipo", "Seca", "Grasa", "Mixta", "Sensible"],
        need: true,
        ask: "¿Para qué tipo de piel es?",
        keys: ["piel", "sensible", "grasa", "seca", "alergia"],
      },
      {
        id: "ingredientes",
        label: "Ingredientes clave",
        type: "text",
        keys: ["ingrediente", "tiene", "karité", "vitamina", "vegano", "cruelty"],
      },
      {
        id: "vence",
        label: "Vencimiento del lote en stock",
        type: "date",
        need: true,
        ask: "¿Cuándo vence el lote que tienes?",
        keys: ["vence", "vencimiento", "caduca", "dura"],
      },
      {
        id: "nso",
        label: "Registro sanitario (NSO de DIGEMID)",
        type: "text",
        need: true,
        ask: "¿Cuál es su NSO? Está en el envase.",
        keys: ["registro", "nso", "digemid", "original", "sanitario"],
      },
    ],
    gallery: ["labial_estuche", "labial_rojo", "labial_nude"],
    ph: {
      labial_rojo: ["labial", "rojo clásico", "#b91c1c"],
      labial_nude: ["labial", "nude", "#c49a7e"],
      labial_estuche: ["estuche", "rojo cereza", "#9f1239"],
    },
    kinds: {
      labial: {
        name: "Labial mate",
        cat: "Labiales",
        cols: "",
        texto: "Labial de acabado mate en barra.",
        kw: ["labial", "pintalabios", "lápiz labial"],
      },
      estuche: {
        name: "Labial cremoso con estuche",
        cat: "Labiales",
        cols: "",
        texto: "Labial cremoso con estuche metálico.",
        kw: ["labial rojo", "labial cremoso"],
      },
    },
    pool: ["labial_estuche", "labial_rojo", "labial_nude"],
    camara: ["labial_estuche", "labial_estuche"],
    sugeridas: [
      "¿Sirve si tengo la piel sensible?",
      "¿Cuándo vence?",
      "¿Tiene registro sanitario?",
      "¿Me lo dejas más barato?",
    ],
    products() {
      const tc: Color[] = [
        { id: "rojo", name: "rojo clásico", hex: "#b91c1c" },
        { id: "nude", name: "nude", hex: "#c49a7e" },
      ]
      return [
        base({
          id: "p1",
          name: "Labial mate",
          cat: "Labiales",
          media: [
            media("labial_rojo", "rojo"),
            media("labial_nude", "nude"),
            video("v_cosmetica", "labial_rojo", "rojo", "El tono en la piel"),
          ],
          colors: tc,
          sizes: ["Única"],
          stock: stockOf(tc, ["Única"], (c) => (c === "nude" ? 6 : 9)),
          list: 39,
          min: 32,
          tiers: [{ desde: 3, precio: 35 }],
          mayor: { desde: 12, precio: 26 },
          promos: [
            {
              id: "pr1",
              nombre: "Nude de lanzamiento",
              pct: 15,
              alcance: "row:nude",
              desde: "2026-11-25",
              hasta: "2026-12-15",
            },
          ],
          ofertas: { envio: true, soles: true, regalo: "Muestra de bálsamo", dosx: true },
          costos: [{ fecha: "22 nov", cant: 24, costo: 14 }],
          datos: {
            contenido: "3,5 g",
            piel: "Todo tipo",
            ingredientes: "Manteca de karité, vitamina E",
            vence: "2028-06",
            nso: "",
          },
          texto: "Labial mate de larga duración.",
          sku: "LAB-MAT",
          paquete: { peso: "0,05", l: "10", a: "4", h: "4" },
          keywords: ["pintalabios", "labial rojo"],
          web: { visible: true, slug: "labial-mate" },
          ai: { datos: { nso: "NSOC12345-23PE" } },
        }),
      ]
    },
    chats: [
      {
        name: "Sofía Ruiz",
        pid: "p1",
        msgs: [
          {
            k: "in",
            t: "¿El labial rojo sirve si tengo la piel sensible? ¿Cuándo vence?",
            h: "16:02",
          },
          {
            k: "out",
            t: "Hola, Sofía. Es para todo tipo de piel y tiene manteca de karité y vitamina E. El lote que tenemos vence en junio de 2028.",
            h: "16:02",
          },
          {
            k: "out",
            img: "labial_rojo",
            t: "Así es el rojo clásico. Está a S/ 39.",
            h: "16:02",
            used: [
              "Tipo de piel: todo tipo",
              "Ingredientes clave",
              "Vence: 06/2028",
              "Foto de «rojo clásico»",
            ],
          },
          { k: "in", t: "¿Tienes video del tono?", h: "16:04" },
          {
            k: "out",
            video: "v_cosmetica",
            img: "labial_rojo",
            t: "Aquí está el tono.",
            h: "16:04",
            used: ["Video de «rojo clásico»"],
          },
        ],
      },
      { name: "Kelly Ríos", pid: "p1", nego: true },
      {
        name: "Andrea Gil",
        pid: "p1",
        q: "¿El labial es cruelty free?",
        short: "¿Es cruelty free?",
        ans: "Sí, la marca no prueba en animales.",
      },
    ],
  },
  tecnologia: {
    label: "Tecnología",
    store: {
      name: "Nodo Tech",
      color: "#0369a1",
      owner: "Jorge Nodo",
      mail: "jorge@nodotech.pe",
      ventas: "Iván Soto",
      slug: "nodotech",
    },
    unit: "unidades",
    unitOne: "unidad",
    row: "Color",
    col: "Modelo",
    datos: [
      {
        id: "compatible",
        label: "Con qué equipos funciona",
        type: "text",
        need: true,
        ask: "¿Con qué equipos funciona?",
        keys: ["funciona", "iphone", "android", "compatible", "laptop", "sirve con"],
      },
      {
        id: "estadoEq",
        label: "Nuevo, caja abierta o reacondicionado",
        type: "chips",
        opts: ["Nuevo", "Caja abierta", "Reacondicionado"],
        need: true,
        ask: "¿Es nuevo, de caja abierta o reacondicionado? La ley pide decirlo.",
        keys: ["nuevo", "original", "usado", "reacondicionado", "caja"],
      },
      {
        id: "garantia",
        label: "Garantía",
        type: "chips",
        opts: ["3 meses", "6 meses", "1 año"],
        need: true,
        keys: ["garantía", "falla", "malogra"],
      },
      {
        id: "incluye",
        label: "Qué trae la caja",
        type: "text",
        ai: {
          q: "¿La caja trae cable de carga?",
          a: { Sí: "Audífonos, cable de carga USB-C y manual.", No: "Audífonos y manual." },
        },
        keys: ["trae", "incluye", "cable", "caja", "viene con"],
      },
      {
        id: "bateria",
        label: "Batería (horas)",
        type: "text",
        keys: ["batería", "dura", "horas", "carga"],
      },
    ],
    gallery: ["audif3", "funda1", "audif1", "audif2"],
    ph: {
      audif1: ["audif", "negro", "#1f2937"],
      audif2: ["audif", "negro", "#1f2937"],
      audif3: ["base", "gris", "#6b7280"],
      funda1: ["funda", "azul", "#1e3a8a"],
    },
    kinds: {
      audif: {
        name: "Audífonos inalámbricos",
        cat: "Audio",
        cols: "Estándar",
        texto: "Audífonos de diadema, inalámbricos, con almohadillas acolchadas.",
        kw: ["audífonos bluetooth", "audífonos de vincha"],
      },
      base: {
        name: "Audífonos con base de carga",
        cat: "Audio",
        cols: "Estándar",
        texto: "Audífonos inalámbricos con su base de carga.",
        kw: ["audífonos tv", "audífonos con base"],
      },
      funda: {
        name: "Funda de celular",
        cat: "Fundas",
        cols: "iPhone 13, iPhone 14, Galaxy A54",
        texto: "Funda tipo billetera con cierre magnético.",
        kw: ["case", "funda billetera"],
      },
    },
    pool: ["audif3", "funda1", "audif2"],
    camara: ["audif3", "audif3"],
    sugeridas: [
      "¿Funcionan con iPhone?",
      "¿Son originales? ¿Tienen garantía?",
      "¿Qué trae la caja?",
      "¿Me los dejas más baratos?",
    ],
    products() {
      const fm = ["iPhone 13", "iPhone 14", "Galaxy A54"]
      return [
        base({
          id: "p1",
          name: "Audífonos inalámbricos",
          cat: "Audio",
          media: [
            media("audif1", "negro"),
            media("audif2", "negro"),
            video("v_tecnologia", "audif1", "negro", "Cómo se pliegan"),
          ],
          colors: [{ id: "negro", name: "negro", hex: "#1f2937" }],
          sizes: ["Estándar"],
          stock: stockOf([{ id: "negro" }], ["Estándar"], () => 7),
          list: 149,
          min: 125,
          tiers: [{ desde: 2, precio: 139 }],
          ofertas: { envio: true, soles: true, regalo: "Estuche de tela", dosx: false },
          combo: { con: ["p2"], pct: 10 },
          costos: [{ fecha: "15 nov", cant: 10, costo: 92 }],
          datos: {
            compatible: "Bluetooth: iPhone, Android y laptop",
            estadoEq: "Nuevo",
            garantia: "6 meses",
            incluye: "",
            bateria: "20",
          },
          texto: "Audífonos inalámbricos de diadema. Almohadillas acolchadas.",
          sku: "AUD-INA",
          paquete: { peso: "0,4", l: "22", a: "18", h: "9" },
          keywords: ["audífonos bluetooth", "audífonos de vincha"],
          web: { visible: true, slug: "audifonos-inalambricos" },
        }),
        base({
          id: "p2",
          name: "Funda de celular",
          cat: "Fundas",
          media: [media("funda1", "azul")],
          colors: [{ id: "azul", name: "azul", hex: "#1e3a8a" }],
          sizes: fm,
          stock: stockOf([{ id: "azul" }], fm, (_c, z) => (z === "Galaxy A54" ? 0 : 5)),
          list: 35,
          min: 29,
          costos: [{ fecha: "9 nov", cant: 30, costo: 12 }],
          datos: { compatible: "iPhone 13, iPhone 14, Galaxy A54", estadoEq: "Nuevo" },
          texto: "Funda tipo billetera.",
          web: { visible: true, slug: "funda-de-celular" },
        }),
      ]
    },
    chats: [
      {
        name: "Luis Cárdenas",
        pid: "p1",
        msgs: [
          { k: "in", t: "¿Funcionan con iPhone? ¿Son originales?", h: "12:10" },
          {
            k: "out",
            t: "Hola, Luis. Sí, se conectan por Bluetooth con iPhone, Android y laptop. Son nuevos, con 6 meses de garantía de la tienda, y la batería dura unas 20 horas.",
            h: "12:10",
          },
          {
            k: "out",
            img: "audif1",
            t: "Están a S/ 149 y me quedan 7.",
            h: "12:10",
            used: ["Compatibilidad", "Estado: nuevo", "Garantía: 6 meses", "Batería: 20 h"],
          },
          { k: "in", t: "¿Tienes un video?", h: "12:11" },
          {
            k: "out",
            video: "v_tecnologia",
            img: "audif1",
            t: "Aquí los ves de cerca.",
            h: "12:11",
            used: ["Video · listo para WhatsApp"],
          },
        ],
      },
      { name: "Marco Díaz", pid: "p1", nego: true },
      {
        name: "Rosa Paredes",
        pid: "p1",
        q: "¿Tienen micrófono para llamadas?",
        short: "¿Tiene micrófono?",
        ans: "Sí, tiene micrófono para llamadas.",
      },
    ],
  },
  hogar: {
    label: "Hogar",
    store: {
      name: "Hogar Simple",
      color: "#15803d",
      owner: "Carmen Ruiz",
      mail: "carmen@hogarsimple.pe",
      ventas: "Raúl Vega",
      slug: "hogarsimple",
    },
    unit: "unidades",
    unitOne: "unidad",
    row: "Color o acabado",
    col: "Tamaño",
    datos: [
      {
        id: "medidas",
        label: "Medidas",
        type: "text",
        need: true,
        ask: "¿Qué medidas tiene? No se pueden medir en una foto.",
        keys: ["medida", "mide", "tamaño", "cm", "grande"],
      },
      { id: "peso", label: "Peso", type: "text", keys: ["peso", "pesa", "liviano"] },
      {
        id: "material",
        label: "Material",
        type: "chips",
        opts: ["Algodón", "Lino", "Madera", "Cerámica", "Tela y metal"],
        need: true,
        ask: "¿De qué material es?",
        keys: ["material", "algodón", "de qué es", "tela"],
      },
      {
        id: "arma",
        label: "Si se arma",
        type: "chips",
        opts: ["Viene listo", "Se arma fácil", "Lo armamos"],
        need: true,
        keys: ["arma", "armar", "instala", "listo"],
      },
      {
        id: "limpia",
        label: "Cómo se limpia",
        type: "text",
        ai: {
          q: "¿La funda se puede lavar?",
          a: {
            Sí: "La funda sale y se lava en lavadora, ciclo suave.",
            No: "Limpiar con un paño húmedo.",
          },
        },
        keys: ["lava", "limpia", "funda", "mancha"],
      },
    ],
    gallery: ["manta1", "taza1", "cojin1", "lampara1"],
    ph: {
      cojin1: ["cojin", "azul y blanco", "#1e40af", "#ffffff"],
      lampara1: ["lampara", "guinda", "#7f1d1d"],
      taza1: ["taza", "blanca", "#f5f5f4"],
      manta1: ["manta", "crema", "#efe6d8"],
    },
    kinds: {
      cojin: {
        name: "Cojín decorativo",
        cat: "Cojines",
        cols: "40 x 40, 45 x 45",
        texto: "Cojín con funda estampada.",
        kw: ["almohadón", "cojín para sofá"],
      },
      lampara: {
        name: "Lámpara de mesa",
        cat: "Iluminación",
        cols: "Única",
        texto: "Lámpara de mesa con pantalla de tela plisada.",
        kw: ["lámpara de noche", "velador"],
      },
      taza: {
        name: "Taza de cerámica",
        cat: "Cocina",
        cols: "Única",
        texto: "Taza de cerámica para café.",
        kw: ["taza", "mug"],
      },
      manta: {
        name: "Manta tejida",
        cat: "Mantas",
        cols: "1,2 x 1,5 m",
        texto: "Manta tejida a crochet.",
        kw: ["manta", "cubre sofá"],
      },
    },
    pool: ["manta1", "taza1", "lampara1"],
    camara: ["manta1", "manta1"],
    sugeridas: [
      "¿Qué medida tiene el cojín?",
      "¿Viene con relleno?",
      "¿La funda se puede lavar?",
      "¿Me lo dejas más barato?",
    ],
    products() {
      const cs = ["40 x 40", "45 x 45"]
      return [
        base({
          id: "p1",
          name: "Cojín decorativo",
          cat: "Cojines",
          media: [media("cojin1", "azul"), video("v_hogar", "cojin1", undefined, "En el sofá")],
          colors: [{ id: "azul", name: "azul y blanco", hex: "#1e40af", hex2: "#ffffff" }],
          sizes: cs,
          stock: stockOf([{ id: "azul" }], cs, (_c, z) => (z === "40 x 40" ? 6 : 3)),
          prices: { "azul|45 x 45": 55 },
          list: 45,
          min: 38,
          tiers: [{ desde: 4, precio: 40 }],
          ofertas: { envio: true, soles: true, regalo: "", dosx: true },
          combo: { con: ["p2"], pct: 10 },
          costos: [{ fecha: "14 nov", cant: 20, costo: 21 }],
          datos: {
            medidas: "40 x 40 cm y 45 x 45 cm",
            peso: "0,4 kg",
            material: "Algodón",
            arma: "Viene listo",
            limpia: "",
          },
          texto: "Cojín con funda de algodón estampada.",
          sku: "COJ-BAT",
          paquete: { peso: "0,5", l: "46", a: "46", h: "12" },
          keywords: ["almohadón", "cojín azul"],
          web: { visible: true, slug: "cojin-decorativo" },
        }),
        base({
          id: "p2",
          name: "Lámpara de mesa",
          cat: "Iluminación",
          media: [media("lampara1", "guinda")],
          colors: [{ id: "guinda", name: "guinda", hex: "#7f1d1d" }],
          sizes: ["Única"],
          stock: stockOf([{ id: "guinda" }], ["Única"], () => 2),
          list: 189,
          min: 165,
          costos: [{ fecha: "2 nov", cant: 4, costo: 110 }],
          datos: { material: "Tela y metal", arma: "Se arma fácil" },
          texto: "Lámpara con pantalla de tela plisada.",
          web: { visible: true, slug: "lampara-de-mesa" },
        }),
      ]
    },
    chats: [
      {
        name: "Gabriela Soto",
        pid: "p1",
        msgs: [
          { k: "in", t: "¿Qué medida tiene el cojín? ¿Es de algodón?", h: "18:30" },
          {
            k: "out",
            t: "Hola, Gabriela. Hay de 40 x 40 cm y de 45 x 45 cm, y la funda es de algodón. Viene listo para usar.",
            h: "18:30",
          },
          {
            k: "out",
            img: "cojin1",
            t: "El de 40 está a S/ 45 y el de 45 a S/ 55.",
            h: "18:30",
            used: ["Medidas", "Material: algodón", "Precio por tamaño"],
          },
          { k: "in", t: "¿Tienes video?", h: "18:31" },
          {
            k: "out",
            video: "v_hogar",
            img: "cojin1",
            t: "Así se ve en el sofá.",
            h: "18:31",
            used: ["Video · listo para WhatsApp"],
          },
        ],
      },
      { name: "Iris Chávez", pid: "p1", nego: true },
      {
        name: "Mario Ruiz",
        pid: "p1",
        q: "¿El cojín viene con relleno?",
        short: "¿Viene con relleno?",
        ans: "Sí, viene con relleno de fibra.",
      },
    ],
  },
}

export const RUBRO_IDS = Object.keys(RUBROS) as RubroId[]

export const CREDITOS = [
  "Superga 2750 Canvas weiß (1) y (3), y Superga 2750 Microfiber schwarz (1) · SPERA.de Designerschuhe, Taschen und Accessoires · CC BY 2.0 (con fondo extendido a cuadrado)",
  "Oca low (2 fotos) · CARIUMA · CC BY-SA 4.0",
  "Ankle boot y Laced ankle boot · Danÿa · CC BY-SA 4.0",
  "Sandalias doradas de mujer · Dorieo · CC BY-SA 4.0",
  "Tacones · Archivaldo · dominio público",
  "Bailarina Bluniq Shoes blanca · Alvaro Blue · CC BY-SA 4.0",
  "Ballerinas (Weiss) · Stefan-Xp · CC BY-SA 3.0",
  "Coffee loafer shoes · Peachyeung316 · CC BY-SA 4.0",
  "Black loafers · Normal Phobic · CC BY-SA 2.5",
  "Rain boots on Stairs · Erikamthompson · CC BY-SA 3.0",
  "EEPISAT Black Polo Shirt · Mukhayyar · CC0",
  "Polo shirt at JCPenney · Ser Amantio di Nicolao · CC BY-SA 4.0",
  "WP polo shirt · Wikimedia Foundation · CC0",
  "Summer dress · USAID Africa Bureau · dominio público",
  "Jeans and brown shirt folded · Ejdowning00 · CC BY-SA 4.0",
  "Tapered jeans · Leo-setä · CC BY 2.0",
  "Lipstick (product) · Maria Morri · CC BY-SA 2.0",
  "MAC pink lipstick · Jen · CC BY-SA 3.0",
  "DiorLippenstift · Sjr · dominio público",
  "Headphones · 17mdnasim89 · CC0",
  "Sony S Wireless Headphones · Allan Barger · CC BY-SA 3.0",
  "Sennheiser RS 175 · Richardkiwi · CC BY-SA 4.0",
  "Mobile phone case · Tiia Monto · CC BY-SA 4.0",
  "Batik Kawung Cushion · Gunarta · CC BY-SA 4.0",
  "Wooden Antique Table Lamp · Amitbalani · CC0",
  "White Ceramic Mug · Janko Ferlic · CC0",
  "Filet crochet sofa blanket · Durova · CC BY-SA 3.0",
]

export const foto = (src: string) =>
  src.startsWith("blob:") || src.startsWith("data:") ? src : `./fotos/${src}.jpg`
export const videoSrc = (src: string) => (src.startsWith("blob:") ? src : `./videos/${src}.mp4`)
