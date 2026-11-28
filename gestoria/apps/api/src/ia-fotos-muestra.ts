import { readdirSync, readFileSync } from "node:fs"
import sharp from "sharp"
import type { ChatModel, ChatRequest, ContentPart, ModelReply } from "./sofi/modelo.js"

/**
 * El modelo de desarrollo de la IA de fotos (`GESTORIA_FOTOS_MODEL=fake`): sin red ni costo,
 * responde lo grabado para las fotos de la demo y del banco de la medición (`eval/fotos/`), como
 * el `ph` del prototipo: qué producto, qué color y qué hex se ve en cada foto, y lo que se lee.
 * Reconoce cada foto por cómo se ve (una huella de 12×12 píxeles), así vale la copia que manda el
 * servidor. Lo grabado lo escribió el equipo mirando cada foto y pasa por la misma revisión que
 * el modelo de verdad (`reviewLook`); las preguntas salen de la plantilla. Una foto que no conoce
 * recibe un nombre de muestra. Nunca cuenta como medición ni corre en producción.
 */

type Rubro = "calzado" | "ropa" | "cosmetica" | "tecnologia" | "hogar"

interface Kind {
  nombre: string
  categoria: string
  rubro: Rubro
  descripcion: string
  palabras: string[]
  leido?: string[]
  datos?: { clave: string; valor: string; de: "foto" | "etiqueta" }[]
  /** La foto no es de un solo producto: lo dice en vez de proponer. */
  aviso?: string
}

