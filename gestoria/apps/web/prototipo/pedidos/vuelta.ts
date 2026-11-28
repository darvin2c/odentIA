import { useSyncExternalStore } from "react"
import { type Producto, RUBROS, type RubroId } from "../datos"
import {
  type Actor,
  agregar,
  type Evento,
  type Linea,
  type Medio,
  type Msg,
  money,
  mover,
  nuevoId,
  type Pedido,
  pedidosDe,
  refrescar,
} from "./modelo"

/**
 * Los cambios y las devoluciones del prototipo. Todo depende de la política de la tienda: gestorIA
 * trae una recomendada por rubro y la tienda la ajusta. Sofi la informa con sus palabras y, con la
 * casilla de Configuración › Sofi marcada, pasa cada caso a una persona ya armado para aprobarlo
 * para aprobarlo en su cajón, sin dejar de contestar lo que sí sabe (como odentIA, ADR 0050).
 */

/* ---------- La política de la tienda ---------- */

export type NoCambia = "abierto" | "interior" | "medida" | "sello"
export interface Politica {
  cambios: boolean
  devoluciones: "si" | "falla" | "no"
  plazoCambio: string
  plazoDevolucion: string
  /** Días de garantía si la ficha del producto no la dice. */
  garantia: string
  sinUso: boolean
  etiqueta: boolean
  caja: boolean
  noCambia: NoCambia[]
  /** Lo que está en liquidación u oferta. */
  oferta: "normal" | "solo_cambio" | "no"
  dinero: "medio" | "saldo" | "elige"
  primero: "saldo" | "medio"
  saldoVence: "no" | "6" | "12"
  envio: "tienda" | "clienta" | "falla"
  cambiosGratis: string
  recojo: boolean
  tienda: boolean
  agencia: boolean
  cuando: "revisar" | "recoger" | "falla_foto"
  sinStock: "otra_saldo_dev" | "saldo_otra_dev" | "otra_dev_saldo"
}

export const NO_CAMBIA: Record<NoCambia, string> = {
  abierto: "Cosmética abierta o usada",
  interior: "Ropa interior y de baño",
  medida: "Lo hecho a medida",
  sello: "Lo que tiene el sello roto (sin falla)",
}

const base: Politica = {
  cambios: true,
  devoluciones: "si",
  plazoCambio: "7",
  plazoDevolucion: "7",
  garantia: "90",
  sinUso: true,
  etiqueta: false,
  caja: true,
  noCambia: [],
  oferta: "solo_cambio",
  dinero: "elige",
  primero: "saldo",
  saldoVence: "6",
  envio: "falla",
  cambiosGratis: "1",
  recojo: true,
  tienda: true,
  agencia: true,
  cuando: "revisar",
  sinStock: "otra_saldo_dev",
}

/** La política recomendada por rubro: el punto de partida. La tienda la ajusta. */
export const RECOMENDADA: Record<RubroId, Politica> = {
  calzado: { ...base },
  ropa: { ...base, etiqueta: true, caja: false, noCambia: ["interior"] },
  cosmetica: {
    ...base,
    devoluciones: "falla",
    caja: false,
    noCambia: ["abierto"],
    oferta: "no",
    dinero: "medio",
    primero: "medio",
    cambiosGratis: "0",
    garantia: "30",
  },
  tecnologia: {
    ...base,
    devoluciones: "falla",
    noCambia: ["sello"],
    dinero: "medio",
    primero: "medio",
    cambiosGratis: "0",
    garantia: "180",
  },
  hogar: {
    ...base,
    plazoCambio: "15",
    plazoDevolucion: "15",
    noCambia: ["medida"],
    envio: "clienta",
    cambiosGratis: "0",
  },
}

/** Lo que dice la tabla del lienzo, por rubro. */
export function resumenRubro(r: RubroId) {
  const p = RECOMENDADA[r]
  return {
    plazo: `${p.plazoCambio} días${p.devoluciones === "falla" ? " (dinero solo por falla)" : ""}`,
    noCambia:
      [...p.noCambia.map((x) => NO_CAMBIA[x]), p.oferta === "no" ? "Lo de oferta" : null]
        .filter(Boolean)
        .join(" · ") || "Nada aparte de las condiciones",
    envio: ENVIO[p.envio],
    dinero: DINERO[p.dinero],
  }
}

export const ENVIO: Record<Politica["envio"], string> = {
  tienda: "La tienda",
  clienta: "La clienta",
  falla: "La tienda, solo si es falla",
}
export const DINERO: Record<Politica["dinero"], string> = {
  medio: "Por el mismo medio",
  saldo: "Como saldo a favor",
  elige: "Que elija la clienta",
}
export const CUANDO: Record<Politica["cuando"], string> = {
  revisar: "Después de recibir y revisar",
  recoger: "Al recoger",
  falla_foto: "Con falla clara y su foto, al aprobar",
}
export const SIN_STOCK: Record<Politica["sinStock"], string> = {
  otra_saldo_dev: "Otra talla o color, saldo a favor, devolución",
  saldo_otra_dev: "Saldo a favor, otra talla o color, devolución",
  otra_dev_saldo: "Otra talla o color, devolución, saldo a favor",
}

/* ---------- Su tienda en memoria: la política y la casilla de Configuración › Sofi ---------- */

const POL: Partial<Record<RubroId, Politica>> = {}
/** «Sofi te pasa el chat cuando… es un reclamo, un cambio o una devolución»: marcada por defecto. */
let CASILLA = true
let ver = 0
const subs = new Set<() => void>()
const avisarCambio = () => {
  ver++
  for (const f of subs) f()
}
const usar = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => ver,
  )

