import { type Dato, ESTADOS, type Producto, type Rubro } from "./datos"
import { autoUnit, basePrice, floorUnit, key, money, promoFor, totalStock } from "./precio"

/**
 * Lo que Sofi sabe de un producto y cómo respondería, calculado SIEMPRE con lo que la ficha tiene
 * en ese momento (también lo no guardado). No hay modelo: son reglas fijas, para que la tienda vea
 * en la práctica qué usa Sofi y qué le falta.
 */

export interface Saber {
  id: string
  label: string
  ok: boolean
  need: boolean
  detail: string
  /** El campo de la ficha donde se completa. */
  target: string
}

const filled = (d: Dato, v: unknown) => {
  if (d.type === "percol" || d.type === "table") return !!v && Object.keys(v as object).length > 0
  return !!v && String(v).trim() !== ""
}

export function datoTexto(d: Dato, v: unknown): string {
  if (!filled(d, v)) return ""
  if (d.type === "percol" || d.type === "table") {
    const n = Object.values(v as object).filter((x) =>
      Array.isArray(x) ? x.some(Boolean) : !!x,
    ).length
    return n === 1 ? "1 medida" : `${n} medidas`
  }
  if (d.type === "date") {
    const [y, m] = String(v).split("-")
    return `${m}/${y}`
  }
  return String(v)
}

export function saber(p: Producto, r: Rubro, tpl: Dato[]): Saber[] {
  const L: Saber[] = []
  const total = totalStock(p)
  const push = (
    id: string,
    label: string,
    ok: boolean,
    need: boolean,
    detail: string,
    target: string,
  ) => L.push({ id, label, ok, need, detail, target })
  push(
    "precio",
    "Precio y mínimo",
    !!(p.list && p.min),
    true,
    p.min ? `${money(p.list)} · baja hasta ${money(p.min)}` : "Sin mínimo: no negocia",
    "campo-minimo",
  )
  push("stock", "Stock por variante", total > 0, true, `${total} ${r.unit}`, "variantes")
  const sinFoto = p.colors.filter(
    (c) => !p.media.some((m) => m.color === c.id && m.kind === "foto"),
  )
  push(
    "fotos",
    `Una foto de cada ${r.row.toLowerCase()}`,
    p.colors.length > 0 && sinFoto.length === 0,
    true,
    sinFoto.length ? `Falta: ${sinFoto.map((c) => c.name).join(", ")}` : "Completas",
    "fotos",
  )
  for (const d of tpl)
    push(
      `dato-${d.id}`,
      d.label,
      filled(d, p.datos[d.id]),
      !!d.need,
      datoTexto(d, p.datos[d.id]) || "Falta",
      `dato-${d.id}`,
    )
  push(
    "video",
    "Un video",
    p.media.some((m) => m.kind === "video"),
    false,
    "",
    "fotos",
  )
  const of = [
    p.ofertas.envio && "envío",
    p.ofertas.soles && "soles de menos",
    p.ofertas.regalo && "regalo",
    p.ofertas.dosx && "2.ª unidad",
  ].filter(Boolean)
  push("ofertas", "Lo que puede ofrecer", of.length > 0, false, of.join(", "), "ofertas")
  push(
    "palabras",
    "Cómo la buscan",
    p.keywords.length > 0,
    false,
    p.keywords.join(", "),
    "organizacion",
  )
  push(
    "paquete",
    "Paquete para la agencia",
    !!(p.paquete.peso && p.paquete.l),
    false,
    p.paquete.peso ? `${p.paquete.peso} kg` : "",
    "paquete",
  )
  return L
}

export function resumen(L: Saber[]) {
  const needMiss = L.filter((x) => x.need && !x.ok)
  const plusMiss = L.filter((x) => !x.need && !x.ok)
  const done = L.filter((x) => x.ok).length
  return {
    needMiss,
    plusMiss,
    done,
    total: L.length,
    vendeSola: needMiss.length === 0,
    completo: needMiss.length + plusMiss.length === 0,
  }
}