/** Lo que se ve de cada producto del banco y de la demo. */
const KINDS: Record<string, Kind> = {
  lona: {
    nombre: "Zapatilla de lona",
    categoria: "Zapatillas",
    rubro: "calzado",
    descripcion: "Zapatilla de lona de caña baja, con planta y pasadores blancos.",
    palabras: ["zapatilla de lona", "zapatilla negra", "tenis"],
    leido: ["CARIUMA"],
    datos: [{ clave: "material", valor: "Lona", de: "foto" }],
  },
  superga: {
    nombre: "Zapatilla de lona Superga",
    categoria: "Zapatillas",
    rubro: "calzado",
    descripcion: "Zapatilla de lona de caña baja, con planta de goma y pasadores del mismo color.",
    palabras: ["zapatilla blanca", "zapatilla de lona", "superga"],
    leido: ["SUPERGA"],
    datos: [{ clave: "material", valor: "Lona", de: "foto" }],
  },
  supergaNegra: {
    nombre: "Zapatilla Superga negra",
    categoria: "Zapatillas",
    rubro: "calzado",
    descripcion: "Zapatilla de caña baja, toda negra, con pasadores.",
    palabras: ["zapatilla negra", "superga"],
    leido: ["SUPERGA"],
  },
  botinLazo: {
    nombre: "Botín con lazo",
    categoria: "Botines",
    rubro: "calzado",
    descripcion: "Botín de caña media con taco ancho y un lazo al costado con un dije.",
    palabras: ["botín", "botín con taco", "botita"],
  },
  botinPasador: {
    nombre: "Botín con pasadores y plataforma",
    categoria: "Botines",
    rubro: "calzado",
    descripcion: "Botín de taco alto con plataforma y pasadores al frente.",
    palabras: ["botín", "botín con pasador", "botín de taco"],
  },
  dorada: {
    nombre: "Sandalia de tiras cruzadas",
    categoria: "Sandalias",
    rubro: "calzado",
    descripcion: "Sandalia de taco corrido con tiras que se cruzan y se atan al tobillo.",
    palabras: ["sandalia dorada", "sandalia de tiras"],
  },
  plataforma: {
    nombre: "Sandalia de plataforma",
    categoria: "Sandalias",
    rubro: "calzado",
    descripcion: "Sandalia de taco corrido con tiras delgadas anudadas al frente.",
    palabras: ["sandalia blanca", "sandalia de plataforma", "sandalia alta"],
  },
  bailarina: {
    nombre: "Bailarina con punta negra",
    categoria: "Bailarinas",
    rubro: "calzado",
    descripcion: "Bailarina de punta redonda, sin taco, con la punta negra y un detalle rojo.",
    palabras: ["bailarina", "balerina", "flats"],
    leido: ["Bluniq", "Made in Spain"],
  },
  bailarinaPerforada: {
    nombre: "Bailarina perforada",
    categoria: "Bailarinas",
    rubro: "calzado",
    descripcion: "Bailarina de punta redonda con perforaciones al frente.",
    palabras: ["bailarina blanca", "balerina"],
    leido: ["Salamander"],
  },
  mocasinBorla: {
    nombre: "Mocasín con borlas",
    categoria: "Mocasines",
    rubro: "calzado",
    descripcion: "Mocasín de punta redonda con borlas en el empeine.",
    palabras: ["mocasín", "mocasín marrón"],
  },
  mocasinNegro: {
    nombre: "Mocasín negro",
    categoria: "Mocasines",
    rubro: "calzado",
    descripcion: "Mocasín sin pasadores, con costura a la vista en el empeine.",
    palabras: ["mocasín", "zapato negro", "zapato sin pasadores"],
  },
  lluvia: {
    nombre: "Botas de lluvia con lunares",
    categoria: "Botas",
    rubro: "calzado",
    descripcion: "Botas de lluvia de caña alta, fucsia con lunares blancos.",
    palabras: ["botas de lluvia", "botas de agua", "botas con lunares"],
  },
  polo: {
    nombre: "Polo con cuello",
    categoria: "Polos",
    rubro: "ropa",
    descripcion: "Polo de manga corta con cuello y botones al frente.",
    palabras: ["polo con cuello", "polera"],
  },
  poloNegro: {
    nombre: "Polo con cuello",
    categoria: "Polos",
    rubro: "ropa",
    descripcion: "Polo de manga corta con cuello y un logo en el pecho.",
    palabras: ["polo con cuello", "polo negro"],
    leido: ["EEPISAT"],
  },
  vestido: {
    nombre: "Vestido de tiras estampado",
    categoria: "Vestidos",
    rubro: "ropa",
    descripcion: "Vestido corto de tiras, con falda amplia y estampado de colores.",
    palabras: ["vestido corto", "vestido estampado"],
    datos: [{ clave: "largo", valor: "Corto", de: "foto" }],
  },
  jean: {
    nombre: "Jean celeste",
    categoria: "Jeans",
    rubro: "ropa",
    descripcion: "Jean celeste de bota recta, con la basta doblada.",
    palabras: ["jean", "pantalón jean", "jean celeste"],
    datos: [{ clave: "tela", valor: "Jean", de: "foto" }],
  },
  varias: {
    nombre: "Prendas",
    categoria: "Ropa",
    rubro: "ropa",
    descripcion: "",
    palabras: [],
    aviso: "La foto muestra varias prendas: sube una foto por producto.",
  },
  labial: {
    nombre: "Labial en barra",
    categoria: "Labiales",
    rubro: "cosmetica",
    descripcion: "Labial en barra con tubo de dos tonos.",
    palabras: ["labial", "lápiz labial", "pintalabios"],
  },
  labialMac: {
    nombre: "Labial MAC",
    categoria: "Labiales",
    rubro: "cosmetica",
    descripcion: "Labial en barra con tubo plateado y negro.",
    palabras: ["labial", "labial rojo", "mac"],
    leido: ["MAC"],
  },
  labialDior: {
    nombre: "Labial Dior con estuche",
    categoria: "Labiales",
    rubro: "cosmetica",
    descripcion: "Labial en barra con tubo dorado y tapa azul transparente.",
    palabras: ["labial", "dior"],
    leido: ["Dior"],
  },
  audifonos: {
    nombre: "Audífonos de diadema",
    categoria: "Audio",
    rubro: "tecnologia",
    descripcion: "Audífonos de diadema con almohadillas grandes.",
    palabras: ["audífonos", "audífonos de diadema", "headphones"],
  },
  audifonosWireless: {
    nombre: "Audífonos de diadema",
    categoria: "Audio",
    rubro: "tecnologia",
    descripcion: "Audífonos de diadema, negros.",
    palabras: ["audífonos", "audífonos de diadema"],
    leido: ["WIRELESS STEREO HEADSET"],
  },
  audifonosBase: {
    nombre: "Audífonos con base",
    categoria: "Audio",
    rubro: "tecnologia",
    descripcion: "Audífonos de diadema sobre su base, con dos botones en la base.",
    palabras: ["audífonos", "audífonos con base"],
    datos: [{ clave: "incluye", valor: "Base", de: "foto" }],
  },
  funda: {
    nombre: "Funda tipo libro",
    categoria: "Fundas",
    rubro: "tecnologia",
    descripcion: "Funda tipo libro para celular, con tapa que se abre al costado.",
    palabras: ["funda", "case", "funda libro"],
  },
  cojin: {
    nombre: "Cojín estampado",
    categoria: "Cojines",
    rubro: "hogar",
    descripcion: "Cojín cuadrado con estampado de flores.",
    palabras: ["cojín", "almohadón", "cojín azul"],
  },
  lampara: {
    nombre: "Pantalla de lámpara con flecos",
    categoria: "Iluminación",
    rubro: "hogar",
    descripcion: "Pantalla de lámpara plisada, con galón y flecos.",
    palabras: ["lámpara", "pantalla de lámpara"],
  },
  taza: {
    nombre: "Taza blanca",
    categoria: "Tazas",
    rubro: "hogar",
    descripcion: "Taza blanca de borde redondo.",
    palabras: ["taza", "taza blanca", "taza para café"],
  },
  manta: {
    nombre: "Manta tejida",
    categoria: "Mantas",
    rubro: "hogar",
    descripcion: "Manta tejida a crochet con rombos y un borde de color.",
    palabras: ["manta", "colcha", "manta tejida"],
  },
}