export function politicaDe(r: RubroId): Politica {
  return POL[r] ?? RECOMENDADA[r]
}
export function usePolitica(r: RubroId): Politica {
  usar()
  return politicaDe(r)
}
export function casilla() {
  return CASILLA
}
export function useCasilla() {
  usar()
  return CASILLA
}
export function reiniciarVueltas() {
  for (const k of Object.keys(POL)) delete POL[k as RubroId]
  CASILLA = true
  avisarCambio()
}

/** Guarda la política: Sofi la usa desde ya y se rearman los casos que esperan aprobación. */
export function guardarPolitica(r: RubroId, pol: Politica) {
  POL[r] = { ...pol }
  rearmar(r)
  avisarCambio()
}

/**
 * La casilla de Configuración › Sofi. Si se desmarca, Sofi ejecuta sola lo que está dentro de la
 * política y solo pasa lo que queda fuera.
 */
export function cambiarCasilla(r: RubroId, on: boolean) {
  CASILLA = on
  rearmar(r)
  if (!on)
    for (const p of pedidosDe(r))
      if (p.vuelta?.estado === "solicitado" && p.vuelta.arm.dentro) aprobar(r, p, "Sofi")
  avisarCambio()
  refrescar()
}

/* ---------- El pedido de cambio o devolución ---------- */

export type VPaso = "solicitado" | "aprobado" | "vuelve" | "revisado" | "final"
export type Motivo = "chica" | "grande" | "falla" | "no_quiere" | "otro_modelo" | "color"
export const MOTIVO: Record<Motivo, string> = {
  chica: "Le queda chica",
  grande: "Le queda grande",
  falla: "Vino fallado",
  no_quiere: "Ya no lo quiere",
  otro_modelo: "Prefiere otro modelo",
  color: "Prefiere otro color",
}
export type Como = "recojo_mismo" | "recojo_solo" | "tienda" | "agencia"

export interface Armado {
  dentro: boolean
  /** Por qué queda fuera de la política, con números: «Pasó el plazo: 12 días de 7». */
  fuera?: string
  plazo: number
  envioPaga: "tienda" | "clienta"
  envio: number
  /** Positivo: Sofi lo cobra con su link. Negativo: a favor de la clienta. */
  diferencia: number
  dinero: "medio" | "saldo" | null
  /** El dinero que vuelve a la clienta (devolución o diferencia a favor). */
  monto: number
  cuandoDinero: Politica["cuando"]
  tarjeta: string
  sofi: string
}

export interface Vuelta {
  id: string
  tipo: "cambio" | "devolucion"
  motivo: Motivo
  /** Lo que escribió la clienta. */
  dice: string
  dias: number
  vuelven: Linea[]
  sale?: Linea
  /** Lo que pidió y no hay: Sofi ofrece en el orden de la política. */
  sinStock?: string
  categoria?: NoCambia | "oferta"
  foto?: boolean
  como: Como
  agencia?: { nombre: "Shalom" | "Olva"; ciudad: string; numero?: string }
  /** Lo que eligió la clienta para su dinero, si la política la deja elegir. */
  quiere?: "medio" | "saldo"
  medio: Medio
  repartidor?: string
  dia?: string
  franja?: string
  estado: "solicitado" | "aprobado" | "rechazado" | "recibido" | "revisado" | "cerrado"
  hechos: Partial<Record<VPaso, { quien: string; cuando: string; texto?: string }>>
  /** Si quedó fuera de la política y la clienta insistió: va a «Te toca». */
  insiste?: boolean
  arm: Armado
  revision?: { k: "vender" | "danado" | "garantia"; motivo: string }
  excepcion?: string
  enlazado?: string
  /** Lo que sigue en el chat: Sofi contesta lo que sabe y suma al tema lo que tiene la persona. */
  chat: Msg[]
  extra?: Msg[]
  /** Quién tiene el tema. */
  persona?: string
}

const nom = (p: Pedido) => p.clienta.split(" ")[0]!
const talla = (l: Linea) => l.variante.split(" · ").at(-1) || l.variante || "otra"
const MEDIOCORTO: Record<Medio, string> = {
  link: "su tarjeta",
  yape: "Yape",
  plin: "Plin",
  efectivo: "Yape",
  pos: "su tarjeta",
}
export const medioDe = (v: Vuelta) => (v.medio === "link" || v.medio === "pos" ? "tarjeta" : MEDIOCORTO[v.medio])

/** La garantía: la de la ficha del producto si la tiene; si no, la de la política. */
export function garantiaDe(r: RubroId, pid: string, pol: Politica): { dias: number; de: string } {
  const prod: Producto | undefined = RUBROS[r].products().find((x) => x.id === pid)
  const g = prod?.datos?.garantia
  if (typeof g === "string" && g) {
    const n = Number.parseInt(g, 10) || 6
    return { dias: g.includes("año") ? 365 * n : n * 30, de: `${g}, de la ficha del producto` }
  }
  return { dias: Number(pol.garantia), de: `${pol.garantia} días, de tu política` }
}

const ofrece = (pol: Politica) =>
  ({
    otra_saldo_dev: ["otro color en tu talla", "saldo a favor", "la devolución de tu dinero"],
    saldo_otra_dev: ["saldo a favor", "otro color en tu talla", "la devolución de tu dinero"],
    otra_dev_saldo: ["otro color en tu talla", "la devolución de tu dinero", "saldo a favor"],
  })[pol.sinStock]

