import { useSyncExternalStore } from "react"
import { type Producto, RUBROS, type RubroId } from "../datos"
import { type AccionV, nuevaVuelta, reiniciarVueltas, type Vuelta, vueltaToca } from "./vuelta"

/**
 * Los pedidos del prototipo, en memoria: una tienda de ejemplo por rubro, con los casos del lienzo
 * «Pedidos». Lo que toca la tienda, la clienta o el repartidor cambia el mismo pedido, como en la
 * app: un solo carrito, un solo link y un solo saldo. Todo es de ejemplo; nada se envía ni se cobra.
 */

export type Paso =
  | "por_pagar"
  | "por_confirmar"
  | "pagado"
  | "preparando"
  | "por_salir"
  | "en_camino"
  | "entregado"
  | "anulado"

/** El camino normal, en orden. Las salidas (no se entregó, anulado, cambio) van aparte. */
export const CAMINO: Paso[] = [
  "por_pagar",
  "por_confirmar",
  "pagado",
  "preparando",
  "por_salir",
  "en_camino",
  "entregado",
]

export const PASO: Record<
  Paso,
  {
    label: string
    corto: string
    tono: "warning" | "soft" | "success" | "secondary" | "outline" | "destructive"
  }
> = {
  por_pagar: { label: "Por pagar", corto: "Por pagar", tono: "secondary" },
  por_confirmar: { label: "Pago por confirmar", corto: "Por confirmar", tono: "warning" },
  pagado: { label: "Pagado", corto: "Pagado", tono: "success" },
  preparando: { label: "Preparando", corto: "Preparando", tono: "soft" },
  por_salir: { label: "Por salir", corto: "Por salir", tono: "soft" },
  en_camino: { label: "En camino", corto: "En camino", tono: "soft" },
  entregado: { label: "Entregado", corto: "Entregado", tono: "success" },
  anulado: { label: "Anulado", corto: "Anulado", tono: "outline" },
}

export type Canal = "whatsapp" | "instagram" | "messenger" | "catalogo"
export const CANAL: Record<Canal, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  catalogo: "Catálogo",
}

export type Origen =
  | { k: "sofi" }
  | { k: "catalogo" }
  | { k: "equipo"; quien: string }
  | { k: "campana"; nombre: string; motivo: string }

export const ORIGEN_LABEL = {
  sofi: "Sofi",
  catalogo: "Catálogo",
  equipo: "Equipo",
  campana: "Campaña",
} as const

/** Quién hizo cada paso: siempre con su nombre. */
export type Actor =
  | "sofi"
  | "pasarela"
  | "repartidor"
  | "persona"
  | "argos"
  | "clienta"
  | "gestoria"

export interface Evento {
  id: string
  cuando: string
  actor: Actor
  quien: string
  texto: string
  /** Un paso del camino que este evento completa. */
  paso?: Paso
  /** El trozo del chat que importa, tal como lo escribió la clienta. */
  cita?: string
  /** Una foto que acompaña al paso: la captura del Yape o el voucher del POS. */
  adjunto?: "captura" | "voucher" | "recojo" | "falla"
}

export type Medio = "link" | "yape" | "plin" | "efectivo" | "pos"
export const MEDIO: Record<Medio, string> = {
  link: "Link de pago",
  yape: "Yape",
  plin: "Plin",
  efectivo: "Efectivo",
  pos: "Tarjeta (POS)",
}
/** Quién confirma cada medio (tablero 24 del lienzo principal). */
export const CONFIRMA: Record<Medio, string> = {
  link: "La pasarela, sola",
  efectivo: "El repartidor, al recibirlo",
  pos: "El repartidor, con la foto del voucher",
  yape: "Una persona, con la captura",
  plin: "Una persona, con la captura",
}

export interface Pago {
  id: string
  medio: Medio
  monto: number
  estado: "confirmado" | "por_confirmar" | "no_coincide" | "deshecho"
  cuando: string
  /** Quién lo confirmó: «la pasarela», «Kevin», «Lucía». */
  quien?: string
  /** Lo que se lee en la captura o el voucher. */
  captura?: { monto: number; nombre: string; hora: string; numero?: string }
  motivo?: string
}

export interface Linea {
  id: string
  pid: string
  nombre: string
  variante: string
  qty: number
  precio: number
  foto: string
  /** Lo que vuelve en un cambio: resta del total. */
  vuelve?: boolean
}

export interface Entrega {
  tipo: "moto" | "agencia" | "recojo"
  zona: string
  envio: number
  dia: string | null
  franja: string | null
  repartidor: string | null
  agencia?: string
  numero?: string
  direccion: string
}

export interface Aviso {
  id: string
  cuando: string
  texto: string
  /** El aviso no sale: espera a que alguien lo mande. Nunca se dice «enviado» si no salió. */
  estado: "enviado" | "por_enviar"
  clave: "pagado" | "salio" | "entregado" | "falla" | "link" | "cambio"
}

export interface Msg {
  de: "clienta" | "sofi" | "sistema"
  texto: string
  hora: string
}

export interface Pedido {
  id: string
  clienta: string
  telefono: string
  canal: Canal
  origen: Origen
  paso: Paso
  creado: string
  lineas: Linea[]
  entrega: Entrega
  cobro: "link" | "captura" | "al_recibir"
  pagos: Pago[]
  eventos: Evento[]
  avisos: Aviso[]
  chat: Msg[]
  /** Hasta cuándo está separado el producto (y vence el link). */
  separadoHasta?: string
  /** Lo que se cedió en la venta (lo negoció Sofi, sin bajar del mínimo). */
  cedido?: string
  /** Pedido de cambio enlazado, o el original de un cambio. */
  cambioDe?: string
  cambioEn?: string
  /** Lo que pasó en la última salida, si no se entregó. */
  noEntregado?: string
  /** Al recibir en efectivo: con cuánto dijo que paga (Sofi se lo pregunta). El repartidor lleva el vuelto. */
  pagaCon?: number
  /** Pidió pagar al recibir y la política de cobros no lo acepta: la regla que le explicó Sofi. */
  reglaCobro?: string
  /** No quiso recibirlo o no pagó en la puerta: el producto vuelve a la tienda. */
  rechazo?: { motivo: string; quien: string; cuando: string; dijo?: string; enTienda?: boolean }
  /**
   * Cargos que se suman al saldo, como el viaje que no se entregó cuando lo paga la clienta.
   * Propuesto: hoy el saldo del pedido no tiene cargos (tablero «Para programar»).
   */
  cargos?: { id: string; concepto: string; monto: number; propuesto: boolean }[]
  /** Lo que pidió para cambiar, si cuesta distinto o no hay stock: lo decide una persona. */
  cambioPide?: Linea
  /** El pedido de cambio o devolución de este pedido entregado, con sus propios pasos. */
  vuelta?: Vuelta
  /** Lo que espera a una persona, con su único botón. */
  toca?: { texto: string; boton: string; accion: Accion; urgente?: boolean }
  /** Lo generó gestorIA sola: cuenta para el 1 %. */
  unoPorCiento: boolean
  /** Fue mostrado en la historia de Valeria (el pedido de la portada). */
  estrella?: boolean
}

export type Accion =
  | "confirmar"
  | "pasar"
  | "cambiar"
  | "no_entregado"
  | "cambio"
  | "asignar"
  /** Anotar el número de envío de la agencia (va por Olva, Shalom…). */
  | "numero"
  | "link"
  | "anular"
  | "cobrar"
  | "empacar"
  | AccionV

/* ---------- Cuentas: un solo saldo ---------- */

export function cuentas(p: Pedido) {
  const productos = p.lineas.reduce((a, l) => a + (l.vuelve ? -1 : 1) * l.precio * l.qty, 0)
  const cargos = (p.cargos ?? []).reduce((a, c) => a + c.monto, 0)
  const total = productos + p.entrega.envio + cargos
  const confirmado = p.pagos
    .filter((x) => x.estado === "confirmado")
    .reduce((a, x) => a + x.monto, 0)
  const porConfirmar = p.pagos
    .filter((x) => x.estado === "por_confirmar")
    .reduce((a, x) => a + x.monto, 0)
  const falta = Math.max(0, total - confirmado - porConfirmar)
  return {
    productos,
    cargos,
    total,
    confirmado,
    porConfirmar,
    falta,
    pagado: total - confirmado <= 0 && porConfirmar === 0,
    alRecibir: p.cobro === "al_recibir",
  }
}

/* ---------- Los pedidos de ejemplo ---------- */

let uid = 0
const id = (p: string) => `${p}${++uid}`

const CLIENTAS = {
  valeria: "Valeria Ríos",
  carla: "Carla Mendoza",
  diana: "Diana Flores",
  jorge: "Jorge Salas",
  andrea: "Andrea Castillo",
  milagros: "Milagros Huamán",
  fiorella: "Fiorella Quispe",
  martin: "Martín Paredes",
  rocio: "Rocío Paz",
  carmen: "Carmen Rojas",
  mariela: "Mariela Ríos",
  lucero: "Lucero Torres",
  patricia: "Patricia Vega",
}

function fotoDe(p: Producto, color?: string) {
  const m =
    p.media.find((x) => x.kind === "foto" && (!color || x.color === color)) ??
    p.media.find((x) => x.kind === "foto") ??
    p.media[0]
  return m ? (m.kind === "video" ? (m.poster ?? "") : m.src) : ""
}

function linea(p: Producto | undefined, ci = 0, si = 2, qty = 1, precio?: number): Linea {
  if (!p)
    return {
      id: id("l"),
      pid: "",
      nombre: "Producto",
      variante: "",
      qty,
      precio: precio ?? 99,
      foto: "",
    }
  const c = p.colors[ci % Math.max(1, p.colors.length)]
  const s = p.sizes.length ? p.sizes[Math.min(si, p.sizes.length - 1)] : undefined
  const variante = [c?.name, s ? (p.sizes.length > 1 ? s : s) : null].filter(Boolean).join(" · ")
  return {
    id: id("l"),
    pid: p.id,
    nombre: p.name,
    variante,
    qty,
    precio: precio ?? p.list,
    foto: fotoDe(p, c?.id),
  }
}