/** Cada foto: su producto y su color, como lo diría una vendedora (`ph` del prototipo). */
const PHOTOS: Record<string, [kind: string, color: string, hex: string, hex2?: string]> = {
  negra1: ["supergaNegra", "negra", "#1f1f1f"],
  negra2: ["lona", "negra", "#1f1f1f"],
  negra3: ["lona", "negra", "#1f1f1f"],
  blanca1: ["superga", "blanca", "#f2f0ea"],
  blanca2: ["superga", "blanca", "#f2f0ea"],
  botin1: ["botinLazo", "negro", "#1c1c1c"],
  botin2: ["botinPasador", "negro", "#1c1c1c"],
  botin2b: ["botinPasador", "negro", "#1c1c1c"],
  dorada1: ["dorada", "dorada", "#b08d57"],
  dorada2: ["dorada", "dorada", "#b08d57"],
  plataforma1: ["plataforma", "blanca", "#f4f1ec"],
  plataforma2: ["plataforma", "blanca", "#f4f1ec"],
  bailarina1: ["bailarina", "blanca", "#f5f5f4", "#1f1f1f"],
  bailarina2: ["bailarinaPerforada", "blanca", "#ececea"],
  mocasin1: ["mocasinBorla", "marrón", "#4a3428"],
  mocasin2: ["mocasinNegro", "negro", "#18181b"],
  lluvia1: ["lluvia", "fucsia", "#db2777", "#ffffff"],
  polo_azul: ["polo", "azul", "#1d4ed8"],
  polo_coral: ["polo", "coral", "#e07a5f"],
  polo_negro: ["poloNegro", "negro", "#2b2b2b"],
  vestido1: ["vestido", "estampado", "#0f766e", "#c2410c"],
  jean1: ["jean", "celeste", "#5b7a9d"],
  jean2: ["varias", "celeste", "#93a9c2"],
  labial_rojo: ["labialMac", "rojo", "#b91c1c"],
  labial_nude: ["labial", "nude", "#c49a7e"],
  labial_estuche: ["labialDior", "rosa cereza", "#9f1239"],
  audif1: ["audifonos", "negro", "#1f2937"],
  audif2: ["audifonosWireless", "negro", "#1f2937"],
  audif3: ["audifonosBase", "negro", "#1f2937"],
  funda1: ["funda", "azul", "#1e3a8a"],
  cojin1: ["cojin", "azul y blanco", "#1e40af", "#ffffff"],
  lampara1: ["lampara", "guinda", "#7f1d1d"],
  taza1: ["taza", "blanca", "#f5f5f4"],
  manta1: ["manta", "crema", "#efe6d8"],
}

const SIDE = 12

async function print(bytes: Uint8Array): Promise<Uint8Array> {
  const raw = await sharp(bytes)
    .flatten({ background: "#ffffff" })
    .resize(SIDE, SIDE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer()
  return new Uint8Array(raw)
}

let known: Promise<{ name: string; print: Uint8Array }[]> | null = null

/** Las huellas de las fotos que conoce: el banco de la medición (que incluye las de la demo). */
function knownPrints() {
  known ??= (async () => {
    const dir = new URL("../eval/fotos/", import.meta.url)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jpg"))
    } catch {
      return []
    }
    return Promise.all(
      files.map(async (file) => ({
        name: file.replace(/\.jpg$/, ""),
        print: await print(new Uint8Array(readFileSync(new URL(file, dir)))),
      })),
    )
  })()
  return known
}

/** La foto conocida que más se parece; ninguna si no se parece bastante. */
async function recognize(bytes: Uint8Array): Promise<string | null> {
  const mine = await print(bytes).catch(() => null)
  if (!mine) return null
  let best: { name: string; distance: number } | null = null
  for (const one of await knownPrints()) {
    let sum = 0
    for (let i = 0; i < mine.length; i++) sum += Math.abs(mine[i]! - one.print[i]!)
    const distance = sum / mine.length
    if (!best || distance < best.distance) best = { name: one.name, distance }
  }
  return best && best.distance < 14 ? best.name : null
}