/** Arma el caso según la política: si está dentro, qué ofrece Sofi, quién paga y la tarjeta. */
export function armar(r: RubroId, p: Pedido, v: Vuelta, pol: Politica, pasa = CASILLA): Armado {
  const n = nom(p)
  const tienda = RUBROS[r].store.name
  const falla = v.motivo === "falla"
  const l = v.vuelven[0]!
  const g = garantiaDe(r, l.pid, pol)
  const plazo = falla ? g.dias : Number(v.tipo === "cambio" ? pol.plazoCambio : pol.plazoDevolucion)
  let fuera: string | undefined
  if (v.tipo === "cambio" && !pol.cambios && !falla) fuera = "Tu tienda no hace cambios"
  if (v.tipo === "devolucion" && !falla && pol.devoluciones !== "si")
    fuera = pol.devoluciones === "falla" ? "Devuelves dinero solo por falla" : "No devuelves dinero"
  if (!falla && v.categoria && v.categoria !== "oferta" && pol.noCambia.includes(v.categoria))
    fuera = `${NO_CAMBIA[v.categoria]}: no se cambia`
  if (!falla && v.categoria === "oferta" && (pol.oferta === "no" || (pol.oferta === "solo_cambio" && v.tipo === "devolucion")))
    fuera = pol.oferta === "no" ? "Lo de oferta no se cambia" : "Lo de oferta solo se cambia"
  if (v.dias > plazo) fuera = `Pasó el plazo: ${v.dias} días de ${plazo}`
  const vuelve = v.vuelven.reduce((a, x) => a + x.precio * x.qty, 0)
  const diferencia = v.sale ? v.sale.precio * v.sale.qty - vuelve : 0
  const tiendaPaga =
    falla || pol.envio === "tienda" || (v.tipo === "cambio" && pol.envio === "falla" && Number(pol.cambiosGratis) > 0) ||
    (v.tipo === "cambio" && pol.envio === "clienta" && Number(pol.cambiosGratis) > 0)
  const envio = v.como === "agencia" ? 15 : v.como === "tienda" ? 0 : p.entrega.envio || 12
  const pagaElla = !(falla || pol.envio === "tienda") && v.tipo === "devolucion" && v.como.startsWith("recojo")
  const monto = v.tipo === "devolucion" ? vuelve - (pagaElla ? envio : 0) : Math.max(0, -diferencia)
  const dinero: Armado["dinero"] = monto
    ? pol.dinero === "elige"
      ? (v.quiere ?? pol.primero)
      : pol.dinero
    : null
  const cuandoDinero: Armado["cuandoDinero"] =
    pol.cuando === "falla_foto" ? (falla && v.foto ? "falla_foto" : "revisar") : pol.cuando
  const envioPaga = tiendaPaga || !envio ? "tienda" : "clienta"
  const rep = v.repartidor ?? p.entrega.repartidor ?? "Kevin"
  const dia = (v.dia ?? "Vie 28").toLowerCase()
  const elDia = dia === "hoy" ? "hoy" : `el ${dia}`
  const franja = (v.franja ?? "2 a 6 p. m.").replace(/\.$/, "")
  const comoCorto = {
    recojo_mismo: `${rep} lleva ${v.sale ? `la ${talla(v.sale)}` : "el nuevo"} y recoge ${v.sale && v.sale.pid === l.pid ? `la ${talla(l)}` : "lo que vuelve"} ${elDia}`,
    recojo_solo: `${rep} lo recoge ${elDia}`,
    tienda: `${n} lo trae a la tienda`,
    agencia: `vuelve por ${v.agencia?.nombre ?? "agencia"} desde ${v.agencia?.ciudad ?? "provincia"}`,
  }[v.como]
  const de =
    v.sale && v.sale.pid === l.pid
      ? `${talla(l)} → ${talla(v.sale)}`
      : v.sale
        ? `${l.nombre} → ${v.sale.nombre}`
        : `${l.nombre} ${l.variante}`
  const plata =
    diferencia > 0
      ? `${money(diferencia)} más (Sofi lo cobra con su link)`
      : diferencia < 0
        ? `${money(-diferencia)} menos (${dinero === "saldo" ? "queda a su favor" : `se le devuelve por ${medioDe(v)}`})`
        : v.tipo === "cambio"
          ? "mismo precio"
          : `${money(monto)} ${dinero === "saldo" ? "a su favor" : `por ${medioDe(v)}`}`
  const envioCorto = envioPaga === "tienda" ? "" : `, envío ${money(envio)} lo paga ${n}`
  const titulo = v.tipo === "cambio" ? (falla ? "Cambio por falla" : "Cambio") : v.vuelven.length < p.lineas.length ? "Devolución de una parte" : "Devolución"
  const tarjeta = fuera
    ? `${titulo} de ${n}: ${de}. Fuera de tu política: ${fuera.charAt(0).toLowerCase()}${fuera.slice(1)}. ${n} insiste.`
    : `${titulo} de ${n}: ${de}, ${plata}${envioCorto}, ${comoCorto}. Dentro de tu política.`
  // Lo que Sofi le dice a la clienta, con sus palabras y sin salirse de la política.
  const cond = [pol.sinUso ? "sin uso" : null, pol.etiqueta ? "con su etiqueta" : null, pol.caja ? "con su caja" : null].filter(Boolean)
  const condTxt = cond.length && !falla ? ` Tiene que estar ${cond.join(" y ")}.` : ""
  const envioTxt =
    envioPaga === "tienda"
      ? falla
        ? " El envío lo pone la tienda: no pagas nada."
        : v.como === "tienda"
          ? ""
          : " El envío lo pone la tienda."
      : v.como === "agencia"
        ? ` El envío por ${v.agencia?.nombre ?? "agencia"} lo pagas tú (unos ${money(envio)}).`
        : v.tipo === "devolucion"
          ? ` El recojo cuesta ${money(envio)}: se descuenta de lo que vuelve.`
          : ` El envío del cambio es ${money(envio)}${diferencia > 0 ? "" : ": lo pagas en tu link"}.`
  const comoTxt = {
    recojo_mismo: ` ${elDia.charAt(0).toUpperCase()}${elDia.slice(1)}, de ${franja}, ${rep} te lleva ${v.sale ? `la ${v.sale.pid === l.pid ? talla(v.sale) : v.sale.nombre.toLowerCase()}` : "el nuevo"} y recoge ${v.sale?.pid === l.pid ? `la ${talla(l)}` : "la que vuelve"} en el mismo viaje.`,
    recojo_solo: ` ${rep} pasa a recogerla ${elDia}, de ${franja}.`,
    tienda: " Puedes traerla a la tienda de lunes a sábado, de 10 a. m. a 7 p. m.",
    agencia: ` Mándala por ${v.agencia?.nombre ?? "agencia"} a nombre de ${tienda} y pásame el número de envío.`,
  }[v.como]
  const plataTxt =
    diferencia > 0
      ? ` Cuesta ${money(diferencia)} más${envioPaga === "clienta" ? ` y el envío ${money(envio)}` : ""}: te mando tu link por ${money(diferencia + (envioPaga === "clienta" ? envio : 0))}.`
      : monto
        ? pol.dinero === "elige" && !v.quiere
          ? pol.primero === "saldo"
            ? ` Te puedo dejar ${money(monto)} a favor para tu próxima compra o, si prefieres, te los devolvemos por ${medioDe(v)}.`
            : ` Te devolvemos ${money(monto)} por ${medioDe(v)} o, si prefieres, te los dejo a favor para tu próxima compra.`
          : dinero === "saldo"
            ? ` Te quedan ${money(monto)} a favor para tu próxima compra${pol.saldoVence === "no" ? "" : `, por ${pol.saldoVence} meses`}.`
            : ` Te devolvemos ${money(monto)} por ${medioDe(v)} ${cuandoDinero === "falla_foto" ? "al aprobarlo" : cuandoDinero === "recoger" ? "al recogerla" : "cuando la recibamos y la revisemos"}.`
        : v.tipo === "cambio"
          ? " Cuesta lo mismo."
          : ""
  const stockTxt = v.sinStock
    ? ` No me queda ${v.sinStock}. Te puedo ofrecer, en este orden: ${ofrece(pol).join(", ")}.`
    : ""
  const cierre = pasa
    ? " Una persona del equipo lo confirma y te aviso por aquí."
    : " ¡Listo, ya quedó!"
  const plazoTxt = falla
    ? ` Está en garantía (${g.de.split(",")[0]}).`
    : ` Está dentro de los ${plazo} días.`
  const sofi = fuera
    ? `Te entiendo, ${n}. En ${tienda} ${
        fuera.startsWith("Pasó")
          ? `los ${v.tipo === "cambio" ? "cambios" : "devoluciones"} son hasta ${plazo} días después de la entrega, y ya pasaron ${v.dias}`
          : fuera.charAt(0).toLowerCase() + fuera.slice(1).replace("Tu tienda", "la tienda").replace("Devuelves", "devolvemos").replace("No devuelves", "no devolvemos")
      }. Si quieres, le paso tu caso a una persona del equipo para que lo vea.`
    : `${falla ? `Qué pena, ${n}. Gracias por la foto.` : `¡Claro, ${n}!`}${plazoTxt}${condTxt}${stockTxt}${plataTxt}${envioTxt}${comoTxt}${cierre}`
  return {
    dentro: !fuera,
    fuera,
    plazo,
    envioPaga,
    envio,
    diferencia,
    dinero,
    monto,
    cuandoDinero,
    tarjeta,
    sofi: sofi.replace(/\s+/g, " ").trim(),
  }
}