/* ---------- la prueba: cómo respondería ---------- */

export interface Usado {
  label: string
  target: string
}
export interface Respuesta {
  partes: string[]
  usados: Usado[]
  faltan: { label: string; target: string; dato?: string }[]
  img?: string
  video?: string
  /** No sabe: deja la pregunta en «Te toca». */
  derivada?: boolean
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!.,;:]/g, " ")
const has = (t: string, words: string[]) => words.some((w) => t.includes(norm(w)))

function sizeIn(p: Producto, raw: string): string | null {
  for (const z of p.sizes) {
    if (z === "Única" || z === "Estándar") continue
    const isWord = /^[A-Z]{1,3}$/.test(z)
    const re = isWord
      ? new RegExp(`(^|\\s)${z}(\\s|$|[?.,])`)
      : new RegExp(`(^|\\D)${z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\D|$)`, "i")
    if (re.test(raw)) return z
  }
  return null
}

function colorIn(p: Producto, t: string) {
  return (
    p.colors.find((c) => t.includes(norm(c.name)) || t.includes(norm(c.name).replace(/a$/, "o"))) ??
    null
  )
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
const punto = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

/** Cómo lo diría Sofi, dato por dato; lo demás, «Dato: valor». */
const FRASE: Record<string, (v: string) => string> = {
  material: (v) => `Es de ${lower(v)}.`,
  tela: (v) => `Es de ${lower(v)}.`,
  calce: (v) => `El calce es ${lower(v)}.`,
  largo: (v) => `El largo es ${lower(v)}.`,
  piel: (v) => (v === "Todo tipo" ? "Sirve para todo tipo de piel." : `Es para piel ${lower(v)}.`),
  contenido: (v) => `Trae ${v}.`,
  ingredientes: (v) => `Tiene ${lower(punto(v))}`,
  nso: (v) => `Tiene registro sanitario ${v}.`,
  compatible: (v) => `Funciona con ${lower(punto(v))}`,
  estadoEq: (v) => `Es ${lower(v)}.`,
  garantia: (v) => `Tiene ${v} de garantía de la tienda.`,
  incluye: (v) => `La caja trae: ${lower(punto(v))}`,
  bateria: (v) => `La batería dura unas ${v} horas.`,
  medidas: (v) => `Mide ${punto(v)}`,
  peso: (v) => `Pesa ${punto(v)}`,
  arma: (v) => punto(v),
  limpia: (v) => punto(v),
  cuidado: (v) => punto(v),
}

export function responder(p: Producto, r: Rubro, tpl: Dato[], pregunta: string): Respuesta {
  const t = ` ${norm(pregunta)} `
  const out: Respuesta = { partes: [], usados: [], faltan: [] }
  const size = sizeIn(p, pregunta)
  const color = colorIn(p, t)
  const colLabel = (r.col ?? "").toLowerCase()
  const est = ESTADOS.find((e) => e.id === p.estado)

  if (p.estado !== "disponible" && est) {
    const frase = est.sofi
      .replace("{dias}", p.estadoInfo.dias || "unos")
      .replace("{cupo}", p.estadoInfo.cupo || "pocas")
      .replace("{fecha}", p.estadoInfo.fecha || "pronto")
    if (frase.startsWith("«")) out.partes.push(frase.replace(/[«»]/g, ""))
    out.usados.push({ label: `Estado: ${lower(est.label)}`, target: "estado" })
  }

  // 1. Lo que dice la plantilla del rubro.
  let tocoDato = false
  for (const d of tpl) {
    if (!has(t, d.keys)) continue
    tocoDato = true
    const v = p.datos[d.id]
    if (!filled(d, v)) {
      out.faltan.push({ label: d.label, target: `dato-${d.id}`, dato: d.id })
      continue
    }
    if (d.id === "horma") out.partes.push(`Calza ${lower(String(v))}.`)
    else if (d.id === "ancho") {
      if (String(v) === "Una talla más") {
        const next = size ? p.sizes[p.sizes.indexOf(size) + 1] : null
        out.partes.push(
          next
            ? `Con pie ancho te recomiendo una talla más: la ${next}.`
            : "Con pie ancho, pide una talla más.",
        )
      } else out.partes.push("Con pie ancho, tu talla de siempre.")
    } else if (d.type === "percol") {
      const m = v as Record<string, string>
      if (size && !m[size]) {
        out.faltan.push({
          label: `${d.label} de la ${size}`,
          target: `dato-${d.id}-${size}`,
          dato: d.id,
        })
        continue
      }
      const z = size ?? Object.keys(m).find((k) => m[k])!
      out.partes.push(`La plantilla de la ${z} mide ${m[z]} cm.`)
    } else if (d.type === "table") {
      const m = v as Record<string, string[]>
      const z = size && m[size] ? size : Object.keys(m)[0]!
      out.partes.push(`La ${z} tiene ${m[z]![0]} cm de pecho y ${m[z]![1]} de largo.`)
    } else if (d.type === "date") out.partes.push(`El lote que tengo vence en ${datoTexto(d, v)}.`)
    else out.partes.push(FRASE[d.id]?.(String(v)) ?? `${d.label}: ${lower(punto(String(v)))}`)
    out.usados.push({
      label: `${d.label}: ${lower(datoTexto(d, v)).slice(0, 34)}`,
      target: `dato-${d.id}`,
    })
  }

  // 2. Una pregunta que la tienda ya respondió.
  const words = t.split(/\s+/).filter((w) => w.length > 3)
  const prev = p.preguntas.find((x) => {
    const q = norm(x.q)
    return words.filter((w) => q.includes(w)).length >= 2
  })
  if (prev) {
    out.partes.push(prev.a)
    out.usados.push({ label: `Pregunta guardada: ${prev.q}`, target: "preguntas" })
  }

  // 3. Precio y negociación.
  const nego = has(t, [
    "barat",
    "descuento",
    "rebaja",
    "dejas",
    "menos",
    "ultimo precio",
    "precio final",
    "oferta",
  ])
  const pide =
    !tocoDato && has(t, ["precio", "cuesta", "cuanto esta", "cuanto sale", "a cuanto", "cuanto es"])
  const c0 = color ?? p.colors[0]
  const z0 = size ?? p.sizes[Math.min(3, p.sizes.length - 1)] ?? "Única"
  if (nego && c0) {
    const [auto] = autoUnit(p, c0.id, z0, 1)
    const floor = floorUnit(p, auto)
    const margin = auto - floor
    const pr = promoFor(p, c0.id, z0)
    if (p.estado === "liquidacion")
      out.partes.push(`Está en liquidación: ${money(auto)} es su precio final.`)
    else if (p.min == null) {
      out.partes.push(`Está a ${money(auto)}, su mejor precio.`)
      out.faltan.push({ label: "Precio mínimo (sin él, Sofi no negocia)", target: "campo-minimo" })
    } else if (margin <= 0) out.partes.push(`Ya está en su mejor precio: ${money(auto)}.`)
    else {
      const conEnvio = p.ofertas.envio && margin >= 10
      const rebaja = Math.max(0, Math.min(margin - (conEnvio ? 10 : 0), Math.round(margin / 2)))
      out.partes.push(
        `Te propongo esto, una sola vez: ${money(auto - rebaja)}${conEnvio ? " con envío gratis a Surco" : ""}${p.ofertas.regalo ? ` y de regalo ${lower(p.ofertas.regalo)}` : ""}, si la pagas hasta mañana a las 6 p. m.`,
      )
      out.usados.push({
        label: `Mínimo ${money(p.min)} · cede de un solo margen`,
        target: "campo-minimo",
      })
      if (conEnvio) out.usados.push({ label: "Puede ofrecer el envío", target: "ofertas" })
    }
    if (pr) out.usados.push({ label: `Promoción: ${pr.nombre}`, target: "promos" })
  } else if (pide && c0) {
    const precios = p.colors.map((c) => [c, basePrice(p, c.id, z0)] as const)
    const distintos = new Set(precios.map(([, v]) => v)).size > 1
    out.partes.push(
      distintos
        ? `${precios.map(([c, v], i) => `${i ? "la" : "La"} ${c.name} está a ${money(v)}`).join(" y ")}.`
        : `Está a ${money(basePrice(p, c0.id, z0))}.`,
    )
    out.usados.push({ label: "Precio por variante", target: "variantes" })
  }

  // 4. Stock de un color o una talla.
  const pideStock =
    has(t, ["tienes", "hay", "queda", "stock", "disponible", "en talla"]) || (!!size && !tocoDato)
  if (pideStock && (color || size) && p.estado !== "agotado") {
    const cs = color ? [color] : p.colors
    const zs = size ? [size] : p.sizes
    const partes: string[] = []
    for (const c of cs) {
      const n = zs.reduce((a, z) => a + (p.stock[key(c.id, z)] ?? 0), 0)
      const donde = size ? `de la ${size}` : `en ${c.name}`
      partes.push(
        n === 0
          ? `${size && p.colors.length > 1 ? `En ${c.name}, ` : ""}${donde} no me queda`
          : `${size && p.colors.length > 1 ? `En ${c.name}, ` : ""}${donde} me quedan ${n}`,
      )
      out.usados.push({
        label: `Stock ${size ? `${size} ` : ""}${c.name}: ${n}`,
        target: "variantes",
      })
    }
    out.partes.push(`${partes.join("; ")}.`.replace(/^./, (x) => x.toUpperCase()))
    if (color && size && (p.stock[key(color.id, size)] ?? 0) === 0) {
      const otro = p.colors.find((c) => c.id !== color.id && (p.stock[key(c.id, size)] ?? 0) > 0)
      if (otro) out.partes.push(`En ${otro.name} sí la tengo.`)
      else out.partes.push("¿Te aviso cuando vuelva?")
    }
  }

  // 5. Envío.
  if (has(t, ["envio", "envian", "llega", "delivery", "despacho", "agencia", "provincia"])) {
    out.partes.push(
      `A Surco el envío cuesta S/ 10 y por agencia a provincia, S/ 18. Desde S/ 250 es gratis.`,
    )
    out.usados.push({ label: "Formas de entrega de la tienda", target: "ofertas" })
    if (!p.paquete.peso)
      out.faltan.push({ label: "Peso del paquete (para la agencia)", target: "paquete" })
  }

  // 6. Foto y video.
  const vid = p.media.find(
    (m) => m.kind === "video" && (!color || !m.color || m.color === color.id),
  )
  if (has(t, ["video", "puesta", "puesto", "como se ve", "de cerca"])) {
    if (vid) {
      out.partes.push("Te mando el video.")
      out.video = vid.src
      out.img = vid.poster
      out.usados.push({
        label: `Video${vid.color ? ` de «${p.colors.find((c) => c.id === vid.color)?.name}»` : ""}`,
        target: "fotos",
      })
    } else out.faltan.push({ label: "Un video", target: "fotos" })
  }
  if (!out.img && (pideStock || pide || nego || has(t, ["foto"])) && out.partes.length) {
    const ph =
      p.media.find((m) => m.kind === "foto" && (!color || m.color === color.id)) ?? p.media[0]
    if (ph) {
      out.img = ph.kind === "video" ? ph.poster : ph.src
      out.usados.push({
        label: `Foto de «${(color ?? p.colors.find((c) => c.id === ph.color))?.name ?? "portada"}»`,
        target: "fotos",
      })
    }
  }

  if (!out.partes.length && !out.faltan.length) {
    out.derivada = true
    out.faltan.push({ label: "La respuesta a esta pregunta", target: "preguntas" })
  }
  if (out.faltan.length && !out.partes.length) {
    out.partes.push(
      "Eso no lo tengo confirmado y no quiero decirte algo que no es. Le pregunto a la tienda y te escribo.",
    )
    out.derivada = true
  } else if (out.faltan.length) out.partes.push("Lo demás se lo confirmo con la tienda.")
  return out
}