const ev = (
  cuando: string,
  actor: Actor,
  quien: string,
  texto: string,
  paso?: Paso,
  extra: Pick<Evento, "cita" | "adjunto"> = {},
): Evento => ({
  ...extra,
  id: id("e"),
  cuando,
  actor,
  quien,
  texto,
  paso,
})
const av = (
  cuando: string,
  clave: Aviso["clave"],
  texto: string,
  estado: Aviso["estado"] = "enviado",
): Aviso => ({
  id: id("a"),
  cuando,
  clave,
  texto,
  estado,
})

function seed(rubro: RubroId): Pedido[] {
  const R = RUBROS[rubro]
  const P = R.products()
  const pr = (i: number) => P[i % P.length]
  const art = R.store.name
  const corto = (n: string) => n.split(" ")[0]
  const v = linea(pr(0), 0, 3)
  const nombreV = `${v.nombre.toLowerCase()} ${v.variante}`

  const valeria: Pedido = {
    id: "0165",
    estrella: true,
    clienta: CLIENTAS.valeria,
    telefono: "987 *** 214",
    canal: "whatsapp",
    origen: { k: "sofi" },
    paso: "por_pagar",
    creado: "Mié 26 · 11:04 p. m.",
    lineas: [v],
    entrega: {
      tipo: "moto",
      zona: "Surco",
      envio: 10,
      dia: "Vie 28",
      franja: "9 a 1 p. m.",
      repartidor: null,
      direccion: "Av. Caminos del Inca 1450, Surco",
    },
    cobro: "link",
    pagos: [],
    separadoHasta: "Jue 27 · 11:04 p. m.",
    cedido: "Sofi cedió el envío a mitad (S/ 5): queda sobre el mínimo.",
    eventos: [
      ev("Mié 26 · 10:58 p. m.", "clienta", "Valeria", `Preguntó por WhatsApp por la ${nombreV}.`),
      ev(
        "Mié 26 · 11:02 p. m.",
        "sofi",
        "Sofi",
        "Le mostró las fotos, cómo calza y que llega el viernes. Ofreció una sola vez: envío a S/ 10 si paga hoy.",
      ),
      ev(
        "Mié 26 · 11:04 p. m.",
        "sofi",
        "Sofi",
        "Armó el pedido, separó el producto 24 horas y le mandó su carrito con «Pagar ahora».",
        "por_pagar",
        { cita: "ya, la quiero" },
      ),
    ],
    avisos: [
      av(
        "Mié 26 · 11:04 p. m.",
        "link",
        `Aquí está tu carrito, Valeria: lo pagas ahí con Yape o tarjeta. Te lo separo hasta mañana 11 p. m. ${R.store.slug}.gestoria24.com/carrito/V8R2`,
      ),
    ],
    chat: [
      {
        de: "clienta",
        texto: `Hola, ¿tienes la ${v.nombre.toLowerCase()} en ${v.variante}?`,
        hora: "10:58 p. m.",
      },
      {
        de: "sofi",
        texto: `¡Hola Valeria! Sí, me queda en ${v.variante}. Es de lona, calza normal y va con todo. Llega el viernes a Surco.`,
        hora: "10:58 p. m.",
      },
      { de: "clienta", texto: "¿Y el envío cuánto es?", hora: "11:01 p. m." },
      {
        de: "sofi",
        texto:
          "El envío a Surco es S/ 15. Si la pagas hoy, te lo dejo en S/ 10. Vale hasta mañana a esta hora.",
        hora: "11:02 p. m.",
      },
      { de: "clienta", texto: "ya, la quiero", hora: "11:03 p. m." },
      {
        de: "sofi",
        texto:
          "¡Listo! Aquí está tu carrito, lo pagas ahí con Yape o tarjeta. Te la separo hasta mañana 11 p. m.",
        hora: "11:04 p. m.",
      },
    ],
    unoPorCiento: true,
  }

  const carla: Pedido = {
    id: "0164",
    clienta: CLIENTAS.carla,
    telefono: "912 *** 507",
    canal: "instagram",
    origen: { k: "sofi" },
    paso: "por_confirmar",
    creado: "Jue 27 · 8:40 a. m.",
    lineas: [linea(pr(3), 0, 3)],
    entrega: {
      tipo: "moto",
      zona: "Callao",
      envio: 12,
      dia: "Hoy",
      franja: "2 a 6 p. m.",
      repartidor: null,
      direccion: "Jr. Colón 230, Callao",
    },
    cobro: "captura",
    pagos: [
      {
        id: id("pg"),
        medio: "yape",
        monto: 0,
        estado: "por_confirmar",
        cuando: "Jue 27 · 9:12 a. m.",
        captura: { monto: 0, nombre: "Carla M.", hora: "9:11 a. m.", numero: "Operación 0482113" },
      },
    ],
    eventos: [
      ev(
        "Jue 27 · 8:40 a. m.",
        "sofi",
        "Sofi",
        "Armó el pedido por Instagram y le mandó su carrito.",
        "por_pagar",
      ),
      ev(
        "Jue 27 · 9:12 a. m.",
        "clienta",
        "Carla",
        "Mandó la captura de un Yape al número de la tienda.",
        "por_confirmar",
        { cita: "Ya te yapeé 👍", adjunto: "captura" },
      ),
      ev(
        "Jue 27 · 9:12 a. m.",
        "sofi",
        "Sofi",
        "Leyó la captura: dice menos que el pedido. Una persona confirma lo que llegó; después Sofi le cobra a Carla lo que falta con su link.",
      ),
    ],
    avisos: [],
    chat: [
      { de: "clienta", texto: "Ya te yapeé 👍", hora: "9:11 a. m." },
      {
        de: "sofi",
        texto: "¡Gracias Carla! La tienda revisa tu Yape y te aviso apenas quede confirmado.",
        hora: "9:12 a. m.",
      },
    ],
    unoPorCiento: true,
  }
  {
    const t = cuentas(carla).total
    carla.pagos[0]!.monto = t
    carla.pagos[0]!.captura!.monto = t - 27
    carla.toca = {
      texto: `Confirma el Yape de Carla: la captura dice ${money(t - 27)} y el pedido es ${money(t)}. Lo que falta lo cobra Sofi.`,
      boton: "Ver y confirmar",
      accion: "confirmar",
      urgente: false,
    }
  }

  const diana: Pedido = {
    id: "0149",
    clienta: CLIENTAS.diana,
    telefono: "945 *** 330",
    canal: "whatsapp",
    origen: { k: "sofi" },
    paso: "en_camino",
    creado: "Mié 26 · 10:05 a. m.",
    lineas: [linea(pr(1), 0, 1, 1, Math.max(pr(1)?.min ?? 0, (pr(1)?.list ?? 100) - 12))],
    entrega: {
      tipo: "moto",
      zona: "Surco",
      envio: 10,
      dia: "Hoy",
      franja: "9 a 1 p. m.",
      repartidor: "Kevin",
      direccion: "Calle Las Gaviotas 155, Surco",
    },
    cobro: "al_recibir",
    pagos: [
      {
        id: id("pg"),
        medio: "yape",
        monto: 80,
        estado: "confirmado",
        cuando: "Mié 26 · 10:18 a. m.",
        quien: "Lucía",
        captura: { monto: 80, nombre: "Diana F.", hora: "10:18 a. m." },
      },
    ],
    cedido: "Sofi bajó S/ 12 por pagar una parte adelantada; queda sobre el mínimo.",
    eventos: [
      ev(
        "Mié 26 · 10:05 a. m.",
        "sofi",
        "Sofi",
        "Armó el pedido: una parte por Yape y el resto al recibir.",
        "por_pagar",
      ),
      ev(
        "Mié 26 · 10:18 a. m.",
        "clienta",
        "Diana",
        "Mandó la captura de un Yape de S/ 80.",
        "por_confirmar",
        { adjunto: "captura" },
      ),
      ev(
        "Mié 26 · 10:20 a. m.",
        "persona",
        "Lucía",
        "Confirmó el Yape de S/ 80. El resto se cobra al entregar.",
        "pagado",
      ),
      ev(
        "Jue 27 · 8:00 a. m.",
        "gestoria",
        "gestorIA",
        "Llegó su día: pasó a Preparando y asignó a Kevin (Surco, 9 a 1 p. m.).",
        "preparando",
      ),
      ev(
        "Jue 27 · 8:35 a. m.",
        "persona",
        "Rosa",
        "Lo empacó y se lo dio a Kevin, de 9 a 1 p. m.",
        "por_salir",
      ),
      ev("Jue 27 · 9:10 a. m.", "repartidor", "Kevin", "Tocó «Salí» en su app.", "en_camino"),
    ],
    avisos: [
      av(
        "Mié 26 · 10:20 a. m.",
        "pagado",
        "¡Recibimos tus S/ 80, Diana! El resto lo pagas al recibir.",
      ),
      av(
        "Jue 27 · 9:10 a. m.",
        "salio",
        "Tu pedido salió: llega hoy entre 9 y 1 p. m. con Kevin. Ten listo lo que falta.",
      ),
    ],
    chat: [
      {
        de: "clienta",
        texto: "¿Puedo pagar la mitad ahora y la mitad cuando llegue?",
        hora: "10:04 a. m.",
      },
      {
        de: "sofi",
        texto: "¡Claro! Me yapeas S/ 80 ahora y el resto al recibir. Así te la separo.",
        hora: "10:05 a. m.",
      },
    ],
    unoPorCiento: true,
  }

  const jorge: Pedido = {
    id: "0160",
    clienta: CLIENTAS.jorge,
    telefono: "956 *** 118",
    canal: "messenger",
    origen: { k: "sofi" },
    paso: "por_salir",
    creado: "Mar 25 · 6:20 p. m.",
    lineas: [linea(pr(2), 0, 3)],
    entrega: {
      tipo: "moto",
      zona: "San Juan de Lurigancho",
      envio: 12,
      dia: "Hoy",
      franja: "2 a 6 p. m.",
      repartidor: "Kevin",
      direccion: "Jr. Los Pinos 145, SJL · puerta verde",
    },
    cobro: "al_recibir",
    pagos: [],
    noEntregado: "Ayer no estaba: nadie abrió.",
    eventos: [
      ev(
        "Mar 25 · 6:20 p. m.",
        "sofi",
        "Sofi",
        "Armó el pedido por Messenger. Paga al recibir.",
        "por_pagar",
      ),
      ev(
        "Mié 26 · 8:00 a. m.",
        "gestoria",
        "gestorIA",
        "Llegó su día: pasó a Preparando y asignó a Kevin (San Juan de Lurigancho, 2 a 6 p. m.).",
        "preparando",
      ),
      ev(
        "Mié 26 · 8:40 a. m.",
        "persona",
        "Rosa",
        "Se lo dio a Kevin, de 2 a 6 p. m.",
        "por_salir",
      ),
      ev("Mié 26 · 2:15 p. m.", "repartidor", "Kevin", "Tocó «Salí».", "en_camino"),
      ev(
        "Mié 26 · 4:50 p. m.",
        "repartidor",
        "Kevin",
        "«No estaba»: nadie abrió. Lo trajo de vuelta.",
      ),
      ev(
        "Mié 26 · 4:51 p. m.",
        "sofi",
        "Sofi",
        "Le escribió a Jorge para otro día. Jorge eligió hoy de 2 a 6 p. m.",
      ),
      ev(
        "Mié 26 · 5:30 p. m.",
        "sofi",
        "Sofi",
        "Lo pasó a hoy, 2 a 6 p. m., con Kevin.",
        "por_salir",
      ),
    ],
    avisos: [
      av("Mié 26 · 2:15 p. m.", "salio", "Tu pedido salió: llega hoy entre 2 y 6 p. m. con Kevin."),
      av(
        "Mié 26 · 4:51 p. m.",
        "falla",
        "No te encontramos en casa, Jorge. ¿Te lo llevamos mañana entre 2 y 6 p. m.?",
      ),
    ],
    chat: [
      {
        de: "sofi",
        texto: "No te encontramos en casa, Jorge. ¿Te lo llevamos mañana entre 2 y 6 p. m.?",
        hora: "4:51 p. m.",
      },
      { de: "clienta", texto: "sí porfa, mañana en la tarde", hora: "5:29 p. m." },
      { de: "sofi", texto: "¡Listo! Mañana entre 2 y 6 p. m. con Kevin.", hora: "5:30 p. m." },
    ],
    unoPorCiento: true,
  }

  const andreaLinea = linea(pr(3), 0, 2)
  const andreaNueva = linea(pr(3), 0, 3)
  const tallaDe = (l: Linea) => l.variante.split(" · ").at(-1) || l.variante || "otra"
  const andreaVieja = tallaDe(andreaLinea)
  const andreaTalla = tallaDe(andreaNueva)
  const andrea: Pedido = {
    id: "0147",
    clienta: CLIENTAS.andrea,
    telefono: "999 *** 640",
    canal: "whatsapp",
    origen: { k: "sofi" },
    paso: "entregado",
    creado: "Lun 24 · 1:31 p. m.",
    lineas: [andreaLinea],
    entrega: {
      tipo: "moto",
      zona: "San Isidro",
      envio: 12,
      dia: "Mar 25",
      franja: "2 a 6 p. m.",
      repartidor: "Kevin",
      direccion: "Av. Rivera Navarrete 501, of. 802",
    },
    cobro: "captura",
    pagos: [
      {
        id: id("pg"),
        medio: "plin",
        monto: andreaLinea.precio,
        estado: "confirmado",
        cuando: "Lun 24 · 1:40 p. m.",
        quien: "Lucía",
      },
      {
        id: id("pg"),
        medio: "efectivo",
        monto: 12,
        estado: "confirmado",
        cuando: "Mar 25 · 3:42 p. m.",
        quien: "Kevin",
      },
    ],
    eventos: [
      ev("Lun 24 · 1:31 p. m.", "sofi", "Sofi", "Armó el pedido.", "por_pagar"),
      ev("Lun 24 · 1:38 p. m.", "clienta", "Andrea", "Mandó la captura del Plin.", "por_confirmar"),
      ev("Lun 24 · 1:40 p. m.", "persona", "Lucía", "Confirmó el Plin.", "pagado"),
      ev(
        "Mar 25 · 8:00 a. m.",
        "gestoria",
        "gestorIA",
        "Pasó a Preparando y asignó a Kevin (San Isidro, 2 a 6 p. m.).",
        "preparando",
      ),
      ev("Mar 25 · 9:00 a. m.", "persona", "Rosa", "Lo empacó y se lo dio a Kevin.", "por_salir"),
      ev("Mar 25 · 2:10 p. m.", "repartidor", "Kevin", "Tocó «Salí».", "en_camino"),
      ev(
        "Mar 25 · 3:42 p. m.",
        "repartidor",
        "Kevin",
        "Cobró S/ 12 en efectivo y tocó «Entregado».",
        "entregado",
      ),
      ev(
        "Jue 27 · 9:40 a. m.",
        "clienta",
        "Andrea",
        "Escribió que le quedó chica y quiere una talla más.",
        undefined,
        { cita: "me quedó chica 😕 ¿la puedo cambiar por una talla más?" },
      ),
      ev(
        "Jue 27 · 9:41 a. m.",
        "sofi",
        "Sofi",
        `Revisó tu política (2 días de 7, primer cambio sin costo de envío) y el stock: hay la ${andreaTalla} y cuesta lo mismo. Armó el cambio y coordinó con Kevin el mismo viaje.`,
      ),
    ],
    avisos: [
      av("Lun 24 · 1:40 p. m.", "pagado", "¡Pago recibido, Andrea! Sale mañana."),
      av("Mar 25 · 2:10 p. m.", "salio", "Tu pedido salió: llega hoy entre 2 y 6 p. m. con Kevin."),
      av("Mar 25 · 3:42 p. m.", "entregado", "Kevin dejó tu pedido. ¿Te llegó bien?"),
    ],
    chat: [],
    unoPorCiento: true,
  }

  /** Un cambio que sí necesita a una persona: el modelo que pide cuesta más. */
  const patriciaLinea = linea(pr(1), 0, 2)
  const patricia: Pedido = {
    id: "0153",
    clienta: CLIENTAS.patricia,
    telefono: "955 *** 118",
    canal: "whatsapp",
    origen: { k: "sofi" },
    paso: "entregado",
    creado: "Sáb 22 · 4:12 p. m.",
    lineas: [patriciaLinea],
    entrega: {
      tipo: "moto",
      zona: "La Molina",
      envio: 12,
      dia: "Lun 24",
      franja: "9 a 1 p. m.",
      repartidor: "Jhon",
      direccion: "Calle Los Fresnos 315, La Molina",
    },
    cobro: "link",
    pagos: [],
    eventos: [
      ev("Sáb 22 · 4:12 p. m.", "sofi", "Sofi", "Armó el pedido y le mandó su carrito.", "por_pagar"),
      ev("Sáb 22 · 4:20 p. m.", "pasarela", "La pasarela", "Confirmó el pago con tarjeta.", "pagado"),
      ev(
        "Lun 24 · 8:00 a. m.",
        "gestoria",
        "gestorIA",
        "Pasó a Preparando y asignó a Jhon (La Molina, 9 a 1 p. m.).",
        "preparando",
      ),
      ev("Lun 24 · 8:50 a. m.", "persona", "Rosa", "Lo empacó y se lo dio a Jhon.", "por_salir"),
      ev("Lun 24 · 9:30 a. m.", "repartidor", "Jhon", "Tocó «Salí».", "en_camino"),
      ev("Lun 24 · 11:05 a. m.", "repartidor", "Jhon", "Tocó «Entregado».", "entregado"),
      ev(
        "Jue 27 · 10:15 a. m.",
        "clienta",
        "Patricia",
        "Escribió que quiere cambiarlas por otro modelo.",
        undefined,
        { cita: "¿las puedo cambiar por las otras que vi en tu catálogo?" },
      ),
      ev(
        "Jue 27 · 10:16 a. m.",
        "sofi",
        "Sofi",
        "Revisó tu política (3 días de 7) y el stock: el modelo que pide cuesta S/ 20 más. Armó el cambio con la diferencia por cobrar.",
      ),
    ],
    avisos: [
      av("Sáb 22 · 4:20 p. m.", "pagado", "¡Pago recibido, Patricia! Sale el lunes entre 9 y 1 p. m."),
      av("Lun 24 · 9:30 a. m.", "salio", "Tu pedido salió: llega hoy entre 9 y 1 p. m. con Jhon."),
      av("Lun 24 · 11:05 a. m.", "entregado", "Jhon dejó tu pedido. ¿Te llegó bien?"),
    ],
    chat: [],
    unoPorCiento: true,
  }
  patricia.pagos.push({
    id: id("pg"),
    medio: "link",
    monto: cuentas(patricia).total,
    estado: "confirmado",
    cuando: "Sáb 22 · 4:20 p. m.",
    quien: "la pasarela",
  })
  patricia.vuelta = nuevaVuelta(rubro, patricia, {
    id: "C-0153",
    tipo: "cambio",
    motivo: "otro_modelo",
    dice: "¿las puedo cambiar por las otras que vi en tu catálogo?",
    dias: 3,
    vuelven: [patriciaLinea],
    sale: linea(pr(2), 0, 2, 1, patriciaLinea.precio + 20),
    como: "recojo_mismo",
    medio: "link",
    repartidor: "Jhon",
    dia: "Vie 28",
    franja: "9 a 1 p. m.",
    estado: "solicitado",
    hechos: { solicitado: { quien: "Patricia", cuando: "Jue 27 · 10:15 a. m." } },
  })
  andrea.vuelta = nuevaVuelta(rubro, andrea, {
    id: "C-0147",
    tipo: "cambio",
    motivo: "chica",
    dice: "Hola, me quedó chica 😕 ¿la puedo cambiar por una talla más?",
    dias: 2,
    vuelven: [andreaLinea],
    sale: andreaNueva,
    como: "recojo_mismo",
    medio: "plin",
    repartidor: "Kevin",
    dia: "Vie 28",
    franja: "2 a 6 p. m.",
    estado: "solicitado",
    hechos: { solicitado: { quien: "Andrea", cuando: "Jue 27 · 9:38 a. m." } },
  })
  const vueltas = semillaVueltas(rubro, pr)

  const milagros: Pedido = {
    id: "0162",
    clienta: CLIENTAS.milagros,
    telefono: "934 *** 882",
    canal: "whatsapp",
    origen: {
      k: "campana",
      nombre: "Vuelven las sandalias",
      motivo: "Compró sandalias el verano pasado y no vuelve hace 9 meses.",
    },
    paso: "pagado",
    creado: "Jue 27 · 7:52 a. m.",
    lineas: [linea(pr(4), 0, 2)],
    entrega: {
      tipo: "moto",
      zona: "Miraflores",
      envio: 10,
      dia: "Vie 28",
      franja: null,
      repartidor: null,
      direccion: "Calle Berlín 320, Miraflores",
    },
    cobro: "link",
    pagos: [],
    eventos: [
      ev(
        "Mié 26 · 6:00 p. m.",
        "argos",
        "Argos",
        "Armó la campaña «Vuelven las sandalias» para 14 clientas que compraron sandalias y no vuelven hace meses. Se la encargó a Sofi.",
      ),
      ev("Jue 27 · 7:30 a. m.", "sofi", "Sofi", "Le escribió a Milagros con las sandalias nuevas."),
      ev(
        "Jue 27 · 7:52 a. m.",
        "sofi",
        "Sofi",
        "Armó el pedido y le mandó su carrito.",
        "por_pagar",
      ),
      ev(
        "Jue 27 · 8:06 a. m.",
        "pasarela",
        "La pasarela",
        "Confirmó el pago con tarjeta. Nadie tuvo que revisar nada.",
        "pagado",
      ),
      ev(
        "Jue 27 · 8:06 a. m.",
        "sofi",
        "Sofi",
        "Le avisó «¡Pago recibido!» y le ofreció sumar algo al mismo envío.",
      ),
    ],
    avisos: [
      av(
        "Jue 27 · 8:06 a. m.",
        "pagado",
        "¡Pago recibido, Milagros! Sale mañana. ¿Le sumas algo al mismo envío? Va gratis.",
      ),
    ],
    chat: [
      {
        de: "sofi",
        texto:
          "¡Hola Milagros! Llegaron las sandalias de verano. Te guardé tu talla de la vez pasada, ¿te muestro?",
        hora: "7:30 a. m.",
      },
      { de: "clienta", texto: "Siii muéstrame", hora: "7:41 a. m." },
    ],
    unoPorCiento: true,
  }
  milagros.pagos.push({
    id: id("pg"),
    medio: "link",
    monto: cuentas(milagros).total,
    estado: "confirmado",
    cuando: "Jue 27 · 8:06 a. m.",
    quien: "la pasarela",
  })

  const fiorella: Pedido = {
    id: "0161",
    clienta: CLIENTAS.fiorella,
    telefono: "921 *** 455",
    canal: "instagram",
    origen: { k: "equipo", quien: "Lucía" },
    paso: "preparando",
    creado: "Mié 26 · 7:15 p. m.",
    lineas: [linea(pr(5), 0, 2), linea(pr(6), 0, 2)],
    entrega: {
      tipo: "moto",
      zona: "Los Olivos",
      envio: 12,
      dia: "Hoy",
      franja: "2 a 6 p. m.",
      repartidor: null,
      direccion: "Av. Carlos Izaguirre 980, Los Olivos",
    },
    cobro: "al_recibir",
    pagos: [],
    eventos: [
      ev(
        "Mié 26 · 7:15 p. m.",
        "persona",
        "Lucía",
        "Anotó el pedido a mano: Fiorella lo pidió por Instagram desde el celular de la tienda. Paga al recibir.",
        "por_pagar",
      ),
      ev(
        "Jue 27 · 8:00 a. m.",
        "gestoria",
        "gestorIA",
        "Llegó su día: pasó a Preparando. Buscó repartidor para Los Olivos de 2 a 6 p. m.: Kevin y Jhon ya van llenos en esa franja. Lo dejó en «Te toca».",
        "preparando",
      ),
    ],
    avisos: [],
    chat: [],
    toca: {
      texto:
        "No hay repartidor libre para Los Olivos de 2 a 6 p. m.: Kevin y Jhon van llenos. Elige otra franja, otro día o que lo recoja.",
      boton: "Elegir cómo sale",
      accion: "asignar",
    },
    unoPorCiento: false,
  }

  const martin: Pedido = {
    id: "0144",
    clienta: CLIENTAS.martin,
    telefono: "977 *** 021",
    canal: "whatsapp",
    origen: { k: "sofi" },
    paso: "anulado",
    creado: "Mar 25 · 9:12 p. m.",
    lineas: [linea(pr(7), 0, 3)],
    entrega: {
      tipo: "moto",
      zona: "Surco",
      envio: 10,
      dia: null,
      franja: null,
      repartidor: null,
      direccion: "—",
    },
    cobro: "link",
    pagos: [],
    separadoHasta: "Mié 26 · 9:12 p. m.",
    eventos: [
      ev(
        "Mar 25 · 9:12 p. m.",
        "sofi",
        "Sofi",
        "Armó el pedido, separó el producto 24 horas y le mandó su carrito.",
        "por_pagar",
      ),
      ev(
        "Mié 26 · 10:00 a. m.",
        "sofi",
        "Sofi",
        "Le recordó una vez que el link vencía a las 9 p. m.",
      ),
      ev(
        "Mié 26 · 9:12 p. m.",
        "gestoria",
        "gestorIA",
        "Pasaron 24 horas sin pago: liberó el producto y anuló el pedido solo.",
        "anulado",
      ),
    ],
    avisos: [
      av(
        "Mar 25 · 9:12 p. m.",
        "link",
        "Aquí está tu carrito, Martín. Te lo separo hasta mañana 9 p. m.",
      ),
    ],
    chat: [],
    unoPorCiento: false,
  }

  const rocio: Pedido = {
    id: "0163",
    clienta: CLIENTAS.rocio,
    telefono: "988 *** 760",
    canal: "catalogo",
    origen: { k: "catalogo" },
    paso: "en_camino",
    creado: "Mié 26 · 9:30 p. m.",
    lineas: [linea(pr(0), 1, 3)],
    entrega: {
      tipo: "moto",
      zona: "Santa Anita",
      envio: 12,
      dia: "Hoy",
      franja: "9 a 1 p. m.",
      repartidor: "Kevin",
      direccion: "Av. Los Ruiseñores 312, Santa Anita",
    },
    cobro: "al_recibir",
    pagos: [],
    eventos: [
      ev(
        "Mié 26 · 9:30 p. m.",
        "clienta",
        "Rocío",
        "Armó su carrito en el catálogo y eligió pagar al recibir.",
        "por_pagar",
      ),
      ev(
        "Jue 27 · 8:00 a. m.",
        "gestoria",
        "gestorIA",
        "Pasó a Preparando y asignó a Kevin (Santa Anita, 9 a 1 p. m.).",
        "preparando",
      ),
      ev(
        "Jue 27 · 8:35 a. m.",
        "persona",
        "Rosa",
        "Se lo dio a Kevin, de 9 a 1 p. m.",
        "por_salir",
      ),
      ev("Jue 27 · 9:10 a. m.", "repartidor", "Kevin", "Tocó «Salí».", "en_camino"),
    ],
    avisos: [
      av(
        "Jue 27 · 9:10 a. m.",
        "salio",
        "Tu pedido salió: llega hoy entre 9 y 1 p. m. con Kevin. Lo pagas al recibir.",
      ),
    ],
    chat: [],
    unoPorCiento: true,
  }

  const carmen: Pedido = {
    id: "0166",
    clienta: CLIENTAS.carmen,
    telefono: "912 *** 678",
    canal: "catalogo",
    origen: { k: "catalogo" },
    paso: "preparando",
    creado: "Jue 27 · 7:02 a. m.",
    lineas: [linea(pr(0), 0, 3)],
    entrega: {
      tipo: "moto",
      zona: "Santa Anita",
      envio: 12,
      dia: "Hoy",
      franja: "2 a 6 p. m.",
      repartidor: "Kevin",
      direccion: "Calle Las Begonias 220, Santa Anita",
    },
    cobro: "link",
    pagos: [],
    eventos: [
      ev(
        "Jue 27 · 6:55 a. m.",
        "clienta",
        "Carmen",
        "Armó su carrito en el catálogo.",
        "por_pagar",
      ),
      ev(
        "Jue 27 · 7:02 a. m.",
        "pasarela",
        "La pasarela",
        "Confirmó el pago con Yape dentro del link.",
        "pagado",
      ),
      ev(
        "Jue 27 · 8:00 a. m.",
        "gestoria",
        "gestorIA",
        "Sale hoy: pasó a Preparando y asignó a Kevin (Santa Anita, 2 a 6 p. m.).",
        "preparando",
      ),
    ],
    avisos: [
      av("Jue 27 · 7:02 a. m.", "pagado", "¡Pago recibido, Carmen! Sale hoy entre 2 y 6 p. m."),
    ],
    chat: [],
    unoPorCiento: true,
  }
  carmen.pagos.push({
    id: id("pg"),
    medio: "link",
    monto: cuentas(carmen).total,
    estado: "confirmado",
    cuando: "Jue 27 · 7:02 a. m.",
    quien: "la pasarela",
  })

  const mariela: Pedido = {
    id: "0158",
    clienta: CLIENTAS.mariela,
    telefono: "959 *** 300",
    canal: "whatsapp",
    origen: { k: "sofi" },
    paso: "en_camino",
    creado: "Mar 25 · 4:10 p. m.",
    lineas: [linea(pr(2), 0, 2)],
    entrega: {
      tipo: "agencia",
      zona: "Arequipa, por agencia",
      envio: 18,
      dia: "Mié 26",
      franja: null,
      repartidor: null,
      agencia: "Shalom",
      numero: "77812",
      direccion: "Agencia Av. Ejército, Arequipa",
    },
    cobro: "captura",
    pagos: [],
    eventos: [
      ev(
        "Mar 25 · 4:10 p. m.",
        "sofi",
        "Sofi",
        "Armó el pedido para Arequipa, por agencia.",
        "por_pagar",
      ),
      ev(
        "Mar 25 · 4:22 p. m.",
        "clienta",
        "Mariela",
        "Mandó la captura del Yape.",
        "por_confirmar",
      ),
      ev("Mar 25 · 4:30 p. m.", "persona", "Lucía", "Confirmó el Yape.", "pagado"),
      ev("Mié 26 · 8:00 a. m.", "gestoria", "gestorIA", "Pasó a Preparando.", "preparando"),
      ev(
        "Mié 26 · 6:40 p. m.",
        "persona",
        "Lucía",
        "Lo dejó en Shalom con el número 77812.",
        "en_camino",
      ),
    ],
    avisos: [
      av("Mar 25 · 4:30 p. m.", "pagado", "¡Pago recibido, Mariela! Sale mañana por Shalom."),
      av(
        "Mié 26 · 6:40 p. m.",
        "salio",
        "Tu pedido va por Shalom a Arequipa. Número de envío: 77812. Lo recoges en la agencia de Av. Ejército.",
      ),
    ],
    chat: [],
    unoPorCiento: true,
  }
  mariela.pagos.push({
    id: id("pg"),
    medio: "yape",
    monto: cuentas(mariela).total,
    estado: "confirmado",
    cuando: "Mar 25 · 4:30 p. m.",
    quien: "Lucía",
  })

  const lucero: Pedido = {
    id: "0159",
    clienta: CLIENTAS.lucero,
    telefono: "944 *** 219",
    canal: "whatsapp",
    origen: {
      k: "campana",
      nombre: "Vuelven las sandalias",
      motivo: "Preguntó por sandalias en octubre y no compró.",
    },
    paso: "entregado",
    creado: "Mar 25 · 11:20 a. m.",
    lineas: [linea(pr(4), 0, 1)],
    entrega: {
      tipo: "moto",
      zona: "Miraflores",
      envio: 10,
      dia: "Mié 26",
      franja: "9 a 1 p. m.",
      repartidor: "Kevin",
      direccion: "Av. Larco 410, Miraflores",
    },
    cobro: "link",
    pagos: [],
    eventos: [
      ev("Mar 25 · 11:20 a. m.", "sofi", "Sofi", "Armó el pedido desde la campaña.", "por_pagar"),
      ev("Mar 25 · 11:31 a. m.", "pasarela", "La pasarela", "Confirmó el pago.", "pagado"),
      ev("Mié 26 · 10:55 a. m.", "repartidor", "Kevin", "Tocó «Entregado».", "entregado"),
      ev("Mié 26 · 11:20 a. m.", "clienta", "Lucero", "Respondió «sí, todo bien»."),
    ],
    avisos: [
      av("Mar 25 · 11:31 a. m.", "pagado", "¡Pago recibido, Lucero!"),
      av("Mié 26 · 9:30 a. m.", "salio", "Tu pedido salió: llega hoy entre 9 y 1 p. m. con Kevin."),
      av("Mié 26 · 10:55 a. m.", "entregado", "Kevin dejó tu pedido. ¿Te llegó bien?"),
    ],
    chat: [],
    unoPorCiento: true,
  }
  lucero.pagos.push({
    id: id("pg"),
    medio: "link",
    monto: cuentas(lucero).total,
    estado: "confirmado",
    cuando: "Mar 25 · 11:31 a. m.",
    quien: "la pasarela",
  })

  void art
  void corto
  return [
    valeria,
    carla,
    fiorella,
    carmen,
    milagros,
    rocio,
    diana,
    jorge,
    mariela,
    lucero,
    patricia,
    andrea,
    martin,
    ...vueltas,
  ]
}