/** El chat del caso: lo que escribió, lo que dijo Sofi según la política y lo que siguió. */
function chatDe(p: Pedido, v: Vuelta): Msg[] {
  const out: Msg[] = [
    { de: "clienta", texto: v.dice, hora: v.hechos.solicitado?.cuando.split(" · ")[1] ?? "9:30 a. m." },
    { de: "sofi", texto: v.arm.sofi, hora: v.hechos.solicitado?.cuando.split(" · ")[1] ?? "9:31 a. m." },
  ]
  if (v.insiste && !v.arm.dentro)
    out.push(
      { de: "clienta", texto: "porfa, solo las usé una vez dentro de casa 🙏", hora: "10:02 a. m." },
      {
        de: "sofi",
        texto: `Te entiendo, ${nom(p)}. Le pasé tu caso a una persona del equipo, con todo lo que me contaste. Te escribo apenas lo vea.`,
        hora: "10:02 a. m.",
      },
    )
  return [...out, ...(v.extra ?? [])]
}

/** Vuelve a armar los casos que esperan aprobación con la política y la casilla de hoy. */
export function rearmar(r: RubroId) {
  const pol = politicaDe(r)
  for (const p of pedidosDe(r)) {
    if (p.vuelta?.estado !== "solicitado") continue
    const v = p.vuelta
    v.arm = armar(r, p, v, pol)
    v.chat = chatDe(p, v)
  }
}