function imagesOf(request: ChatRequest): Uint8Array[] {
  const user = request.messages.find((m) => m.role === "user")
  if (!user || typeof user.content === "string") return []
  return (user.content as ContentPart[]).flatMap((part) =>
    part.type === "image_url" && part.image_url.url.startsWith("data:")
      ? [new Uint8Array(Buffer.from(part.image_url.url.split(",")[1] ?? "", "base64"))]
      : [],
  )
}

const NO_USAGE = { input: 0, cached: 0, output: 0 }

async function lookReply(request: ChatRequest) {
  const names = await Promise.all(imagesOf(request).map(recognize))
  const kinds = names.map((n) => (n ? PHOTOS[n]?.[0] : undefined))
  const counts = new Map<string, number>()
  for (const k of kinds) if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const kind = main ? KINDS[main] : undefined
  const intro = request.messages.find((m) => m.role === "user")
  const text =
    intro && typeof intro.content !== "string"
      ? ((intro.content as ContentPart[]).find((p) => p.type === "text") as { text: string })?.text
      : ""
  // Con el rubro del producto dicho, no propone otro.
  const fixed = /El rubro del producto es (\w+)/.exec(text ?? "")?.[1]
  if (!kind)
    return {
      mismo_producto: true,
      aviso: null,
      leido: [],
      nombre: { valor: "Producto de muestra", porque: "Modelo de desarrollo: no conoce la foto" },
      categoria: null,
      rubro: null,
      colores: [],
      datos: [],
      palabras: [],
      descripcion: null,
    }
  const colors = new Map<
    string,
    { nombre: string; hex: string; hex2: string | null; fotos: number[] }
  >()
  names.forEach((name, i) => {
    const photo = name ? PHOTOS[name] : undefined
    if (!photo || photo[0] !== main) return
    const [, color, hex, hex2] = photo
    const now = colors.get(color) ?? { nombre: color, hex, hex2: hex2 ?? null, fotos: [] }
    now.fotos.push(i + 1)
    colors.set(color, now)
  })
  const others = counts.size > 1
  return {
    mismo_producto: !others && !kind.aviso,
    aviso: kind.aviso ?? (others ? "Alguna foto parece de otro producto." : null),
    leido: kind.leido ?? [],
    nombre: kind.aviso ? null : { valor: kind.nombre, porque: "Se ve en las fotos" },
    categoria: kind.aviso ? null : { valor: kind.categoria, porque: "Por el tipo de producto" },
    rubro: fixed ? null : { valor: kind.rubro, porque: `Es ${kind.categoria.toLowerCase()}` },
    colores: kind.aviso
      ? []
      : [...colors.values()].map((c) => ({
          ...c,
          porque: c.fotos.length === 1 ? `Se ve en la foto ${c.fotos[0]}` : "Se ve en las fotos",
        })),
    // Con fotos de otro producto, ningún dato: no se sabe de cuál es.
    datos: (others ? [] : (kind.datos ?? [])).map((d) => ({
      ...d,
      porque: d.de === "etiqueta" ? "Se lee en la etiqueta" : "Se ve en la foto",
    })),
    palabras: kind.palabras,
    descripcion: kind.descripcion || null,
  }
}

async function groupReply(request: ChatRequest) {
  const names = await Promise.all(imagesOf(request).map(recognize))
  const byKind = new Map<string, number[]>()
  names.forEach((name, i) => {
    const kind = name ? PHOTOS[name]?.[0] : undefined
    if (!kind || kind === "varias") return
    byKind.set(kind, [...(byKind.get(kind) ?? []), i + 1])
  })
  return {
    grupos: [...byKind.entries()]
      .filter(([, fotos]) => fotos.length > 1)
      .map(([kind, fotos]) => ({
        fotos,
        porque: `${KINDS[kind]?.nombre ?? "El mismo producto"}, en distintas fotos`,
      })),
  }
}

export function samplePhotosModel(fallback: ChatModel): ChatModel {
  return {
    name: "fake",
    async complete(request): Promise<ModelReply> {
      const schema = request.responseFormat?.json_schema.name
      if (schema === "propuesta_de_producto")
        return { content: JSON.stringify(await lookReply(request)), toolCalls: [], usage: NO_USAGE }
      if (schema === "fotos_juntas")
        return {
          content: JSON.stringify(await groupReply(request)),
          toolCalls: [],
          usage: NO_USAGE,
        }
      return fallback.complete(request)
    },
  }
}