/* ---------- Los cambios y las devoluciones de ejemplo ---------- */

/** Un pedido ya entregado, con su historia de siempre: así empieza cada caso de vuelta. */
function entregadoEl(o: {
  id: string
  clienta: string
  telefono: string
  lineas: Linea[]
  zona: string
  direccion: string
  creado: string
  dia: string
  medio: Medio
  repartidor?: string
  franja?: string
  agencia?: { nombre: string; numero: string }
}): Pedido {
  const n = o.clienta.split(" ")[0]!
  const rep = o.repartidor ?? "Kevin"
  const dia = o.creado.split(" · ")[0]!
  const envio = o.agencia ? 15 : 12
  const total = o.lineas.reduce((a, l) => a + l.precio * l.qty, 0) + envio
  const link = o.medio === "link"
  const eventos: Evento[] = [
    ev(o.creado, "sofi", "Sofi", "Armó el pedido y le mandó su carrito.", "por_pagar"),
  ]
  if (!link)
    eventos.push(
      ev(`${dia} · 1:15 p. m.`, "clienta", n, `Mandó la captura del ${MEDIO[o.medio]}.`, "por_confirmar"),
    )
  eventos.push(
    ev(
      `${dia} · 1:20 p. m.`,
      link ? "pasarela" : "persona",
      link ? "La pasarela" : "Lucía",
      link ? "Confirmó el pago con tarjeta." : `Confirmó el ${MEDIO[o.medio]}.`,
      "pagado",
    ),
    ev(
      `${o.dia} · 8:00 a. m.`,
      "gestoria",
      "gestorIA",
      o.agencia
        ? "Pasó a Preparando."
        : `Pasó a Preparando y asignó a ${rep} (${o.zona}, ${o.franja ?? "2 a 6 p. m."}).`,
      "preparando",
    ),
    ev(
      `${o.dia} · 9:00 a. m.`,
      "persona",
      "Rosa",
      o.agencia ? "Lo empacó." : `Lo empacó y se lo dio a ${rep}.`,
      "por_salir",
    ),
    ev(
      `${o.dia} · ${o.agencia ? "11:30 a. m." : "2:10 p. m."}`,
      o.agencia ? "persona" : "repartidor",
      o.agencia ? "Rosa" : rep,
      o.agencia ? `Lo dejó en ${o.agencia.nombre} y anotó el N.º ${o.agencia.numero}.` : "Tocó «Salí».",
      "en_camino",
    ),
    ev(
      `${o.dia} · 4:05 p. m.`,
      o.agencia ? "clienta" : "repartidor",
      o.agencia ? n : rep,
      o.agencia ? `Lo recogió en ${o.agencia.nombre}.` : "Tocó «Entregado».",
      "entregado",
    ),
  )
  return {
    id: o.id,
    clienta: o.clienta,
    telefono: o.telefono,
    canal: "whatsapp",
    origen: { k: "sofi" },
    paso: "entregado",
    creado: o.creado,
    lineas: o.lineas,
    entrega: {
      tipo: o.agencia ? "agencia" : "moto",
      zona: o.zona,
      envio,
      dia: o.dia,
      franja: o.agencia ? null : (o.franja ?? "2 a 6 p. m."),
      repartidor: o.agencia ? null : rep,
      agencia: o.agencia?.nombre,
      numero: o.agencia?.numero,
      direccion: o.direccion,
    },
    cobro: link ? "link" : "captura",
    pagos: [
      {
        id: id("pg"),
        medio: o.medio,
        monto: total,
        estado: "confirmado",
        cuando: `${dia} · 1:20 p. m.`,
        quien: link ? "la pasarela" : "Lucía",
      },
    ],
    eventos,
    avisos: [
      av(`${dia} · 1:20 p. m.`, "pagado", `¡Pago recibido, ${n}!`),
      av(
        `${o.dia} · 4:05 p. m.`,
        "entregado",
        `${o.agencia ? "Ya lo recogiste" : `${rep} dejó tu pedido`}. ¿Te llegó bien?`,
      ),
    ],
    chat: [],
    unoPorCiento: true,
  }
}