/** Crea el caso con su armado inicial (lo usa la semilla). */
export function nuevaVuelta(r: RubroId, p: Pedido, v: Omit<Vuelta, "arm" | "chat">): Vuelta {
  const full = { ...v, arm: undefined as unknown as Armado, chat: [] } as Vuelta
  full.arm = armar(r, p, full, RECOMENDADA[r], true)
  full.chat = chatDe(p, full)
  return full
}

/* ---------- Lo que le toca a una persona ---------- */

export type AccionV = "aprobar_vuelta" | "excepcion" | "revisar" | "devolver"

export function vueltaToca(p: Pedido): { texto: string; boton: string; accion: AccionV } | undefined {
  const v = p.vuelta
  if (!v) return undefined
  const n = nom(p)
  if (v.estado === "solicitado") {
    if (!v.arm.dentro)
      return v.insiste ? { texto: v.arm.tarjeta, boton: "Decidir", accion: "excepcion" } : undefined
    return CASILLA ? { texto: v.arm.tarjeta, boton: "Aprobar", accion: "aprobar_vuelta" } : undefined
  }
  if (v.estado === "recibido")
    return {
      texto: `Revisa lo que volvió de ${n}: ${v.vuelven.map((l) => `${l.nombre} ${l.variante}`).join(", ")}. ${v.motivo === "falla" ? "Vino con falla: elige «Garantía» o «Dañado»." : "Si está bien, vuelve al stock."}`,
      boton: "Revisar",
      accion: "revisar",
    }
  const a = v.arm
  if (v.estado === "revisado" && a.dinero === "medio" && a.monto && !v.hechos.final)
    return v.medio === "link" || v.medio === "pos"
      ? {
          texto: `Aprueba devolverle ${money(a.monto)} a ${n}: la pasarela lo devuelve sola a su tarjeta.`,
          boton: "Aprobar la devolución",
          accion: "devolver",
        }
      : {
          texto: `Devuélvele ${money(a.monto)} a ${n} por ${MEDIOCORTO[v.medio]} desde tu app (al ${p.telefono}) y toca «Ya lo devolví».`,
          boton: "Ya lo devolví",
          accion: "devolver",
        }
  return undefined
}

/** Qué pasa ahora con la vuelta, en una frase, si no le toca a nadie. */
export function vueltaSigue(p: Pedido): string | undefined {
  const v = p.vuelta
  if (!v) return undefined
  const n = nom(p)
  const t = v.tipo === "cambio" ? "el cambio" : "la devolución"
  switch (v.estado) {
    case "solicitado":
      return v.arm.dentro
        ? `${n} pidió ${t}; Sofi lo hizo sola, dentro de tu política.`
        : `${n} pidió ${t}, fuera de tu política. Sofi se lo explicó; si insiste, pasa a «Te toca».`
    case "aprobado":
      return v.como === "tienda"
        ? `${t} está aprobado. Espera que ${n} lo traiga a la tienda.`
        : v.como === "agencia"
          ? `${t} está aprobado. Vuelve por ${v.agencia?.nombre}${v.agencia?.numero ? `, N.º ${v.agencia.numero}` : ""}: llega a la tienda y pasa a «Te toca» para revisarlo.`
          : `${t} está aprobado. ${v.repartidor ?? "Kevin"} lo recoge el ${(v.dia ?? "vie 28").toLowerCase()} y, al dejarlo en la tienda, pasa a «Te toca» para revisarlo.`
    case "rechazado":
      return `no se hizo ${t}: quedó fuera de tu política. Sofi se lo dijo a ${n}.`
    case "revisado":
    case "cerrado":
      return `${t} terminó.${v.arm.dinero === "saldo" && v.arm.monto ? ` ${n} tiene ${money(v.arm.monto)} a favor para su próxima compra.` : ""}`
    default:
      return undefined
  }
}

/* ---------- Lo que hace cada toque ---------- */

const ahora = "Hoy · ahora"
function evento(p: Pedido, actor: Actor, quien: string, texto: string, extra: Partial<Evento> = {}) {
  p.eventos.push({ id: nuevoId("e"), cuando: ahora, actor, quien, texto, ...extra })
}
function aviso(p: Pedido, texto: string) {
  p.avisos.push({ id: nuevoId("a"), cuando: ahora, clave: "cambio", estado: "enviado", texto })
}

/** El pedido de cambio, enlazado: sale lo nuevo y vuelve lo otro. El entregado no se toca. */
function crearCambio(r: RubroId, p: Pedido, v: Vuelta, quien: string): string {
  const a = v.arm
  const num = String(Math.max(...pedidosDe(r).map((x) => Number(x.id))) + 1).padStart(4, "0")
  const cobrar = Math.max(0, a.diferencia) + (a.envioPaga === "clienta" ? a.envio : 0)
  const sale = v.sale ?? { ...v.vuelven[0]!, id: nuevoId("l") }
  const n: Pedido = {
    ...structuredClone(p),
    id: num,
    creado: ahora,
    origen: { k: "sofi" },
    lineas: [{ ...sale, id: nuevoId("l") }, ...v.vuelven.map((l) => ({ ...l, id: nuevoId("l"), vuelve: true }))],
    entrega: {
      ...p.entrega,
      envio: a.envioPaga === "clienta" ? a.envio : 0,
      dia: v.dia ?? "Vie 28",
      franja: v.franja ?? "2 a 6 p. m.",
      repartidor: v.como === "agencia" ? null : (v.repartidor ?? p.entrega.repartidor ?? "Kevin"),
      tipo: v.como === "agencia" ? "agencia" : "moto",
    },
    cobro: "link",
    paso: cobrar ? "por_pagar" : "pagado",
    separadoHasta: cobrar ? "Vie 28 · 11:00 a. m." : undefined,
    pagos: [],
    eventos: [
      {
        id: nuevoId("e"),
        cuando: ahora,
        actor: "sofi",
        quien: "Sofi",
        texto: `Armó este cambio del ${p.id} según tu política: sale ${sale.nombre} ${sale.variante}, vuelve ${v.vuelven.map((l) => l.variante).join(", ")}. ${cobrar ? `Le mandó su link por ${money(cobrar)}.` : "No hay nada que cobrar."}${quien !== "Sofi" ? ` Lo aprobó ${quien}.` : ""}`,
        paso: "por_pagar",
        cita: v.dice,
      },
    ],
    avisos: [],
    chat: [],
    cambioDe: p.id,
    cambioEn: undefined,
    cambioPide: undefined,
    vuelta: undefined,
    toca: undefined,
    estrella: false,
  }
  if (!cobrar)
    n.eventos.push({
      id: nuevoId("e"),
      cuando: ahora,
      actor: "gestoria",
      quien: "gestorIA",
      texto:
        v.como === "recojo_mismo"
          ? `Separó ${sale.variante} y asignó a ${n.entrega.repartidor} (${n.entrega.zona}, ${n.entrega.franja}): lleva una y recoge la otra en el mismo viaje.`
          : `Separó ${sale.variante}. Sale cuando llegue lo que vuelve.`,
      paso: "pagado",
    })
  agregar(r, n)
  return num
}

