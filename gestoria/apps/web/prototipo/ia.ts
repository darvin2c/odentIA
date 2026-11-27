import { type Color, nid, type Producto, type Rubro } from "./datos"
import { readValues } from "./ficha/variantes"

/**
 * La «IA» del prototipo: lo que se ve en las fotos de ejemplo está anotado en `Rubro.ph` (producto,
 * color, código). Con eso propone nombre, categoría, colores, texto y lo que se lee en la etiqueta;
 * nunca el precio. Lo que no se ve en una foto, lo pregunta.
 */

/** Lo que se lee en una foto o una etiqueta, por rubro y producto. */
const VE: Record<string, Record<string, Record<string, string>>> = {
  calzado: {
    lona: { material: "Lona" },
    plat: { material: "Sintético" },
    bailarina: { material: "Sintético" },
    mocasin: { material: "Cuero" },
    lluvia: { material: "Sintético" },
    hebilla: { material: "Sintético" },
    pasador: { material: "Sintético" },
    dorada: { material: "Sintético" },
  },
  ropa: {
    polo: { tela: "Piqué de algodón" },
    jean: { tela: "Jean" },
    short: { tela: "Jean" },
    vestido: { tela: "Algodón" },
  },
  cosmetica: { labial: { contenido: "3,5 g" }, estuche: { contenido: "4 g" } },
  tecnologia: {
    audif: { estadoEq: "Nuevo" },
    base: { estadoEq: "Nuevo" },
    funda: { compatible: "iPhone 13, iPhone 14, Galaxy A54" },
  },
  hogar: {
    manta: { material: "Algodón" },
    cojin: { material: "Algodón" },
    taza: { material: "Cerámica" },
    lampara: { material: "Tela y metal" },
  },
}

export interface Propuesta {
  kind: string
  name: string
  cat: string
  texto: string
  kw: string[]
  cols: string
  colors: (Color & { fotos: string[] })[]
  datos: Record<string, string>
  /** Algunas fotos parecen de otro producto. */
  mixed: boolean
}

export function proponer(fotos: string[], R: Rubro, rubroId: string): Propuesta {
  const seen = fotos.map((f) => R.ph[f]).filter(Boolean) as [string, string, string, string?][]
  const counts = new Map<string, number>()
  for (const [k] of seen) counts.set(k, (counts.get(k) ?? 0) + 1)
  const kind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? Object.keys(R.kinds)[0]!
  const K = R.kinds[kind] ?? Object.values(R.kinds)[0]!
  const colors: Propuesta["colors"] = []
  fotos.forEach((f) => {
    const v = R.ph[f]
    if (!v || v[0] !== kind) return
    const [, name, hex, hex2] = v
    const c = colors.find((x) => x.name === name)
    if (c) c.fotos.push(f)
    else colors.push({ id: nid("c"), name, hex, ...(hex2 ? { hex2 } : {}), fotos: [f] })
  })
  if (!colors.length)
    colors.push({ id: nid("c"), name: "único", hex: "#9ca3af", fotos: [...fotos] })
  return {
    kind,
    name: K.name,
    cat: K.cat,
    texto: K.texto,
    kw: K.kw,
    cols: K.cols,
    colors,
    datos: VE[rubroId]?.[kind] ?? {},
    mixed: counts.size > 1,
  }
}

/** Arma el producto con lo propuesto: lo aceptado como valor y lo demás como propuesta (✦). */
export function crearProducto(
  pr: Propuesta,
  o: {
    name: string
    cat: string
    precio: number
    tallas: string
    stock?: number
    texto: string
    datos: Record<string, string>
    aceptado: Set<string>
    extraFotos?: string[]
  },
  R: Rubro,
): Producto {
  const sizes = R.col ? readValues(o.tallas || pr.cols || "Única") : ["Única"]
  const colors: Color[] = pr.colors.map(({ fotos: _f, ...c }) => c)
  const stock: Record<string, number> = {}
  for (const c of colors) for (const z of sizes) stock[`${c.id}|${z}`] = o.stock ?? 0
  const aiColor = !o.aceptado.has("colores")
  const media = pr.colors.flatMap((c) =>
    c.fotos.map((src) => ({ id: nid("m"), src, kind: "foto" as const, color: c.id, aiColor })),
  )
  for (const src of o.extraFotos ?? [])
    media.push({ id: nid("m"), src, kind: "foto", color: colors[0]?.id ?? "", aiColor: true })
  const aiDatos = Object.fromEntries(Object.entries(pr.datos).filter(([k]) => !(k in o.datos)))
  return {
    id: nid("p"),
    name: o.name,
    cat: o.cat,
    estado: "disponible",
    estadoInfo: {},
    media,
    colors,
    sizes,
    stock,
    prices: {},
    list: o.precio,
    min: null,
    costos: [],
    tiers: [],
    mayor: null,
    promos: [],
    ofertas: { envio: true, soles: true, regalo: "", dosx: false },
    datos: o.datos,
    texto: o.texto,
    preguntas: [],
    keywords: o.aceptado.has("kw") ? pr.kw : [],
    web: {
      visible: true,
      slug: o.name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-"),
    },
    paquete: { peso: "", l: "", a: "", h: "" },
    combo: { con: [], pct: 0 },
    parecido: [],
    sku: "",
    ai: {
      ...(o.aceptado.has("name") ? {} : { name: o.name }),
      ...(o.aceptado.has("kw") ? {} : { keywords: pr.kw }),
      datos: aiDatos,
    },
  }
}