/** El momento en que la clienta pide y Sofi atiende según la política (lo mismo en cada caso). */
function pide(p: Pedido, cuando: string, cita: string, sofi: string) {
  p.eventos.push(
    ev(cuando, "clienta", p.clienta.split(" ")[0]!, "Escribió por WhatsApp.", undefined, { cita }),
    ev(cuando, "sofi", "Sofi", sofi),
  )
}

/**
 * Los casos del lienzo «¿Y cuando algo vuelve?», con la política recomendada del rubro. Andrea
 * (mismo precio) y Patricia (con diferencia) están en la semilla principal.
 */
function semillaVueltas(rubro: RubroId, pr: (i: number) => Producto): Pedido[] {
  const out: Pedido[] = []

  // Cuesta menos: queda a su favor o se le devuelve. Lo trae a la tienda.
  const sVieja = linea(pr(4), 0, 2)
  const sandra = entregadoEl({
    id: "0143",
    clienta: "Sandra Ortiz",
    telefono: "944 *** 310",
    lineas: [sVieja],
    zona: "Cercado de Lima",
    direccion: "Jr. Callao 410, Cercado",
    creado: "Sáb 22 · 12:40 p. m.",
    dia: "Lun 24",
    medio: "yape",
  })
  const sDice = "¿puedo cambiarlas por las de tu catálogo que están más baratas? paso por la tienda"
  pide(
    sandra,
    "Jue 27 · 11:20 a. m.",
    sDice,
    "Revisó tu política (3 días de 7) y el stock: el modelo que pide cuesta S/ 30 menos. Armó el cambio y ofreció la diferencia como dice tu política.",
  )
  sandra.vuelta = nuevaVuelta(rubro, sandra, {
    id: "C-0143",
    tipo: "cambio",
    motivo: "otro_modelo",
    dice: sDice,
    dias: 3,
    vuelven: [sVieja],
    sale: linea(pr(5), 0, 2, 1, Math.max(39, sVieja.precio - 30)),
    como: "tienda",
    medio: "yape",
    estado: "solicitado",
    hechos: { solicitado: { quien: "Sandra", cuando: "Jue 27 · 11:20 a. m." } },
  })
  out.push(sandra)

  // Falla: garantía. La clienta no paga nada; lo que vuelve no va al stock.
  const gVieja = linea(pr(6), 0, 1)
  const gabriela = entregadoEl({
    id: "0141",
    clienta: "Gabriela Núñez",
    telefono: "912 *** 507",
    lineas: [gVieja],
    zona: "Miraflores",
    direccion: "Calle Schell 220, dpto. 401",
    creado: "Mar 4 · 6:10 p. m.",
    dia: "Jue 6",
    medio: "link",
  })
  const gDice = "hola, se le despegó la suela 😢 te mando la foto"
  pide(
    gabriela,
    "Lun 24 · 10:05 a. m.",
    gDice,
    "Recibió la foto de la falla. Está en garantía: armó el cambio por el mismo, sin costo y con el recojo en el mismo viaje. Pasó el caso a Rosa, con todo el chat.",
  )
  gabriela.eventos.at(-2)!.adjunto = "falla"
  gabriela.vuelta = nuevaVuelta(rubro, gabriela, {
    id: "C-0141",
    tipo: "cambio",
    motivo: "falla",
    dice: gDice,
    dias: 18,
    vuelven: [gVieja],
    sale: { ...gVieja, id: id("l") },
    foto: true,
    como: "recojo_mismo",
    medio: "link",
    repartidor: "Kevin",
    dia: "Mié 26",
    franja: "2 a 6 p. m.",
    estado: "recibido",
    enlazado: "0154",
    hechos: {
      solicitado: { quien: "Gabriela", cuando: "Lun 24 · 10:05 a. m." },
      aprobado: { quien: "Rosa", cuando: "Lun 24 · 10:30 a. m." },
      vuelve: { quien: "Kevin", cuando: "Mié 26 · 3:40 p. m.", texto: "Recogido" },
    },
  })
  gabriela.cambioEn = "0154"
  gabriela.eventos.push(
    ev(
      "Lun 24 · 10:30 a. m.",
      "persona",
      "Rosa",
      "Aprobó el cambio por falla que dejó listo Sofi: pedido 0154, enlazado.",
    ),
    ev(
      "Lun 24 · 10:30 a. m.",
      "gestoria",
      "gestorIA",
      "Asignó a Kevin (Miraflores, mié 26, 2 a 6 p. m.): lleva el par nuevo y recoge el fallado en el mismo viaje.",
    ),
    ev(
      "Mié 26 · 3:40 p. m.",
      "repartidor",
      "Kevin",
      "Tocó «Recogí» con la foto de cómo estaba: «suela despegada en el talón». Lo dejó en la tienda al cerrar su ruta.",
      undefined,
      { adjunto: "recojo" },
    ),
  )
  gabriela.avisos.push(
    av(
      "Lun 24 · 10:30 a. m.",
      "cambio",
      "Listo, Gabriela: el miércoles de 2 a 6 p. m. Kevin te lleva un par nuevo y recoge el fallado. No pagas nada.",
    ),
    av("Mié 26 · 3:40 p. m.", "cambio", "Kevin ya recogió el par fallado y te dejó el nuevo. ¿Te quedó bien?"),
  )
  const gCambio: Pedido = {
    ...structuredClone(gabriela),
    id: "0154",
    creado: "Lun 24 · 10:30 a. m.",
    lineas: [
      { ...gVieja, id: id("l") },
      { ...gVieja, id: id("l"), vuelve: true },
    ],
    entrega: {
      ...gabriela.entrega,
      envio: 0,
      dia: "Mié 26",
      franja: "2 a 6 p. m.",
      repartidor: "Kevin",
    },
    paso: "entregado",
    pagos: [],
    cobro: "link",
    eventos: [
      ev(
        "Lun 24 · 10:30 a. m.",
        "sofi",
        "Sofi",
        "Armó este cambio por falla del 0141: sale un par nuevo igual, vuelve el fallado. Es garantía: no hay nada que cobrar y el envío lo pone la tienda.",
        "por_pagar",
        { cita: "se le despegó la suela 😢" },
      ),
      ev("Lun 24 · 10:30 a. m.", "gestoria", "gestorIA", "Separó el par y asignó a Kevin para el mié 26.", "pagado"),
      ev("Mié 26 · 8:00 a. m.", "gestoria", "gestorIA", "Pasó a Preparando.", "preparando"),
      ev("Mié 26 · 9:10 a. m.", "persona", "Rosa", "Lo empacó y se lo dio a Kevin.", "por_salir"),
      ev("Mié 26 · 2:05 p. m.", "repartidor", "Kevin", "Tocó «Salí».", "en_camino"),
      ev(
        "Mié 26 · 3:40 p. m.",
        "repartidor",
        "Kevin",
        "Entregó el par nuevo y recogió el fallado.",
        "entregado",
      ),
    ],
    avisos: [],
    chat: [],
    cambioDe: "0141",
    cambioEn: undefined,
    vuelta: undefined,
    unoPorCiento: false,
  }
  out.push(gabriela, gCambio)

  // No hay stock: Sofi ofreció otra talla o color, saldo a favor o devolución. Eligió el saldo.
  const kVieja = linea(pr(0), 1, 4)
  const kiara = entregadoEl({
    id: "0145",
    clienta: "Kiara Soto",
    telefono: "976 *** 044",
    lineas: [kVieja],
    zona: "San Juan de Lurigancho",
    direccion: "Av. Próceres 1880, SJL",
    creado: "Dom 23 · 7:30 p. m.",
    dia: "Mar 25",
    medio: "yape",
  })
  const kDice = "me quedó grande, ¿tienes una talla menos?"
  pide(
    kiara,
    "Mié 26 · 6:15 p. m.",
    kDice,
    "No hay la talla menos en ese color. Le ofreció, en el orden de tu política: otro color en su talla, saldo a favor o la devolución. Kiara eligió el saldo a favor.",
  )
  kiara.vuelta = nuevaVuelta(rubro, kiara, {
    id: "D-0145",
    tipo: "devolucion",
    motivo: "grande",
    dice: kDice,
    dias: 1,
    vuelven: [kVieja],
    sinStock: `la talla menos en ${kVieja.variante.split(" · ")[0]?.toLowerCase() || "ese color"}`,
    como: "recojo_solo",
    medio: "yape",
    quiere: "saldo",
    repartidor: "Kevin",
    dia: "Hoy",
    franja: "2 a 6 p. m.",
    estado: "aprobado",
    hechos: {
      solicitado: { quien: "Kiara", cuando: "Mié 26 · 6:15 p. m." },
      aprobado: { quien: "Rosa", cuando: "Mié 26 · 6:40 p. m." },
    },
    extra: [
      { de: "clienta", texto: "mejor déjamelo a favor 👍", hora: "6:20 p. m." },
      {
        de: "sofi",
        texto:
          "¡Hecho! Kevin pasa a recogerla mañana de 2 a 6 p. m. y, al revisarla, te queda el monto a favor para tu próxima compra.",
        hora: "6:41 p. m.",
      },
    ],
  })
  kiara.eventos.push(
    ev(
      "Mié 26 · 6:40 p. m.",
      "persona",
      "Rosa",
      "Aprobó la devolución como saldo a favor que dejó lista Sofi.",
    ),
    ev(
      "Mié 26 · 6:40 p. m.",
      "gestoria",
      "gestorIA",
      "Asignó el recojo a Kevin (San Juan de Lurigancho, hoy, 2 a 6 p. m.): un viaje solo para recoger. Le llegó la tarea «Recoger» a su app.",
    ),
  )
  out.push(kiara)

  // Devolución de una parte (uno de dos), pagada con Yape: la persona la devuelve desde su app.
  const d1 = linea(pr(1), 0, 2)
  const d2 = linea(pr(2), 1, 2)
  const daniela = entregadoEl({
    id: "0146",
    clienta: "Daniela Paz",
    telefono: "987 *** 221",
    lineas: [d1, d2],
    zona: "Surco",
    direccion: "Av. Benavides 3020, Surco",
    creado: "Jue 20 · 5:10 p. m.",
    dia: "Sáb 22",
    medio: "yape",
    repartidor: "Jhon",
  })
  const dDice = "hola, las otras ya no las quiero, ¿me devuelves la plata?"
  pide(
    daniela,
    "Lun 24 · 9:12 a. m.",
    dDice,
    "Revisó tu política (2 días de 7, sin uso y con su caja). Ofreció primero dejarle el dinero a favor; Daniela prefirió que se lo devuelvan por Yape.",
  )
  daniela.vuelta = nuevaVuelta(rubro, daniela, {
    id: "D-0146",
    tipo: "devolucion",
    motivo: "no_quiere",
    dice: dDice,
    dias: 2,
    vuelven: [d2],
    como: "recojo_solo",
    medio: "yape",
    quiere: "medio",
    repartidor: "Jhon",
    dia: "Mié 26",
    franja: "9 a 1 p. m.",
    estado: "revisado",
    revision: { k: "vender", motivo: "" },
    persona: "Rosa",
    hechos: {
      solicitado: { quien: "Daniela", cuando: "Lun 24 · 9:12 a. m." },
      aprobado: { quien: "Rosa", cuando: "Lun 24 · 9:30 a. m." },
      vuelve: { quien: "Jhon", cuando: "Mié 26 · 11:20 a. m.", texto: "Recogido" },
      revisado: { quien: "Rosa", cuando: "Jue 27 · 9:05 a. m.", texto: "Se puede vender" },
    },
    extra: [
      { de: "clienta", texto: "prefiero la plata por yape porfa", hora: "9:14 a. m." },
      {
        de: "sofi",
        texto: "Perfecto, Daniela. Una persona del equipo ve tu devolución y te aviso por aquí.",
        hora: "9:14 a. m.",
      },
      { de: "clienta", texto: "oye y las sandalias negras ¿tienen en 37?", hora: "9:40 a. m." },
      { de: "sofi", texto: "¡Sí! Me quedan 2 en 37. Calzan normal. ¿Te armo el carrito?", hora: "9:40 a. m." },
      { de: "clienta", texto: "¿y ya me devolvieron?", hora: "9:20 a. m." },
      {
        de: "sofi",
        texto:
          "Eso lo tiene Rosa, del equipo: ya revisó tu par. Le sumé tu mensaje y te escribo apenas salga.",
        hora: "9:20 a. m.",
      },
    ],
  })
  daniela.eventos.push(
    ev(
      "Lun 24 · 9:14 a. m.",
      "sofi",
      "Sofi",
      "Pasó la devolución a Rosa como un tema, con todo el chat, el motivo y el pedido. Siguió contestando: le mostró otras sandalias.",
    ),
    ev("Lun 24 · 9:30 a. m.", "persona", "Rosa", "Aprobó la devolución que dejó lista Sofi."),
    ev(
      "Lun 24 · 9:30 a. m.",
      "gestoria",
      "gestorIA",
      "Asignó el recojo a Jhon (Surco, mié 26, 9 a 1 p. m.): un viaje solo para recoger.",
    ),
    ev(
      "Mié 26 · 11:20 a. m.",
      "repartidor",
      "Jhon",
      "Tocó «Recogí» con la foto de cómo estaba: «sin uso, con su caja».",
      undefined,
      { adjunto: "recojo" },
    ),
    ev(
      "Jue 27 · 9:05 a. m.",
      "persona",
      "Rosa",
      "Revisó lo que volvió: «Se puede vender». Entró al stock como «devolución» en el kardex.",
    ),
    ev(
      "Jue 27 · 9:20 a. m.",
      "sofi",
      "Sofi",
      "Daniela preguntó por su dinero: eso lo tiene Rosa. Sofi sumó el mensaje al tema y le avisó a Rosa.",
      undefined,
      { cita: "¿y ya me devolvieron?" },
    ),
  )
  daniela.avisos.push(
    av(
      "Lun 24 · 9:30 a. m.",
      "cambio",
      "Listo, Daniela: tu devolución está aprobada. Jhon pasa a recoger el par el miércoles de 9 a 1 p. m.",
    ),
    av(
      "Jue 27 · 9:05 a. m.",
      "cambio",
      `Daniela, ya revisamos el par. Estamos devolviéndote ${money(d2.precio - 12)} por Yape (el recojo se descontó); te aviso apenas salga.`,
    ),
  )
  out.push(daniela)

  // Devolución total desde provincia, por agencia; pagó con la pasarela.
  const rVieja = linea(pr(4), 2, 3)
  const renata = entregadoEl({
    id: "0140",
    clienta: "Renata Gil",
    telefono: "958 *** 731",
    lineas: [rVieja],
    zona: "Arequipa",
    direccion: "Shalom Arequipa · Av. Ejército",
    creado: "Lun 17 · 8:20 p. m.",
    dia: "Mié 19",
    medio: "link",
    agencia: { nombre: "Shalom", numero: "4471-2290" },
  })
  const rDice = "no me convencieron, ¿las puedo devolver? estoy en Arequipa"
  pide(
    renata,
    "Vie 21 · 4:30 p. m.",
    rDice,
    "Revisó tu política (2 días de 7). Le explicó que el envío de vuelta por Shalom lo paga ella y le pidió el número. Renata prefirió su dinero a la tarjeta.",
  )
  renata.vuelta = nuevaVuelta(rubro, renata, {
    id: "D-0140",
    tipo: "devolucion",
    motivo: "no_quiere",
    dice: rDice,
    dias: 2,
    vuelven: [rVieja],
    como: "agencia",
    agencia: { nombre: "Shalom", ciudad: "Arequipa", numero: "8830-1175" },
    medio: "link",
    quiere: "medio",
    estado: "recibido",
    hechos: {
      solicitado: { quien: "Renata", cuando: "Vie 21 · 4:30 p. m." },
      aprobado: { quien: "Rosa", cuando: "Vie 21 · 5:00 p. m." },
      vuelve: { quien: "Shalom", cuando: "Hoy · 10:15 a. m.", texto: "Llegó por Shalom" },
    },
    extra: [
      { de: "clienta", texto: "ya la mandé, el número es 8830-1175", hora: "11:02 a. m." },
      {
        de: "sofi",
        texto: "¡Gracias, Renata! Lo sigo con Shalom y te aviso cuando llegue y lo revisemos.",
        hora: "11:02 a. m.",
      },
    ],
  })
  renata.eventos.push(
    ev("Vie 21 · 5:00 p. m.", "persona", "Rosa", "Aprobó la devolución que dejó lista Sofi."),
    ev(
      "Sáb 22 · 11:02 a. m.",
      "sofi",
      "Sofi",
      "Renata mandó el número de Shalom: 8830-1175. Sofi lo anotó y lo sigue sola.",
    ),
    ev(
      "Hoy · 10:15 a. m.",
      "gestoria",
      "gestorIA",
      "Llegó por Shalom, N.º 8830-1175. Pasa a «Te toca» para revisarlo.",
    ),
  )
  out.push(renata)

  // Fuera de plazo (o algo que no se cambia, según el rubro): la clienta insiste.
  const jVieja = linea(pr(5), 0, 2)
  const jimena = entregadoEl({
    id: "0138",
    clienta: "Jimena Lara",
    telefono: "921 *** 668",
    lineas: [jVieja],
    zona: "Pueblo Libre",
    direccion: "Av. Bolívar 1120, Pueblo Libre",
    creado: "Vie 14 · 3:00 p. m.",
    dia: "Sáb 15",
    medio: "plin",
  })
  const jDice = "¿las puedo cambiar por otro color?"
  pide(
    jimena,
    "Jue 27 · 9:50 a. m.",
    jDice,
    "Revisó tu política y se lo explicó con amabilidad, con la regla de la tienda. Jimena insistió: Sofi pasó el caso a una persona, con todo el chat.",
  )
  jimena.vuelta = nuevaVuelta(rubro, jimena, {
    id: "C-0138",
    tipo: "cambio",
    motivo: "color",
    dice: jDice,
    dias: 12,
    vuelven: [jVieja],
    sale: linea(pr(5), 1, 2),
    categoria: rubro === "cosmetica" ? "abierto" : undefined,
    como: "recojo_mismo",
    medio: "plin",
    repartidor: "Kevin",
    dia: "Sáb 29",
    franja: "9 a 1 p. m.",
    estado: "solicitado",
    insiste: true,
    hechos: { solicitado: { quien: "Jimena", cuando: "Jue 27 · 9:50 a. m." } },
  })
  out.push(jimena)
  return out
}