/** Aprobar el caso que Sofi dejó listo (se confirma en el cajón), y desde ahí sigue solo. */
export function aprobar(r: RubroId, p: Pedido, quien: string, excepcion?: string) {
  const pol = politicaDe(r)
  let num: string | undefined
  const v0 = p.vuelta!
  if (v0.tipo === "cambio") num = crearCambio(r, p, { ...v0, arm: armar(r, p, v0, pol, false) }, quien)
  mover(
    r,
    p.id,
    (x) => {
      const v = x.vuelta!
      v.arm = armar(r, x, v, pol, false)
      if (excepcion) {
        v.arm = { ...v.arm, dentro: true }
        v.excepcion = excepcion
      }
      v.estado = "aprobado"
      v.hechos.aprobado = { quien, cuando: ahora, texto: excepcion ? "Excepción" : undefined }
      if (num) {
        v.enlazado = num
        x.cambioEn = num
      }
      const rep = v.repartidor ?? x.entrega.repartidor ?? "Kevin"
      const n = nom(x)
      if (quien === "Sofi")
        evento(x, "sofi", "Sofi", `Lo aprobó sola: está dentro de tu política y la casilla de Configuración › Sofi no lo pasa a una persona.`)
      if (v.como.startsWith("recojo"))
        evento(
          x,
          "gestoria",
          "gestorIA",
          `Asignó el recojo a ${rep} (${x.entrega.zona}, ${(v.dia ?? "vie 28").toLowerCase()}, ${v.franja ?? "2 a 6 p. m."})${v.como === "recojo_mismo" ? ": lleva el cambio y recoge en el mismo viaje" : ": un viaje solo para recoger"}. Le llegó la tarea «Recoger» a su app.`,
        )
      const txt = excepcion
        ? `Buenas noticias, ${n}: la tienda hizo una excepción con tu ${v.tipo === "cambio" ? "cambio" : "devolución"}. ${v.arm.sofi.replace(/^.*?!\s*/, "").replace(/Una persona del equipo.*$|¡Listo, ya quedó!/, "")}`
        : `Listo, ${n}: tu ${v.tipo === "cambio" ? "cambio" : "devolución"} está ${quien === "Sofi" ? "confirmad" : "aprobad"}${v.tipo === "cambio" ? "o" : "a"}.${v.como === "recojo_mismo" ? ` El ${(v.dia ?? "vie 28").toLowerCase()} de ${v.franja ?? "2 a 6 p. m."} ${rep} te lleva lo nuevo y recoge lo otro.` : v.como === "recojo_solo" ? ` ${rep} pasa a recogerla el ${(v.dia ?? "vie 28").toLowerCase()} de ${v.franja ?? "2 a 6 p. m."}.` : v.como === "tienda" ? " Te espero en la tienda, de lunes a sábado de 10 a. m. a 7 p. m." : ` Mándala por ${v.agencia?.nombre} y pásame el número.`}${v.arm.diferencia > 0 ? " Te mandé tu link por la diferencia." : ""}`
      aviso(x, txt.replace(/\s+/g, " ").trim())
    },
    {
      actor: quien === "Sofi" ? "sofi" : "persona",
      quien,
      texto: excepcion
        ? `Aprobó una excepción a la política: «${excepcion}». Sofi se lo dijo a ${nom(p)}.`
        : quien === "Sofi"
          ? `Aprobó ${v0.tipo === "cambio" ? "el cambio" : "la devolución"}${num ? `: pedido ${num}, enlazado` : ""}.`
          : `Aprobó ${v0.tipo === "cambio" ? "el cambio" : "la devolución"} que dejó listo Sofi${num ? `: pedido ${num}, enlazado` : ""}.`,
    },
  )
}

/** Fuera de la política: la persona la rechaza y Sofi se lo dice con amabilidad. */
export function rechazar(r: RubroId, p: Pedido, quien: string, motivo: string) {
  mover(
    r,
    p.id,
    (x) => {
      const v = x.vuelta!
      v.estado = "rechazado"
      v.hechos.aprobado = { quien, cuando: ahora, texto: "No se hizo" }
      aviso(
        x,
        `${nom(x)}, lo revisó una persona del equipo y esta vez no podemos hacer ${v.tipo === "cambio" ? "el cambio" : "la devolución"}: ${v.arm.fuera?.toLowerCase()}. Gracias por entenderlo; aquí sigo para lo que necesites.`,
      )
    },
    { actor: "persona", quien, texto: `No hizo la excepción: «${motivo}». Sofi se lo dijo a ${nom(p)}.` },
  )
}

