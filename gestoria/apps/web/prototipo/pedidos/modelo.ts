import { useSyncExternalStore } from "react"
import { type Producto, RUBROS, type RubroId } from "../datos"

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
  | "link"
  | "anular"
  | "cobrar"

/* ---------- Cuentas: un solo saldo ---------- */

export function cuentas(p: Pedido) {
  const productos = p.lineas.reduce((a, l) => a + (l.vuelve ? -1 : 1) * l.precio * l.qty, 0)
  const total = productos + p.entrega.envio
  const confirmado = p.pagos
    .filter((x) => x.estado === "confirmado")
    .reduce((a, x) => a + x.monto, 0)
  const porConfirmar = p.pagos
    .filter((x) => x.estado === "por_confirmar")
    .reduce((a, x) => a + x.monto, 0)
  const falta = Math.max(0, total - confirmado - porConfirmar)
  return {
    productos,
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

const ev = (cuando: string, actor: Actor, quien: string, texto: string, paso?: Paso): Evento => ({
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
      ),
      ev(
        "Jue 27 · 9:12 a. m.",
        "sofi",
        "Sofi",
        "Leyó la captura: dice un monto distinto al del pedido. La dejó en «Te toca» sin decirle nada a Carla.",
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
      texto: `La captura del Yape de Carla dice ${money(t - 27)}; el pedido es ${money(t)}.`,
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
        "Llegó su día: pasó a Preparando.",
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
        "Llegó su día: pasó a Preparando.",
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
      ev("Mar 25 · 8:00 a. m.", "gestoria", "gestorIA", "Pasó a Preparando.", "preparando"),
      ev("Mar 25 · 9:00 a. m.", "persona", "Rosa", "Se lo dio a Kevin.", "por_salir"),
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
        "sofi",
        "Sofi",
        "Andrea escribió que le quedó chica y quiere una talla más. Sofi se lo pasó a una persona: un cambio lo decide la tienda.",
      ),
    ],
    avisos: [
      av("Lun 24 · 1:40 p. m.", "pagado", "¡Pago recibido, Andrea! Sale mañana."),
      av("Mar 25 · 2:10 p. m.", "salio", "Tu pedido salió: llega hoy entre 2 y 6 p. m. con Kevin."),
      av("Mar 25 · 3:42 p. m.", "entregado", "Kevin dejó tu pedido. ¿Te llegó bien?"),
    ],
    chat: [
      {
        de: "clienta",
        texto: "Hola, me quedó chica 😕 ¿la puedo cambiar por una talla más?",
        hora: "9:38 a. m.",
      },
      {
        de: "sofi",
        texto:
          "¡Claro que sí, Andrea! Le paso tu cambio a la tienda y te escribo en un ratito con el día.",
        hora: "9:40 a. m.",
      },
    ],
    toca: {
      texto: "Andrea quiere cambiar por una talla más.",
      boton: "Cambio o devolución",
      accion: "cambio",
    },
    unoPorCiento: true,
  }

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
        "Llegó su día: pasó a Preparando.",
        "preparando",
      ),
    ],
    avisos: [],
    chat: [],
    toca: {
      texto: "Sale hoy de 2 a 6 p. m. y no tiene repartidor.",
      boton: "Asignar",
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
      ev("Jue 27 · 8:00 a. m.", "gestoria", "gestorIA", "Pasó a Preparando.", "preparando"),
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
        "Sale hoy: pasó a Preparando con Kevin, que ya tenía la franja.",
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
    andrea,
    martin,
  ]
}

/* ---------- La tienda de pedidos (en memoria) ---------- */

type Estado = { porRubro: Partial<Record<RubroId, Pedido[]>>; version: number }
let S: Estado = { porRubro: {}, version: 0 }
const subs = new Set<() => void>()
const emit = () => {
  S = { ...S, version: S.version + 1 }
  for (const f of subs) f()
}

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
  S = { porRubro: {}, version: S.version + 1 }
  for (const f of subs) f()
}

/** Cambia un pedido y anota lo que pasó. */
export function mover(
  r: RubroId,
  pid: string,
  fn: (p: Pedido) => void,
  evento?: { actor: Actor; quien: string; texto: string; paso?: Paso; cuando?: string },
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

/** Lo que necesita a una persona ahora (lo de «Te toca» de pedidos). */
export function teToca(list: Pedido[]): Pedido[] {
  return list.filter((p) => p.toca && p.paso !== "anulado")
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