/* ---------- La tienda de pedidos (en memoria) ---------- */

type Estado = { porRubro: Partial<Record<RubroId, Pedido[]>>; version: number }
let S: Estado = { porRubro: {}, version: 0 }
const subs = new Set<() => void>()
const emit = () => {
  S = { ...S, version: S.version + 1 }
  for (const f of subs) f()
}
/** Vuelve a pintar todo: lo usa la política al cambiar. */
export const refrescar = emit

/** Otros pedidos de ejemplo que suma otra parte del prototipo (Despachos: el resto de la semana). */
export const MAS_PEDIDOS: ((r: RubroId) => Pedido[])[] = []

export function pedidosDe(r: RubroId): Pedido[] {
  if (!S.porRubro[r]) S.porRubro[r] = [...seed(r), ...MAS_PEDIDOS.flatMap((f) => f(r))]
  return S.porRubro[r]!
}

export function usePedidos(r: RubroId): Pedido[] {
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => S.version,
  )
  return pedidosDe(r)
}

export function usePedido(r: RubroId, pid: string | null): Pedido | undefined {
  const all = usePedidos(r)
  return pid ? all.find((p) => p.id === pid) : undefined
}

export function reiniciarPedidos() {
  reiniciarVueltas()
  S = { porRubro: {}, version: S.version + 1 }
  for (const f of subs) f()
}