/** El repartidor recogió: deja la foto de cómo estaba y lo lleva a la tienda. */
export function recogido(r: RubroId, p: Pedido, quien: string, estado: string) {
  mover(
    r,
    p.id,
    (x) => {
      const v = x.vuelta!
      v.estado = "recibido"
      v.hechos.vuelve = { quien, cuando: ahora, texto: "Recogido" }
      aviso(x, `${quien} ya recogió ${v.vuelven.length > 1 ? "lo que vuelve" : "tu producto"}, ${nom(x)}. Te aviso apenas lo revisemos.`)
    },
    {
      actor: "repartidor",
      quien,
      texto: `Tocó «Recogí» con la foto de cómo estaba: «${estado}». Lo deja en la tienda al cerrar su ruta.`,
      adjunto: "recojo",
    },
  )
}

/** Llegó a la tienda (la trajo ella o por agencia). */
export function llego(r: RubroId, p: Pedido) {
  const v = p.vuelta!
  mover(
    r,
    p.id,
    (x) => {
      x.vuelta!.estado = "recibido"
      x.vuelta!.hechos.vuelve = {
        quien: v.como === "agencia" ? (v.agencia?.nombre ?? "La agencia") : nom(p),
        cuando: ahora,
        texto: v.como === "agencia" ? "Llegó por agencia" : "Lo trajo a la tienda",
      }
    },
    {
      actor: v.como === "agencia" ? "gestoria" : "clienta",
      quien: v.como === "agencia" ? "gestorIA" : nom(p),
      texto:
        v.como === "agencia"
          ? `Llegó por ${v.agencia?.nombre}, N.º ${v.agencia?.numero}. Pasa a «Te toca» para revisarlo.`
          : "Lo trajo a la tienda. Pasa a «Te toca» para revisarlo.",
    },
  )
}

export const REVISION = {
  vender: { label: "Se puede vender", kardex: "Entró al stock como «devolución» en el kardex." },
  danado: { label: "Dañado", kardex: "No vuelve al stock: salió como «dañado» en el kardex." },
  garantia: {
    label: "Garantía con el proveedor",
    kardex: "No vuelve al stock: salió como «garantía con el proveedor» en el kardex.",
  },
} as const

/** Revisar lo que volvió: decide si vuelve al stock. Lo que sigue (saldo, dinero) va solo. */
export function revisar(r: RubroId, p: Pedido, quien: string, k: keyof typeof REVISION, motivo: string) {
  mover(
    r,
    p.id,
    (x) => {
      const v = x.vuelta!
      v.revision = { k, motivo }
      v.estado = "revisado"
      v.hechos.revisado = { quien, cuando: ahora, texto: REVISION[k].label }
      const n = nom(x)
      const a = v.arm
      if (a.monto && a.dinero === "saldo") {
        v.hechos.final = { quien: "gestorIA", cuando: ahora, texto: "Saldo a favor" }
        v.estado = "cerrado"
        evento(x, "gestoria", "gestorIA", `Dejó ${money(a.monto)} a favor de ${n}: es suyo y se usa solo en su próxima compra. Sale en su ficha y en Caja.`)
        aviso(x, `${n}, ya revisamos lo que volvió. Tienes ${money(a.monto)} a favor: se descuenta solo en tu próxima compra.`)
      } else if (a.monto && a.dinero === "medio") {
        aviso(x, `${n}, ya revisamos lo que volvió. Estamos devolviéndote ${money(a.monto)} por ${medioDe(v)}; te aviso apenas salga.`)
      } else {
        v.estado = "cerrado"
        aviso(x, `${n}, ya revisamos lo que volvió. ¡Todo listo! Gracias por avisarnos.`)
      }
    },
    {
      actor: "persona",
      quien,
      texto: `Revisó lo que volvió: «${REVISION[k].label}»${motivo ? ` (${motivo})` : ""}. ${REVISION[k].kardex}`,
    },
  )
}

/** Devolver el dinero: con la pasarela, al aprobarlo; con Yape o Plin, la persona lo hace en su app. */
export function devolver(r: RubroId, p: Pedido, quien: string) {
  const v = p.vuelta!
  const pasarela = v.medio === "link" || v.medio === "pos"
  mover(
    r,
    p.id,
    (x) => {
      const w = x.vuelta!
      w.estado = "cerrado"
      w.hechos.final = { quien: pasarela ? "La pasarela" : quien, cuando: ahora, texto: "Dinero devuelto" }
      if (pasarela)
        evento(x, "pasarela", "La pasarela", `Devolvió ${money(w.arm.monto)} a la tarjeta de ${nom(x)}. Reportes deja de contarlo como vendido.`)
      aviso(x, `${nom(x)}, te devolvimos ${money(w.arm.monto)} por ${medioDe(w)}.${pasarela ? " En tu tarjeta puede tardar unos días en verse." : ""} ¡Gracias por tu paciencia!`)
    },
    {
      actor: "persona",
      quien,
      texto: pasarela
        ? `Aprobó devolver ${money(v.arm.monto)} por la pasarela.`
        : `Devolvió ${money(v.arm.monto)} por ${MEDIOCORTO[v.medio]} desde su app y tocó «Ya lo devolví». Reportes deja de contarlo como vendido.`,
    },
  )
}

/** Los pasos de la vuelta, con quién lo hizo y cuándo, o quién lo mueve y cuándo. */
export function pasosVuelta(p: Pedido, enlazado?: Pedido) {
  const v = p.vuelta!
  const n = nom(p)
  const rep = v.repartidor ?? p.entrega.repartidor ?? "Kevin"
  const salio =
    enlazado && ["en_camino", "entregado"].includes(enlazado.paso)
      ? [...enlazado.eventos].reverse().find((e) => e.paso === "en_camino" || e.paso === "entregado")
      : undefined
  const final =
    v.tipo === "cambio" && !v.arm.monto
      ? "Cambio enviado"
      : v.arm.dinero === "saldo"
        ? "Saldo a favor"
        : v.arm.monto
          ? "Dinero devuelto"
          : "Cerrado"
  const vuelveL =
    v.como === "agencia" ? "En camino de vuelta" : v.como === "tienda" ? "Lo trae a la tienda" : "Por recoger"
  const pasa = v.arm.dentro ? (CASILLA ? "Una persona · lo aprueba" : "Sofi, sola") : "Una persona · excepción"
  return [
    { k: "solicitado" as const, l: "Solicitado", h: v.hechos.solicitado, falta: { quien: n, cuando: "" } },
    {
      k: "aprobado" as const,
      l: v.estado === "rechazado" ? "No se hizo" : "Aprobado",
      h: v.hechos.aprobado,
      falta: { quien: pasa, cuando: "" },
    },
    {
      k: "vuelve" as const,
      l: v.hechos.vuelve?.texto ?? vuelveL,
      h: v.hechos.vuelve,
      falta:
        v.como === "agencia"
          ? { quien: v.agencia?.nombre ?? "Agencia", cuando: v.agencia?.numero ? `N.º ${v.agencia.numero}` : "Espera el número" }
          : v.como === "tienda"
            ? { quien: n, cuando: "Lun a sáb, 10 a 7" }
            : { quien: rep, cuando: `${v.dia ?? "Vie 28"} · ${v.franja ?? "2 a 6 p. m."}` },
    },
    {
      k: "revisado" as const,
      l: "Recibido y revisado",
      h: v.hechos.revisado,
      falta: { quien: "Una persona", cuando: "Al llegar" },
    },
    {
      k: "final" as const,
      l: final,
      h: v.hechos.final ?? (salio ? { quien: salio.quien, cuando: salio.cuando } : undefined),
      falta:
        final === "Cambio enviado"
          ? { quien: rep, cuando: v.como === "recojo_mismo" ? "En el mismo viaje" : "Al llegar lo que vuelve" }
          : final === "Saldo a favor"
            ? { quien: "gestorIA", cuando: "Al revisar" }
            : {
                quien: v.medio === "link" || v.medio === "pos" ? "La pasarela" : "Una persona",
                cuando: v.arm.cuandoDinero === "falla_foto" ? "Al aprobar" : v.arm.cuandoDinero === "recoger" ? "Al recoger" : "Después de revisar",
              },
    },
  ]
}

/** La política en pocas líneas: la que cita Sofi y ve la clienta en su link y en la vitrina. */
export function lineasPolitica(r: RubroId, pol: Politica): string[] {
  const cond = [pol.sinUso ? "sin uso" : null, pol.etiqueta ? "con etiqueta" : null, pol.caja ? "con su caja" : null].filter(Boolean)
  return [
    pol.cambios ? `Cambios hasta ${pol.plazoCambio} días después de la entrega${cond.length ? `, ${cond.join(" y ")}` : ""}.` : "No hacemos cambios, salvo por falla.",
    pol.devoluciones === "si"
      ? `Devoluciones de dinero hasta ${pol.plazoDevolucion} días: ${DINERO[pol.dinero].toLowerCase()}.`
      : pol.devoluciones === "falla"
        ? "Devolvemos el dinero solo si vino con falla."
        : "No devolvemos dinero, salvo por falla.",
    `Si vino con falla, la garantía es de ${pol.garantia} días (o la de la ficha del producto) y el envío lo pone la tienda.`,
    [...pol.noCambia.map((x) => NO_CAMBIA[x]), pol.oferta === "no" ? "Lo de oferta" : null].filter(Boolean).length
      ? `No se cambia: ${[...pol.noCambia.map((x) => NO_CAMBIA[x].toLowerCase()), pol.oferta === "no" ? "lo de oferta" : null].filter(Boolean).join(", ")}.${pol.oferta === "solo_cambio" ? " Lo de oferta solo se cambia." : ""}`
      : pol.oferta === "solo_cambio"
        ? "Lo de oferta o liquidación solo se cambia."
        : "",
    `El envío de vuelta: ${ENVIO[pol.envio].toLowerCase()}${pol.envio !== "tienda" && Number(pol.cambiosGratis) ? `; tu primer cambio va sin costo` : ""}.`,
    `Vuelve ${[pol.recojo ? "con nuestro repartidor en Lima" : null, pol.tienda ? "en la tienda" : null, pol.agencia ? "por agencia desde provincia" : null].filter(Boolean).join(", ")}.`,
  ].filter(Boolean)
}

/** El saldo a favor de una clienta: lo que quedó de sus cambios y devoluciones. */
export function saldoAFavor(list: Pedido[], clienta: string): number {
  return list
    .filter((p) => p.clienta === clienta && p.vuelta?.arm.dinero === "saldo" && p.vuelta.hechos.final)
    .reduce((a, p) => a + p.vuelta!.arm.monto, 0)
}