/** Cambia un pedido y anota lo que pasó. */
export function mover(
  r: RubroId,
  pid: string,
  fn: (p: Pedido) => void,
  evento?: Pick<Evento, "actor" | "quien" | "texto" | "paso" | "cita" | "adjunto"> & {
    cuando?: string
  },
) {
  const list = pedidosDe(r)
  const i = list.findIndex((p) => p.id === pid)
  if (i < 0) return
  const p = structuredClone(list[i]!)
  fn(p)
  if (evento)
    p.eventos.push({
      id: id("e"),
      cuando: evento.cuando ?? "Hoy · ahora",
      actor: evento.actor,
      quien: evento.quien,
      texto: evento.texto,
      paso: evento.paso,
      cita: evento.cita,
      adjunto: evento.adjunto,
    })
  list[i] = p
  S.porRubro[r] = [...list]
  emit()
}

export function agregar(r: RubroId, p: Pedido) {
  S.porRubro[r] = [p, ...pedidosDe(r)]
  emit()
}

export function avisar(
  p: Pedido,
  clave: Aviso["clave"],
  texto: string,
  estado: Aviso["estado"] = "enviado",
) {
  p.avisos.push({ id: id("a"), cuando: "Hoy · ahora", clave, texto, estado })
}

export const nuevoId = id

/** El paso siguiente cuando un pago queda completo: pagado, o preparando si sale hoy. */
export function trasPagar(p: Pedido): Paso {
  if (p.paso === "en_camino" || p.paso === "entregado") return p.paso
  return p.entrega.dia === "Hoy" ? "preparando" : "pagado"
}

export function money(n: number) {
  const c = Math.round(n * 100)
  return c % 100 ? `S/ ${(c / 100).toFixed(2).replace(".", ",")}` : `S/ ${Math.round(n)}`
}

/**
 * Lo que espera a una persona, con su único botón. A una persona solo le queda empacar,
 * confirmar capturas de Yape o Plin y los casos raros (que vienen anotados en `toca`).
 */
export function tocaDe(p: Pedido): Pedido["toca"] {
  if (p.paso === "anulado") return undefined
  if (p.toca) return p.toca
  const v = vueltaToca(p)
  if (v) return v
  if (p.paso === "por_confirmar" && p.pagos.some((x) => x.estado === "por_confirmar"))
    return {
      texto: `Confirma el ${p.pagos.find((x) => x.estado === "por_confirmar")?.medio === "plin" ? "Plin" : "Yape"} de ${p.clienta.split(" ")[0]}: mira tu app y confirma lo que llegó.`,
      boton: "Ver y confirmar",
      accion: "confirmar",
    }
  if (p.paso === "preparando" && p.entrega.repartidor && p.entrega.tipo === "moto")
    return {
      texto: `Empácalo: sale hoy de ${p.entrega.franja} con ${p.entrega.repartidor}.`,
      boton: "Empacar",
      accion: "empacar",
    }
  return undefined
}

/** Lo que necesita a una persona ahora (lo de «Te toca» de pedidos). */
export function teToca(list: Pedido[]): Pedido[] {
  return list.filter((p) => tocaDe(p))
}

/** El repartidor de siempre de cada zona. Lo usa gestorIA para asignar sola. */
const DE_SIEMPRE: Record<string, string> = {
  "La Molina": "Jhon",
  "Los Olivos": "Jhon",
  "San Juan de Lurigancho": "Kevin",
}

/**
 * gestorIA asigna al repartidor de siempre según la zona y la franja, sin que nadie lo toque.
 * Devuelve lo que se anota en la historia, o nada si no le toca asignar.
 */
export function asignarSolo(x: Pedido): string | null {
  const e = x.entrega
  if (e.tipo !== "moto" || e.repartidor || !e.dia) return null
  e.franja ??= "2 a 6 p. m."
  e.repartidor = DE_SIEMPRE[e.zona] ?? "Kevin"
  return `Asignó a ${e.repartidor} (${e.zona}, ${e.franja}).`
}

/** Tres horas antes de una hora como «Jue 27 · 11:04 p. m.»: cuándo Sofi recuerda el link. */
export function tresHorasAntes(cuando: string): string {
  const m = /^(.*?) · (\d+):(\d+) (a|p)\. m\.$/.exec(cuando)
  if (!m) return cuando
  const h24 = (Number(m[2]) % 12) + (m[4] === "p" ? 12 : 0) - 3
  const h = ((h24 + 24) % 12) || 12
  return `${m[1]} · ${h}:${m[3]} ${h24 >= 12 ? "p" : "a"}. m.`
}

export interface Falta {
  actor: Actor
  quien: string
  cuando: string
  texto: string
  /** El paso del camino que mueve. */
  paso?: Paso
}

/** Lo que falta, en orden: quién lo va a mover y cuándo. Casi todo lo hace gestorIA sola. */
export function loQueFalta(p: Pedido): Falta[] {
  // No lo recibió: no queda nada por hacer en la puerta; Sofi espera si lo quiere otro día.
  if (p.rechazo) return []
  const n = p.clienta.split(" ")[0]!
  const e = p.entrega
  const k = cuentas(p)
  const dia = e.dia ? (e.dia === "Hoy" ? "hoy" : `el ${e.dia.toLowerCase()}`) : "el día de entrega"
  const rep = e.repartidor ?? (e.tipo === "moto" ? "El repartidor" : null)
  const fr = e.franja ? `, de ${e.franja.replace(/\.$/, "")}` : ""
  const out: Falta[] = []
  const at = CAMINO.indexOf(p.paso)
  if (p.paso === "anulado") return out
  const antes = (s: Paso) => at < CAMINO.indexOf(s)
  if (p.paso === "por_pagar" && p.cobro === "link" && p.separadoHasta) {
    out.push({
      actor: "sofi",
      quien: "Sofi",
      cuando: tresHorasAntes(p.separadoHasta),
      texto: `Le recuerda el link una sola vez, 3 horas antes de que venza. Nadie tiene que tocar nada.`,
    })
    out.push({
      actor: "pasarela",
      quien: `${n} y la pasarela`,
      cuando: `Hasta ${p.separadoHasta.toLowerCase()}`,
      texto: `${n} paga en su link y la pasarela lo confirma sola. Si no paga, se libera el producto y se anula solo.`,
      paso: "pagado",
    })
  }
  if (p.paso === "por_confirmar")
    out.push({
      actor: "persona",
      quien: "Una persona",
      cuando: "Ahora",
      texto: "Mira su app de Yape o Plin y confirma lo que llegó. Si falta algo, Sofi lo cobra con su link.",
      paso: "pagado",
    })
  if (antes("preparando") && e.tipo === "moto")
    out.push({
      actor: "gestoria",
      quien: "gestorIA",
      cuando:
        e.dia === "Hoy"
          ? "Hoy, al confirmar el pago"
          : `${dia.replace(/^el /, "")[0]!.toUpperCase()}${dia.replace(/^el /, "").slice(1)} · 8 a. m.`,
      texto: e.repartidor
        ? `Pasa a Preparando. Ya tiene a ${e.repartidor} (${e.zona}, ${e.franja}).`
        : `Pasa a Preparando y asigna al repartidor de siempre de ${e.zona}${fr}.`,
      paso: "preparando",
    })
  if (antes("por_salir") && e.tipo === "moto")
    out.push({
      actor: "persona",
      quien: "Una persona",
      cuando: e.dia === "Hoy" ? "Hoy, antes de la franja" : `${e.dia ?? "Ese día"}, antes de la franja`,
      texto: e.repartidor
        ? `Lo empaca: «Empacar» abre lo que va en el paquete y ahí confirma «Listo: se lo di a ${e.repartidor}».`
        : "Lo empaca y toca «Listo» cuando se lo da al repartidor.",
      paso: "por_salir",
    })
  if (antes("en_camino"))
    out.push({
      actor: e.tipo === "agencia" ? "persona" : "repartidor",
      quien: e.tipo === "agencia" ? "Una persona" : (rep ?? "El repartidor"),
      cuando: e.tipo === "agencia" ? "Al dejarlo en la agencia" : "Al salir",
      texto:
        e.tipo === "agencia"
          ? `Anota el número de ${e.agencia ?? "la agencia"}; Sofi se lo manda a ${n}.`
          : `Toca «Salí» y Sofi le avisa a ${n} la franja y quién lo lleva.`,
      paso: "en_camino",
    })
  if (antes("entregado") || p.paso === "en_camino")
    out.push({
      actor: e.tipo === "agencia" ? "clienta" : "repartidor",
      quien: e.tipo === "agencia" ? n : (rep ?? "El repartidor"),
      cuando: e.tipo === "agencia" ? "Al recogerlo" : `En la puerta${e.franja ? `, de ${e.franja}` : ""}`,
      texto:
        e.tipo === "agencia"
          ? "Lo recoge en la agencia y Sofi le pregunta «¿Te llegó bien?»."
          : k.falta && p.cobro !== "link"
            ? `Cobra ${money(k.falta)} y toca «Entregado». Sin pago confirmado no entrega. Sofi le pregunta «¿Te llegó bien?».`
            : "Toca «Entregado» y Sofi le pregunta «¿Te llegó bien?».",
      paso: "entregado",
    })
  return out
}

/** Toda la conversación: la del pedido y la del cambio o la devolución. */
export function todoElChat(p: Pedido): Msg[] {
  return [...p.chat, ...(p.vuelta?.chat ?? [])]
}

/** El texto corto de la entrega: «Hoy · 2 a 6 p. m. · Kevin». */
export function entregaTexto(e: Entrega) {
  if (e.tipo === "agencia")
    return [e.agencia ?? "Agencia", e.numero ? `N.º ${e.numero}` : null].filter(Boolean).join(" · ")
  return [e.dia ?? "Sin día", e.franja, e.repartidor ?? (e.dia === "Hoy" ? "sin repartidor" : null)]
    .filter(Boolean)
    .join(" · ")
}

export function origenTexto(o: Origen, c: Canal) {
  if (o.k === "sofi") return `Sofi · ${CANAL[c]}`
  if (o.k === "catalogo") return "Catálogo"
  if (o.k === "equipo") return `Anotado por ${o.quien}`
  return `Campaña «${o.nombre}»`
}
